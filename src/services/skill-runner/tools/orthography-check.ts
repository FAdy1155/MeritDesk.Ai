import "server-only";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { withTenantContext } from "@/db/client";
import { documents, skillRuns } from "@/db/schema";
import { createGeneratedDocument } from "@/lib/documents/service";
import { detectFileKind } from "@/lib/documents/file-kind";
import { isWordprocessingDocument } from "@/lib/documents/ooxml";
import { getObjectBytes } from "@/lib/s3";
import { readToolOutput, TOOL_OUTPUT_LIMITS } from "@/services/sandbox/untrusted-exec";
import { cleanupWorkDir, DOCX_TEMPLATES_DIR, generateDocxWithPreview } from "@/services/docx-generator/generate";
import { toJsonSchemaObject } from "../json-schema";
// Types only: tools.ts imports this module for its registry.
import type { SkillTool, ToolExecutionContext } from "../tools";

/**
 * orthography-check's corrected copy (tool key make_corrected_copy_orthography,
 * exposed to the model as make_corrected_copy). The skill's
 * references/file-handling.md says to return the corrected copy "in the same
 * format the author gave you, with formatting intact", and for Word files to
 * "change only the runs that contain an actual fix ... Do not rebuild the
 * document from scratch; open it, apply the specific text substitutions, and
 * save", with tracked changes as an option. generate_document cannot do that
 * (it builds a new document from a spec), so this tool applies the model's
 * certain fixes to the author's own file instead:
 *
 * - a Word document on the matter: templates/orthography-check/apply_corrections.py
 *   edits only the text of each fix, directly or as tracked changes, and the
 *   copy is rendered like any generated document, for render_and_qa_docx;
 * - a text file on the matter, in its own encoding and extension;
 * - text the attorney pasted into the case note ("If the user pasted text
 *   into chat ... return the corrected copy ... as a .txt file").
 *
 * A PDF or a scan cannot be edited in place; the skill delivers its
 * corrected copy as a new Word file, which is generate_document's job.
 *
 * The tool never writes the model's text wholesale: every change is a
 * substitution located in the source, and a correction that cannot be
 * located exactly (missing, ambiguous, overlapping) stops the whole call, so
 * the corrected copy holds exactly the fixes the report lists as applied.
 * Matter documents are read only when they passed the malware scan, at the
 * version the scan read.
 */

const SCRIPT_PATH = path.join(DOCX_TEMPLATES_DIR, "orthography-check", "apply_corrections.py");
const SOURCE_FILE = "source.docx";
const REPORT_FILE = "corrections_report.json";
// The work file's name; the stored copy takes the model's file_name.
const OUTPUT_FILE = "corrected.docx";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_DOCX_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
// Who the tracked changes name in Word's review pane: the automated pass,
// not a person, so a reviewer can tell its changes from their own.
const TRACKED_CHANGE_AUTHOR = "Orthography check";
const CASE_NOTE_SOURCE = "case_note";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTEXT_CHARS = 30;
// How much of each end of a pasted-text copy the result quotes back.
const SPAN_PREVIEW_CHARS = 40;

// The one-for-one stand-ins apply_corrections.py compares text with: curly
// and straight quotes, non-breaking and ordinary spaces. One UTF-16 unit
// each, so offsets in the compared text are offsets in the source.
const MATCH_EQUIVALENTS: Record<string, string> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201b": "'",
  "\u2032": "'",
  "\u201c": '"',
  "\u201d": '"',
  "\u201f": '"',
  "\u2033": '"',
  "\u00a0": " ",
  "\u2007": " ",
  "\u202f": " ",
};
const MATCH_EQUIVALENT_CHARS = /[\u2018\u2019\u201b\u2032\u201c\u201d\u201f\u2033\u00a0\u2007\u202f]/g;
// Characters XML 1.0 cannot carry; also refused in text copies, which hold prose.
const CONTROL_CHARACTERS = /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/;

const correctionSchema = z.object({
  original: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      "The text exactly as the source has it, within one paragraph or table cell (one line of a text file): the word to fix, with enough of the words around it to find the spot."
    ),
  corrected: z
    .string()
    .max(2000)
    .describe("The same text with only the certain fix applied; everything else in it stays identical to original."),
  replace_all: z
    .boolean()
    .optional()
    .describe("true to apply the fix to every occurrence of original (a misspelling or variant standardized throughout). Otherwise original must occur once, or occurrence says which one."),
  occurrence: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("When original occurs more than once and only one is to change: which one, counting from 1 in document order (body, then headers and footers)."),
});
type Correction = z.infer<typeof correctionSchema>;

