import { z } from "zod";

// The JSON spec the generic Word builder takes
// (src/services/docx-generator/templates/make_document.py). This is the
// input contract of the generate_document tool (tool key generate_document in
// tools.ts): the model fills it in, the runner validates it here, and the
// Python script validates it again before writing anything. Keep the two in
// step: a field added here must be handled there.
//
// Client-safe on purpose (zod only), so skill modules and docs can refer to
// the shape without importing server code.
//
// One key the script reads is never the model's: `letterhead`, which
// generate_document adds from the run's firm identity when the spec sets
// firm_letterhead (docs/ADDING_A_SKILL.md 2.8). It is not in this schema, so
// a letterhead the model sends is dropped by the parse.
//
// Inline markup inside any text field: **bold**, *italic*, __underline__.
// Nothing else is interpreted. A newline inside a string is a line break
// within the same paragraph.

const text = z.string().max(20_000);
const lines = z.array(z.string().max(2_000)).max(60);

export const documentParagraphBlockSchema = z.object({
  type: z.literal("paragraph"),
  text: text.describe("Paragraph text. Inline **bold**, *italic*, __underline__."),
  style: z
    .enum(["body", "quote", "indented"])
    .optional()
    .describe(
      "body (default): document line spacing, first-line indent, body alignment. quote: single-spaced block quote indented 1 inch on both sides. indented: body paragraph indented 0.5 inch, no first-line indent."
    ),
  align: z.enum(["left", "center", "right", "justify"]).optional().describe("Overrides the style's alignment."),
  first_line_indent: z
    .number()
    .min(0)
    .max(1.5)
    .optional()
    .describe(
      "body style only: this paragraph's first-line indent in inches, overriding the document's. 0 for a flush-left date, inside address or RE block in a letter whose body paragraphs are indented."
    ),
});

export const documentNumberedBlockSchema = z.object({
  type: z.literal("numbered"),
  items: z.array(text).min(1).max(400).describe("One numbered paragraph per item (\"1.\", \"2.\", ...)."),
  start: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .optional()
    .describe("First number. Use it to continue numbering across sections, e.g. a declaration's paragraphs."),
});

export const documentBulletedBlockSchema = z.object({
  type: z.literal("bulleted"),
  items: z.array(text).min(1).max(400),
});

export const documentTableBlockSchema = z.object({
  type: z.literal("table"),
  columns: z.array(z.string().max(500)).min(1).max(12).describe("Header row labels, bold and shaded."),
  rows: z
    .array(z.array(z.string().max(5_000)).max(12))
    .max(500)
    .describe("Each row has one cell per column, in column order."),
  column_widths: z
    .array(z.number().min(0.3).max(7))
    .max(12)
    .optional()
    .describe("Column widths in inches, one per column. Omit for equal widths."),
});

export const documentPageBreakBlockSchema = z.object({
  type: z.literal("page_break"),
});

export const documentSignatureBlockSchema = z.object({
  type: z.literal("signature"),
  lines: lines
    .min(1)
    .describe(
      "Signature block lines, single-spaced and kept on one page, e.g. \"Respectfully submitted,\", \"\", \"______________________\", the signer's name, bar number, firm, address."
    ),
  align: z
    .enum(["left", "right"])
    .optional()
    .describe("right (default): starts at the middle of the page, as in pleadings. left: flush left, as in letters."),
});

export const documentSpacerBlockSchema = z.object({
  type: z.literal("spacer"),
  lines: z.number().int().min(1).max(30).optional().describe("Blank single-spaced lines; default 1."),
});

export const documentBlockSchema = z.discriminatedUnion("type", [
  documentParagraphBlockSchema,
  documentNumberedBlockSchema,
  documentBulletedBlockSchema,
  documentTableBlockSchema,
  documentPageBreakBlockSchema,
  documentSignatureBlockSchema,
  documentSpacerBlockSchema,
]);
export type DocumentBlock = z.infer<typeof documentBlockSchema>;

export const documentSectionSchema = z.object({
  heading: z.string().max(1_000).optional(),
  level: z
    .number()
    .int()
    .min(1)
    .max(3)
    .optional()
    .describe("Heading level. 1 (default): bold, centered. 2: bold, left. 3: bold italic, left."),
  page_break_before: z.boolean().optional().describe("Start this section on a new page."),
  repeat_caption: z
    .boolean()
    .optional()
    .describe(
      "Print header_lines, the caption and the title again at the top of this section, before its heading, as on a brief's first text page after its cover page. The counsel block, top_right_lines and after_caption_lines are not repeated. With page_break_before they start the new page."
    ),
  blocks: z.array(documentBlockSchema).max(500),
});
export type DocumentSection = z.infer<typeof documentSectionSchema>;

