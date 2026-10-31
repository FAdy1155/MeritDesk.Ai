// Citation finding and normalization for the library: the citation forms
// immigration research turns on, each normalized to one canonical string so
// a citation written any common way finds the same document
// (library_citations.normalized). Pure, no dependencies: the pipeline uses
// it on what adapters return and on document text, the lookup tool on what
// the model asks for, and the reader page to link citations.
//
// Canonical forms (subsections and pin cites are kept in `raw`, dropped
// from `normalized`, so "8 U.S.C. 1158(b)(1)(A)" finds 8 U.S.C. 1158):
//   ina_dec        27 I&N Dec. 837
//   us             583 U.S. 202
//   f              12 F. 34, 123 F.2d 456, 747 F.3d 773, 98 F.4th 1
//   f_app          123 F. App'x 456
//   f_supp         123 F. Supp. 456, 123 F. Supp. 2d 456, 123 F. Supp. 3d 456
//   usc            8 U.S.C. 1158
//   cfr            8 C.F.R. 1003.38 (a part alone: 8 C.F.R. part 1003)
//   ina            INA 240A
//   fed_reg        89 Fed. Reg. 12345
//   interim        Interim Decision 3984
//   aao            AAO JAN032024_01H6101 (the decision file's ID, upper case)
//   other          anything an adapter states that fits none of these, whitespace collapsed

export type CitationKind =
  | "ina_dec"
  | "us"
  | "f"
  | "f_app"
  | "f_supp"
  | "usc"
  | "cfr"
  | "ina"
  | "fed_reg"
  | "interim"
  | "aao"
  | "other";

export type FoundCitation = {
  kind: CitationKind;
  normalized: string;
  /** As written in the text. */
  raw: string;
  /** Reporter citations: the volume and first page, for pin-page lookups. */
  volume?: number;
  page?: number;
  /** A pin page or subsection written after the citation, when there is one. */
  pin?: string;
};

type Pattern = {
  kind: CitationKind;
  re: RegExp;
  build(m: RegExpExecArray): Omit<FoundCitation, "kind" | "raw"> | null;
  /** Too loose for running text ("ID 1234" can be anything there); used only on a citation given as such. */
  citationOnly?: boolean;
  /**
   * In running text, only when the text is about the INA: "section 202 of
   * the Act" in 21 C.F.R. part 1308 is the Controlled Substances Act, and in
   * 20 C.F.R. part 416 the Social Security Act. A citation given as such
   * (normalizeCitation) is always read.
   */
  inaContextOnly?: boolean;
};

/** Running text that names the INA or cites Title 8 or the I&N Decisions: "the Act" there is the INA. */
const INA_CONTEXT = /Immigration and Nationality Act|\bINA\b|\b8\s+U\.?\s?S\.?\s?C\.?\s|\b8\s+C\.?\s?F\.?\s?R\.?\s|I\.?\s*&\s*N\.?\s+Dec/;

const SECTION = "(?:\u00a7{1,2}|sec(?:tion|s)?\\.?)";
const num = (s: string | undefined) => (s === undefined ? NaN : Number(s.replace(/,/g, "")));
const stripZeros = (s: string) => s.replace(/^0+(?=\d)/, "");