export const makeCorrectedCopyInputSchema = z.object({
  source: z
    .string()
    .min(1)
    .describe(
      'The document to correct, the one whose text you checked: "Document N" with the number its label gives it (for example "Document 3"), its file name exactly as its label shows it, or its document id; or "case_note" for text the attorney pasted into the case note. When two documents share a file name, use "Document N".'
    ),
  pasted_text_from: z
    .string()
    .optional()
    .describe(
      "case_note only, when the note also holds instructions: the first words of the pasted text, exactly as the note has them, enough of them that they occur only once in the note."
    ),
  pasted_text_to: z
    .string()
    .optional()
    .describe(
      "case_note only, when the note also holds instructions: the last words of the pasted text, exactly as the note has them, enough of them that they occur only once from the start of the pasted text on."
    ),
  corrections: z
    .array(correctionSchema)
    .max(2000)
    .describe("Only the certain fixes, the ones the report lists as Fixed. Flagged items are not corrections: leave them out, so they stay as the author wrote them."),
  tracked_changes: z
    .boolean()
    .describe("Word sources only: true records each fix as a tracked deletion and insertion the author can accept or reject one by one; false applies the fixes directly. Ignored for text."),
  file_name: z
    .string()
    .min(1)
    .max(150)
    .describe("Name for the corrected copy, without extension, e.g. the source's name followed by \" - corrected\". The source's format and extension are kept."),
});
type MakeCorrectedCopyInput = z.infer<typeof makeCorrectedCopyInputSchema>;

// What apply_corrections.py writes next to its spec on success.
const scriptReportSchema = z.object({
  corrections: z.array(z.object({ index: z.number(), applied: z.number(), contexts: z.array(z.string()) })),
  edits: z.number(),
  tracked_changes: z.boolean(),
  not_reviewed: z.array(z.string()),
});

type AppliedCorrection = { index: number; applied: number; contexts: string[] };

type MatterDocument = {
  id: string;
  fileName: string;
  mimeType: string | null;
  malwareScanStatus: string;
  s3Bucket: string;
  s3Key: string;
  s3VersionId: string | null;
  version: number;
  createdAt: Date;
};

/** A matter document with the "Document N" its label gives it; null for a document this run generated. */
type NumberedDocument = MatterDocument & { number: number | null };

function forMatching(text: string): string {
  return text.replace(MATCH_EQUIVALENT_CHARS, (c) => MATCH_EQUIVALENTS[c] ?? c);
}

function shorten(text: string): string {
  return text.length <= 60 ? text : `${text.slice(0, 57)}...`;
}

function describeCorrection(c: Correction, index: number): string {
  return `Correction ${index + 1} ("${shorten(c.original)}" -> "${shorten(c.corrected)}")`;
}

/** Why a correction can never be applied, whatever the source says; null when it can (apply_corrections.py's correction_problem). */
function correctionProblem(c: Correction): string | null {
  if (/[\r\n]/.test(c.original + c.corrected)) {
    return "contains a line break; a fix must lie within one paragraph or table cell (one line of a text file).";
  }
  if (CONTROL_CHARACTERS.test(c.original + c.corrected)) return "contains a control character.";
  if (c.replace_all && c.occurrence !== undefined) return "gives both replace_all and occurrence; use one.";
  if (forMatching(c.original) === forMatching(c.corrected)) {
    return "changes nothing this tool can apply: original and corrected are the same, or differ only in curly versus straight quotes or non-breaking spaces, which it treats as the same character.";
  }
  return null;
}