export const documentSpecSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(500)
    .describe("Document title: the Word title property, and printed centered and bold after the caption."),
  show_title: z.boolean().optional().describe("Print the title (default true). False when a section already carries it."),
  firm_letterhead: z
    .boolean()
    .optional()
    .describe(
      "Print this firm's letterhead at the top of the first page: the firm name, address lines, licensure line and website centered, then the phone with \"Email Address\" and the fax with the email address, a rule under them. The app fills it from the firm identity (the FIRM IDENTITY section); never type a letterhead into header_lines, counsel_block or the caption."
    ),
  counsel_block: lines
    .optional()
    .describe("Counsel's name, bar number, firm, address and phone, single-spaced at the top left of the first page."),
  top_right_lines: lines
    .optional()
    .describe("Single-spaced lines flush right at the top of the first page, level with the counsel block, e.g. a detention status \"NON-DETAINED\"."),
  header_lines: lines
    .optional()
    .describe("Agency or court heading, centered and bold above the caption, e.g. \"UNITED STATES DEPARTMENT OF JUSTICE\"."),
  caption: z
    .object({
      lines: lines.optional().describe("A simple caption: single-spaced lines, flush left."),
      left: lines.optional().describe("Two-column caption, left side, e.g. \"In the Matter of:\", the name, \"Respondent.\""),
      right: lines.optional().describe("Two-column caption, right side, e.g. \"File No.: A 000-000-000\", \"In Removal Proceedings\"."),
      divider: z
        .string()
        .max(3)
        .optional()
        .describe("Character repeated down the middle of a two-column caption; default \")\"."),
    })
    .optional(),
  after_caption_lines: lines
    .optional()
    .describe("Single-spaced lines flush left after the caption and before the title, on the first page only, e.g. the Immigration Judge and the next hearing date and time."),
  sections: z.array(documentSectionSchema).min(1).max(200),
  footer_text: z.string().max(300).optional().describe("Small text centered in the footer of every page."),
  font: z.string().max(60).optional().describe("Default \"Times New Roman\"."),
  font_size: z.number().min(8).max(16).optional().describe("Points; default 12."),
  line_spacing: z
    .number()
    .min(1)
    .max(3)
    .optional()
    .describe("Body paragraph line spacing; default 1 (single). 2 is double-spaced. Captions, headings, tables, quotes and signatures stay single-spaced."),
  body_alignment: z.enum(["justify", "left"]).optional().describe("Body paragraph alignment; default justify."),
  first_line_indent: z.number().min(0).max(1.5).optional().describe("Body paragraph first-line indent in inches; default 0.5."),
  page_numbers: z.boolean().optional().describe("Centered page number in the footer; default true."),
  number_first_page: z
    .boolean()
    .optional()
    .describe("Show the page number (and footer text) on the first page; default true. False for a cover page."),
  confidentiality_banner: z
    .string()
    .max(200)
    .optional()
    .describe("Bold line at the top of every page, e.g. \"PRIVILEGED AND CONFIDENTIAL - ATTORNEY WORK PRODUCT - DRAFT\". Omit on documents meant for filing."),
  plain_ascii: z
    .boolean()
    .optional()
    .describe("Refuse to build if any text has a non-ASCII character (em dash, curly quote, accent), listing where each one is."),
  forbid_typographic_punctuation: z
    .boolean()
    .optional()
    .describe(
      "Refuse to build if any text has an em dash, en dash, or curly quotation mark or apostrophe, listing where each one is. Unlike plain_ascii, other characters (a section sign, an accent in a name) are allowed."
    ),
});
export type DocumentSpec = z.infer<typeof documentSpecSchema>;

/** Input of the generate_document tool. */
export const generateDocumentInputSchema = z.object({
  file_name: z
    .string()
    .min(1)
    .max(120)
    .describe("File name for the matter's documents list, e.g. \"Respondent Declaration - DRAFT.docx\". Letters, digits, spaces, and . _ - ( ) only."),
  spec: documentSpecSchema,
});
export type GenerateDocumentInput = z.infer<typeof generateDocumentInputSchema>;