const PATTERNS: Pattern[] = [
  {
    kind: "ina_dec",
    re: /\b(\d{1,2})\s+I\.?\s*&\s*N\.?\s+Dec\.?\s+(\d{1,4})(?:\s*,\s*(\d{1,4}))?/g,
    build: (m) => ({ normalized: `${num(m[1])} I&N Dec. ${num(m[2])}`, volume: num(m[1]), page: num(m[2]), pin: m[3] }),
  },
  {
    kind: "f_app",
    re: /\b(\d{1,4})\s+(?:F\.\s?App(?:'|\u2019|&#39;)?x\.?|Fed\.\s?Appx\.?)\s+(\d{1,5})(?:\s*,\s*(\d{1,5}))?/g,
    build: (m) => ({ normalized: `${num(m[1])} F. App'x ${num(m[2])}`, volume: num(m[1]), page: num(m[2]), pin: m[3] }),
  },
  {
    kind: "f_supp",
    re: /\b(\d{1,4})\s+F\.\s?Supp\.?\s?(2d|3d)?\s+(\d{1,5})(?:\s*,\s*(\d{1,5}))?/g,
    build: (m) => ({
      normalized: `${num(m[1])} F. Supp.${m[2] ? ` ${m[2]}` : ""} ${num(m[3])}`,
      volume: num(m[1]),
      page: num(m[3]),
      pin: m[4],
    }),
  },
  {
    kind: "f",
    re: /\b(\d{1,4})\s+F\.\s?(2d|3d|4th)?\s+(\d{1,5})(?:\s*,\s*(\d{1,5}))?/g,
    build: (m) => ({
      normalized: m[2] ? `${num(m[1])} F.${m[2]} ${num(m[3])}` : `${num(m[1])} F. ${num(m[3])}`,
      volume: num(m[1]),
      page: num(m[3]),
      pin: m[4],
    }),
  },
  {
    kind: "usc",
    re: new RegExp(
      `\\b(\\d{1,2})\\s+U\\.?\\s?S\\.?\\s?C\\.?(?:\\s?A\\.?|\\s?S\\.?)?\\s+(?:${SECTION}\\s*)?(\\d{1,5}[a-z]{0,2}(?:-\\d+[a-z]?)?)((?:\\([0-9a-zA-Z]{1,6}\\)){0,6})`,
      "g"
    ),
    build: (m) => ({ normalized: `${num(m[1])} U.S.C. ${m[2]}`, pin: m[3] || undefined }),
  },
  {
    kind: "us",
    // "U.S." followed by a page number: never "U.S.C." (no digits follow "U.S." there).
    re: /\b(\d{1,3})\s+U\.\s?S\.\s+(\d{1,4})(?:\s*,\s*(\d{1,4}))?\b/g,
    build: (m) => ({ normalized: `${num(m[1])} U.S. ${num(m[2])}`, volume: num(m[1]), page: num(m[2]), pin: m[3] }),
  },
  {
    kind: "cfr",
    re: new RegExp(
      `\\b(\\d{1,2})\\s+C\\.?\\s?F\\.?\\s?R\\.?\\s+(?:${SECTION}\\s*)?(\\d{1,4})\\.(\\d{1,5}[a-z]?(?:-\\d+[a-z]?)?)((?:\\([0-9a-zA-Z]{1,6}\\)){0,6})`,
      "g"
    ),
    build: (m) => ({ normalized: `${num(m[1])} C.F.R. ${num(m[2])}.${m[3]}`, pin: m[4] || undefined }),
  },
  {
    kind: "cfr",
    re: /\b(\d{1,2})\s+C\.?\s?F\.?\s?R\.?\s+(?:part|pt\.)\s+(\d{1,4})\b(?!\.\d)/gi,
    build: (m) => ({ normalized: `${num(m[1])} C.F.R. part ${num(m[2])}` }),
  },
  {
    kind: "ina",
    re: new RegExp(
      `\\b(?:INA|I\\.N\\.A\\.|Immigration and Nationality Act)\\s*,?\\s*(?:${SECTION}\\s*)?(\\d{3}[A-Z]?)(?![\\d.])((?:\\([0-9a-zA-Z]{1,6}\\)){0,6})`,
      "g"
    ),
    build: (m) => ({ normalized: `INA ${m[1]}`, pin: m[2] || undefined }),
  },
  {
    kind: "ina",
    // "section 240A(b)(1) of the Act" and "section 212(a) of the Immigration and Nationality Act".
    re: /\bsection\s+(\d{3}[A-Z]?)((?:\([0-9a-zA-Z]{1,6}\)){0,6})\s+of\s+the\s+(?:Immigration and Nationality\s+)?Act\b/gi,
    build: (m) => ({ normalized: `INA ${m[1].toUpperCase()}`, pin: m[2] || undefined }),
    inaContextOnly: true,
  },
  {
    kind: "fed_reg",
    re: /\b(\d{1,3})\s+(?:Fed\.?\s?Reg\.?|FR)\s+(\d{1,3}(?:,\d{3})+|\d{1,6})\b/g,
    build: (m) => ({ normalized: `${num(m[1])} Fed. Reg. ${num(m[2])}`, volume: num(m[1]), page: num(m[2]) }),
  },
  {
    kind: "interim",
    re: /\b(?:Interim\s+Dec(?:ision)?\.?|Int\.?\s?Dec\.?)\s*(?:No\.?\s*|#\s*)?(\d{3,4})\b/gi,
    build: (m) => ({ normalized: `Interim Decision ${stripZeros(m[1])}` }),
  },
  {
    kind: "interim",
    // EOIR's own volume listings: "ID 3984", "ID #0939".
    re: /\bID\s*#?\s*(\d{4})\b/g,
    build: (m) => ({ normalized: `Interim Decision ${stripZeros(m[1])}` }),
    citationOnly: true,
  },
  {
    kind: "aao",
    // A non-precedent decision's file ID: its date, a two- or three-digit
    // sequence, the decision folder's code (a letter and one or two digits)
    // and the statute section; files from before about 2011 write the month
    // in mixed case ("Jul292010_04F1101").
    re: /\b((?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{6}_\d{2,3}[A-Z]\d{4,5})\b/gi,
    build: (m) => ({ normalized: `AAO ${m[1].toUpperCase()}` }),
  },
];

/**
 * Every citation in `text`, in order of first appearance, one per
 * normalized form (the first occurrence's raw text kept), at most `limit`.
 */
export function extractCitations(text: string, limit = 500, options: { citationOnlyForms?: boolean } = {}): FoundCitation[] {
  const found: { at: number; citation: FoundCitation }[] = [];
  const seen = new Set<string>();
  // Spans already claimed by a more specific pattern (F. App'x before F.).
  const claimed: [number, number][] = [];
  let inaContext: boolean | undefined;
  for (const pattern of PATTERNS) {
    if (pattern.citationOnly && !options.citationOnlyForms) continue;
    if (pattern.inaContextOnly && !options.citationOnlyForms && !(inaContext ??= INA_CONTEXT.test(text))) continue;
    pattern.re.lastIndex = 0;
    for (const m of text.matchAll(pattern.re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (claimed.some(([a, b]) => start < b && end > a)) continue;
      const built = pattern.build(m as RegExpExecArray);
      if (!built) continue;
      claimed.push([start, end]);
      const key = `${pattern.kind}|${built.normalized}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ at: start, citation: { kind: pattern.kind, raw: m[0].replace(/\s+/g, " ").trim(), ...stripUndefined(built) } });
    }
  }
  return found.sort((a, b) => a.at - b.at).slice(0, limit).map((f) => f.citation);
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && !(typeof v === "number" && Number.isNaN(v)))) as T;
}

/**
 * The canonical form of one citation as an adapter or a user writes it: the
 * first citation found in it, or (for a form this file does not know) the
 * text with its whitespace collapsed, as kind "other". Null for empty input.
 */
export function normalizeCitation(raw: string): FoundCitation | null {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const [first] = extractCitations(text, 1, { citationOnlyForms: true });
  if (first) return first;
  return { kind: "other", normalized: text, raw: text };
}
