# Adding a skill to the Skill Runner

This is the exact recipe for wiring one of the firm's skills into the app.
Follow it literally. A skill is a self-contained change: you create files
that belong to that skill, and in at most two shared registries
(`skills/index.ts`, and `views/index.ts` if the skill gets a dedicated view)
you add one import line and one entry. You never edit `run.ts`,
`schemas.ts`, `SkillRunPanel.tsx`, `seed-skills.ts`, or another skill's files.

All paths below are relative to the repo root.

## 0. Checklist

For a skill named `<name>` (kebab-case, exactly the directory name under
`skills-content/`):

| # | File | Action | Required |
|---|------|--------|----------|
| 1 | `skills-content/<name>/SKILL.md` (+ `references/`, `assets/`, `scripts/`) | already present; do not edit | yes |
| 2 | `src/services/skill-runner/skills/<name>.ts` | create (the SkillModule) | yes |
| 3 | `src/services/skill-runner/skills/index.ts` | add 1 import line + 1 array entry | yes |
| 4 | `src/app/(app)/matters/[matterId]/views/<name>.tsx` | create (dedicated report view) | recommended |
| 5 | `src/app/(app)/matters/[matterId]/views/index.ts` | add 1 import line + 1 map entry | only with 4 |
| 6 | `src/services/skill-runner/tool-keys.ts` + `tools.ts` | add a tool key + implementation | only if the skill needs a tool that does not exist yet |
| 7 | run `npm run db:seed-skills` | inserts the skill's next version | yes, against each database |

Insert every registry line in **alphabetical order by skill name**, so two
skills added on parallel branches land on different lines.

If the skill needs a new Server Action or route handler under `src/app/(app)`
(a new form, a new download), its first line is
`await getCurrentEntitledTenant("<what it does>")` from `src/lib/tenant.ts`,
then `requireRole`: a firm whose free month or subscription has ended may
not change or read anything but the Billing page (README "Trial, billing
and emails", "The lock"). The worker already refuses to start a locked
firm's queued run, and the connector already hides its tools, so a skill
needs nothing more than that first line.

Two maps outside the skill runner name skills and are kept by hand from the
skills' own text. Add the new skill to them only when that text names it:
`src/lib/practice-profile/ripple.ts` (when its SKILL.md says "Read
PRACTICE_PROFILE.md for ..."; the editor shows which skills each profile
change reaches) and `src/services/monitoring/routing.ts` (when
`skills-content/eoir-weekly-update/references/routing.md` routes items to
it; its runs then get the RECENT LEGAL UPDATES section, 2.6).

## 1. Skill content (`skills-content/<name>/`)

`skills-content/` holds the canonical copy of every firm skill, taken
byte-for-byte from the firm's two Claude plugins (eoir-court-practice and
uscis-affirmative-practice), less the two files section 7 names as left
out on purpose. Do not edit SKILL.md or its references to make
the app work; adapt the app side instead. If the SKILL.md itself is wrong,
that is a change to the firm's plugin, made there first and copied here.

What the runner does with the directory (`src/services/skill-runner/skill-content.ts`):

- `SKILL.md` is the system prompt, verbatim (stored per version in
  `skill_definitions.skill_markdown` by the seed script).
- Every `references/*.md` file is inlined after SKILL.md, sorted by file
  name, each under a `# references/<file>.md` heading. Only `.md` files
  directly in `references/` are inlined. Nothing in `assets/` or `scripts/`
  is sent to the model.
- The tenant's active Practice Profile (rendered Markdown) is appended
  as `# PRACTICE_PROFILE.md`, then the tenant's `# FIRM IDENTITY` section
  last (see 2.8). `skills-content/_shared/PRACTICE_PROFILE.template.md`
  is the plugin's blank template, kept for reference only; the app does not
  read it.
- Line endings are normalized to LF before prompting and hashing.

There is no file-read tool. When a SKILL.md says "read references/x.md",
that file is already in the prompt. When it says to build a Word file
(python-docx, "save the .docx") or to "render with soffice", give the skill
`generate_document` and `render_and_qa_docx` (2.3); when it says "run
assets/foo.py" for a firm-specific generator, wrap that script as its own
tool (step 6). When it says `web_search` / `web_fetch`, give it
`serverTools` (2.4).

Before wiring, confirm the copy is free of the encoding artifacts earlier
exports had (double-encoded non-breaking spaces and dashes, which show up
as an A-circumflex, or an a-circumflex followed by a euro sign). In bash:

```bash
LC_ALL=C grep -rlE $'\xc3\x82|\xc3\xa2\xe2\x82\xac' skills-content/<name>   # must print nothing
```

## 2. The SkillModule (`src/services/skill-runner/skills/<name>.ts`)

The interface (from `src/services/skill-runner/skills/types.ts`):

```ts
export type SkillCategory = "asylum" | "eoir" | "uscis" | "general";
export type SkillKind = "review" | "build" | "research";

export type SkillModule<TSchema extends z.ZodType = z.ZodType> = {
  name: string;                       // === skills-content/<name>/ directory name
  label: string;                      // run button text, e.g. "Run packet review"; the run list shows it without a leading "Run"
  category: SkillCategory;            // group in the skill picker on the matter page
  kind: SkillKind;
  description: string;                // one sentence; shown under the label in the skill picker and the run form
  outputSchema: TSchema;              // submit_report input schema (see 2.1)
  extractEscalationFlags(output: z.infer<TSchema>): string[];   // see 2.2
  tools: readonly ToolKey[];          // extra tools beyond submit_report (see 2.3)
  serverTools?: readonly ServerToolConfig[];  // web_search / web_fetch, run by the API (see 2.4)
  maxTokens?: number;                 // per-turn output cap; default 64000, max 128000 (see 2.5)
  maxIterations?: number;             // model requests per run; default 12, max 40 (see 2.5)
  needsNote?: boolean;                // show the case note box in this skill's run form
  notePlaceholder?: string;           // "Case note for <label> (optional): <what to include>"; the run form shows the part after the colon as help text above the note box
  applicableCaseTypes?: readonly MatterCaseType[];  // omit = any matter
};

export type ServerToolName = "web_search" | "web_fetch";
export type ServerToolConfig =
  | ServerToolName
  | {
      name: ServerToolName;
      allowedDomains?: readonly string[];  // bare hostnames; web_search entries may add a path
      blockedDomains?: readonly string[];  // never together with allowedDomains
      maxUses?: number;                    // per API request (1-50); defaults 8 and 8
      maxContentTokens?: number;           // web_fetch only; default 30000
    };
```

`MatterCaseType` is one of the values in `src/lib/matters/case-types.ts`:
`asylum_affirmative`, `asylum_defensive`, `withholding_cat`, `cancellation`,
`vawa`, `i130`, `i90`. On matters of other types it only moves the skill
under Other skills; it never blocks a run. If a skill needs a case type that
does not exist, add it to that file (one line) rather than leaving the field
off.

Choosing the fields:

- `category`: `eoir` for Immigration Court / BIA work (pleadings, motions,
  merits briefs, bench memos, direct exam, filing compliance, fee packets);
  `uscis` for USCIS filings (I-130, AOS, I-90, VAWA); `asylum` for asylum
  skills used in both forums and for Asylum Office interview work;
  `general` for skills that are not tied to a case type (orthography-check).
- `kind`: `review` if the skill audits something that exists (a packet, a
  motion, a filing); `build` if it drafts or assembles something new (a
  letter, a declaration, a brief, a packet); `research` if its product is
  sources or authorities (country-conditions-research,
  legal-argument-research).
- `label`: imperative, starting with "Run" for reviews and "Build" or
  "Draft" for builds, matching the existing buttons.
- `description`: one plain sentence saying what the skill produces. Take it
  from the SKILL.md frontmatter `description` or the plugin README; do not
  invent claims.
- `needsNote`: true when the SKILL.md's first step asks the attorney for
  facts or confirmations that will not be in the uploaded documents (the
  venue and circuit, the relief to evaluate, an intended filing date, a
  safety concern). Write the placeholder as "Case note for <label>
  (optional): <what to include>." and keep new ones under 350 characters.
  Never ask in the note for another skill's report: give the skill
  `read_prior_skill_reports` (2.3). The catalog strips the lead-in and
  shows the rest as visible help text, so write it as complete
  instructions.

Template (copy this, then fill it in):

```ts
import { z } from "zod";
import { defineSkill } from "./types";

// Mirrors skills-content/<name>/SKILL.md "<exact output heading>", items 1-N.
export const <camelName>OutputSchema = z.object({
  // one key per numbered output item, in SKILL.md order (see 2.1)
});
export type <PascalName>Output = z.infer<typeof <camelName>OutputSchema>;

export const <camelName> = defineSkill({
  name: "<name>",
  label: "Run <thing>",
  category: "uscis",
  kind: "review",
  description: "<one sentence>",
  outputSchema: <camelName>OutputSchema,
  extractEscalationFlags: (output) => output.escalationFlags,
  tools: [],
  applicableCaseTypes: ["i90"],
});
```

Hard rules for this file:

- Import only `zod`, `./types`, and types. **Never** import `tools.ts`,
  `run.ts`, `@/db/*`, `@/lib/*` services, or anything with `"server-only"`.
  The registry is loaded by the seed script under plain Node and its
  catalog feeds the browser UI.