/** The part of `found` that actually changes: offsets within found, and its replacement (apply_corrections.py's change_region). */
function changeRegion(found: string, corrected: string): { start: number; end: number; insert: string } {
  const nf = forMatching(found);
  const nc = forMatching(corrected);
  let prefix = 0;
  while (prefix < nf.length && prefix < nc.length && nf[prefix] === nc[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < nf.length - prefix &&
    suffix < nc.length - prefix &&
    nf[nf.length - 1 - suffix] === nc[nc.length - 1 - suffix]
  ) {
    suffix++;
  }
  return { start: prefix, end: found.length - suffix, insert: corrected.slice(prefix, corrected.length - suffix) };
}

function findAll(haystack: string, needle: string): number[] {
  const hits: number[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) hits.push(i);
  return hits;
}

function contextAround(text: string, start: number, end: number): string {
  const from = Math.max(0, start - CONTEXT_CHARS);
  const to = Math.min(text.length, end + CONTEXT_CHARS);
  return `${from > 0 ? "..." : ""}${text.slice(from, start)}[${text.slice(start, end)}]${text.slice(end, to)}${to < text.length ? "..." : ""}`
    .replace(/\r\n|\r|\n/g, " / ")
    .replace(/\t/g, " ");
}

/**
 * The corrections applied to plain text with the rules apply_corrections.py
 * applies to a Word document's paragraphs: matched with the quote and space
 * equivalences, unique unless replace_all or occurrence says otherwise, only
 * the differing characters changed, nothing applied unless everything is.
 */
function correctText(
  text: string,
  corrections: Correction[]
): { text: string; applied: AppliedCorrection[]; edits: number } | { problems: string[] } {
  const haystack = forMatching(text);
  const problems: string[] = [];
  const applied: AppliedCorrection[] = [];
  const edits: { start: number; end: number; insert: string; correction: number }[] = [];

  corrections.forEach((c, ci) => {
    const label = describeCorrection(c, ci);
    const problem = correctionProblem(c);
    if (problem) {
      problems.push(`${label} ${problem}`);
      return;
    }
    const hits = findAll(haystack, forMatching(c.original));
    if (hits.length === 0) {
      problems.push(`${label}: not found. Copy original exactly as the text has it, within one line.`);
      return;
    }
    let selected = hits;
    if (!c.replace_all) {
      if (c.occurrence !== undefined) {
        if (c.occurrence > hits.length) {
          problems.push(
            `${label}: occurrence ${c.occurrence} was asked for, but original occurs ${hits.length} time${hits.length === 1 ? "" : "s"}.`
          );
          return;
        }
        selected = [hits[c.occurrence - 1]];
      } else if (hits.length > 1) {
        problems.push(
          `${label}: original occurs ${hits.length} times. Set replace_all to fix every occurrence, give occurrence to fix one, or lengthen original with the surrounding words so it is unique.`
        );
        return;
      }
    }
    const contexts: string[] = [];
    for (const start of selected) {
      const found = text.slice(start, start + c.original.length);
      const region = changeRegion(found, c.corrected);
      if (region.start === region.end && !region.insert) {
        problems.push(`${label}: changes nothing in the source's own text.`);
        return;
      }
      edits.push({ start: start + region.start, end: start + region.end, insert: region.insert, correction: ci });
      contexts.push(contextAround(text, start, start + c.original.length));
    }
    applied.push({ index: ci, applied: selected.length, contexts: contexts.slice(0, 10) });
  });

  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < edits.length; i++) {
    const [earlier, later] = [edits[i - 1], edits[i]];
    // Two edits starting at the same point conflict even when one only inserts.
    if (later.start < earlier.end || later.start === earlier.start) {
      const [first, second] = [earlier.correction, later.correction].sort((a, b) => a - b);
      const message =
        first === second
          ? `${describeCorrection(corrections[first], first)} overlaps itself; make original unique instead of replace_all.`
          : `${describeCorrection(corrections[first], first)} and correction ${second + 1} change overlapping text; merge them into one correction.`;
      if (!problems.includes(message)) problems.push(message);
    }
  }
  if (problems.length > 0) return { problems };

  // From the end back, so earlier offsets stay valid.
  let corrected = text;
  for (const edit of [...edits].reverse()) {
    corrected = corrected.slice(0, edit.start) + edit.insert + corrected.slice(edit.end);
  }
  return { text: corrected, applied, edits: edits.length };
}

/** A text upload decoded the way the ingest job decoded it for the model, with the encoder that writes it back the same way. */
function decodeTextSource(bytes: Buffer): { text: string; encode: (text: string) => Buffer } | string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    if (bytes.length % 2 !== 0) return "it is not valid UTF-16";
    return {
      text: bytes.subarray(2).toString("utf16le"),
      encode: (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]),
    };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    if (bytes.length % 2 !== 0) return "it is not valid UTF-16";
    return {
      text: Buffer.from(bytes.subarray(2)).swap16().toString("utf16le"),
      encode: (text) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]),
    };
  }
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let text: string;
  try {
    // Fatal: re-encoding a file with invalid bytes would silently change them.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "it is not valid UTF-8, so a copy could not keep every byte it does not fix";
  }
  return {
    text,
    encode: (corrected) => Buffer.concat([bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(corrected, "utf-8")]),
  };
}

