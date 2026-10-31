// Text rules the monitor applies to what it stores and checks. Pure.

function chars(...codes: number[]): string {
  return codes.map((c) => String.fromCharCode(c)).join("");
}

// The same substitutions as the skill's helper (scripts/weekly_update.py
// normalize_text), written as code points so this file stays plain ASCII:
// the summaries the app writes follow the skill's "Plain characters" rule
// (straight quotes, plain hyphens, no section sign, no invisible characters).
const SINGLE_QUOTES = chars(0x2018, 0x2019, 0x201a, 0x2032, 0x02bc);
const DOUBLE_QUOTES = chars(0x201c, 0x201d, 0x201e, 0x2033);
const DASHES = chars(0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212);
const SPACES = chars(0x00a0, 0x2002, 0x2003, 0x2009, 0x202f);
const INVISIBLE = chars(0x200b, 0x200c, 0x200d, 0x2060, 0xfeff);
const SECTION = chars(0x00a7);
const PILCROW = chars(0x00b6);
const ELLIPSIS = chars(0x2026);

function charClass(set: string): RegExp {
  return new RegExp(`[${set.replace(/[\\\]^-]/g, "\\$&")}]`, "g");
}

const SINGLE_QUOTES_RE = charClass(SINGLE_QUOTES);
const DOUBLE_QUOTES_RE = charClass(DOUBLE_QUOTES);
const DASHES_RE = charClass(DASHES);
const SPACES_RE = charClass(SPACES);
const INVISIBLE_RE = charClass(INVISIBLE);

/**
 * Text the app writes itself (summaries, notes) in the skill's plain
 * characters: "8 U.S.C. <section sign> 1182" becomes "8 U.S.C. 1182", curly
 * quotes become straight, every dash a hyphen. Never applied to the quoted
 * source text, which is stored as the source printed it.
 */
export function toPlainCharacters(text: string): string {
  return text
    .split(chars(0x2018, 0x2018)).join('"')
    .split(chars(0x2019, 0x2019)).join('"')
    .replace(new RegExp(`${SECTION}${SECTION}\\s*`, "g"), "")
    .replace(new RegExp(`${SECTION}\\s*`, "g"), "")
    .replace(SINGLE_QUOTES_RE, "'")
    .replace(DOUBLE_QUOTES_RE, '"')
    .replace(DASHES_RE, "-")
    .replace(SPACES_RE, " ")
    .replace(INVISIBLE_RE, "")
    .split(ELLIPSIS).join("...")
    .split(PILCROW).join("para.")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/**
 * The form two texts are compared in when checking that a passage was
 * copied from the source: typography folded (quotes, dashes, spaces,
 * invisible characters, the section sign), whitespace collapsed. Case and
 * wording must match exactly.
 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .replace(SINGLE_QUOTES_RE, "'")
    .replace(DOUBLE_QUOTES_RE, '"')
    .replace(DASHES_RE, "-")
    .replace(INVISIBLE_RE, "")
    .replace(new RegExp(`${SECTION}\\s*`, "g"), "")
    .split(ELLIPSIS).join("...")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fewer words than this is not a passage (a lone name or "the court"). */
const MIN_PASSAGE_WORDS = 3;

/**
 * Splits passages offered as quotations into those found verbatim (after
 * normalizeForMatch) in one of the source texts and those not found. Only
 * verified passages are kept; a summary with none is not published.
 */
export function verifyPassages(
  passages: readonly string[],
  sourceTexts: readonly string[]
): { verified: string[]; rejected: string[] } {
  const haystacks = sourceTexts.map(normalizeForMatch).filter(Boolean);
  const verified: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const passage of passages) {
    const needle = normalizeForMatch(passage.replace(/^["']+|["']+$/g, ""));
    if (!needle || seen.has(needle)) continue;
    seen.add(needle);
    const words = needle.split(" ").length;
    if (words >= MIN_PASSAGE_WORDS && haystacks.some((h) => h.includes(needle))) verified.push(needle);
    else rejected.push(passage);
  }
  return { verified, rejected };
}

/** True when `url` is https on the default port, without credentials, on one of `hosts`. */
export function isAllowedHttpsUrl(url: string, hosts: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    !parsed.username &&
    !parsed.password &&
    (parsed.port === "" || parsed.port === "443") &&
    hosts.includes(parsed.hostname.toLowerCase())
  );
}

/** Text cut to at most `max` characters at a word boundary, marked when cut. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()} [...]`;
}
