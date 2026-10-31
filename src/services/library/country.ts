// The country a library document is about, as a filter key.
//
// The country-conditions collectors (./adapters/country-conditions/) store
// the country exactly as their source names it in metadata.country
// ("Congo, Democratic Republic of the", "Myanmar (Burma)", "Cote d'Ivoire"),
// and next to it metadata.countryKey and metadata.countryKeys, lookup keys
// derived from that name here; prepare.ts derives countryKeys for any other
// document that states metadata.country (TPS, reciprocity, adoption), and
// search.ts filters on them, so one country's documents from every source
// can be found with one containment test on the keys. The key is
// derived, never shown as a fact: it folds case, accents, apostrophes,
// "X, The" and "Congo, Republic of the" inversions, and the handful of
// alternative names the sources use for the same country
// (ALIASES). Pure: no I/O.

/** Alternative names the sources use, folded to one key (the State Department's name where it has one). */
const ALIASES: Record<string, string> = {
  myanmar: "burma",
  "myanmar-burma": "burma",
  "burma-myanmar": "burma",
  "ivory-coast": "cote-divoire",
  "czech-republic": "czechia",
  swaziland: "eswatini",
  "eswatini-swaziland": "eswatini",
  turkiye: "turkey",
  "turkey-turkiye": "turkey",
  macedonia: "north-macedonia",
  "cape-verde": "cabo-verde",
  "east-timor": "timor-leste",
  kyrgyzstan: "kyrgyz-republic",
  "korea-north": "north-korea",
  "democratic-peoples-republic-of-korea": "north-korea",
  "korea-democratic-peoples-republic-of": "north-korea",
  "korea-south": "south-korea",
  "republic-of-korea": "south-korea",
  "korea-republic-of": "south-korea",
  drc: "democratic-republic-of-the-congo",
  "dr-congo": "democratic-republic-of-the-congo",
  "congo-kinshasa": "democratic-republic-of-the-congo",
  "congo-brazzaville": "republic-of-the-congo",
  "russian-federation": "russia",
  "syrian-arab-republic": "syria",
  "iran-islamic-republic-of": "iran",
  "islamic-republic-of-iran": "iran",
  "viet-nam": "vietnam",
  "lao-pdr": "laos",
  "lao-peoples-democratic-republic": "laos",
  "the-gambia": "gambia",
  "the-bahamas": "bahamas",
  "the-netherlands": "netherlands",
  "federated-states-of-micronesia": "micronesia",
  "micronesia-federated-states-of": "micronesia",
};

// Built from code points to keep this file ASCII: the combining accents NFKD
// splits off (U+0300 to U+036F), and the apostrophes the sources write
// (U+2018, U+2019, U+02BC, the ASCII apostrophe and backtick).
const COMBINING_MARKS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, "g");
const APOSTROPHES = new RegExp(`[${String.fromCharCode(0x2018, 0x2019, 0x2bc)}'\`]`, "g");

/** The trailing parts of an inverted name ("Congo, Republic of the") that go in front again. */
const INVERTED_TAIL = /^(?:the|republic of(?: the)?|democratic republic of(?: the)?|federated states of|islamic republic of|people's republic of|kingdom of(?: the)?)$/i;

/**
 * The lookup key for a country name as a source writes it: lowercase ASCII
 * words joined by hyphens, inversions undone, known alternative names
 * folded (ALIASES). Null for an empty name.
 */
export function countryKey(name: string | null | undefined): string | null {
  if (!name) return null;
  let s = name
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .replace(APOSTROPHES, "")
    .replace(/&/g, " and ")
    // "China (Includes Hong Kong, Macau, and Tibet)" is China's report.
    .replace(/\s*\((?:includes?|including)\b[^)]*\)/gi, "")
    .trim();
  const inverted = /^(.+?),\s*(.+)$/.exec(s);
  if (inverted && INVERTED_TAIL.test(inverted[2].trim())) s = `${inverted[2].trim()} ${inverted[1].trim()}`;
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return null;
  const unprefixed = slug.startsWith("the-") && !ALIASES[slug] ? slug.slice(4) : slug;
  return ALIASES[unprefixed] ?? unprefixed;
}

export type CountryMetadata = { country?: string; countryKey?: string; countries?: string[]; countryKeys?: string[] };

/**
 * The country metadata every collector here writes: for one stated country,
 * metadata.country, metadata.countryKey and metadata.countryKeys ([key]);
 * for several (a report covering more than one), metadata.countries and
 * metadata.countryKeys only. Empty when no country is stated. A lookup by
 * country tests countryKeys, which is set in both cases.
 */
export function countryFields(names: string | readonly (string | null | undefined)[] | null | undefined): CountryMetadata {
  const list = (typeof names === "string" ? [names] : (names ?? []))
    .map((n) => n?.replace(/\s+/g, " ").trim() ?? "")
    .filter((n) => n && countryKey(n));
  const unique = list.filter((n, i) => list.findIndex((m) => countryKey(m) === countryKey(n)) === i);
  if (unique.length === 0) return {};
  const keys = unique.map((n) => countryKey(n)!);
  if (unique.length === 1) return { country: unique[0], countryKey: keys[0], countryKeys: keys };
  return { countries: unique, countryKeys: keys };
}
