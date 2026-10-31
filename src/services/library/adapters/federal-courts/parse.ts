import { attrValue, decodeEntities, inlineText, resolveUrl, tableRows } from "../../extract/html";
import { cleanText } from "../../text";

// Pure parsers for the federal-court collectors in this folder, kept apart
// from the adapters so they can be tried on saved pages:
//
// - GovInfo (www.govinfo.gov): sitemaps, the MODS record of a United States
//   Courts Opinions (USCOURTS) package and of a United States Reports
//   (USREPORTS) volume, the API's package lists.
// - The Supreme Court's "Opinions of the Court" term pages and the running
//   heads that separate a Supreme Court opinion into its syllabus, the
//   opinion of the Court and each separate writing.
// - CourtListener's search API results and opinion records.
// - The immigration filters each collector applies, stated here once.
//
// Every value returned is read from the document as fetched; a field the
// source does not state is null.

// ---------------------------------------------------------------------------
// XML helpers (MODS and sitemaps are simple, well-formed XML)
// ---------------------------------------------------------------------------

function xmlValue(raw: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  return decodeEntities(cdata ? cdata[1] : raw.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** The text of the first <tag> element in `xml` (any attributes), or null. */
export function firstTag(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}\\s*>`, "i").exec(xml);
  if (!m) return null;
  const value = xmlValue(m[1]);
  return value || null;
}

/** The texts of every <tag> element in `xml`, in order, empty ones left out. */
export function allTags(xml: string, tag: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}\\s*>`, "gi"))) {
    const value = xmlValue(m[1]);
    if (value) out.push(value);
  }
  return out;
}

/** The attribute text of the first <tag ...> start tag (self-closing or not), or null. */
function firstTagAttributes(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(\\s[^>]*)?\\/?>`, "i").exec(xml);
  return m ? (m[1] ?? "") : null;
}

/** <url> elements of a <location>, with their displayLabel and access attributes. */
function locationUrls(xml: string): { label: string | null; access: string | null; url: string }[] {
  const out: { label: string | null; access: string | null; url: string }[] = [];
  for (const m of xml.matchAll(/<url\b([^>]*)>([\s\S]*?)<\/url\s*>/gi)) {
    const url = xmlValue(m[2]);
    if (url) out.push({ label: attrValue(m[1], "displayLabel"), access: attrValue(m[1], "access"), url });
  }
  return out;
}

/** An absolute https URL as a source states it (protocol-relative "//host/..." resolved to https); null for anything else. */
export function httpsUrl(raw: string | null | undefined, base = "https://www.govinfo.gov/"): string | null {
  if (!raw) return null;
  const resolved = resolveUrl(raw, base);
  if (!resolved) return null;
  try {
    return new URL(resolved).protocol === "https:" ? resolved : null;
  } catch {
    return null;
  }
}

/** A YYYY-MM-DD the source states, checked to be a real calendar date; null otherwise. */
export function isoDateOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// ---------------------------------------------------------------------------
// Sitemaps (www.govinfo.gov/sitemap/...)
// ---------------------------------------------------------------------------

export type SitemapEntry = { loc: string; lastmod: string | null };

/** The <loc> and <lastmod> of every <sitemap> (an index) or <url> (a urlset) entry; recognized is false when the document is neither. */
export function parseSitemap(xml: string): { recognized: boolean; entries: SitemapEntry[] } {
  const recognized = /<(sitemapindex|urlset)\b/i.test(xml);
  const entries: SitemapEntry[] = [];
  for (const m of xml.matchAll(/<(sitemap|url)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
    const loc = firstTag(m[2], "loc");
    if (loc) entries.push({ loc, lastmod: firstTag(m[2], "lastmod") });
  }
  return { recognized, entries };
}

/** The package ID at the end of a GovInfo details link ("https://www.govinfo.gov/app/details/USCOURTS-ca5-24-40149"). */
export function packageIdFromDetailsUrl(url: string): string | null {
  const m = /\/app\/details\/([A-Za-z0-9_-]+)\/?$/.exec(url);
  return m ? m[1] : null;
}

/**
 * The MODS link a GovInfo details page prints ("MODS" in its downloads,
 * `//www.govinfo.gov/metadata/pkg/<package>/mods.xml`), resolved to https.
 */
export function modsLinkFromDetailsPage(html: string, pageUrl: string): string | null {
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = attrValue(m[1], "href");
    if (href && /\/metadata\/pkg\/[^/]+\/mods\.xml$/i.test(href)) return httpsUrl(href, pageUrl);
  }
  return null;
}

// ---------------------------------------------------------------------------
// USCOURTS MODS (one package = one case; one granule = one opinion or order)
// ---------------------------------------------------------------------------

export type UscourtsParty = { name: string; role: string | null };

export type UscourtsGranule = {
  granuleId: string;
  sequence: number | null;
  title: string | null;
  /** The court's docket entry for the opinion, as GovInfo prints it ("UNPUBLISHED OPINION FILED. [25-60702 Affirmed] ..."). */
  docketText: string | null;
  dateIssued: string | null;
  pdfUrl: string | null;
  detailsUrl: string | null;
  courtName: string | null;
};

export type UscourtsCase = {
  packageId: string;
  title: string | null;
  courtType: string | null;
  courtCode: string | null;
  courtName: string | null;
  circuit: string | null;
  state: string | null;
  caseNumber: string | null;
  caseOffice: string | null;
  caseType: string | null;
  natureSuitCode: string | null;
  natureSuit: string | null;
  cause: string | null;
  parties: UscourtsParty[];
  detailsUrl: string | null;
  dateIssued: string | null;
  granules: UscourtsGranule[];
};

const CONSTITUENT = /<relatedItem\b[^>]*\btype="constituent"/i;

function splitConstituents(xml: string): { head: string; items: string[] } {
  const parts = xml.split(new RegExp(CONSTITUENT.source, "gi"));
  return { head: parts[0] ?? "", items: parts.slice(1) };
}