/**
 * This matter's documents, each with the number the run's labels give it
 * ("Document N of M", document-input.ts): every document, scanned or not, in
 * upload order, ties broken by id, compared exactly as prepareDocumentInput
 * compares them. Documents this run generated get no number: they were saved
 * after the labels were written. Neither they nor uploads made since come
 * before a labeled document in that order, and documents are never deleted,
 * so a labeled document keeps its number here.
 */
async function numberedMatterDocuments(ctx: ToolExecutionContext): Promise<NumberedDocument[]> {
  const rows: MatterDocument[] = await withTenantContext(ctx.tenantId, (tx) =>
    tx
      .select({
        id: documents.id,
        fileName: documents.fileName,
        mimeType: documents.mimeType,
        malwareScanStatus: documents.malwareScanStatus,
        s3Bucket: documents.s3Bucket,
        s3Key: documents.s3Key,
        s3VersionId: documents.s3VersionId,
        version: documents.version,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .where(and(eq(documents.tenantId, ctx.tenantId), eq(documents.matterId, ctx.matterId)))
  );
  const ordered = rows.sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  let next = 1;
  return ordered.map((r) => ({
    ...r,
    number: ctx.generatedDocuments.get(r.id)?.origin === "generated" ? null : next++,
  }));
}

/** How a result names a matter document: its label's number when it has one, and its file name. */
function describeDocument(doc: NumberedDocument): string {
  return doc.number === null ? `"${doc.fileName}"` : `Document ${doc.number} ("${doc.fileName}")`;
}

/**
 * One of this matter's documents, named by the model by its label's number
 * ("Document 3", or the whole label), by file name, or by id (the labels
 * show numbers and file names; the inventory line also gives each document_id). Two uploads can share a file
 * name (a revised declaration uploaded again), and their labels differ only
 * in the number, so a name that fits more than one clean document is refused
 * with each one's number, never resolved by guessing. Returns an error the
 * model can act on instead of throwing.
 */
async function findMatterDocument(reference: string, ctx: ToolExecutionContext): Promise<NumberedDocument | string> {
  // The label quotes the file name; take it with or without the quotes.
  const ref = reference.trim().replace(/^"(.*)"$/, "$1").trim();
  const all = await numberedMatterDocuments(ctx);

  if (UUID.test(ref)) {
    return all.find((d) => d.id === ref.toLowerCase()) ?? `No document with id ${ref} is on this matter.`;
  }

  const named = all.filter((d) => d.fileName === ref && d.number !== null);
  // "Document 3", "Document 3 of 7", or a whole label or inventory line
  // ('Document 3 of 7: "Declaration.docx" (...)'); not "Document 3.docx".
  const label = /^document\s+(\d+)(?:\s+of\s+\d+)?(?:\s*:\s*([\s\S]*))?$/i.exec(ref);
  if (label) {
    const doc = all.find((d) => d.number === Number(label[1]));
    if (!doc) {
      return `No document on this matter is numbered ${label[1]}. Give "Document N" with the number of the document's own label, or its file name.`;
    }
    const rest = label[2]?.trim();
    if (rest && !rest.includes(doc.fileName)) {
      return `Document ${doc.number} on this matter is "${doc.fileName}", not the file the rest of your reference names (${shorten(rest)}). Nothing was saved. Give "Document N" with the number of the label whose text you checked.`;
    }
    if (named.some((d) => d.id !== doc.id)) {
      return `"${ref}" is both a file name on this matter and Document ${doc.number}'s number. Nothing was saved. Give the whole label of the document you checked, file name included.`;
    }
    return doc;
  }

  if (named.length === 0) {
    return `No document named "${ref}" is on this matter. Give "Document N" with the number of the document's label, or its file name exactly as the label shows it.`;
  }
  const clean = named.filter((d) => d.malwareScanStatus === "clean");
  if (clean.length === 1) return clean[0];
  if (clean.length === 0) return named[named.length - 1]; // refused by the caller, with its scan status
  return (
    `Several documents on this matter are named "${ref}": ` +
    clean.map((d) => `Document ${d.number} (uploaded ${d.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC)`).join("; ") +
    `. Nothing was saved. Call make_corrected_copy again with source set to "Document N", the number of the label whose text you checked, so the corrected copy is made from that document and no other.`
  );
}

/** The case note this run was queued with (input_snapshot.attorneyNote), or an error for the model. */
async function loadCaseNote(ctx: ToolExecutionContext): Promise<{ note: string } | { error: string }> {
  const runId = ctx.skillRunId;
  if (!runId) return { error: "This run has no stored case note to read." };
  const [row] = await withTenantContext(ctx.tenantId, (tx) =>
    tx
      .select({ inputSnapshot: skillRuns.inputSnapshot })
      .from(skillRuns)
      .where(and(eq(skillRuns.id, runId), eq(skillRuns.tenantId, ctx.tenantId), eq(skillRuns.matterId, ctx.matterId)))
      .limit(1)
  );
  const note = (row?.inputSnapshot as { attorneyNote?: unknown } | undefined)?.attorneyNote;
  if (typeof note !== "string" || !note.trim()) return { error: "This run has no case note, so there is no pasted text to correct." };
  return { note };
}

/** Every offset of needle in haystack from `from` on, overlapping ones included. */
function occurrencesFrom(haystack: string, needle: string, from: number): number[] {
  const hits: number[] = [];
  for (let i = haystack.indexOf(needle, from); i !== -1; i = haystack.indexOf(needle, i + 1)) hits.push(i);
  return hits;
}

/** Text on one line for a tool result. */
function flatten(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " / ").replace(/\t/g, " ");
}

/**
 * The pasted text inside the case note, from its first to its last words as
 * the model quoted them; without those bounds, the whole note as the run's
 * prompt showed it (trimmed). A bound that occurs more than once is refused,
 * never guessed: the first of repeated closing words would cut the copy short,
 * and opening words the instructions repeat would pull instructions in. `span`
 * says which part of the note was taken, for the model to check.
 */
function pastedText(
  note: string,
  from: string | undefined,
  to: string | undefined
): { text: string; span: string } | { error: string } {
  const haystack = forMatching(note);
  const first = from?.trim() ?? "";
  const last = to?.trim() ?? "";
  let start = 0;
  if (first) {
    const hits = occurrencesFrom(haystack, forMatching(first), 0);
    if (hits.length === 0) {
      return { error: "pasted_text_from was not found in the case note; copy the first words exactly as the note has them. Nothing was saved." };
    }
    if (hits.length > 1) {
      return {
        error: `pasted_text_from occurs ${hits.length} times in the case note, so where the pasted text begins is ambiguous. Nothing was saved. Call make_corrected_copy again with more of the opening words, enough that they occur only once.`,
      };
    }
    start = hits[0];
  }
  let end = note.length;
  if (last) {
    // Closing words inside the opening words would cut the copy short too.
    const hits = occurrencesFrom(haystack, forMatching(last), start).filter((at) => at + last.length >= start + first.length);
    if (hits.length === 0) {
      return {
        error: "pasted_text_to was not found in the case note after pasted_text_from; copy the last words exactly as the note has them. Nothing was saved.",
      };
    }
    if (hits.length > 1) {
      return {
        error: `pasted_text_to occurs ${hits.length} times from the start of the pasted text on, so where it ends is ambiguous. Nothing was saved. Call make_corrected_copy again with more of the closing words, enough that they occur only once.`,
      };
    }
    end = hits[0] + last.length;
  }
  const text = first || last ? note.slice(start, end) : note.trim();
  if (!text.trim()) return { error: "The pasted text is empty. Nothing was saved." };

  const chars = Array.from(text.trim());
  const taken =
    first && last
      ? "from pasted_text_from through pasted_text_to"
      : first
        ? "from pasted_text_from to the end of the note"
        : last
          ? "from the start of the note through pasted_text_to"
          : "the whole note, as no pasted_text_from or pasted_text_to was given";
  const span =
    `The copy holds ${text.length} of the case note's ${note.length} characters (${taken}), ` +
    `beginning "${flatten(chars.slice(0, SPAN_PREVIEW_CHARS).join(""))}" and ending "${flatten(chars.slice(-SPAN_PREVIEW_CHARS).join(""))}". ` +
    "If that is not exactly the pasted text, with none of the attorney's instructions and nothing cut off, call make_corrected_copy again with pasted_text_from and pasted_text_to set to its first and last words.";
  return { text, span };
}

/** The model's file_name made safe for the documents list and the S3 key it becomes part of. */
function safeFileStem(raw: string): string {
  const base = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\.(docx|txt)$/i, "")
    .replace(/[^A-Za-z0-9 ._()-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 100)
    .trim();
  return base || "Corrected copy";
}

/** A text upload's own extension, when it is a plain one; otherwise txt. */
function textExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const ext = dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : "txt";
}

