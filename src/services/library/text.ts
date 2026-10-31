import crypto from "node:crypto";

// Text clean-up for what the library stores. Only mechanical changes that
// keep the source's words: Unicode normalization, characters Postgres
// cannot store, line endings and runs of blank lines, and a few
// double-encoding artifacts official pages carry (a UTF-8 section sign read
// as Latin-1 and written out again shows as an A-circumflex before it).
// Nothing here rewrites, summarizes or shortens what the source says,
// except excerpt(), which only link_only sources use.

// Double-encoded UTF-8 seen on official pages, mapped back. Each key is the
// UTF-8 bytes of the character read as Windows-1252 and re-encoded.
const MOJIBAKE: [string, string][] = [
  ["\u00e2\u20ac\u2122", "\u2019"], // right single quotation mark
  ["\u00e2\u20ac\u02dc", "\u2018"],
  ["\u00e2\u20ac\u0153", "\u201c"],
  ["\u00e2\u20ac\u009d", "\u201d"],
  ["\u00e2\u20ac\u201c", "\u2013"], // en dash
  ["\u00e2\u20ac\u201d", "\u2014"], // em dash
  ["\u00e2\u20ac\u00a6", "\u2026"],
  ["\u00c2\u00a7", "\u00a7"], // section sign
  ["\u00c2\u00b6", "\u00b6"],
  ["\u00c2\u00a0", "\u00a0"],
];

/** Repairs the double-encoding artifacts in MOJIBAKE; text without them is returned unchanged. */
export function repairMojibake(text: string): string {
  if (!/[\u00c2\u00e2]/.test(text)) return text;
  let out = text;
  for (const [bad, good] of MOJIBAKE) out = out.split(bad).join(good);
  return out;
}

/**
 * Text as stored: NFC, valid UTF-16 (lone surrogates dropped), no NUL or
 * other control characters but tab, newline and form feed, LF line endings,
 * no trailing spaces, at most one blank line in a row, trimmed.
 */
export function cleanText(raw: string): string {
  const wellFormed = (raw as string & { toWellFormed?: () => string }).toWellFormed?.() ?? raw;
  return repairMojibake(wellFormed.normalize("NFC"))
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g, "")
    .replace(/\ufffe|\uffff/g, "")
    .replace(/[ \t\u00a0]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** One-line text: whitespace runs collapsed. */
export function oneLine(text: string): string {
  return cleanText(text).replace(/\s+/g, " ").trim();
}

export function sha256Hex(text: string | Buffer): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * The opening of a text, at most `maxChars`, cut at the last sentence end
 * (or, failing that, word break) before the limit, with " [...]" when cut.
 */
export function excerpt(text: string, maxChars: number): string {
  const clean = cleanText(text);
  if (clean.length <= maxChars) return clean;
  const head = clean.slice(0, maxChars);
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf(".\n"));
  const cut = sentence > maxChars * 0.5 ? sentence + 1 : Math.max(head.lastIndexOf(" "), maxChars * 0.8);
  return `${head.slice(0, Math.floor(cut)).trimEnd()} [...]`;
}

/**
 * Whether two addresses name the same page: same host (any case) and path,
 * ignoring a trailing slash, the query and the fragment. Used to match an
 * imported page to the link a listing page gives for it (../manual-import.ts).
 */
export function sameAddress(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const path = (u: URL) => u.pathname.replace(/\/+$/, "") || "/";
    return x.hostname.toLowerCase() === y.hostname.toLowerCase() && path(x) === path(y);
  } catch {
    return false;
  }
}
