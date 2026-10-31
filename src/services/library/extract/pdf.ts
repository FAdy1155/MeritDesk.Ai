import "server-only";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { Semaphore, readConcurrencySetting } from "@/services/queue/concurrency";
import { execUntrusted, readToolOutputHead, writeWorkFile } from "@/services/sandbox/untrusted-exec";
import { cleanText } from "../text";

// PDF text for library documents, without poppler: pdf.js (pdfjs-dist's
// legacy build) in a worker thread (./pdf-worker.mjs) with a wall-clock
// timeout, a heap cap (resourceLimits) and an empty environment, a few at a
// time per process. When pdf.js fails on a file and the worker image has
// poppler, the sandboxed pdftotext the upload ingest uses
// (src/services/sandbox/untrusted-exec.ts) is tried instead; on a machine
// without it the pdf.js error stands.
//
// The text keeps "[Page N]" markers, as the upload ingest's does, so a
// reader can cite pages. A PDF with no text layer (a scan; no OCR is run)
// comes back with text "" and pagesWithText 0.

export type PdfText = {
  text: string;
  pageCount: number;
  pagesRead: number;
  pagesWithText: number;
  /** Pages or characters beyond the caps were not read. */
  truncated: boolean;
  method: "pdfjs" | "pdftotext";
  ms: number;
  /** Why pdf.js was not used, when pdftotext was. */
  fallbackReason?: string;
};

export class PdfExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfExtractionError";
  }
}

function readSetting(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

const TIMEOUT_MS = readSetting("LIBRARY_PDF_TIMEOUT_SECONDS", 120, 5, 1800) * 1000;
const MEMORY_MB = readSetting("LIBRARY_PDF_MEMORY_MB", 512, 128, 4096);
const MAX_PAGES = readSetting("LIBRARY_PDF_MAX_PAGES", 3000, 1, 100_000);
/** Text kept per PDF; the rest is noted as not read. */
export const MAX_PDF_TEXT_CHARS = readSetting("LIBRARY_PDF_MAX_CHARS", 5_000_000, 10_000, 50_000_000);
const PDFJS_DIR = path.join(process.cwd(), "node_modules", "pdfjs-dist");
const WORKER_SCRIPT = path.join(process.cwd(), "src", "services", "library", "extract", "pdf-worker.mjs");

let slots: Semaphore | undefined;
function pdfSlots(): Semaphore {
  slots ??= new Semaphore("PDF text extraction", readConcurrencySetting({ env: "LIBRARY_PDF_CONCURRENCY", fallback: 1, max: 8 }));
  return slots;
}

type WorkerAnswer =
  | { ok: true; text: string; pageCount: number; pagesRead: number; pagesWithText: number; truncated: boolean }
  | { ok: false; error: string; name: string };

function runPdfjs(bytes: Buffer): Promise<WorkerAnswer> {
  return new Promise((resolve) => {
    // A copy the worker owns: transferring it leaves the caller's Buffer intact.
    const data = new Uint8Array(bytes.byteLength);
    data.set(bytes);
    const worker = new Worker(WORKER_SCRIPT, {
      workerData: { data, maxPages: MAX_PAGES, maxChars: MAX_PDF_TEXT_CHARS, pdfjsDir: PDFJS_DIR },
      transferList: [data.buffer],
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: MEMORY_MB, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 },
      stdout: true,
      stderr: true,
    });
    // pdf.js prints warnings about malformed files; they are not needed, but must be drained.
    worker.stdout?.resume();
    worker.stderr?.resume();
    let settled = false;
    const finish = (answer: WorkerAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(answer);
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: `pdf.js did not finish within ${TIMEOUT_MS / 1000} seconds`, name: "Timeout" }),
      TIMEOUT_MS
    );
    worker.on("message", (answer: WorkerAnswer) => finish(answer));
    worker.on("error", (err) =>
      finish({
        ok: false,
        error: (err as NodeJS.ErrnoException).code === "ERR_WORKER_OUT_OF_MEMORY" ? `pdf.js ran out of its ${MEMORY_MB} MB memory cap` : err.message,
        name: err.name,
      })
    );
    worker.on("exit", (code) => finish({ ok: false, error: `the pdf.js worker exited (code ${code})`, name: "Exit" }));
  });
}

async function runPdftotext(bytes: Buffer): Promise<{ text: string; truncated: boolean } | null> {
  if (process.env.LIBRARY_PDF_FALLBACK === "off") return null;
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "library-pdf-"));
  try {
    const input = await writeWorkFile(workDir, "document.pdf", bytes);
    const output = path.join(workDir, "document.txt");
    try {
      await execUntrusted("pdftotext", ["-layout", "-enc", "UTF-8", input, output], { workDir, timeoutMs: TIMEOUT_MS });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const maxBytes = MAX_PDF_TEXT_CHARS * 4;
    const { bytes: head, totalBytes } = await readToolOutputHead(output, maxBytes);
    const pages = head.toString("utf-8").split("\f");
    if (pages.length > 1 && pages[pages.length - 1].trim() === "") pages.pop();
    const text = pages.map((page, i) => `[Page ${i + 1}]\n${page.trim()}\n`).join("\n");
    return { text, truncated: totalBytes > maxBytes };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Extracts a PDF's text layer. Throws PdfExtractionError when neither pdf.js nor pdftotext can read it. */
export async function extractPdfText(bytes: Buffer): Promise<PdfText> {
  return pdfSlots().run(async () => {
    const started = Date.now();
    const answer = await runPdfjs(bytes);
    if (answer.ok) {
      return {
        text: cleanText(answer.text),
        pageCount: answer.pageCount,
        pagesRead: answer.pagesRead,
        pagesWithText: answer.pagesWithText,
        truncated: answer.truncated,
        method: "pdfjs",
        ms: Date.now() - started,
      };
    }
    let fallback: { text: string; truncated: boolean } | null = null;
    try {
      fallback = await runPdftotext(bytes);
    } catch (err) {
      throw new PdfExtractionError(
        `pdf.js could not read the PDF (${answer.error}), and neither could pdftotext (${err instanceof Error ? err.message : String(err)}).`
      );
    }
    if (!fallback) throw new PdfExtractionError(`pdf.js could not read the PDF: ${answer.error}.`);
    const pages = fallback.text.split(/^\[Page \d+\]$/m).length - 1;
    return {
      text: cleanText(fallback.text),
      pageCount: pages,
      pagesRead: pages,
      pagesWithText: fallback.text.split(/^\[Page \d+\]$/m).filter((p) => p.trim()).length,
      truncated: fallback.truncated,
      method: "pdftotext",
      ms: Date.now() - started,
      fallbackReason: answer.error,
    };
  });
}