function describeExecError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function appliedLines(applied: AppliedCorrection[], corrections: Correction[]): string[] {
  return applied.map((a) => {
    const c = corrections[a.index];
    const where = a.contexts.length ? `: ${a.contexts.join(" | ")}${a.applied > a.contexts.length ? " | ..." : ""}` : "";
    return `- ${describeCorrection(c, a.index)} applied ${a.applied} time${a.applied === 1 ? "" : "s"}${where}`;
  });
}

const FIX_ADVICE =
  "Fix these corrections, or leave out any you are not certain of and list them as flagged items instead (unchanged in the copy), then call make_corrected_copy again.";
const RETRY_ADVICE = `Nothing was saved. ${FIX_ADVICE}`;
const FINAL_ID_ADVICE =
  "Each make_corrected_copy call saves a new document; call again only to fix a problem, and report only the final document_id as the corrected copy.";

/** Stores a corrected text copy on the matter and registers it as generated in this run. */
async function storeTextCopy(
  ctx: ToolExecutionContext,
  params: { fileName: string; contentType: string; body: Buffer }
): Promise<string> {
  // No pages to render; the empty work directory keeps the entry's shape
  // (cleanupGeneratedDocuments removes it at the end of the run).
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "orthocopy-"));
  try {
    const row = await createGeneratedDocument({
      tenantId: ctx.tenantId,
      matterId: ctx.matterId,
      fileName: params.fileName,
      contentType: params.contentType,
      body: params.body,
      uploadedBy: ctx.requestedBy,
      type: "generated_draft",
    });
    ctx.generatedDocuments.set(row.id, { documentRowId: row.id, pageImagePaths: [], workDir, origin: "generated" });
    return row.id;
  } catch (err) {
    await cleanupWorkDir(workDir);
    throw err;
  }
}