- Always wrap the object in `defineSkill(...)`. It keeps `name` as a literal
  type, which is how `SupportedSkillName` and `SkillOutput<"<name>">` work.
- `name` must not collide with an existing skill; the registry throws at
  import time if two modules share a name.

### 2.1 How `outputSchema` must mirror the SKILL.md output section

The model returns its result by calling a `submit_report` tool whose
`input_schema` is `z.toJSONSchema(outputSchema)`; the runner rejects any
call that fails `outputSchema.safeParse` and asks the model to retry. The
schema is therefore the contract, and it must say what the SKILL.md already
says, not something new.

1. Find the section that defines the deliverable: its heading is usually
   "Output format", "Report format", "Output", "Deliverables", "SECTION n.
   OUTPUT", or, in skills like eoir-motion-self-review and
   eoir-filing-compliance, the report template inside the "Report" /
   "Write the report" step. Quote that heading exactly in the comment line
   above the schema.
2. **One top-level key per numbered (or bulleted) item, in the same order.**
   The key is the item's bold title in camelCase: "Element scorecard" ->
   `elementScorecard`, "Bars & escalation flags" -> `barsAndEscalationFlags`.
   Do not merge, split, rename, or reorder items, and do not add keys the
   section does not list.
3. **Tables become arrays of objects, one property per column, in column
   order**, named from the column headers: `Element | Rating | Basis` ->
   `z.array(z.object({ element, rating, basis }))`. One exception: in a
   research skill (`serverTools`), every object describing a web source
   also carries `url` (if the table has no URL column) and `retrievedAt`
   (see the research example in 2.7).
4. **Fixed labels become `z.enum` with the SKILL.md's exact labels**
   (spaces -> underscores, case preserved): `GREEN/YELLOW/RED`,
   `BLOCKER | MATERIAL | POLISH`, `ESTABLISHED | THIN | NOT ESTABLISHED` ->
   `"NOT_ESTABLISHED"`, "Blocking -> Strongly recommended -> Optional" ->
   `"blocking" | "strongly_recommended" | "optional"`. Use `z.string()` when
   the SKILL.md gives no closed list.
5. **Lists of findings, questions, or steps become `z.array(z.string())`**
   unless the SKILL.md gives each entry named parts ("issue | location |
   recommended edit"), in which case each entry is an object with those parts.
6. **Every citation list is an array of objects with `citation: z.string()`
   and `verified: z.boolean()`** plus whatever else the SKILL.md attaches
   ("why"). `verified` is true only for authority actually confirmed in the
   run (fetched, or quoted from a bundled reference); everything else is
   false, which the UI shows as "unverified". In a skill with web tools, add
   `url: z.string().optional()` (the page the authority was confirmed on,
   exactly as retrieved), so the matter page can match it against the run's
   verification log. The skills never invent
   citations, and the schema must not pressure them to: no `min(1)` on
   citation arrays.
7. Make a field `.optional()` only where the SKILL.md says "if known", "if
   any", "where applicable", or the item clearly may not exist (e.g. a
   second ground). Use `.nullable()` for a yes/no the skill may be unable
   to determine. Everything else is required.
8. Keep the schema JSON-Schema-friendly: no `.default()`, `.transform()`,
   `.refine()`, `.preprocess()`, unions of objects, or recursive types.
   `.min()`/`.max()` on numbers and `.describe()` are fine.
9. If the deliverable is a document (letter, declaration, brief, memo,
   question set, packet), it is produced by a generator tool
   (`generate_document`, or a skill-specific `generate_docx_*`), and the
   schema carries the returned document id plus the report items that
   surround it. Never put the drafted document's text in a report field:
   the report is a structured summary, and the attorney opens the Word file.
   **Name every such field `generated<Something>DocumentId` (one id) or
   `generated<Something>DocumentIds` (an array)**, at any depth, e.g.
   `generatedDocumentId`, `generatedLetterDocumentId`. The runner rejects a
   report whose `generated...DocumentId(s)` values are not documents a
   generator tool produced in that run (a fabricated or stale id), and
   accepts an empty string, which means "no document could be generated";
   the report must then say why. A view must hide its download button when
   the id is empty (see `i130-expedite-build.tsx`).
10. Work-product headers, "plain ASCII" rules, file names, and "present the
    file" instructions in the SKILL.md are presentation, not fields. The UI
    prints the work-product header itself.

Examples to copy from: `claim-evaluation.ts` (numbered list + table),
`packet-review.ts` (nested object + priority checklist),
`vawa-packet-review.ts` (12-item output with enums and per-element defects),
`i130-expedite-build.ts` (build skill with a generated document and tools).

When a SKILL.md changes later, re-read its output section and update the
schema and view in the same change. Old runs keep rendering: the matter
page validates each stored output against the current schema and falls back
to the generic layout when it no longer matches.

### 2.2 `extractEscalationFlags`

Returns the strings stored in `skill_runs.escalation_flags`: the items the
SKILL.md routes to the supervising attorney. Use, in order of preference:
an `escalationFlags: string[]` item if the output has one
(`(output) => output.escalationFlags`); a flags item with objects
(`(output) => output.barsAndEscalationFlags.map((f) => f.flag)`); the
blocking tier of a QA report (`(output) => output.qaReport.blocking`). If
the output has none of these, return `[]`. The argument is already
validated against `outputSchema`, so no null checks are needed.