function partiesOf(xml: string): UscourtsParty[] {
  const out: UscourtsParty[] = [];
  const seen = new Set<string>();
  for (const m of xml.matchAll(/<party\b([^>]*?)\/?>/gi)) {
    const name = attrValue(m[1], "fullName")?.replace(/\s+/g, " ").trim();
    if (!name) continue;
    const role = attrValue(m[1], "role")?.trim() || null;
    const key = `${name}|${role ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, role });
  }
  return out;
}

/**
 * A USCOURTS package's MODS record (https://www.govinfo.gov/metadata/pkg/<id>/mods.xml).
 * Returns null when the document is not a USCOURTS MODS record.
 */
export function parseUscourtsMods(xml: string): UscourtsCase | null {
  if (!/<mods\b/i.test(xml) || !/<collectionCode>\s*USCOURTS\s*<\/collectionCode>/i.test(xml)) return null;
  const { head, items } = splitConstituents(xml);
  const packageId = firstTag(head, "accessId") ?? firstTag(head, "recordIdentifier");
  if (!packageId) return null;
  const titleInfo = /<titleInfo\b[^>]*>([\s\S]*?)<\/titleInfo\s*>/i.exec(head)?.[1] ?? "";
  const headUrls = locationUrls(/<location\b[^>]*>([\s\S]*?)<\/location\s*>/i.exec(head)?.[1] ?? "");
  const granules: UscourtsGranule[] = items.map((item) => {
    const urls = locationUrls(item);
    const pdfHref = /<relatedItem\b[^>]*type="otherFormat"[^>]*xlink:href="([^"]+\.pdf)"/i.exec(item)?.[1] ?? null;
    const sequence = firstTag(item, "sequenceNumber");
    return {
      granuleId: firstTag(item, "accessId") ?? attrValue(` ${/^([^>]*)>/.exec(item)?.[1] ?? ""}`, "ID")?.replace(/^id-/, "") ?? "",
      sequence: sequence !== null && /^\d+$/.test(sequence) ? Number(sequence) : null,
      title: firstTag(item, "title"),
      docketText: firstTag(item, "docketText") ?? firstTag(item, "subTitle"),
      dateIssued: isoDateOrNull(firstTag(item, "dateIssued")),
      pdfUrl: httpsUrl(urls.find((u) => /PDF/i.test(u.label ?? ""))?.url ?? pdfHref),
      detailsUrl: httpsUrl(urls.find((u) => /Content Detail/i.test(u.label ?? ""))?.url ?? null),
      courtName: firstTag(item, "courtName"),
    };
  });
  return {
    packageId,
    title: firstTag(titleInfo, "title"),
    courtType: firstTag(head, "courtType"),
    courtCode: firstTag(head, "courtCode"),
    courtName: granules.find((g) => g.courtName)?.courtName ?? null,
    circuit: firstTag(head, "courtCircuit"),
    state: firstTag(head, "courtState"),
    caseNumber: firstTag(head, "caseNumber"),
    caseOffice: firstTag(head, "caseOffice"),
    caseType: firstTag(head, "caseType"),
    natureSuitCode: firstTag(head, "natureSuitCode"),
    natureSuit: firstTag(head, "natureSuit"),
    cause: firstTag(head, "cause"),
    parties: partiesOf(head),
    detailsUrl: httpsUrl(headUrls.find((u) => /Content Detail/i.test(u.label ?? ""))?.url ?? null),
    dateIssued: isoDateOrNull(firstTag(/<originInfo\b[^>]*>([\s\S]*?)<\/originInfo\s*>/i.exec(head)?.[1] ?? "", "dateIssued")),
    granules: granules.filter((g) => g.granuleId),
  };
}

// ---------------------------------------------------------------------------
// GovInfo API package lists (/published and /collections)
// ---------------------------------------------------------------------------

export type GovinfoPackageEntry = { packageId: string; title: string | null; dateIssued: string | null; lastModified: string | null };

/** A GovInfo API page of packages; null when the JSON is not one. */
export function parseGovinfoPackageList(data: unknown): { count: number | null; nextPage: string | null; packages: GovinfoPackageEntry[] } | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { count?: unknown; nextPage?: unknown; packages?: unknown };
  if (!Array.isArray(d.packages)) return null;
  const packages: GovinfoPackageEntry[] = [];
  for (const p of d.packages) {
    if (!p || typeof p !== "object") continue;
    const e = p as Record<string, unknown>;
    if (typeof e.packageId !== "string" || !e.packageId) continue;
    packages.push({
      packageId: e.packageId,
      title: typeof e.title === "string" ? e.title : null,
      dateIssued: typeof e.dateIssued === "string" ? isoDateOrNull(e.dateIssued) : null,
      lastModified: typeof e.lastModified === "string" ? e.lastModified : null,
    });
  }
  return {
    count: typeof d.count === "number" ? d.count : null,
    nextPage: typeof d.nextPage === "string" && d.nextPage ? d.nextPage : null,
    packages,
  };
}

/** The offsetMark of a GovInfo nextPage link (the API's own deep-paging cursor). */
export function offsetMarkOf(nextPage: string | null): string | null {
  if (!nextPage) return null;
  try {
    return new URL(nextPage).searchParams.get("offsetMark");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Court of appeals opinions on GovInfo: which are immigration cases, and
// how the court marked them
// ---------------------------------------------------------------------------

/**
 * Attorneys General and acting Attorneys General since 1988, the respondent
 * a petition for review of a Board of Immigration Appeals decision names
 * (INA 242(b)(3)(A), 8 U.S.C. 1252(b)(3)(A)), as the courts caption them.
 */
const ATTORNEYS_GENERAL = [
  "Thornburgh",
  "Barr",
  "Gerson",
  "Reno",
  "Ashcroft",
  "Gonzales",
  "Keisler",
  "Mukasey",
  "Filip",
  "Holder",
  "Lynch",
  "Yates",
  "Boente",
  "Sessions",
  "Whitaker",
  "Rosen",
  "Wilkinson",
  "Garland",
  "Bondi",
  "Blanche",
];
const AG_PARTY = new RegExp(`\\b(?:Attorney General|Atty\\.? Gen|${ATTORNEYS_GENERAL.join("|")})\\b`, "i");

/** Immigration agencies and offices as they appear in party names and captions. */
const IMMIGRATION_PARTY =
  /\b(?:Immigration|Naturalization|Homeland Security|Citizenship and Immigration|Customs Enforcement|Customs and Border|Border Patrol|Bureau of Citizenship|Field Office Director|Service Processing Center|Enforcement and Removal|I\.\s?N\.\s?S\.|INS|ICE|DHS|USCIS|BICE|CBP)\b/;

/** The civil natures of suit (JS 44) for immigration: 462 naturalization, 463 alien detainee habeas, 465 other immigration actions. */
export const IMMIGRATION_NATURES_OF_SUIT = ["462", "463", "465"];

/** A case caption worth reading the MODS record of (the cheap first pass over a list of titles). */
export function appellateTitleCandidate(title: string | null): boolean {
  return Boolean(title && (AG_PARTY.test(title) || IMMIGRATION_PARTY.test(title)));
}

export type ImmigrationVerdict = { kind: "immigration" | "maybe" | "no"; reasons: string[] };

/**
 * Whether a court of appeals case on GovInfo is an immigration case, from its
 * MODS record alone:
 * - "immigration": a petition for review naming the Attorney General as
 *   respondent (how every petition for review of a Board decision is
 *   captioned), or a party or the caption naming an immigration agency;
 * - "maybe": the Attorney General is a party in an appeal (immigration
 *   habeas and APA appeals, but also firearms, FOIA and other cases): the
 *   opinion's text decides (decisiveImmigrationTerms);
 * - "no": neither.
 */
export function appellateImmigrationVerdict(c: Pick<UscourtsCase, "title" | "parties" | "natureSuitCode" | "natureSuit">): ImmigrationVerdict {
  const reasons: string[] = [];
  // An appeal from a district court case filed under an immigration nature of suit.
  if (c.natureSuitCode && IMMIGRATION_NATURES_OF_SUIT.includes(c.natureSuitCode)) reasons.push(`nature of suit ${c.natureSuitCode}${c.natureSuit ? ` ${c.natureSuit}` : ""}`);
  const petitioner = c.parties.some((p) => /^petitioner/i.test(p.role ?? ""));
  for (const p of c.parties) {
    if (/^respondent/i.test(p.role ?? "") && AG_PARTY.test(p.name) && petitioner) reasons.push(`petition for review naming the Attorney General as respondent (${p.name})`);
    if (IMMIGRATION_PARTY.test(p.name)) reasons.push(`party ${p.name}${p.role ? ` (${p.role})` : ""}`);
  }
  if (c.title && IMMIGRATION_PARTY.test(c.title)) reasons.push(`caption ${c.title}`);
  if (reasons.length) return { kind: "immigration", reasons: [...new Set(reasons)] };
  const ag = c.parties.find((p) => AG_PARTY.test(p.name)) ?? (c.title && AG_PARTY.test(c.title) ? { name: c.title, role: null } : null);
  if (ag) return { kind: "maybe", reasons: [`the Attorney General is a party (${ag.name})`] };
  return { kind: "no", reasons: [] };
}

export type PrecedentialReading = { status: "precedential" | "non_precedential" | "unknown"; basis: string | null };

const NON_PRECEDENTIAL_MARKS: RegExp[] = [
  /\bUNPUBLISHED\b/i,
  /\bNOT[- ]PRECEDENTIAL\b/i,
  /\bNON-?PRECEDENTIAL\b/i,
  /\bNOT RECOMMENDED FOR (?:FULL[- ]TEXT )?PUBLICATION\b/i,
  /\bNOT FOR PUBLICATION\b/i,
  /\bSUMMARY ORDER\b/i,
  /\bMEMORANDUM\s*\*?\s*$/im,
  /\bshould not be published and is not precedent\b/i,
  /\bnot designated for publication\b/i,
  /\bPER CURIAM JUDGMENT\b/i,
  /\bDO NOT PUBLISH\b/i,
  /\bnonprecedential disposition\b/i,
];
const PRECEDENTIAL_MARKS: RegExp[] = [/\bPUBLISHED\b/i, /\bPRECEDENTIAL\b/i, /\bFOR PUBLICATION\b/i, /\bPublish\b/, /\bFILED OPINION\b/, /\bRECOMMENDED FOR (?:FULL[- ]TEXT )?PUBLICATION\b/i];

/**
 * How a court of appeals marked an opinion: first from the docket text
 * GovInfo prints ("PUBLISHED OPINION FILED", "UNPUBLISHED OPINION FILED",
 * "Publish", "FILED OPINION" in the Ninth Circuit, which sends GovInfo its
 * published opinions only), then from the legend on the opinion's first
 * page ("NOT RECOMMENDED FOR PUBLICATION", "NOT PRECEDENTIAL", "SUMMARY
 * ORDER"...). Unknown when neither says.
 */
export function appellatePrecedential(docketText: string | null, firstPageText: string | null): PrecedentialReading {
  for (const [source, text] of [
    ["docket text", docketText],
    ["first page", firstPageText],
  ] as const) {
    if (!text) continue;
    const non = NON_PRECEDENTIAL_MARKS.find((re) => re.test(text));
    if (non) return { status: "non_precedential", basis: `${source}: ${non.exec(text)?.[0].trim()}` };
    const pub = PRECEDENTIAL_MARKS.find((re) => re.test(text));
    if (pub) return { status: "precedential", basis: `${source}: ${pub.exec(text)?.[0].trim()}` };
  }
  return { status: "unknown", basis: null };
}

/**
 * The summary court staff print at the head of a published opinion (the
 * Ninth Circuit's "SUMMARY*", "This summary constitutes no part of the
 * opinion of the court"), verbatim up to the COUNSEL or OPINION heading;
 * null when the opinion has none.
 */
export function courtStaffSummary(text: string): string | null {
  const head = text.slice(0, 40_000);
  const start = /^\s*SUMMARY\s*\*{1,3}\s*$/m.exec(head);
  if (!start) return null;
  const rest = head.slice((start.index ?? 0) + start[0].length);
  const end = /^\s*(?:COUNSEL|OPINION|ORDER)\s*$/m.exec(rest);
  if (!end) return null;
  const body = cleanText(rest.slice(0, end.index).replace(/^\[Page \d+\]$/gm, ""));
  return body.length >= 80 && body.length <= 12_000 ? body : null;
}

/** The court of appeals number GovInfo's courtCircuit states ("5th" → "5", "DC" for the D.C. Circuit). */
export function circuitNumber(courtCircuit: string | null, courtCode: string | null): string | null {
  const m = /^(\d{1,2})(?:st|nd|rd|th)$/i.exec(courtCircuit ?? "");
  if (m) return String(Number(m[1]));
  if (/^cadc$/i.test(courtCode ?? "") || /^DC$/i.test(courtCircuit ?? "")) return "DC";
  const c = /^ca(\d{1,2})$/i.exec(courtCode ?? "");
  return c ? String(Number(c[1])) : null;
}

// ---------------------------------------------------------------------------
// Immigration terms in an opinion's text (Supreme Court syllabi, the
// "maybe" appeals above)
// ---------------------------------------------------------------------------

const IMMIGRATION_TERMS: [string, RegExp][] = [
  ["immigration", /\bimmigra(?:tion|nts?)\b/i],
  ["deportation", /\bdeport(?:ation|ed|able|ability)?\b/i],
  ["removal", /\b(?:removal proceedings?|order(?:s)? of removal|removal order|removable|cancellation of removal|withholding of removal)\b/i],
  ["noncitizen", /\bnoncitizens?\b/i],
  ["alien", /\baliens?\b(?! tort)/i],
  ["naturalization", /\b(?:naturaliz(?:ation|ed|e)|denaturaliz\w*)\b/i],
  ["asylum", /\basylum\b(?! (?:hospital|for the insane))/i],
  ["refugee", /\brefugees?\b/i],
  ["Board of Immigration Appeals", /\bBoard of Immigration Appeals\b/],
  ["Immigration and Nationality Act", /\bImmigration and Nationality Act\b/],
  ["8 U.S.C.", /\b8 U\.\s?S\.\s?C\.?\s/],
  ["Homeland Security", /\bHomeland Security\b/],
  ["citizenship", /\b(?:Citizenship Clause|citizens? at birth|birthright citizenship|citizenship of (?:a|the) child)\b/i],
  ["visa", /\bvisas?\b/i],
  ["Alien Enemies Act", /\bAlien Enem(?:y|ies) Act\b/i],
  ["Chinese exclusion", /\bChinese (?:Exclusion|laborers?)\b/i],
];

/** The immigration terms (by label) `text` uses; empty when none. */
export function immigrationTermsIn(text: string): string[] {
  return IMMIGRATION_TERMS.filter(([, re]) => re.test(text)).map(([label]) => label);
}

/** Terms that only an immigration case uses (not "alien", "visa" or "Homeland Security", which firearms, tax and other cases use too). */
const DECISIVE_TERMS = new Set(["Board of Immigration Appeals", "removal", "deportation", "noncitizen", "naturalization", "asylum", "refugee", "Immigration and Nationality Act", "8 U.S.C."]);

/**
 * The terms that make an opinion an immigration case when its parties alone
 * do not say: at least two distinct decisive terms; empty otherwise.
 */
export function decisiveImmigrationTerms(text: string): string[] {
  const found = immigrationTermsIn(text).filter((t) => DECISIVE_TERMS.has(t));
  return found.length >= 2 ? found : [];
}

// ---------------------------------------------------------------------------
// United States Reports volumes on GovInfo (USREPORTS)
// ---------------------------------------------------------------------------

export type UsReportsCase = {
  granuleId: string;
  title: string;
  usCitation: string | null;
  fullCitation: string | null;
  /** Full date only when GovInfo states the day (no notSpecified attribute). */
  decisionDate: string | null;
  decisionDateText: string | null;
  decisionYear: number | null;
  pdfUrl: string | null;
  detailsUrl: string | null;
  courtTerm: string | null;
  docketId: string | null;
  /** Subject headings of the Law Library of Congress (llc) and the Supreme Court Database (scdb) the record carries. */
  topics: string[];
  scdbIssues: string[];
  adminAction: string | null;
  petitioner: string | null;
  respondent: string | null;
  legalProvisions: string[];
  caseOrigin: string | null;
  caseSource: string | null;
  jurisdiction: string | null;
  decisionType: string | null;
  disposition: string | null;
  majorityWriter: string | null;
  votes: { majority: number | null; minority: number | null } | null;
  dateArgument: string | null;
  chiefJustice: string | null;
};

export type UsReportsVolume = {
  packageId: string;
  volume: number | null;
  title: string | null;
  courtTerm: string | null;
  dateIssued: string | null;
  cases: UsReportsCase[];
  /** Constituent records that are not cases (front and back matter). */
  otherGranules: number;
};

/** A United States Reports volume's MODS record; null when the document is not one. */
export function parseUsReportsVolumeMods(xml: string): UsReportsVolume | null {
  if (!/<mods\b/i.test(xml) || !/<collectionCode>\s*USREPORTS\s*<\/collectionCode>/i.test(xml)) return null;
  const { head, items } = splitConstituents(xml);
  const packageId = firstTag(head, "accessId");
  if (!packageId) return null;
  const volume = firstTag(head, "volume");
  const cases: UsReportsCase[] = [];
  let otherGranules = 0;
  for (const item of items) {
    if (!/<granuleClass>\s*CASE\s*<\/granuleClass>/i.test(item)) {
      otherGranules++;
      continue;
    }
    const granuleId = firstTag(item, "accessId");
    const title = firstTag(item, "title");
    if (!granuleId || !title) continue;
    const urls = locationUrls(item);
    const dateAttrs = firstTagAttributes(item, "decisionDate");
    const decisionDateText = firstTag(item, "decisionDate");
    const dayStated = dateAttrs !== null && !/notSpecified/i.test(dateAttrs);
    const year = /^(\d{4})/.exec(decisionDateText ?? "")?.[1] ?? /\((\d{4})\)\s*$/.exec(firstTag(item, "fullCitation") ?? "")?.[1] ?? null;
    const llc: string[] = [];
    const scdb: string[] = [];
    for (const s of item.matchAll(/<subject\b([^>]*)>([\s\S]*?)<\/subject\s*>/gi)) {
      const target = /scdb/i.test(attrValue(s[1], "authority") ?? "") ? scdb : llc;
      for (const t of allTags(s[2], "topic")) target.push(t);
    }
    const majority = firstTag(item, "majority");
    const minority = firstTag(item, "minority");
    cases.push({
      granuleId,
      title,
      usCitation: firstTag(item, "usCitation"),
      fullCitation: firstTag(item, "fullCitation"),
      decisionDate: dayStated ? isoDateOrNull(decisionDateText) : null,
      decisionDateText,
      decisionYear: year ? Number(year) : null,
      pdfUrl: httpsUrl(urls.find((u) => /PDF/i.test(u.label ?? ""))?.url ?? null),
      detailsUrl: httpsUrl(urls.find((u) => /Content Detail/i.test(u.label ?? ""))?.url ?? null),
      courtTerm: firstTag(item, "courtTerm"),
      docketId: firstTag(item, "docketId"),
      topics: [...new Set(llc)],
      scdbIssues: [...new Set(scdb)],
      adminAction: firstTag(item, "adminAction"),
      petitioner: firstTag(item, "petitioner"),
      respondent: firstTag(item, "respondent"),
      legalProvisions: allTags(item, "legalProvisions"),
      caseOrigin: firstTag(item, "caseOrigin"),
      caseSource: firstTag(item, "caseSource"),
      jurisdiction: firstTag(item, "jurisdiction"),
      decisionType: firstTag(item, "decisionType"),
      disposition: firstTag(item, "disposition"),
      majorityWriter: firstTag(/<majorityOpinion\b[^>]*>([\s\S]*?)<\/majorityOpinion\s*>/i.exec(item)?.[1] ?? "", "writer"),
      votes: majority !== null || minority !== null ? { majority: majority && /^\d+$/.test(majority) ? Number(majority) : null, minority: minority && /^\d+$/.test(minority) ? Number(minority) : null } : null,
      dateArgument: isoDateOrNull(firstTag(item, "dateArgument")),
      chiefJustice: firstTag(item, "chiefJustice"),
    });
  }
  return {
    packageId,
    volume: volume && /^\d+$/.test(volume) ? Number(volume) : null,
    title: firstTag(head, "title"),
    courtTerm: firstTag(head, "courtTerm"),
    dateIssued: firstTag(head, "dateIssued"),
    cases,
    otherGranules,
  };
}

/** The volume number in a USREPORTS package ID ("USREPORTS-343" → 343). */
export function usReportsVolumeOf(packageId: string): number | null {
  const m = /^USREPORTS-(\d+)$/.exec(packageId);
  return m ? Number(m[1]) : null;
}

const US_REPORTS_PARTY = /Immigration and Naturalization Service|Board of Immigration Appeals|Alien, person subject to a denaturalization|Immigration and Naturalization, Immigration, Nationality|Homeland Security|Citizenship and Immigration|Customs Enforcement/i;
const US_REPORTS_TOPIC =
  /^(?:Immigration\b.*|Deportation\b.*|Aliens|Illegal Aliens|Resident Aliens|Undocumented Immigrants|Naturalization|Denaturalization|Fraudulent Naturalization|Revocation of Citizenship|Removal Hearing|Chinese Exclusion Act|Alien Registration Act of 1940|Nationality Act of 1940|Immigration and Nationality Act.*|Immigrant Responsibility Act of 1996|Border Security|Visas and Passports|Asylum.*|Refugees?\b.*|Alien Enemies|Alien Enemy Act of 1798|Expatriation)$/i;
const US_REPORTS_TITLE = /\b(?:Immigration|Naturalization|Homeland Security|Chinese Exclusion|I\.\s?N\.\s?S\.|INS)\b/;

/**
 * Why a United States Reports case is an immigration case, from GovInfo's
 * record of it: the Supreme Court Database's party, administrative-agency
 * and legal-provision codes (an alien or the INS as a party, the INS or the
 * Board as the agency below, the immigration acts), the Law Library of
 * Congress and Supreme Court Database subject headings (Immigration,
 * Deportation, Aliens, Naturalization, Chinese Exclusion Act, Visas and
 * Passports...), or the caption (an immigration agency as a party). Empty
 * when nothing does; "Citizenship and Nationality" alone is not enough (it
 * also marks diversity-of-citizenship cases).
 */
export function usReportsImmigrationReasons(c: UsReportsCase): string[] {
  const reasons: string[] = [];
  for (const [field, value] of [
    ["adminAction", c.adminAction],
    ["petitioner", c.petitioner],
    ["respondent", c.respondent],
  ] as const) {
    if (value && US_REPORTS_PARTY.test(value)) reasons.push(`${field}: ${value}`);
  }
  for (const p of c.legalProvisions) if (US_REPORTS_PARTY.test(p)) reasons.push(`legalProvisions: ${p}`);
  for (const t of [...c.topics, ...c.scdbIssues]) if (US_REPORTS_TOPIC.test(t.trim())) reasons.push(`subject: ${t}`);
  if (US_REPORTS_TITLE.test(c.title)) reasons.push(`caption: ${c.title}`);
  return [...new Set(reasons)];
}

/** Whether GovInfo's record carries any subject or Supreme Court Database fields for the case (recent volumes do not yet). */
export function usReportsHasSubjectData(c: UsReportsCase): boolean {
  return c.topics.length > 0 || c.scdbIssues.length > 0 || Boolean(c.adminAction || c.petitioner || c.respondent);
}

// ---------------------------------------------------------------------------
// Supreme Court: "Opinions of the Court" term pages
// ---------------------------------------------------------------------------

export type SlipTermLink = { term: number; url: string };

/** The term pages the side menu links ("2026" → /opinions/slipopinion/26), newest first. */
export function parseSlipTermLinks(html: string, pageUrl: string): SlipTermLink[] {
  const out = new Map<number, string>();
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const text = inlineText(m[2]);
    const href = attrValue(m[1], "href");
    if (!href || !/^(?:19|20)\d{2}$/.test(text)) continue;
    const url = resolveUrl(href, pageUrl);
    if (!url || !/\/opinions\/slipopinion\/\d{2}$/.test(new URL(url).pathname)) continue;
    out.set(Number(text), url);
  }
  return [...out.entries()].sort((a, b) => b[0] - a[0]).map(([term, url]) => ({ term, url }));
}

export type SlipOpinionRow = {
  /** The Reporter of Decisions' sequential number for the opinion in the term. */
  r: number;
  dateText: string;
  docket: string;
  name: string;
  /** The opinion's link as the page gives it, resolved (a slip opinion PDF, or a page of a preliminary print or bound volume). */
  url: string;
  /** The page's one-sentence statement of the holding (the link's title text). */
  summary: string | null;
  justice: string | null;
  citationText: string | null;
  revisions: { dateText: string; url: string }[];
};

/**
 * One term's table ("Term Year: 2025"). recognized is false when the page
 * has no table with the R-, Date, Docket, Name, J. and Citation columns (a
 * changed layout); a recognized table with no rows is an empty term.
 */
export function parseSlipOpinionPage(html: string, pageUrl: string): { term: number | null; recognized: boolean; rows: SlipOpinionRow[] } {
  const termText = /Term Year:\s*(\d{4})/i.exec(html)?.[1] ?? null;
  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)].map((m) => m[1]);
  const opinionTables = tables.filter((t) => {
    const head = (tableRows(t)[0] ?? []).map((c) => inlineText(c).replace(/\s+/g, ""));
    return head.join("|") === "R-|Date|Docket|Name|J.|Citation";
  });
  const rows: SlipOpinionRow[] = [];
  for (const table of opinionTables) {
    for (const cells of tableRows(table).slice(1)) {
      if (cells.length < 6) continue;
      const r = inlineText(cells[0]);
      const link = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/i.exec(cells[3]);
      const href = link ? attrValue(link[1], "href") : null;
      const url = href ? resolveUrl(href, pageUrl) : null;
      if (!/^\d+$/.test(r) || !link || !url) continue;
      const revisions: { dateText: string; url: string }[] = [];
      const revisionsAt = cells[3].search(/Revisions/i);
      if (revisionsAt >= 0) {
        for (const a of cells[3].slice(revisionsAt).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
          const revHref = attrValue(a[1], "href");
          const revUrl = revHref ? resolveUrl(revHref, pageUrl) : null;
          if (revUrl) revisions.push({ dateText: inlineText(a[2]), url: revUrl });
        }
      }
      rows.push({
        r: Number(r),
        dateText: inlineText(cells[1]),
        docket: inlineText(cells[2]),
        name: inlineText(link[2]),
        url,
        summary: attrValue(link[1], "title")?.replace(/\s+/g, " ").trim() || null,
        justice: inlineText(cells[4]) || null,
        citationText: inlineText(cells[5]) || null,
        revisions,
      });
    }
  }
  return { term: termText ? Number(termText) : null, recognized: opinionTables.length > 0, rows };
}

/** The table's date ("6/30/26", decided-on; the year in two digits) as YYYY-MM-DD; null when it does not parse. */
export function slipTableDate(text: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text.trim());
  if (!m) return null;
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return isoDateOrNull(`${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`);
}

/** The definitions page's table of Justice codes ("BK: Associate Justice Brett M. Kavanaugh"). */
export function parseJusticeCodes(html: string): Record<string, string> {
  const text = inlineText(html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " "));
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/\b([A-Z]{1,2}): ((?:Chief Justice|Associate Justice) [A-Z][A-Za-z.,' -]+?|Decree in Original Case|Unsigned Per Curiam Opinion(?: or decree)?)(?= [A-Z]{1,2}: | Citation:|$)/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

/** "609 U.S. 672" when the table gives the paginated citation; null for "609/2" (volume and preliminary-print part, not yet paginated). */
export function slipCitation(citationText: string | null): { citation: string | null; volume: number | null; part: number | null } {
  if (!citationText) return { citation: null, volume: null, part: null };
  const full = /^(\d{1,3}) U\.\s?S\. (\d{1,4})$/.exec(citationText.trim());
  if (full) return { citation: `${full[1]} U.S. ${full[2]}`, volume: Number(full[1]), part: null };
  const pp = /^(\d{1,3})\/(\d{1,2})$/.exec(citationText.trim());
  if (pp) return { citation: null, volume: Number(pp[1]), part: Number(pp[2]) };
  return { citation: null, volume: null, part: null };
}

/** The first page a "#page=N" link opens at, or null. */
export function pageFragment(url: string): number | null {
  const m = /#page=(\d+)$/.exec(url);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// The parts of a Supreme Court opinion, from its running heads
// ---------------------------------------------------------------------------

export type PdfPage = { page: number; text: string };

/** The pages of extractPdfText's output ("[Page N]" markers). */
export function pdfPages(text: string): PdfPage[] {
  const out: PdfPage[] = [];
  const re = /^\[Page (\d+)\]$/gm;
  const marks = [...text.matchAll(re)];
  marks.forEach((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < marks.length ? (marks[i + 1].index ?? text.length) : text.length;
    out.push({ page: Number(m[1]), text: text.slice(start, end).trim() });
  });
  return out;
}

const JUSTICE_NAME = "[A-Z][A-Za-z'’. -]+?";
const PART_LABELS: RegExp[] = [
  /^Syllabus\.?$/,
  /^Opinion of the Court\.?$/i,
  /^Per Curiam\.?$/i,
  /^Statement of the Case\.?$/i,
  new RegExp(`^Opinion of ${JUSTICE_NAME}, (?:C\\. )?J\\.$`),
  new RegExp(`^${JUSTICE_NAME}, (?:C\\. )?J\\., (?:concurring|dissenting|announcing|respecting|statement)[A-Za-z ,]*\\.?$`),
  new RegExp(`^Statement of ${JUSTICE_NAME}, (?:C\\. )?J\\.$`),
  // Nineteenth-century volumes: "Dissenting Opinion: Brewer, J.", "Concurring Opinion: Field, J."
  new RegExp(`^(?:Dissenting|Concurring) Opinions?\\s?: ${JUSTICE_NAME}, (?:C\\. )?J\\.$`),
  /^Appendix(?: [A-Za-z].*)?$/,
];

/** The part label among a page's first lines (its running head), or null. */
function runningHead(pageText: string): string | null {
  const lines = pageText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 6);
  for (const raw of lines) {
    // Bound-volume heads carry the case's first page or the volume beside
    // the label ("169 Opinion of the Court.", "Opinion of the Court. 343 U. S."),
    // and OCR of older volumes spaces letters out ("Bla ck , J., dissenting.").
    const line = raw
      .replace(/^\d{1,4}\s+/, "")
      .replace(/\s+\d{1,4}\s+U\.\s?S\.$/, "")
      .replace(/\s+,/g, ",")
      .trim();
    // "Syllabus." and "Opinion of the Court." lose their period; "Opinion of Alito, J." keeps it.
    if (PART_LABELS.some((re) => re.test(line))) return /\bJ\.$/.test(line) ? line : line.replace(/\.$/, "");
  }
  return null;
}

/** Labels compared without spaces or case, so OCR spacing ("Jac kso n" / "Jack son") does not split a part. */
const labelKey = (label: string) => label.replace(/\s+/g, "").toLowerCase();

/**
 * The pages of one case in a preliminary print or bound volume, from the
 * page the Court's table links to up to the page before the next case the
 * table links into the same file (cases follow one another in the United
 * States Reports). For the last of them, which is followed by the orders
 * and other matter: every following page whose running head cites the case
 * ("Cite as: 588 U. S. 840 (2019)", odd pages) and the caption page after
 * each of them (even pages); without the case's citation, to the end of the
 * file.
 */
export function casePageRange(pages: PdfPage[], start: number, nextStart: number | null, cite: { volume: number; page: number } | null): { first: number; last: number } {
  const maxPage = pages.length ? pages[pages.length - 1].page : start;
  if (nextStart !== null && nextStart > start) return { first: start, last: Math.min(nextStart - 1, maxPage) };
  const bound = maxPage;
  if (!cite) return { first: start, last: bound };
  const citeRe = new RegExp(`Cite as: ${cite.volume} U\\.\\s?S\\. ${cite.page}\\b`);
  const captionRe = /^\d{0,4}\s*[A-Z][A-Z0-9 .,'’&()-]* v\. [A-Z0-9 .,'’&()-]+(?:\s\d{1,4})?$/;
  let last = start;
  for (const p of pages) {
    if (p.page <= start) continue;
    if (p.page > bound) break;
    const head = p.text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 4);
    if (head.some((l) => citeRe.test(l))) last = p.page;
    else if (p.page === last + 1 && head.some((l) => captionRe.test(l)) && !head.some((l) => /OCTOBER TERM|^ORDERS\b/.test(l))) last = p.page;
    else if (p.page > last + 1) break;
  }
  return { first: start, last };
}

export type OpinionPart = { label: string; firstPage: number; lastPage: number };

/**
 * The syllabus, the opinion of the Court and each separate writing, as the
 * running head of each page names them ("Syllabus", "Opinion of the Court",
 * "THOMAS, J., dissenting"). A page whose head names no part continues the
 * part before it. Empty when no page has a recognizable head.
 */
export function opinionParts(pages: PdfPage[]): OpinionPart[] {
  const parts: OpinionPart[] = [];
  for (const p of pages) {
    const label = runningHead(p.text);
    const last = parts[parts.length - 1];
    if (label && (!last || labelKey(last.label) !== labelKey(label))) parts.push({ label, firstPage: p.page, lastPage: p.page });
    else if (last) last.lastPage = p.page;
  }
  return parts;
}

const HEAD_LINE = /^(?:\d{1,4}\s*)?(?:\(Slip Opinion\)\s*)?(?:OCTOBER TERM, \d{4}\.?|Cite as: .*|Syllabus\.?|[A-Z0-9][A-Z0-9 .,'’&()-]* v\. [A-Z0-9 .,'’&()-]+(?: \d{1,4})?)$/;

/**
 * The syllabus as the Reporter of Decisions prints it: the pages of the
 * first "Syllabus" part, with each page's running head lines (page number,
 * caption, "Cite as", "Syllabus") left out. Null when there is none.
 */
export function syllabusText(pages: PdfPage[], parts: OpinionPart[]): string | null {
  const part = parts.find((p) => p.label === "Syllabus");
  if (!part) return null;
  const chunks: string[] = [];
  for (const p of pages) {
    if (p.page < part.firstPage || p.page > part.lastPage) continue;
    const lines = p.text.split("\n");
    let skip = 0;
    while (skip < Math.min(lines.length, 5) && (lines[skip].trim() === "" || HEAD_LINE.test(lines[skip].trim()))) skip++;
    chunks.push(lines.slice(skip).join("\n").trim());
  }
  const text = cleanText(chunks.join("\n\n"));
  return text || null;
}

// ---------------------------------------------------------------------------
// CourtListener (search API v4, opinions API v4)
// ---------------------------------------------------------------------------

export type ClOpinionRef = {
  id: number;
  type: string | null;
  downloadUrl: string | null;
  sha1: string | null;
  authorId: number | null;
  perCuriam: boolean;
};

export type ClCluster = {
  clusterId: number;
  absoluteUrl: string;
  caseName: string;
  caseNameFull: string | null;
  courtId: string;
  court: string | null;
  dateFiled: string | null;
  dateArgued: string | null;
  docketNumber: string | null;
  docketId: number | null;
  status: string | null;
  citations: string[];
  judge: string | null;
  panelNames: string[];
  syllabus: string | null;
  posture: string | null;
  proceduralHistory: string | null;
  suitNature: string | null;
  source: string | null;
  opinions: ClOpinionRef[];
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

/** A page of CourtListener's search API (type=o); null when the JSON is not one. */
export function parseClSearchPage(data: unknown): { count: number | null; next: string | null; results: ClCluster[] } | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { count?: unknown; next?: unknown; results?: unknown };
  if (!Array.isArray(d.results)) return null;
  const results: ClCluster[] = [];
  for (const raw of d.results) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const clusterId = int(r.cluster_id);
    const absoluteUrl = str(r.absolute_url);
    const caseName = str(r.caseName) ?? str(r.caseNameFull);
    const courtId = str(r.court_id);
    if (clusterId === null || !absoluteUrl || !caseName || !courtId) continue;
    const opinions: ClOpinionRef[] = [];
    for (const o of Array.isArray(r.opinions) ? r.opinions : []) {
      if (!o || typeof o !== "object") continue;
      const op = o as Record<string, unknown>;
      const id = int(op.id);
      if (id === null) continue;
      opinions.push({
        id,
        type: str(op.type),
        downloadUrl: str(op.download_url),
        sha1: str(op.sha1),
        authorId: int(op.author_id),
        perCuriam: op.per_curiam === true,
      });
    }
    results.push({
      clusterId,
      absoluteUrl,
      caseName,
      caseNameFull: str(r.caseNameFull),
      courtId,
      court: str(r.court),
      dateFiled: isoDateOrNull(str(r.dateFiled)),
      dateArgued: isoDateOrNull(str(r.dateArgued)),
      docketNumber: str(r.docketNumber),
      docketId: int(r.docket_id),
      status: str(r.status),
      citations: Array.isArray(r.citation) ? r.citation.filter((c): c is string => typeof c === "string" && c.trim() !== "").map((c) => c.trim()) : [],
      judge: str(r.judge),
      panelNames: Array.isArray(r.panel_names) ? r.panel_names.filter((c): c is string => typeof c === "string") : [],
      syllabus: str(r.syllabus),
      posture: str(r.posture),
      proceduralHistory: str(r.procedural_history),
      suitNature: str(r.suitNature),
      source: str(r.source),
      opinions,
    });
  }
  return { count: typeof d.count === "number" ? d.count : null, next: str(d.next), results };
}

/** The cursor parameter of a CourtListener "next" link. */
export function clCursorOf(next: string | null): string | null {
  if (!next) return null;
  try {
    return new URL(next).searchParams.get("cursor");
  } catch {
    return null;
  }
}

/** The text fields of a CourtListener opinion record, richest first (HTML with citations linked, the Columbia, Lawbox and Harvard Caselaw Access Project texts, plain HTML), then plain text. */
const CL_TEXT_FIELDS = ["html_with_citations", "html_columbia", "html_lawbox", "xml_harvard", "html_anon_2020", "html"] as const;

/** The opinion's text and the field it came from (HTML fields as HTML, to be converted by the caller); null when every field is empty. */
export function clOpinionTextSource(op: Record<string, unknown>): { field: string; html: string | null; plain: string | null } | null {
  for (const field of CL_TEXT_FIELDS) {
    const v = op[field];
    if (typeof v === "string" && v.replace(/<[^>]*>/g, "").trim().length > 0) return { field, html: v, plain: null };
  }
  const plain = op.plain_text;
  if (typeof plain === "string" && plain.trim()) return { field: "plain_text", html: null, plain };
  return null;
}

/** How CourtListener's opinion types read in a heading ("lead-opinion" or "020lead" → "Lead opinion"). */
export function clOpinionTypeLabel(type: string | null): string {
  const t = (type ?? "").replace(/^\d+/, "").replace(/-opinion$/, "").replace(/-/g, " ").trim();
  const known: Record<string, string> = {
    combined: "Opinion",
    lead: "Lead opinion",
    plurality: "Plurality opinion",
    concurrence: "Concurrence",
    concurrenceinpart: "Concurrence in part and dissent in part",
    "concurrence in part": "Concurrence in part",
    "in part": "Concurrence in part and dissent in part",
    dissent: "Dissent",
    addendum: "Addendum",
    remittitur: "Remittitur",
    rehearing: "On rehearing",
    onthemerits: "On the merits",
    "on the merits": "On the merits",
    onmotiontostrike: "On motion to strike",
    "on motion to strike": "On motion to strike",
    trialcourt: "Trial court opinion",
    "trial court": "Trial court opinion",
    "unanimous": "Unanimous opinion",
  };
  return known[t] ?? (t ? t[0].toUpperCase() + t.slice(1) : "Opinion");
}

/**
 * Precedential status from CourtListener's status field ("Published",
 * "Unpublished"), except that a case whose only reporter citation is the
 * Federal Appendix (opinions the courts did not select for publication) is
 * non-precedential whatever the field says.
 */
export function clPrecedential(status: string | null, citations: string[]): PrecedentialReading {
  const reporters = citations.filter((c) => /\bF\.\s?(?:2d|3d|4th)?\s|\bF\. App(?:'|’)?x\b|\bF\. Supp\b|\bU\.\s?S\.\s/.test(c));
  if (reporters.length && reporters.every((c) => /\bF\. App(?:'|’)?x\b/.test(c))) return { status: "non_precedential", basis: `reported only in the Federal Appendix (${reporters.join("; ")})` };
  if (status === "Published") return { status: "precedential", basis: "CourtListener status: Published" };
  if (status === "Unpublished") return { status: "non_precedential", basis: "CourtListener status: Unpublished" };
  return { status: "unknown", basis: status ? `CourtListener status: ${status}` : null };
}