async function correctTextSource(
  input: MakeCorrectedCopyInput,
  ctx: ToolExecutionContext,
  source: {
    label: string;
    text: string;
    encode: (text: string) => Buffer;
    extension: string;
    contentType: string;
    // For pasted text: which part of the case note the copy holds.
    span?: string;
  }
) {
  const result = correctText(source.text, input.corrections);
  if ("problems" in result) {
    return { content: [RETRY_ADVICE, ...result.problems.map((p) => `- ${p}`)].join("\n"), isError: true };
  }
  const fileName = `${safeFileStem(input.file_name)}.${source.extension}`;
  let documentId: string;
  try {
    documentId = await storeTextCopy(ctx, { fileName, contentType: source.contentType, body: source.encode(result.text) });
  } catch (err) {
    return { content: `The corrected copy could not be stored: ${describeExecError(err)}`, isError: true };
  }
  return {
    content: [
      `Saved the corrected copy of ${source.label} as document_id ${documentId} ("${fileName}"), plain text in the source's own format, with ${result.edits} change${result.edits === 1 ? "" : "s"}.`,
      ...(source.span ? [source.span] : []),
      ...(input.tracked_changes ? ["Tracked changes apply to Word documents only, so the fixes were applied directly."] : []),
      ...appliedLines(result.applied, input.corrections),
      FINAL_ID_ADVICE,
    ].join("\n"),
  };
}