When the output has both an escalation list and a separate blocking list
(the packet reviews' "Blocking issues"), return both, the blocking items
prefixed `BLOCKING: ` (i90-packet-review, packet-review, aos-packet-review).
Safety flags lead (vawa-packet-review's SAFETY, CONFLICT and 1367 flags,
then a DO NOT FILE verdict), and a build that runs a review as its QA gate
extracts that review's flags the same way the review does on its own
(vawa-packet-build). A build whose generated document id is empty flags the
missing document first. Deduplicate with a `Set`.

### 2.3 `tools` and the available tool keys

`tools` lists keys from `src/services/skill-runner/tool-keys.ts`. These are
client tools: the app runs them. The runner always adds `submit_report`
itself; never list it. Keys available today:

| Key | Model sees it as | What it does | Needs on the worker |
|-----|------------------|--------------|---------------------|
| `build_fee_packet` | `build_fee_packet` | Runs `src/services/docx-generator/templates/asylum-fee-proof-packet/fee_packet.py` (the multi-tenant copy of the skill's `scripts/fee_packet.py`, CLI `read` / `build`): reads the receipt, refuses a config whose A-number, tracking ID, payment date, amount or fee kind differs from it, then builds the filing-ready PDF and the editable Word file from the receipt and order PDFs on the matter (malware-clean only, named by document id or file name), with the counsel block and signer filled server-side from the firm identity (2.8) and the signature from `getSignerSignature` (else `/s/`; `wet_signature` leaves it blank). Stores both as `generated_draft` documents (`firm_signature.applied` recorded for each when the image is used) and returns both ids plus the script's report. asylum-fee-proof-packet only. | python3 + python-docx, pdfplumber, Pillow, numpy, reportlab; soffice, pdftoppm, qpdf |
| `eoir_judge_profile` | `eoir_judge_profile` | Read-only (`src/services/library/adapters/eoir-statistics/tools.ts`). One immigration judge's record in the app's EOIR statistics (aggregates the worker computes from EOIR's public case data release, migration 0008): completions and outcomes by fiscal year, asylum, withholding and CAT decisions against the court and the nation, Board appeals and processing times, each rate with its denominator and small numbers flagged, the snapshot (release and data date), the definitions used, and that rates describe historical outcomes and do not predict a case. Written to the verification log (`library`, the release's official URL). | database |
| `fetch_ecfr_section` | `fetch_ecfr_section` | The current text of one CFR section, read through the eCFR's versioner API (www.ecfr.gov/api/versioner/v1 only; the eCFR's web pages turn automated clients away). Every call is written to the run's verification log. | network |
| `fetch_uscis_page` | `fetch_uscis_page` | Fetches an https page on uscis.gov (egov.uscis.gov included, where USCIS posts processing times), justice.gov (EOIR), or travel.state.gov and returns its text (HTML and plain text only; PDFs are refused, `web_fetch` reads them). Redirects are followed by hand, at most 5, each checked against the same list. Every call is written to the run's verification log by the app, not the model. | network |
| `fill_pdf_form_packet_build` | `fill_pdf_form` | Fills the blank fillable I-589 with `templates/packet-build/pdf_form.py`: the attorney's upload (clean, read at its scanned version), otherwise the current form linked from https://www.uscis.gov/i-589, downloaded (logged with its hash) and scanned with ClamAV before use (`downloadBlankForm` in `tools/shared/uscis-forms.ts`, shared by the three form tools; the scan is `runClamScan` in `src/services/ingest/clamav.ts`, the upload scan's own). Every entry is checked against the form before anything is written; signature fields are never filled; the form stays fillable. Part E preparer values come from the firm identity (`preparer.fields`), and typed firm or roster details are refused. Stores the filled PDF as a `generated_draft` with page images for `render_and_qa_docx`. packet-build only. | python3 + pypdf, pdftoppm, clamscan, network (uscis.gov) |
| `fill_pdf_form_vawa` | `fill_pdf_form` | The same for the blank I-360, I-485 or I-765 (`templates/vawa-packet-build/pdf_form.py`; download from that form's uscis.gov page). Preparer and firm details are `firm_values` the server fills from the firm identity (the address and name splits and the typed-value check in `tools/shared/firm-values.ts`, shared with the I-90 tool); bracketed flags, non-ASCII text, signature and date-of-signature fields are refused. vawa-packet-build only. | (as above) |
| `fill_uscis_form_pdf_i90` | `fill_uscis_form_pdf` | `action: "inspect"` then `"fill"` on the official fillable I-90 or G-28 (`templates/i90-packet-build/fill_uscis_form.py`), from uscis.gov (downloaded, logged and ClamAV-scanned as above) or a clean upload. Representative and preparer fields take a `firm_value` the server fills from the firm identity (`tools/shared/firm-values.ts`); typed firm or roster details are refused; signature fields are never filled. i90-packet-build only. | (as above) |
| `generate_document` | `generate_document` | The generic, firm-neutral Word builder. Input `{ file_name, spec }`; the spec (`documentSpecSchema` in `src/services/skill-runner/document-spec.ts`) has a title, the firm's letterhead (`firm_letterhead: true`, filled server-side from the firm identity, never typed), optional counsel block with `top_right_lines` level with it (a detention status), court heading lines, caption (simple lines, or a two-column "In the Matter of" table) and `after_caption_lines` (judge and hearing), sections with headings, `page_break_before` and `repeat_caption` (a brief's first text page after its cover), and blocks (`paragraph` with style body / quote / indented and an optional `first_line_indent`, `numbered` with `start`, `bulleted`, `table`, `page_break`, `signature`, `spacer`), footer text, font, size, line spacing, page numbers, a confidentiality banner, a `plain_ascii` gate, and a `forbid_typographic_punctuation` gate (dashes and curly quotes only, so a section sign passes). Defaults: Times New Roman 12, 1 inch margins, justified body, 0.5 inch first-line indent, centered page numbers. Inline `**bold**`, `*italic*`, `__underline__`. Runs `src/services/docx-generator/templates/make_document.py`, stores the .docx on the matter as a `generated_draft` document, renders page images, and returns the document_id. Use it for every drafting skill that has no generator script of its own. | python3 + python-docx, soffice, pdftoppm |
| `generate_docx_eoir_pleadings` | `generate_docx` | Runs `src/services/docx-generator/templates/eoir-written-pleadings/make_pleadings.py` (the multi-tenant copy of the generator embedded in the skill's SKILL.md) on the Step 4 config the model writes; the counsel block, the signature block and the name in the certificate of service are filled server-side from the firm identity (2.8). The signature line is the firm's bare line for ink by default; `apply_signature: true` (only when the attorney's note asks) puts the signer's image from `getSignerSignature`, else `/s/`. Stores the .docx as "Written Pleadings - <Surname>.docx" and renders page images. eoir-written-pleadings only. | python3 + python-docx, soffice, pdftoppm |
| `generate_docx_i130` | `generate_docx` | Runs `src/services/docx-generator/templates/i130-expedite/make_expedite_letter.py` (the multi-tenant copy of the skill's `assets/make_expedite_letter.py`) on the letter content the model writes, with the letterhead and signer filled in server-side from the firm identity (2.8), stores the .docx as a matter document, renders page images. i130-expedite-build only. | (as above) |
| `list_pdf_form_fields_packet_build` | `list_pdf_form_fields` | Lists the blank I-589's fields (qualified name, type, page, tooltip, limits, states, options) and the edition printed on it, from the same sources as `fill_pdf_form_packet_build` (the run reuses a download). packet-build only. | python3 + pypdf, clamscan, network (uscis.gov) |
| `list_pdf_form_fields_vawa` | `list_pdf_form_fields` | The same for the blank I-360, I-485 or I-765. vawa-packet-build only. | (as above) |
| `load_companion_skill_packet_build` | `load_companion_skill` | Returns the latest seeded SKILL.md (and any references that differ from the build's own) of claim-evaluation, declaration-draft, country-conditions-research, evidence-organizer, brief-draft or packet-review, for the build step packet-build's Build order says to invoke it in (`tools/companion-skills.ts`). | database |
| `load_motion_references_legal_argument_research` | `load_motion_references` | Returns the reference files of eoir-motion-self-review (motion-elements.md, icpm-mechanics.md) and eoir-filing-compliance (icpm-checklist.md, bia-checklist.md) that legal-argument-research's `references/eoir-motions.md` points to, as each skill's latest seeded version stores them, with notes that keep every authority in them unverified until retrieved. | database |
| `load_qa_gate_skill_asylum_interview_prep` | `load_qa_gate_skill` | Returns asylum-interview-prep-review's latest seeded SKILL.md (version and content hash in the result), so the build's "Then run the QA gate" step runs under the review skill's own text in the same run (`createQaGateSkillTool` in `tools/companion-skills.ts`). asylum-interview-prep-build only. | database |
| `load_qa_gate_skill_i90_packet_review` | `load_qa_gate_skill` | The same for i90-packet-review (i90-packet-build's SECTION 8 QA gate). | database |
| `load_qa_gate_skill_orthography_check` | `load_orthography_check_skill` | The same for orthography-check (vawa-packet-build's Step 10 orthography pass). | database |
| `load_qa_gate_skill_vawa_packet_review` | `load_vawa_packet_review_skill` | The same for vawa-packet-review (vawa-packet-build's Step 10 QA gate). | database |
| `lookup_library_citation` | `lookup_library_citation` | Read-only (`tools/library.ts`). One citation (I&N Dec. with a pin page, Interim Decision numbers, U.S., F., F.2d, F.3d, F.4th, F. App'x, F. Supp., U.S.C., C.F.R., INA sections, Fed. Reg., AAO decision IDs, or a case name) looked up in the app's library of official sources (`src/services/library/`, `docs/LIBRARY.md`): the exact match, else the decision whose first page precedes a pin page, else similar citations and titles flagged as not exact; each with its document id, official URL, precedential status, how many library documents cite it, and when its source was last refreshed (STALE when overdue). Written to the verification log (`library`, action `lookup`). | database |
| `make_corrected_copy_orthography` | `make_corrected_copy` | orthography-check's corrected copy. Applies the run's certain fixes to the author's own file in place: a clean Word document on the matter (`templates/orthography-check/apply_corrections.py` changes only the text of each fix, directly or as tracked changes by "Orthography check", then the copy is rendered for `render_and_qa_docx`), a clean text file (same encoding and extension), or text pasted into the case note (.txt). The source is "Document N" (its label's number), its file name, or its id; a file name shared by two clean documents is refused with each one's number. If any fix cannot be located exactly, nothing is saved. orthography-check only. | python3 + python-docx, soffice, pdftoppm (Word sources) |
| `query_eoir_stats` | `query_eoir_stats` | Read-only (same module). EOIR statistics by measure (completions, applications, appeals, processing) with filters (judge, court, nationality, case type, custody, representation, application, appeal type, fiscal years) and one grouping; a combination the aggregates do not hold is refused, never estimated. Every result states the snapshot, filters, denominators and definitions. Written to the verification log (`library`). | database |
| `read_library_document` | `read_library_document` | Read-only (`tools/library.ts`). A library document by id: title, citations, court or agency, dates, precedential status (unpublished BIA and AAO decisions labeled NON-PRECEDENTIAL), the source's own headnote or summary, and up to 40,000 characters of its text per call (`offset` to read on), with the official URL to cite and the source's last refresh. Written to the verification log (`library`, action `read`, with the character range). | database |
| `read_prior_skill_reports` | `read_prior_skill_reports` | Read-only (`tools/prior-skill-reports.ts`). Input `{ skill_names?, include_failed? }`: for the run's own tenant and matter only (`withTenantContext` plus tenant and matter filters; never the asking run), the latest completed run of each named skill, or of every skill that has one: run id, skill name and version, completion time, escalation flags, the documents that run read (from its `input_snapshot.documentInput`), a note when its stored report no longer matches the current schema, and the structured output as JSON, cut at 60,000 characters per report when several are returned and 120,000 per call, with a note naming the cut. `include_failed: true` adds the failure message when a skill's newest run failed. A report returned in full is not resent later in the run. The result tells the model a report is work product, not evidence, that an authority it marks verified is unverified in this run until re-confirmed, and that a drafted document is in the inventory, not the report. | database |
| `render_and_qa_docx` | `render_and_qa_docx` | Returns page images (at most 20 per call; `first_page` / `last_page` for more) of a document generated earlier in the run (a Word file, or a PDF a form or packet tool produced), or of any malware-clean Word document already on the matter, by the `document_id` the run's document inventory lists. Use with a generator key, or alone in a review skill that must see a Word file's layout. | soffice, pdftoppm |
| `search_eoir_judges` | `search_eoir_judges` | Read-only (same module as `eoir_judge_profile`). Immigration judges in the EOIR statistics by name or EOIR judge code and court code, with EOIR's judge code to pass to `eoir_judge_profile`. Written to the verification log (`library`). | database |
| `search_library` | `search_library` | Read-only (`tools/library.ts`). Full-text search of the library (websearch syntax, or a citation, which puts its document first) with group, source, date, precedential-only, court and country filters (country matches the country conditions reports, TPS designations and other documents filed by country); 10 results per call with a snippet, official URL and the source's last refresh. Each result is written to the verification log as `library_search` (seen, not read). | database |

Give `search_library`, `lookup_library_citation` and `read_library_document`
(in that order, after the skill's other keys) to every skill that
researches or cites law: they read the app's own copy of the official
sources (decisions, statutes, regulations, manuals, guidance), refreshed
daily, with nothing about the case leaving the app. The runtime notes
(2.6) tell the model to prefer them over web search for anything the
library holds, to cite the official URL, to label unpublished BIA and AAO
decisions non-precedential and to say when a source is stale. A
report-only skill on the default 12 requests gets `maxIterations` 16 for
the lookups and reads. They do not replace `web_fetch` for what the
library does not hold yet (`/library` shows which groups are collected).

Give `search_eoir_judges`, `eoir_judge_profile` and `query_eoir_stats`
(after the library tools) to a skill that prepares for or evaluates a case
before a particular immigration court or judge. Their runtime note (2.6)
tells the model to give the snapshot and the denominator with every rate,
to keep the filters the result states, and never to present a judge's rate
as a likelihood for the client's case. They have no data until the worker
has loaded EOIR's case data release (`/library/eoir-statistics` shows the
snapshot), and they say so.

Use `fetch_uscis_page` for any skill whose SKILL.md has a run-time
verification step against those sites (EOIR practice manual pages live on
justice.gov and are covered; USCIS's posted processing times live on
egov.uscis.gov, a page built by script, so its fetched text may not carry
the times and the check can come back unconfirmed), and
`fetch_ecfr_section` for a step that checks a regulation's current text.
For anything wider (country conditions, case law, PDFs such as decisions
and fee rules), give the skill the server-side web tools (2.4), not a
broader fetch tool.

Where a SKILL.md says to build on another skill's output if it exists
("Where earlier skills have run, pull their output", "Pull the element
analysis from claim-evaluation if it exists", a hand-off such as
country-conditions-research's "Hand the raw material to evidence-organizer
next"), give it `read_prior_skill_reports`, and do not ask for those
results in the case note. The tool returns the earlier runs' reports on the
same matter; a Word document an earlier run generated is a matter document
and already reaches the run through its document inventory. This is
different from a QA gate or a companion step (next paragraph), which runs
the other skill's instructions inside this run.

Where a SKILL.md says to run another firm skill as one of its steps (a QA
gate over its own output, or a companion for one build step), do not chain
runs: give it a loader built with `createQaGateSkillTool` in
`src/services/skill-runner/tools/companion-skills.ts` (one key per
build/review pair, as the `load_qa_gate_skill_*` keys above). It returns
the other skill's latest seeded SKILL.md, and the model performs that step
in the same run and puts its result in its own report. The other skill
must be registered and seeded; until it is, the tool returns an error and
the model performs the step from its own SKILL.md and flags it.

A skill whose SKILL.md says to "build the .docx with python-docx", "save the
file", "convert to PDF and look at every page", or "present the file" needs
`generate_document` plus `render_and_qa_docx`. The runner adds a short
"How this app runs the skill" section to the system prompt (2.6) that maps
those instructions onto the tools, so the SKILL.md itself never changes.

Adding a new tool (only when the skill needs one that does not exist):

1. Add the key to `TOOL_KEYS` in `src/services/skill-runner/tool-keys.ts`
   (alphabetical, with a one-line comment).
2. Add the implementation to `TOOL_REGISTRY` in
   `src/services/skill-runner/tools.ts` (alphabetical). The registry is
   typed `Record<ToolKey, SkillTool>`, so a key without an implementation
   fails `tsc`.
3. For a skill's bundled Python generator, do not hand-write a tool; use
   the factory:

   ```ts
   // in tools.ts
   const generateFooDocxTool = createDocxGeneratorTool({
     toolName: "generate_docx",                       // what the model calls
     description: "Generate the <document> as a .docx from a JSON spec. Returns a document_id; call render_and_qa_docx with it before finalizing your report.",
     specSchema: fooSpecSchema,                       // zod object, exported from skills/<name>.ts
     scriptPath: "<name>/scripts/<script>.py",        // relative to skills-content/
     // or, for an adapted copy of a firm script (see 2.8):
     // templatePath: "<name>/<script>.py",           // relative to src/services/docx-generator/templates/
     // completeSpec: completeFooSpec,                // fills letterhead/signer server-side (2.8)
     outputFileName: "<File_Name>.docx",
   });
   // TOOL_REGISTRY entry: generate_docx_<short-name>: generateFooDocxTool,
   ```

   The script is invoked as `python3 <script> <spec.json> <output.docx>`
   (see `runPythonDocxGenerator` in
   `src/services/docx-generator/generate.ts`). It runs sandboxed
   (`src/services/sandbox/untrusted-exec.ts`): no network, no secrets in its
   environment, and on the worker as an unprivileged user that can write
   only its own work directory, so a generator must not fetch anything or
   read configuration from the environment. If the firm's script has a
   different command line, add a small wrapper script next to it under
   `skills-content/<name>/scripts/` rather than editing the firm's script,
   and say so in your change. Mirror the script's spec as a zod schema in
   the skill module (as `i130ExpediteLetterSpecSchema` does) and add any
   new Python dependency to `requirements.txt`. A script that hard-codes
   the firm's letterhead, signer or signature is not used as is: follow 2.8
   (an adapted copy under `templates/`, `templatePath`, `completeSpec`).
4. Two tools with the same model-facing name cannot be in one skill's
   `tools` list (`getSkillTools` throws), so each skill uses at most one
   `generate_docx_*` key.
5. A tool whose results contain images counts toward the API's per-request
   image rules together with the matter's attached images (20 images of any
   size, more only if every image is at most 2000 px per side). Add any new
   image-returning key to `IMAGE_RETURNING_TOOL_KEYS` in `tools.ts`: the
   runner then keeps `RESERVED_TOOL_IMAGE_SLOTS` free when attaching matter
   images and gives the run an image budget (`ctx.toolImages`, at most 60
   images) that the tool must respect, as `render_and_qa_docx` does. Such
   a skill also gets a smaller share of the 32 MB request for matter
   attachments, and the tool must add each image's base64 size to
   `ctx.requestBytes.used` and stop before it passes
   `ctx.requestBytes.limit`: everything a tool returns is resent with every
   later request of the run.
6. A client tool's input streams to the runner unvalidated by the API
   (the runner sets `eager_input_streaming` on every client tool), so
   `execute` must validate its input (zod `safeParse`, as
   `generate_document` does) and return `isError: true` with the message
   on a bad input.

Do not add a tool for reading the matter's uploads. Every run's first
message already carries them (`src/services/skill-runner/document-input.ts`):
PDFs and images natively, other files as extracted text, each labeled with
its file name, plus an inventory that gives each document's `document_id`
(the id `render_and_qa_docx` and the other tools that take a matter document
accept), marks anything left out as NOT REVIEWED or EXCLUDED, and tells the
model to report those as not reviewed. A schema with a field for missing
evidence, open items, or review limits gives the model a place to put them.
A tool that reads a matter document itself (a form filler, a packet
builder) reads it through `withTenantContext` with the tenant and matter
filters, only when its `malware_scan_status` is `clean`, and at its scanned
`s3_version_id`. A new form tool reuses `tools/shared/uscis-forms.ts`
(`findMatterDocument`, `downloadBlankForm`, which fetches, logs and
ClamAV-scans a blank form and fails closed, and the file helpers),
`tools/shared/firm-values.ts` (the firm's address and the signer's name
split for a form, the typed-value check) and `tools/shared/request-bytes.ts`
(`chargeRequestBytes`), rather than copying them; the ClamAV run itself is
`runClamScan` in `src/services/ingest/clamav.ts`, which the upload scan
uses too.

Python, LibreOffice, and pdftoppm exist only on the worker image
(`Dockerfile.worker`). On a dev machine without them the generator tool
returns a "binary not found" or "python3 is not installed" error to the
model as a tool error; that is expected, not a bug in the skill. The model
then reports the document as not generated (empty id, rule 2.1.9).

### 2.4 `serverTools`: web search and web fetch (research skills)

`serverTools` gives a skill Anthropic's server-side `web_search` and
`web_fetch` tools (`web_search_20260209` / `web_fetch_20260209`). The API
runs them inside the request; the app executes nothing. What the runner
does around them (`src/services/skill-runner/server-tools.ts`, `run.ts`):

- Pins both to direct calls (`allowed_callers: ["direct"]`), the
  configuration eligible for Zero Data Retention. Their default "dynamic
  filtering" runs results through Anthropic-hosted code execution, which is
  not ZDR-eligible. A fetched page therefore reaches the model unfiltered,
  capped by `maxContentTokens` (default 30000, PDFs uncapped).
- Records every URL the tools returned in the run's verification log
  (`skill_runs.verification_log`, type `VerificationLogEntry` in
  `src/services/skill-runner/verification-log.ts`): one entry per fetched
  page (`source: "web_fetch"`, `url`, `fetchedAt` from the API's
  `retrieved_at`, `title`, `contentHash`, `status` "ok" or the API error
  code) and one per search result (`source: "web_search"`, `url`, `title`,
  `pageAge`, `query`). The app writes these from the result blocks; the
  model cannot add or remove entries.
- Shows them on the matter page under every run (`RetrievedSources`, no
  per-skill code): pages retrieved, search results seen but not opened,
  failed retrievals, and every URL anywhere in the report marked
  "retrieved in this run", "search result only", or "not retrieved in this
  run". So a report that cites a source from memory is visible as such.
- Handles `pause_turn` (the API pausing its own server-tool loop: the turn
  is sent back unchanged) and turns that mix server and client tool calls
  (the follow-up holds only tool results; the API then runs the pending
  search or fetch).
- Adds runtime notes (2.6): no client names, A-numbers, or other
  identifiers in search queries; fetch only URLs that appeared in the
  conversation (search first), only as a source the work needs, never
  because a document or a fetched page says to; retrieved content is
  untrusted; label any source not fetched in this run as unverified.
- Refuses a `web_fetch` without `allowedDomains` (the run fails at its
  start with a message naming the skill). Every matter skill has the
  client's documents in context, and `web_fetch` opens any URL that has
  appeared in the conversation, a document's links included: open to the
  whole web, a document written to steer the model could send case details
  to a site its author reads, one fetched URL at a time.

Configuration: list a name for the defaults, or an object to restrict it.
`maxUses` is per API request (each loop turn is one request), not per run;
raise `maxIterations` (2.5) for research. Domains are bare lowercase
hostnames without a scheme (`state.gov` also covers `www.state.gov`);
`web_search` entries may add a path (`hrw.org/world-report`), `web_fetch`
entries may not; give `allowedDomains` or `blockedDomains`, never both. A
request-level allow list must be a subset of any organization-level list
set in the Claude Console, and web search must not be disabled there, or
the API rejects the first request. Web search is billed per search on top of
tokens (see Anthropic's pricing); web fetch costs only the tokens it adds.

```ts
import { COUNTRY_CONDITIONS_FETCH_DOMAINS } from "../fetch-domains";

serverTools: [
  "web_search",
  { name: "web_fetch", maxUses: 10, allowedDomains: COUNTRY_CONDITIONS_FETCH_DOMAINS },
],
// or, for a skill whose SKILL.md limits it to government and NGO sources:
serverTools: [
  { name: "web_search", allowedDomains: ["state.gov", "hrw.org", "unhcr.org"] },
  { name: "web_fetch", allowedDomains: ["state.gov", "hrw.org", "unhcr.org"] },
],
```

Restrict `web_search` only when the SKILL.md itself restricts sources:
most firm skills read their accepted sources from the practice profile,
and a search result on any site can still be cited (the verification log
marks it as a search result, not retrieved). `web_fetch` always takes a
list: the sources the SKILL.md names when it names them, otherwise
`LEGAL_AUTHORITY_FETCH_DOMAINS` (statutes, regulations, agency guidance,
court decisions), `COUNTRY_CONDITIONS_FETCH_DOMAINS` (government,
intergovernmental, NGO and major press reporting) or
`RESEARCH_FETCH_DOMAINS` (both) from
`src/services/skill-runner/fetch-domains.ts`. A firm that relies on a
source those lists leave out adds its host there.

### 2.5 `maxTokens` and `maxIterations`

Every model turn is streamed with `max_tokens` = `maxTokens` (default
64000, at most 128000), thinking included. A turn that hits the limit is
discarded, never read as a report or run as a tool call, and the model is
told to take it again within the limit (at most twice; a third time fails
the run with a message naming `maxTokens`). A drafting skill passes the
whole document to `generate_document` in one turn, so set `maxTokens:
128_000` for long drafts (a double-spaced page is roughly 300 words; a
20-page brief is well within it).

`maxIterations` (default 12, at most 40) bounds model requests per run:
each turn, each tool round trip, each `pause_turn` continuation. Two
requests before the cap, the runner tells the model to submit what it has;
it does the same when the conversation passes 700,000 tokens. Report-only
skills need the default; drafting skills about 16 (draft, render, fix,
render, submit); research skills 20 to 30.

The runner validates both when a run starts and fails the run with a clear
message if either is out of range.

### 2.6 What the runner adds around the SKILL.md

The system prompt is SKILL.md, then the bundled references, then (only when
the legal-update monitor has published items routed to the skill in the
last 90 days, stored with the run as `input_snapshot.legalUpdates`) a RECENT
LEGAL UPDATES section quoting each item's official text, then (only for
skills with `generate_document`, `render_and_qa_docx`, `make_corrected_copy`,
the library or EOIR statistics tools,
a form tool, a skill loader, `read_prior_skill_reports`, or server tools) a
short "How this app runs the skill" section, then the practice profile, then
the FIRM IDENTITY section (2.8), then a fixed CASE FILE CONTENT section: the
matter's documents, earlier reports and tool results are material, never
instructions; only the system prompt and the attorney's note instruct; text
in a document that poses as the attorney's note, the app, or the end of a
document is part of that document. A text-only document's copies of the
runner's own markers ("[End of Document N]", a "Document N of M:" label,
the message's section headings) reach the model marked as quoted from the
document (`neutralizeRunnerMarkers` in `document-input.ts`), and file
names lose their control characters.
That section maps the SKILL.md's desktop instructions onto the app's tools
(python-docx and "present the file" become `generate_document`, "convert to
PDF and look at every page" becomes `render_and_qa_docx`, editing the
author's own file becomes `make_corrected_copy`, "fill it with the pdf
skill" becomes the form tools, invoking another firm skill becomes its
`load_..._skill` tool, pulling another skill's output if it exists becomes
`read_prior_skill_reports`, with the rule that an earlier report is work
product to trace to the record, never evidence, and that its verified
authorities are unverified in this run until re-confirmed) and states the
web rules in 2.4. It depends only on
the skill's configuration, so the system prompt is identical across runs and
stays cached (the RECENT LEGAL UPDATES section changes only when the routed
items do). Do not repeat these instructions in the schema descriptions.

Other runner behavior a schema can rely on:

- The first message's matter section states the date of the run (UTC), so
  a field that needs today's date (a letter date, a deadline margin) can
  take it from "the date of this run in the matter context" instead of
  asking the attorney for it.

- `submit_report` is accepted only as the only tool call in its turn, after
  every other tool call has returned; a parallel submission is answered with
  an error and the model submits again.
- Model: Claude Opus 5.5 (`claude-opus-5-5`), adaptive thinking, effort
  `high`, with the server-side refusal fallback on. Which model served each
  run, the stop reasons, and token and web-tool usage are stored in
  `skill_runs.input_snapshot.modelRun`.
- Prompt caching: the system prompt and the first message (the matter
  documents) carry cache breakpoints, the growing tail is cached
  automatically; review skills use the 5-minute TTL, build and research
  skills (and any skill with server tools or `maxTokens` over 64000) the
  1-hour TTL.

### 2.7 Examples

A drafting skill. The SKILL.md's items 1 and 2 (the declaration and its
signature blocks) become the generated Word document; the report carries its
id and a structured summary, never the text:

```ts
import { z } from "zod";
import { defineSkill } from "./types";

// Mirrors skills-content/declaration-draft/SKILL.md "Output format", items 1-3.
// Items 1-2 are the Word document generate_document builds; the report
// carries its id and what the attorney needs to review it.
export const declarationDraftOutputSchema = z.object({
  declaration: z.object({
    generatedDocumentId: z
      .string()
      .describe("document_id returned by generate_document for the final draft; empty if none could be generated"),
    paragraphCount: z.number().int().min(0),
    sectionsInOrder: z.array(z.string()),
  }),
  signatureBlock: z.object({
    included: z.boolean(),
    interpreterCertificationIncluded: z.boolean(),
    declarantLanguage: z.string().optional(),
  }),
  flagsForTheAttorney: z.array(z.string()),
});
export type DeclarationDraftOutput = z.infer<typeof declarationDraftOutputSchema>;

export const declarationDraft = defineSkill({
  name: "declaration-draft",
  label: "Draft declaration",
  category: "asylum",
  kind: "build",
  description: "Drafts the respondent's declaration as a Word document from the client's own account, flagging every gap.",
  outputSchema: declarationDraftOutputSchema,
  extractEscalationFlags: (output) => output.flagsForTheAttorney,
  tools: ["generate_document", "render_and_qa_docx"],
  maxTokens: 128_000,
  maxIterations: 16,
  needsNote: true,
  notePlaceholder: "Case note for Draft declaration (optional): interview notes or facts not in the uploaded documents.",
  applicableCaseTypes: ["asylum_affirmative", "asylum_defensive", "withholding_cat"],
});
```

Its view shows the download button only when the id is non-empty:
`{output.declaration.generatedDocumentId ? <button onClick={() =>
actions.downloadDocument(output.declaration.generatedDocumentId)}>...</button>
: <Muted>No document was generated in this run.</Muted>}`.

A research skill. Every source object carries the SKILL.md's columns plus
`url` and `retrievedAt`, the one addition rule 2.1.3 allows for research
skills: `retrievedAt` is the time this run fetched the URL (the `retrieved_at`
the web_fetch result shows), or an empty string for a source not fetched in
this run. The verification log remains the authoritative record; these two
fields let the report and the log be compared line by line.

```ts
// Mirrors skills-content/country-conditions-research/SKILL.md "Output format", items 1-5.
const sourceSchema = z.object({
  title: z.string(),
  publisher: z.string(),
  publicationDate: z.string(),
  url: z.string().describe("Exactly as retrieved; never constructed"),
  retrievedAt: z.string().describe("ISO time this run fetched the URL, from the web_fetch result; empty if not fetched in this run"),
  relevantFinding: z.string(),
  claimCorroborated: z.string(),
});

export const countryConditionsResearchOutputSchema = z.object({
  researchProfile: z.object({
    countryOrRegion: z.string(),
    protectedGrounds: z.array(z.string()),
    harm: z.string(),
    persecutor: z.string(),
    stateProtectionIssue: z.string(),
    timeframe: z.string(),
  }),
  recencyCutoffApplied: z.object({ cutoffDate: z.string(), firmRule: z.string().optional() }),
  sourcedEvidenceByClaim: z.array(z.object({ claim: z.string(), sources: z.array(sourceSchema) })),
  gaps: z.array(z.object({ claimOrElement: z.string(), recommendation: z.string() })),
  verificationNote: z.string(),
});

export const countryConditionsResearch = defineSkill({
  name: "country-conditions-research",
  label: "Run country conditions research",
  category: "asylum",
  kind: "research",
  description: "Gathers recent, retrieved country-conditions sources that corroborate the claims in the client's declaration.",
  outputSchema: countryConditionsResearchOutputSchema,
  extractEscalationFlags: (output) => output.gaps.map((g) => g.claimOrElement),
  tools: [],
  serverTools: ["web_search", { name: "web_fetch", maxUses: 10, allowedDomains: COUNTRY_CONDITIONS_FETCH_DOMAINS }],
  maxIterations: 24,
});
```

These are shapes to copy, not finished modules: the item names, enums and
optionality must still come from the skill's own SKILL.md (2.1).

### 2.8 Firm identity

The firm's skills were written for one firm, The Law Firm of Nisreen S.
Mousa, PC, and name it, its attorney and its contact details throughout: the
SKILL.md descriptions, the house-format references and signature blocks, and
the generator scripts (`i130-expedite-build/assets/make_expedite_letter.py`,
`asylum-fee-proof-packet/scripts/fee_packet.py`, and the script embedded in
`eoir-written-pleadings/SKILL.md`). The skill text stays byte-identical to
the plugin; the app supplies each tenant's own details instead.

**Where the details live.** `firm_identities` (one row per tenant: legal
name, address lines, phone, fax, email, website, an optional letterhead
licensure line) and `firm_attorneys` (the roster: full name, title, role
`attorney` | `accredited_representative`, bar state and number, EOIR ID,
email, `is_default_signer`, and a signature image), both under the tenant
RLS policy (`src/db/migrations/0004_firm_identity.sql`). They are separate
tables, not a section of the practice profile, because roster entries need
stable ids (a tool names its signer by id, a signature belongs to one
entry), signature storage keys must never reach a rendered prompt, and
contact details change without the profile's propose/confirm cycle. Edited
on the Firm page (`/firm`) by owner_admin and attorney users only
(`FIRM_IDENTITY_EDIT_ROLES` in `src/lib/tenant.ts`); every change is audited
(`firm_identity.*`, `firm_attorney.*`, `firm_signature.*`). Service:
`src/lib/firm-identity/service.ts`.

**How a skill gets them: nothing in the skill module.** `enqueueSkillRun`
stores a snapshot in `skill_runs.input_snapshot.firmIdentity` (type
`FirmIdentitySnapshot` in `src/lib/firm-identity/schema.ts`), and the runner
renders it as the last section of the system prompt
(`buildFirmIdentitySection` in `prompt.ts`). That section tells the model to
use this firm and its default signer (or the roster member the matter or the
case note names) wherever the skill text names the original firm, Ms. Mousa,
Nisreen S. Mousa, or that firm's contact details; to write bracketed
placeholders such as `[FIRM NAME]` for anything the tenant has not provided;
and, when the identity is incomplete, to flag "firm identity setup is
incomplete" in the report. It lists every roster entry with its id, so a
tool can take a signer by id. It is rendered from the snapshot's content
only (no timestamps, a fixed roster order), so a tenant's system prompt stays
byte-identical, and cached, until its identity changes. A run keeps the
snapshot it was queued with; a Retry takes the current identity. Do not
repeat these instructions in schema descriptions: a report with a flags or
open-items field already gives the model a place for the flag.

**Generator tools fill letterhead and signer server-side.** A generator that
prints a letterhead or a signature block never takes them from the model;
otherwise the model could put another firm's letterhead, or another
person's name or signature, on a document.

1. If the firm's script hard-codes the firm, copy it to
   `src/services/docx-generator/templates/<skill>/` and change only what
   reads the firm (the copy under `skills-content/` stays untouched): read
   the letterhead from a `firm` object and the signer from a `signer` object
   in the spec, and keep the script's own checks (ASCII gate, required keys)
   as they are. `templates/i130-expedite/make_expedite_letter.py` is the
   example: `signer.signature` is `"image"` (the image named by
   `signer.signature_image`, a bare file name next to `spec.json`, above the
   typed name), `"conformed"` (`/s/ Name`, used when no image is on file),
   or `"blank"` (space for a wet signature).
2. In the skill module, split the spec: the content the model writes (the
   tool's `specSchema`, with no letterhead or signer fields, and optionally a
   `signer_attorney_id`), the firm fields, and the full spec the script reads
   (`i130ExpediteLetterContentSchema`, `i130ExpediteLetterFirmFieldsSchema`,
   `i130ExpediteLetterSpecSchema`). zod strips unknown keys, so a `firm` or
   `signer` the model sends anyway is dropped.
3. In `tools.ts`, give `createDocxGeneratorTool` a `templatePath` (instead of
   `scriptPath`) and a `completeSpec(content, ctx)` that builds the full spec
   from `ctx.firmIdentity` (the run's snapshot): the firm fields; the signer,
   which is the roster entry named by `signer_attorney_id` (refused with a
   tool error if it is not on the roster) or else the default signer; and
   bracketed placeholders for anything missing, reported back in `notes` so
   the model flags them. `completeI130LetterSpec` is the example.
4. For the signature image, call `getSignerSignature(tenantId, attorneyId)`
   (`src/lib/firm-identity/service.ts`, server-only). It returns
   `{ bytes, mediaType, sha256, widthPx, heightPx }`, or `null` when the
   tenant has no such roster entry or no signature is on file. It reads the
   stored S3 version and throws when the bytes no longer match the sha256
   recorded at upload or fail validation; return that as a tool error, never
   fall back silently to a different signature. Pass the bytes as
   `inputFiles` (e.g. `[{ name: "signature.png", bytes }]`: written next to
   `spec.json`, deleted once the script has run) and name the file in the
   spec. Record `firm_signature.applied` with `recordFirmSignatureApplied`
   from `completeSpec`'s `inTransaction` hook, which runs in the transaction
   that stores the generated document.

The same rule covers the app's other tools that print firm details.
`build_fee_packet` and `generate_docx_eoir_pleadings` fill their counsel and
signature blocks as above (adapted copies of the firm's scripts under
`templates/`). `generate_document` prints a letterhead only through
`firm_letterhead: true`, which the tool fills from the firm identity (the
spec has no letterhead field the model could set). The PDF form tools fill
preparer and representative fields from a server-resolved `firm_value` (or
`preparer.fields`), refuse a typed value that carries the firm's or a
roster member's name, bar number, EOIR ID, email or phone, and never fill a
signature field.

Signature images are PNG or JPEG, at most 512 KB and 2400 x 1200 px. They
are uploaded through a Server Action (never a presigned PUT), checked from
their content and re-serialized without metadata
(`src/lib/firm-identity/signature-image.ts`, which explains why this replaces
the ClamAV scan for these files), stored under
`tenants/<tenant>/firm-signatures/`, and shown in a browser only as a
60-second presigned preview to owner_admin and attorney users. A generated
document that embeds a signature is an ordinary matter document: anyone in
the firm who can download documents can open it, and `render_and_qa_docx`
shows its pages, signature included, to the model.

## 3. Register the skill (`src/services/skill-runner/skills/index.ts`)

Add exactly two lines, both alphabetical by skill name:

```ts
import { i90PacketReview } from "./i90-packet-review";   // with the other imports

export const SKILL_MODULES = [
  ...
  i90PacketReview,                                         // in the array
  ...
] as const;
```

That is the whole registration. `SupportedSkillName`, `SKILL_SCHEMAS`,
`getSkillModule`, the runner's schema / tool / escalation lookups, the seed
script, and the matter page's skill picker (via `getSkillCatalog()` in
`skills/catalog.ts`) all derive from this array. `schemas.ts` is a
back-compat re-export file; do not add to it.

## 4. The report view (optional but recommended)

Without a dedicated view, completed runs render through
`GenericReportView` (`src/app/(app)/matters/[matterId]/views/GenericReportView.tsx`),
which walks any output: top-level keys become sections, nested objects
become sub-sections, arrays of objects become tables, string lists become
bullet lists, `{ citation, verified }` rows become a CitationsList,
`{ priority | severity, ... }` rows become a checklist, string lists whose
key contains "flag", "blocking", or "escalat" become a red callout, and
short enum-like strings become colored badges. It is readable, but a
dedicated view lets you order and emphasize what the attorney needs first.

Create `src/app/(app)/matters/[matterId]/views/<name>.tsx`:

```tsx
import type { SkillViewProps } from "./types";
import { Badge, BulletList, ChecklistList, CitationsList, Flags, Muted, ReportBody, Section, Table, priorityColor } from "./primitives";

export function I90PacketReviewView({ output }: SkillViewProps<"i90-packet-review">) {
  return (
    <ReportBody>
      <Section title="Packet snapshot">...</Section>
      <Flags title="Blocking issues" items={output.blockingIssues} />
      ...
    </ReportBody>
  );
}
```

Rules:

- Named export `<PascalName>View`, props typed `SkillViewProps<"<name>">`
  (gives you `output` typed from the schema, and `actions`).
- Render every schema field, in the SKILL.md's order, with the SKILL.md's
  item titles as section titles. Put flags and blocking items in `Flags`
  (red) and attorney questions in `Flags tone="amber"`.
- Build only from `./primitives`: `Badge` (+ `ratingColor`,
  `priorityColor`, `severityColor`, `coverageColor`, `statusColor`,
  `verdictColor`, `badgeClassFor`, `toneClass`), `Section`, `ReportBody`,
  `Table` (`columns: { header, cell(row) }[]`, optional `rowClassName`),
  `Flags`, `Callout`, `BulletList`, `ChecklistList`
  (`{ badge, badgeClassName?, content }[]`), `CitationsList`
  (`{ citation, verified, note? }[]`, always shows a verified / unverified
  marker), `Muted`, `humanize`, `yesNo`. If you need a new primitive, add
  it to `primitives.tsx` in a separate, generic form; do not restyle
  existing ones.
- For a generated document, render a download button that calls
  `actions.downloadDocument(output.<documentIdField>)`, and only when the
  id is non-empty (see `i130-expedite-build.tsx`).
- Do not render the run's retrieved sources yourself: `SkillRunPanel`
  shows `RetrievedSources` (`views/RetrievedSources.tsx`) under every run,
  built from `skill_runs.verification_log`, and marks each URL in the report
  as retrieved in the run, search result only, or not retrieved. In a
  research view, show each source's `url` and `retrievedAt` as reported.
- No data fetching, no hooks, no `"use client"` directive (the panel that
  imports the views is already a Client Component). Import from
  `@/services/skill-runner/...` only with `import type`.
- Plain ASCII in UI strings (no em dashes or typographic quotes).

Then register it in `src/app/(app)/matters/[matterId]/views/index.ts`,
two lines, alphabetical:

```ts
import { I90PacketReviewView } from "./i90-packet-review";

export const SKILL_VIEWS: SkillViewMap = {
  ...
  "i90-packet-review": I90PacketReviewView,
  ...
};
```

`SkillRunPanel.tsx` needs no change: it builds the skill picker from the
catalog (skills for the matter's case type, or for any matter, first,
grouped by `category`; the rest under Other skills), opens one run form for
the chosen skill (description, note help from `notePlaceholder`, pre-run
warnings), shows `skill_runs.escalation_flags` in a callout above every
completed report, and picks the view from this map. If the new skill is
easy to confuse with an existing one, add the pair to `SIMILAR_SKILL_GROUPS`
in `skills/catalog.ts` so the run form shows both descriptions.

## 5. Seed the skill definition

```bash
npm run db:seed-skills
```

For every registered skill, the seed script hashes SKILL.md plus every
`references/*.md` (sorted, LF-normalized) and compares it with the latest
`skill_definitions` row for that name. No row, or a different hash, inserts
version latest+1 (`rollout_status` ga, `required_tools` = the module's tool
keys, `output_json_schema` = the current schema, and `skill_markdown` plus
`reference_files`, the exact text the version sends). Same hash: nothing
happens. Existing rows are never modified, because each `skill_runs` row
points at the exact version it ran, and a run sends that version's stored
SKILL.md and references, not the files on the worker's disk. New runs
always use the latest version.

Run it against every database (local, staging) after merging. Re-running it
is always safe. On Fly it runs as part of every worker deploy
(`release_command` in `fly.worker.toml`).

Note: changing only `outputSchema` does not create a new version (the hash
covers content, not code). The runner always validates against the current
code schema, so this only affects the `output_json_schema` audit column.

## 6. Verify

```bash
npm run typecheck   # next typegen && tsc --noEmit
npx eslint src
LC_ALL=C grep -rlE $'\xc3\x82|\xc3\xa2\xe2\x82\xac' skills-content   # must print nothing
```

Then a quick registry probe (delete the file afterwards):

```ts
// .probe.ts at the repo root, run with: npx tsx .probe.ts
import { getSkillModule } from "./src/services/skill-runner/skills";
import { readSkillContent } from "./src/services/skill-runner/skill-content";
import { toJsonSchemaObject } from "./src/services/skill-runner/json-schema";
const skill = getSkillModule("<name>");
readSkillContent(skill.name).then((c) =>
  console.log(skill.name, c.contentHash.slice(0, 12), c.referenceFiles.map((r) => r.path), Object.keys(toJsonSchemaObject(skill.outputSchema)))
);
```

Finally, with the app and `npm run worker` running, open a matter, run the
skill, and expand the completed run.

## 7. Which skills are wired

All 29 firm skills are in `skills-content/`. 26 are wired as matter skills:
each has a module in `src/services/skill-runner/skills/`, an entry in
`skills/index.ts`, and a dedicated view in `views/`. The other 3 are not
matter skills, by design (end of this section). Every skill that names the
original firm gets the tenant's details from the FIRM IDENTITY section (2.8)
with no module change; the firm scripts that hard-code the firm
(i130-expedite-build, asylum-fee-proof-packet, eoir-written-pleadings) run as
adapted copies under `src/services/docx-generator/templates/`, with the firm
and signer filled server-side.

Two plugin files are not in `skills-content/`, on purpose; everything else
is a byte-for-byte copy:

- `asylum-fee-proof-packet/assets/signature.png`: the original firm
  attorney's signature image, which the plugin's script puts on the packet.
  It must never reach a tenant's documents (and nothing in a skill's
  `assets/` is sent to the model anyway). `build_fee_packet` signs with the
  tenant signer's image from `getSignerSignature` (2.8), else `/s/`, so the
  file is not needed; do not copy it when re-syncing the skill.
- `eoir-weekly-update/scripts/weekly_update.py` (see "Not wired" below).

Limits not listed are the defaults (`maxTokens` 64000, `maxIterations` 12).
The 18 skills that research or cite law also have the three library tools
(`search_library`, `lookup_library_citation`, `read_library_document`),
not repeated in the table: aos-packet-review, asylum-merits-brief,
bench-memo, brief-draft, claim-evaluation, closing-statement,
country-conditions-research, eoir-filing-compliance,
eoir-motion-self-review, evidence-organizer, i130-expedite-build,
i90-packet-build, i90-packet-review, legal-argument-research, packet-build,
packet-review, vawa-packet-build and vawa-packet-review. Of those,
aos-packet-review, packet-review and vawa-packet-review have
`maxIterations` 16 for them. Three of them (bench-memo, claim-evaluation
and legal-argument-research) also have the EOIR statistics tools
(`search_eoir_judges`, `eoir_judge_profile`, `query_eoir_stats`), and
claim-evaluation has `maxIterations` 18 for both sets. The rest do not
research law: the drafting skills that work from the client's own account
(the two declarations, direct-exam), the interview-prep pair (the review
bars research outside the record), the fee packet, the written pleadings
(they plead to the NTA's charges as written) and orthography-check.
Every skill has a case note (`needsNote`). The skills for matters before
the Immigration Court (bench-memo, direct-exam, eoir-filing-compliance,
eoir-motion-self-review, eoir-written-pleadings, legal-argument-research)
share `applicableCaseTypes` `asylum_defensive`, `withholding_cat`,
`cancellation`, `vawa`, `i130`: any matter that can be in removal
proceedings (affirmative asylum and I-90 matters are not before EOIR).

| Skill | Kind, category | Output section mirrored | Tools; server tools | Notes |
|-------|----------------|-------------------------|---------------------|-------|
| aos-packet-review | review, uscis | "Report format", items 1-11 | none | Flags: item 10 plus item 2's blocking issues (`BLOCKING: `). The case note asks for prior immigration and criminal history and whether the marriage will be under two years old at approval. |
| asylum-fee-proof-packet | build, eoir | Steps 4-6 (config, check, deliver) | `build_fee_packet`, `render_and_qa_docx` | Both deliverables (filing PDF and Word file) come only from the firm's script; the report carries both ids. The receipt cross-check refuses a config that disagrees with the receipt. Worker needs qpdf and the Python packages in requirements.txt. `maxIterations` 16. |
| asylum-interview-prep-build | build, asylum | "Output", items 1-5, plus the QA gate's report | `read_prior_skill_reports`, `fetch_uscis_page`, `generate_document`, `render_and_qa_docx`, `load_qa_gate_skill_asylum_interview_prep` | "Where earlier skills have run, pull their output": claim-evaluation, declaration-draft, evidence-organizer reports. The QA gate runs asylum-interview-prep-review's text in the same run. `maxTokens` 128000, `maxIterations` 22. |
| asylum-interview-prep-review | review, asylum | "Report format", items 1-10 | `render_and_qa_docx` | No live checks: the skill bars research outside the record. `render_and_qa_docx` renders a Word draft on the matter by its inventory document id, so heading-style and numbering rules are checked on the pages instead of landing under UNVERIFIED. |
| asylum-merits-brief | build, eoir | Steps 4-5 (Word document, cover note) | `read_prior_skill_reports`, `fetch_uscis_page`, `generate_document`, `render_and_qa_docx` | The spec covers the house style: `top_right_lines` (detention status) and `after_caption_lines` (judge, hearing) on the cover, `repeat_caption` on the first text page. `fetch_uscis_page` checks the authority bank's BIA entries on their justice.gov listing pages; its court of appeals entries stay with the attorney. Earlier claim-evaluation, evidence-organizer and country-conditions-research reports through `read_prior_skill_reports`. `maxTokens` 128000, `maxIterations` 22. |
| bench-memo | build, eoir | "Deliverables", items 1-4 | `read_prior_skill_reports`, `generate_document`, `render_and_qa_docx`; `web_search`, `web_fetch` (legal-authority list, `maxContentTokens` 10000) | The web tools verify the citation table (an unverified citation is Blocking in the skill's self check). claim-evaluation, evidence-organizer and country-conditions-research output through `read_prior_skill_reports`; brief-draft's draft is a matter document. `maxIterations` 24. |
| brief-draft | build, asylum | "Output format" (brief, attorney checklist) | `read_prior_skill_reports`, `generate_document`, `render_and_qa_docx` | No web retrieval. The library tools confirm a citation and its official link where the library holds it; every authority still goes on the attorney checklist to verify, and anything else stays a [CITE] placeholder or unverified, as the skill requires (an earlier report's verified authority included). claim-evaluation and evidence-organizer (and legal-argument-research) reports through `read_prior_skill_reports`. `maxTokens` 128000, `maxIterations` 18. |
| claim-evaluation | review, asylum | "Output format", items 1-5 | none | The case note asks which relief to evaluate and takes a pasted intake. |
| closing-statement | build, asylum | "8. Deliverables", items 1-5 | `read_prior_skill_reports`, `fetch_uscis_page`, `generate_document`, `render_and_qa_docx` | The spec covers the letter: `firm_letterhead`, flush-left blocks with `first_line_indent` 0, and `forbid_typographic_punctuation` (the letter needs a section sign, so not `plain_ascii`). `fetch_uscis_page` for a non-Houston asylum office address. `maxTokens` 128000, `maxIterations` 20. |
| country-conditions-research | research, asylum | "Output format", items 1-5 | `web_search`, `web_fetch` (country-conditions list) | No search domain list: accepted sources come from the practice profile; a source outside the fetch list is reported as a search result, not retrieved. `maxIterations` 24. |
| declaration-draft | build, asylum | "Output format", items 1-3 | `read_prior_skill_reports`, `generate_document`, `render_and_qa_docx` | The relief in play from claim-evaluation's report when it has run. `maxTokens` 128000, `maxIterations` 18. |
| declaration-draft-concise | build, asylum | "Output format", items 1-3 | `read_prior_skill_reports`, `generate_document`, `render_and_qa_docx` | The 6-page cap is checked from the page count `render_and_qa_docx` reports. The relief in play from claim-evaluation's report when it has run. `maxTokens` 128000, `maxIterations` 18. |
| direct-exam | build, eoir | "Deliverables", items 1-4 | `read_prior_skill_reports`, `generate_document`, `render_and_qa_docx` | Two Word files (counsel script, client practice guide) on one numbering. claim-evaluation and evidence-organizer reports through `read_prior_skill_reports`; the bench memo is a matter document. `maxTokens` 128000, `maxIterations` 24. |
| eoir-filing-compliance | review, eoir | "Step 5: Report" template | `fetch_ecfr_section`, `render_and_qa_docx`; `web_search` (justice.gov/eoir, govinfo.gov), `web_fetch` (justice.gov, govinfo.gov) | No `fetch_uscis_page`: it returns 20,000 characters per call and the manual chapters Step 3 checks are longer; `web_fetch` reads them whole. `maxIterations` 20. |
| eoir-motion-self-review | review, eoir | "7. Write the report" template | `fetch_ecfr_section`, `fetch_uscis_page`, `render_and_qa_docx`; `web_search`, `web_fetch` (legal-authority list) | `maxIterations` 20. |
| eoir-written-pleadings | build, eoir | Steps 4-6 | `generate_docx_eoir_pleadings`, `render_and_qa_docx` | Houston Immigration Court only, as the firm's script. No ACIS lookup (not on the fetch allow list, and it would send the A-number out): the docket details come from the case note. `maxIterations` 16. |
| evidence-organizer | build, asylum | "Output format", items 1-6, plus the Word Index of Documents | `read_prior_skill_reports`, `fetch_uscis_page`, `generate_document`, `render_and_qa_docx`; `web_search` (justice.gov/eoir, uscis.gov), `web_fetch` (justice.gov, uscis.gov, `maxUses` 5) | Items 1-6 stay structured in the report; step 3's Index of Documents (item 1 keyed to tabs) and the filing checklist (item 6) are also the Word document named by `indexOfDocuments.generatedIndexOfDocumentsDocumentId`. country-conditions-research's sources (its hand-off) and claim-evaluation's report through `read_prior_skill_reports`. `maxIterations` 20. |
| i130-expedite-build | build, uscis | "SECTION 7. DELIVERABLES" | `fetch_uscis_page`, `generate_docx_i130`, `render_and_qa_docx` | SECTION 3's posted processing time is on egov.uscis.gov, on the fetch allow list; that page is built by script, so the check can come back unconfirmed. `maxIterations` 16. |
| i90-packet-build | build, uscis | "SECTION 7. DELIVERABLES", items 1-12, plus SECTION 8 | `fetch_uscis_page`, `fill_uscis_form_pdf_i90`, `generate_document`, `render_and_qa_docx`, `load_qa_gate_skill_i90_packet_review` | `maxTokens` 128000, `maxIterations` 30. |
| i90-packet-review | review, uscis | "Report format", items 1-13 | `fetch_uscis_page`; `web_search`, `web_fetch` (uscis.gov) | Items 4-11 may be omitted only after the scope stop. Flags: item 12 plus the blocking issues (`BLOCKING: `). `maxIterations` 20. |
| legal-argument-research | research, eoir | "Report format", items 1-7 | `load_motion_references_legal_argument_research`; `web_search`, `web_fetch` (legal-authority list) | `maxIterations` 30. |
| orthography-check | review, general | "Report structure" template | `make_corrected_copy_orthography`, `generate_document`, `render_and_qa_docx` | `generate_document` only for the corrected copy of a PDF or scan; a Word or text source is corrected in place. `maxTokens` 128000, `maxIterations` 16. |
| packet-build | build, asylum | "Output format", items 1-9 | `fetch_uscis_page`, `generate_document`, `render_and_qa_docx`, `list_pdf_form_fields_packet_build`, `fill_pdf_form_packet_build`, `load_companion_skill_packet_build`, `read_prior_skill_reports`; `web_search`, `web_fetch` (both lists, `maxContentTokens` 20000) | The companions' earlier reports on the matter through `read_prior_skill_reports`; the companion steps themselves run in this run. `maxTokens` 128000, `maxIterations` 40. |
| packet-review | review, asylum | "Report format", items 1-9 | `read_prior_skill_reports` | "Where earlier skills have run, pull their output": claim-evaluation, evidence-organizer, declaration-draft reports. Flags: item 8 plus item 2's blocking issues (`BLOCKING: `). The case note asks for the venue and circuit. |
| vawa-packet-build | build, uscis | "SECTION 7. OUTPUT", items 1-18 | `fetch_uscis_page`, `generate_document`, `render_and_qa_docx`, `list_pdf_form_fields_vawa`, `fill_pdf_form_vawa`, `load_qa_gate_skill_vawa_packet_review`, `load_qa_gate_skill_orthography_check`; `web_search`, `web_fetch` (legal-authority list, `maxUses` 5, `maxContentTokens` 20000) | `maxTokens` 128000, `maxIterations` 40. |
| vawa-packet-review | review, uscis | "SECTION 4. OUTPUT FORMAT" | `fetch_uscis_page` | Flags, as vawa-packet-build extracts its QA gate's: item 2's SAFETY, CONFLICT and 1367 flags first, a DO NOT FILE verdict, then item 12. The case note asks for the intended filing date and current safety concerns. |

Not wired, by design:

- **cold-start-interview**: the interactive setup of PRACTICE_PROFILE.md.
  The app's Practice Profile pages replace it.
- **customize**: edits one profile field. Replaced by the Practice Profile
  editor, which shows current to proposed, the skills each change reaches
  (`src/lib/practice-profile/ripple.ts`, kept in step with the SKILL.md
  files by hand), and requires an acknowledgment to weaken an escalation
  rule.
- **eoir-weekly-update**: not a matter skill. It drives the legal-update
  monitor (`src/services/monitoring/`, `/updates`): its
  `references/sources.md` and `routing.md` are read at run time by the
  summary step, and its `references/update-log.md` was re-synced from the
  plugin. Its `scripts/` were not copied (machine-specific paths) and are
  not needed: the monitor stores items in the database instead of editing
  reference files.

Open items that cross skills:

- `read_prior_skill_reports` returns the latest completed run of each skill
  on the matter, never an earlier one the attorney might prefer, and a run
  still queued or running is not visible to it. Runs started together do
  not see each other's reports: run the skill whose output another builds
  on first.
- The new Python scripts (`asylum-fee-proof-packet/fee_packet.py`,
  `eoir-written-pleadings/make_pleadings.py`, `orthography-check/
  apply_corrections.py` and the three PDF form fillers) have never run: no
  Python on the machine they were written on. Smoke-test each on the worker
  image before relying on it.