async function correctWordSource(input: MakeCorrectedCopyInput, ctx: ToolExecutionContext, doc: NumberedDocument, bytes: Buffer) {
  // Never-applicable corrections are refused here, before a sandbox is
  // started; the script checks them again with everything else.
  const early = input.corrections
    .map((c, i) => ({ problem: correctionProblem(c), label: describeCorrection(c, i) }))
    .filter((p) => p.problem !== null)
    .map((p) => `- ${p.label} ${p.problem}`);
  if (early.length > 0) return { content: [RETRY_ADVICE, ...early].join("\n"), isError: true };

  const spec = {
    source: SOURCE_FILE,
    report: REPORT_FILE,
    tracked_changes: input.tracked_changes,
    author: TRACKED_CHANGE_AUTHOR,
    date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    corrections: input.corrections.map((c) => ({
      original: c.original,
      corrected: c.corrected,
      ...(c.replace_all !== undefined ? { replace_all: c.replace_all } : {}),
      ...(c.occurrence !== undefined ? { occurrence: c.occurrence } : {}),
    })),
  };

  let result;
  try {
    result = await generateDocxWithPreview({
      scriptPath: SCRIPT_PATH,
      spec,
      outputFileName: OUTPUT_FILE,
      inputFiles: [{ name: SOURCE_FILE, bytes }],
    });
  } catch (err) {
    const message = describeExecError(err);
    // The script's own refusal lists every correction it could not apply.
    return {
      content: /Nothing was saved/.test(message)
        ? `${message}\n${FIX_ADVICE}`
        : `The corrected copy of ${describeDocument(doc)} could not be made: ${message}`,
      isError: true,
    };
  }

  let keepWorkDir = false;
  try {
    let report: z.infer<typeof scriptReportSchema>;
    try {
      const parsed = scriptReportSchema.safeParse(JSON.parse(await readToolOutput(path.join(result.workDir, REPORT_FILE), { maxBytes: TOOL_OUTPUT_LIMITS.report, encoding: "utf-8" })));
      if (!parsed.success) return { content: `apply_corrections.py wrote an unexpected report: ${parsed.error.message}`, isError: true };
      report = parsed.data;
    } catch (err) {
      return { content: `apply_corrections.py wrote no readable report: ${describeExecError(err)}`, isError: true };
    }

    const fileName = `${safeFileStem(input.file_name)}.docx`;
    let documentId: string;
    try {
      const row = await createGeneratedDocument({
        tenantId: ctx.tenantId,
        matterId: ctx.matterId,
        fileName,
        contentType: DOCX_MIME,
        body: await readToolOutput(result.docxPath, { maxBytes: TOOL_OUTPUT_LIMITS.document }),
        uploadedBy: ctx.requestedBy,
        type: "generated_draft",
      });
      documentId = row.id;
    } catch (err) {
      return { content: `The corrected copy could not be stored: ${describeExecError(err)}`, isError: true };
    }
    // From here the work directory (with the page images render_and_qa_docx
    // reads) belongs to the stored document's entry.
    ctx.generatedDocuments.set(documentId, {
      documentRowId: documentId,
      pageImagePaths: result.pageImagePaths,
      workDir: result.workDir,
      origin: "generated",
    });
    keepWorkDir = true;

    return {
      content: [
        `Saved the corrected copy of ${describeDocument(doc)} as document_id ${documentId} ("${fileName}", ${result.pageImagePaths.length} page(s)): the author's own Word file with only the text of each fix changed, ${
          report.tracked_changes
            ? `each fix recorded as a tracked change by "${TRACKED_CHANGE_AUTHOR}" (${report.edits} in all)`
            : `the fixes applied directly (${report.edits} in all)`
        }.`,
        ...appliedLines(report.corrections, input.corrections),
        ...(report.not_reviewed.length > 0
          ? [
              `Not in the text you were given, so not checked and not changed: ${report.not_reviewed.join("; ")}. List each in the report's notChecked.`,
            ]
          : []),
        "Call render_and_qa_docx with this document_id to look at the pages if you need to.",
        FINAL_ID_ADVICE,
      ].join("\n"),
    };
  } finally {
    if (!keepWorkDir) await cleanupWorkDir(result.workDir);
  }
}

async function executeMakeCorrectedCopy(input: unknown, ctx: ToolExecutionContext) {
  const parsed = makeCorrectedCopyInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      content: `Input validation failed: ${parsed.error.message}. Call make_corrected_copy again with corrected input.`,
      isError: true,
    };
  }
  const data = parsed.data;

  if (data.source.trim() === CASE_NOTE_SOURCE) {
    const loaded = await loadCaseNote(ctx);
    if ("error" in loaded) return { content: loaded.error, isError: true };
    const pasted = pastedText(loaded.note, data.pasted_text_from, data.pasted_text_to);
    if ("error" in pasted) return { content: pasted.error, isError: true };
    return correctTextSource(data, ctx, {
      label: "the text pasted into the case note",
      text: pasted.text,
      span: pasted.span,
      encode: (text) => Buffer.from(text, "utf-8"),
      extension: "txt",
      contentType: "text/plain",
    });
  }

  const doc = await findMatterDocument(data.source, ctx);
  if (typeof doc === "string") return { content: doc, isError: true };
  if (doc.malwareScanStatus !== "clean") {
    return {
      content: `"${doc.fileName}" has not passed the malware scan (status: ${doc.malwareScanStatus}), so it cannot be read or copied.`,
      isError: true,
    };
  }

  const byName = detectFileKind({ mimeType: doc.mimeType, fileName: doc.fileName });
  if (byName.kind === "pdf" || byName.kind === "image") {
    return {
      content:
        `"${doc.fileName}" is a ${byName.kind === "pdf" ? "PDF" : "scanned image"}, which cannot be edited in place. ` +
        "Deliver its corrected copy as a new Word document with generate_document (references/file-handling.md, PDFs), and tell the author the source was a PDF.",
      isError: true,
    };
  }
  if (byName.kind !== "docx" && byName.kind !== "text") {
    return { content: `"${doc.fileName}" is neither a Word document nor a text file, so this tool cannot copy it.`, isError: true };
  }

  let bytes: Buffer;
  try {
    // The version the malware scan read, never bytes written to the key since.
    bytes = await getObjectBytes({
      bucket: doc.s3Bucket,
      key: doc.s3Key,
      versionId: doc.s3VersionId,
      maxBytes: byName.kind === "docx" ? MAX_DOCX_BYTES : MAX_TEXT_BYTES,
    });
  } catch (err) {
    return { content: `Could not read "${doc.fileName}": ${describeExecError(err)}`, isError: true };
  }
  const byContent = detectFileKind({ bytes, mimeType: doc.mimeType, fileName: doc.fileName });

  if (byName.kind === "docx") {
    // Only a package that declares itself WordprocessingML goes to python-docx.
    if (byContent.kind !== "docx" || !isWordprocessingDocument(bytes)) {
      return {
        content: `"${doc.fileName}" is named as a Word document but its content is not a .docx (WordprocessingML) package, so it cannot be corrected in place.`,
        isError: true,
      };
    }
    return correctWordSource(data, ctx, doc, bytes);
  }

  if (byContent.kind !== "text") {
    return { content: `"${doc.fileName}" is named as a text file but its content is not text.`, isError: true };
  }
  const decoded = decodeTextSource(bytes);
  if (typeof decoded === "string") {
    return { content: `"${doc.fileName}" cannot be corrected in place: ${decoded}. Flag that to the author instead.`, isError: true };
  }
  const mime = (doc.mimeType ?? "").split(";")[0].trim().toLowerCase();
  return correctTextSource(data, ctx, {
    label: describeDocument(doc),
    text: decoded.text,
    encode: decoded.encode,
    extension: textExtension(doc.fileName),
    contentType: mime.startsWith("text/") ? mime : "text/plain",
  });
}

export const makeCorrectedCopyTool: SkillTool = {
  definition: {
    name: "make_corrected_copy",
    description:
      "Make the corrected copy (Workflow step 4) by applying your certain fixes to the author's own file, in its own format, and save it to the matter's documents. " +
      "Use it for a Word document (it changes only the text of each fix and keeps every other run, style, table, heading, caption and signature block, as references/file-handling.md requires; never rebuild a Word source with generate_document), for a text file, and for text pasted into the case note (source \"case_note\"). " +
      "Where the skill says to open the author's file, apply the substitutions and save it, or to save the corrected copy of a Word or text source, this tool is how; generate_document only builds new documents. " +
      "For a PDF or a scan, which cannot be edited in place, use generate_document for a new Word copy instead. " +
      "Pass only the fixes the report lists as Fixed; flagged items stay as the author wrote them. Each fix is located in the source by its original text (curly and straight quotes, and non-breaking and ordinary spaces, match each other) and only the characters that differ are changed. " +
      "Word sources: set tracked_changes true to record each fix as a tracked change the author can accept or reject, false to apply them directly. Only the text the extracted copy you were given contains is reachable; the result lists anything else in the file (text boxes, footnotes, comments, other headers) as not checked. " +
      "If any correction cannot be applied exactly (not found, ambiguous, overlapping), nothing is saved and every problem is listed. " +
      "Returns the copy's document_id and, per correction, how many times it was applied and where.",
    input_schema: toJsonSchemaObject(makeCorrectedCopyInputSchema) as Anthropic.Tool.InputSchema,
  },
  execute: executeMakeCorrectedCopy,
};
