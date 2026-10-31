import { anchors, attrValue, decodeEntities, htmlToText, inlineText, resolveUrl } from "../../extract/html";
import { repairMojibake } from "../../text";

// Parsers for the official pages the AAO collectors read. Pure, so they can
// be checked against saved pages:
// - USCIS's AAO Non-Precedent Decisions page
//   (https://www.uscis.gov/administrative-appeals/aao-decisions/aao-non-precedent-decisions):
//   a Drupal view ("aao_npd_recent") with a filter form (Decision Category,
//   Month, Year, Rows per page), a row per decision (the PDF link captioned
//   "<subject> - <file ID>", the date, the form number and the statute or
//   regulation) and a "1 - 100 of N total rows" counter;
// - USCIS's AAO Decisions page (https://www.uscis.gov/administrative-appeals/aao-decisions):
//   the current and superseded adopted AAO decisions;
// - EOIR's DHS/AAO/INS Decisions page (https://www.justice.gov/eoir/dhs-aao-ins-decisions):
//   the precedent decisions of the AAO and the legacy INS and DHS officers,
//   by volume of I&N Dec.;
// - the AAO Practice Manual's book pages on uscis.gov.

/** The part of `html` from `start` to the first of `ends` after it; null when `start` is missing. */
function sliceFrom(html: string, start: string | RegExp, ends: (string | RegExp)[]): string | null {
  const at = typeof start === "string" ? html.indexOf(start) : html.search(start);
  if (at < 0) return null;
  const rest = html.slice(at);
  let end = rest.length;
  for (const marker of ends) {
    const found = typeof marker === "string" ? rest.indexOf(marker, 1) : rest.slice(1).search(marker) + 1;
    if (found > 0 && found < end) end = found;
  }
  return rest.slice(0, end);
}

function oneLine(text: string): string {
  return repairMojibake(text).replace(/[\s\u00a0]+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// AAO non-precedent decisions (uscis.gov view "aao_npd_recent")

export type SelectOption = { value: string; label: string };

/** The view's filter form, as the page prints it: the GET form the listing queries are built from. */
export type NpdForm = {
  /** The form's action, resolved (the listing page itself). */
  action: string;
  categories: SelectOption[];
  months: SelectOption[];
  /** "2026" ... "2005", newest first, as the page lists them. */
  years: SelectOption[];
  pageSizes: string[];
};

export type NpdRow = {
  /** The decision file's ID as its file name states it ("AUG242026_05B2203", "Jul292010_04F1101"). */
  fileId: string;
  /** The link's caption without the file note: "Immigrant Petition for Alien Worker (Extraordinary Ability) - AUG242026_05B2203". */
  caption: string;
  /** The caption's subject (before " - <file ID>"): "Immigrant Petition for Alien Worker (Extraordinary Ability)". */
  subject: string;
  pdfUrl: string;
  /** The row's date as listed ("August 24, 2026"). */
  dateText: string | null;
  /** The row's form and statute line as listed: `I-140,"Sec. 203(b)(1)(A) of the INA"`. */
  formAndAuthority: string | null;
  formNumber: string | null;
  /** The quoted statutes or regulations in that line. */
  authorities: string[];
  /** The file note's size ("650.38 KB"); null when the page leaves it empty. */
  sizeText: string | null;
  /** The decision folder the file sits in ("B2 - Aliens with Extraordinary Ability"). */
  folder: string | null;
  /** The year folder ("Decisions_Issued_in_2026"). */
  yearFolder: string | null;
};

export type NpdListing = {
  /** The view's container is on the page (the layout this parser reads). */
  recognized: boolean;
  /** The counter's total ("of 169813 total rows"); 0 for the view's empty result; null when neither is printed. */
  total: number | null;
  /** The counter's first and last row numbers ("1 - 100"). */
  range: [number, number] | null;
  rows: NpdRow[];
  form: NpdForm | null;
  /** Rows that could not be read, and other things worth a note. */
  notes: string[];
};

function selectOptions(form: string, name: string): SelectOption[] | null {
  const select = new RegExp(`<select\\b[^>]*\\bname="${name}"[^>]*>([\\s\\S]*?)<\\/select\\s*>`, "i").exec(form);
  if (!select) return null;
  const out: SelectOption[] = [];
  for (const m of select[1].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option\s*>/gi)) {
    const value = attrValue(m[1], "value");
    if (value === null || value === "All") continue;
    out.push({ value, label: oneLine(inlineText(m[2])) });
  }
  return out;
}

/** The view's exposed filter form; null when it is not on the page or lacks a filter this collector uses. */
export function parseNpdForm(html: string, pageUrl: string): NpdForm | null {
  const formHtml = /<form\b([^>]*\bviews-exposed-form\b[^>]*)>([\s\S]*?)<\/form\s*>/i.exec(html);
  if (!formHtml) return null;
  const action = resolveUrl(attrValue(formHtml[1], "action") ?? "", pageUrl);
  const categories = selectOptions(formHtml[2], "uri_1");
  const months = selectOptions(formHtml[2], "m");
  const years = selectOptions(formHtml[2], "y");
  // "Rows per page" sits in the view's footer, outside the form.
  const pageSizes = (selectOptions(html, "items_per_page") ?? []).map((o) => o.value);
  if (!action || !categories?.length || !months?.length || !years?.length) return null;
  return { action, categories, months, years, pageSizes };
}

const FILE_ID = /^[A-Za-z]{3}\d{6}_[0-9A-Za-z_-]+$/;

/** The quoted statutes and regulations, and the form number before them, in a row's third field. */
export function splitFormAndAuthority(text: string): { formNumber: string | null; authorities: string[] } {
  const authorities = [...text.matchAll(/"([^"]+)"/g)].map((m) => oneLine(m[1])).filter(Boolean);
  const head = text.split('"')[0].replace(/,\s*$/, "").trim();
  return { formNumber: head || null, authorities };
}

function rowFromHtml(row: string, pageUrl: string): NpdRow | string {
  const titleField = /<div class="views-field views-item-title">([\s\S]*?)<\/div>\s*<\/div>/i.exec(row)?.[1] ?? row;
  const link = anchors(titleField).find((a) => /\.pdf(?:$|[?#])/i.test(a.href));
  if (!link) return `a row has no PDF link (${oneLine(inlineText(row)).slice(0, 80)})`;
  const pdfUrl = resolveUrl(link.href, pageUrl);
  if (!pdfUrl) return `a row's link is not a URL (${link.href.slice(0, 80)})`;
  const path = new URL(pdfUrl).pathname;
  const segments = path.split("/").map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const fileName = segments[segments.length - 1] ?? "";
  const fileId = fileName.replace(/\.pdf$/i, "");
  if (!FILE_ID.test(fileId)) return `a row's file name is not a decision ID (${fileName.slice(0, 80)})`;
  const errAt = segments.indexOf("err");
  const folder = errAt >= 0 && segments.length > errAt + 3 ? oneLine(segments[errAt + 1]) : null;
  const yearFolder = errAt >= 0 && segments.length > errAt + 3 ? segments[errAt + 2] : null;
  const extra = /<span class="extra-info">([\s\S]*?)<\/span>/i.exec(link.inner);
  const caption = oneLine(inlineText(link.inner.replace(/<span class="extra-info">[\s\S]*?<\/span>/i, "")));
  const sizeText = extra ? oneLine(inlineText(extra[1])).replace(/^\(PDF,\s*/i, "").replace(/\)$/, "").trim() || null : null;
  const idAt = caption.toLowerCase().lastIndexOf(` - ${fileId.toLowerCase()}`);
  const subject = idAt > 0 ? caption.slice(0, idAt).trim() : caption;
  const fields = [...row.matchAll(/<div class="views-field(?:\s[^"]*)?">\s*<div class="field-content">([\s\S]*?)<\/div>/gi)];
  const dateField = /<div class="views-field views-field-field-display-date">\s*<div class="field-content">([\s\S]*?)<\/div>/i.exec(row);
  const dateText = dateField ? oneLine(inlineText(dateField[1])) || null : null;
  // The third field (form and statute) has no field class of its own.
  const plain = fields.find((f) => /^<div class="views-field">/i.test(f[0]));
  const formAndAuthority = plain ? oneLine(inlineText(plain[1])) || null : null;
  const { formNumber, authorities } = formAndAuthority ? splitFormAndAuthority(formAndAuthority) : { formNumber: null, authorities: [] };
  return { fileId, caption, subject, pdfUrl, dateText, formAndAuthority, formNumber, authorities, sizeText, folder, yearFolder };
}

/** One page of the non-precedent decisions view. */
export function parseNpdListing(html: string, pageUrl: string): NpdListing {
  const notes: string[] = [];
  const view = sliceFrom(html, /<div class="[^"]*\baao-npd-recent\b/, ['<div class="region region-content_second', "</article>", "<footer class=\"usa-footer"]);
  const form = parseNpdForm(html, pageUrl);
  if (!view) return { recognized: false, total: null, range: null, rows: [], form, notes: ["The page has no aao-npd-recent view."] };
  const counter = /view__counter-text">\s*([\d,]+)\s*-\s*([\d,]+)\s*<\/span>\s*of\s*([\d,]+)/i.exec(view);
  const num = (s: string) => Number(s.replace(/,/g, ""));
  const rowsHtml = view.split(/<div class="views-row\b[^"]*">/i).slice(1);
  const rows: NpdRow[] = [];
  for (const rowHtml of rowsHtml) {
    const row = rowFromHtml(rowHtml, pageUrl);
    if (typeof row === "string") notes.push(row);
    else rows.push(row);
  }
  let total: number | null = counter ? num(counter[3]) : null;
  // With no match the view prints no rows and no counter, but its "No items matched your criteria." message.
  if (total === null && rowsHtml.length === 0 && /block-msg--no-results|No items matched your criteria/i.test(view)) total = 0;
  return { recognized: true, total, range: counter ? [num(counter[1]), num(counter[2])] : null, rows, form, notes };
}

/** "AUG242026" or "Jul292010" at the start of a file ID, as YYYY-MM-DD; null when it is not a real date. */
export function fileIdDate(fileId: string): string | null {
  const m = /^([A-Za-z]{3})(\d{2})(\d{4})_/.exec(fileId);
  if (!m) return null;
  const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m[1].toLowerCase()) + 1;
  if (month < 1) return null;
  const iso = `${m[3]}-${String(month).padStart(2, "0")}-${m[2]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

export type NpdDecisionHeader = {
  /** The date line at the top of the decision as its text layer reads ("AUG. 24, 2026", "APR 0 2 2015"). */
  dateLine: string | null;
  /** The number after "In Re:" on decisions issued since about 2019. */
  inReNumber: string | null;
  /** The "ID#" number of the decisions issued about 2015 to 2019, the AAO's citation form for them then. */
  idNumber: string | null;
  /** The caption those decisions print ("MATTER OF D-E-S- INC."), as the text layer reads it. */
  matterOf: string | null;
  /** The office whose decision was appealed, on the "FILE: ... Office: ... Date:" line of decisions before about 2015 or the "APPEAL OF ... DECISION" line after it ("CALIFORNIA SERVICE CENTER"). */
  office: string | null;
};

/** The header facts at the top of a non-precedent decision's text (OCR text, so each is read only when it is unambiguous). */
export function parseNpdHeader(text: string): NpdDecisionHeader {
  const head = text.slice(0, 4000);
  const dateLine = /\bDate:?[ \t]*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[A-Za-z]*\.?[ \t]*[0-9][0-9 \t]{0,3},?[ \t]*\d{4})/i.exec(head)?.[1] ?? null;
  const inReNumber = /\bIn Re:?[ \t]*(\d{5,12})\b/i.exec(head)?.[1] ?? null;
  const idNumber = /\bID#[ \t]*(\d{3,9})\b/.exec(head)?.[1] ?? null;
  const matter = /^[ \t]*MATTER OF ([A-Z0-9][A-Z0-9 .,'&()-]{0,100}?)[ \t]*$/m.exec(head)?.[1] ?? null;
  // Only an office name in capitals that ends where the "Date:" field (or the line) does; OCR noise reads as nothing.
  // Decisions of about 2015 to 2019 print "APPEAL OF TEXAS SERVICE CENTER DECISION" instead.
  const office =
    /\bOffice:[ \t]*([A-Z][A-Z .,'&-]{2,60}?)[ \t]*(?:\bDate\b|$)/m.exec(head)?.[1] ??
    /^[ \t]*APPEAL OF ([A-Z][A-Z .,'&-]{2,60}?) DECISION[ \t]*$/m.exec(head)?.[1] ??
    null;
  return {
    dateLine: dateLine ? oneLine(dateLine) : null,
    inReNumber,
    idNumber,
    matterOf: matter ? oneLine(matter) : null,
    office: office && /[A-Z]{3}/.test(office) ? oneLine(office).replace(/[ ,.-]+$/, "") : null,
  };
}

// ---------------------------------------------------------------------------
// Adopted AAO decisions (uscis.gov "AAO Decisions" page)

export type AdoptedEntry = {
  /** The designation as listed ("2020-01", "06-0001"). */
  designation: string;
  /** The link's text: "Matter of F-M- Co.". */
  name: string;
  pdfUrl: string;
  /** The entry's citation as listed: "Matter of F-M- Co., Adopted Decision 2020-01 (AAO May 5, 2020)". */
  citation: string;
  /** The date in the citation's parenthetical ("May 5, 2020"). */
  dateText: string | null;
  /** Listed under "Previous adopted decisions, now superseded". */
  superseded: boolean;
  /** For a superseded entry, what the page says after the citation ("superseded by PM-602-0188 (Jul. 1, 2022)"). */
  supersededText: string | null;
  /** Links in that text, resolved. */
  supersededLinks: { text: string; url: string }[];
  /** The whole entry as listed. */
  entryText: string;
};

export type AdoptedPage = { recognized: boolean; entries: AdoptedEntry[]; notes: string[]; reviewedText: string | null; intro: string | null };

function listItems(fragment: string): string[] {
  return [...fragment.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)].map((m) => m[1]);
}

/** The adopted decisions on the AAO Decisions page: the current list, then the superseded one. */
export function parseAdoptedDecisions(html: string, pageUrl: string): AdoptedPage {
  const notes: string[] = [];
  const panel = sliceFrom(html, /Adopted AAO Decisions\s*<\/h4>/i, [/<h4\b/i, "Last Reviewed/Updated", "</article>"]);
  const reviewed = /Last Reviewed\/Updated:\s*(?:<[^>]+>\s*)*([0-9/]+)/i.exec(html)?.[1] ?? null;
  if (!panel) return { recognized: false, entries: [], notes: ["The page has no Adopted AAO Decisions section."], reviewedText: reviewed, intro: null };
  const split = panel.search(/Previous adopted decisions/i);
  const parts: { html: string; superseded: boolean }[] =
    split > 0 ? [{ html: panel.slice(0, split), superseded: false }, { html: panel.slice(split), superseded: true }] : [{ html: panel, superseded: false }];
  if (split < 0) notes.push("The page has no list of superseded adopted decisions.");
  const introParas = [...panel.slice(0, Math.max(0, panel.search(/<ul\b/i))).matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)].map((m) => oneLine(inlineText(m[1])));
  const entries: AdoptedEntry[] = [];
  for (const part of parts) {
    for (const li of listItems(part.html)) {
      const text = oneLine(inlineText(li));
      const m = /Adopted Decision\s+(\d{2,4}-\d{2,4})\s*\(([^)]*)\)/i.exec(text);
      const links = anchors(li);
      const first = links[0];
      if (!m || !first) {
        notes.push(`An entry could not be read (${text.slice(0, 80) || "empty"}); it was left out.`);
        continue;
      }
      const pdfUrl = resolveUrl(first.href, pageUrl);
      if (!pdfUrl) {
        notes.push(`An entry's link is not a URL (${text.slice(0, 80)}).`);
        continue;
      }
      const citationEnd = text.indexOf(m[0]) + m[0].length;
      const citation = text.slice(0, citationEnd).trim();
      const rest = text.slice(citationEnd).replace(/^[\s,]+/, "").trim();
      const dateText = /^AAO\s+(.+)$/i.exec(m[2].trim())?.[1]?.trim() ?? null;
      entries.push({
        designation: m[1],
        name: oneLine(first.text).replace(/,$/, ""),
        pdfUrl,
        citation,
        dateText,
        superseded: part.superseded,
        supersededText: part.superseded ? rest || null : null,
        supersededLinks: part.superseded
          ? links
              .slice(1)
              .map((a) => ({ text: oneLine(a.text), url: resolveUrl(a.href, pageUrl) ?? "" }))
              .filter((a) => a.url)
          : [],
        entryText: text,
      });
    }
  }
  return { recognized: true, entries, notes, reviewedText: reviewed, intro: introParas.filter(Boolean).join("\n") || null };
}

// ---------------------------------------------------------------------------
// DHS/AAO/INS precedent decisions (justice.gov EOIR page)

export type PrecedentEntry = {
  volume: number;
  page: number;
  /** The caption as listed ("BORGES BORSOI", "H-G-G-"). */
  name: string;
  /** "30 I&N Dec. 67 (AAO 2026)", rebuilt only from the listed volume, page and parenthetical. */
  citation: string;
  /** The parenthetical as listed ("AAO 2026", "R.C. 1964", "BIA 1967, D.D. decision reversed-denied"). */
  parenthetical: string;
  /** The deciding office before the year ("AAO", "R.C.", "Assoc. Comm."). */
  issuer: string | null;
  year: number | null;
  /** Text after the citation, when the page adds any ("appeal dismissed"). */
  note: string | null;
  pdfUrl: string;
  /** The Interim Decision number when the PDF link's file name is one ("/vol25/3700.pdf"). */
  idNumber: number | null;
  /** The whole entry as listed. */
  entryText: string;
};

export type PrecedentPage = { recognized: boolean; entries: PrecedentEntry[]; notes: string[]; pageUpdated: string | null; volumesListed: number[] };

/** EOIR's "Updated <date>" line under a justice.gov page. */
export function justiceGovUpdated(html: string): string | null {
  const m = /<div class="node-updated-date[^"]*">\s*([^<]*?)\s*<\/div>/i.exec(html);
  return m ? oneLine(decodeEntities(m[1])) || null : null;
}

// "30 I&N Dec. 67 (AAO 2026)"; the page sometimes drops the period or the "I" ("10 &N Dec. 706").
const PRECEDENT_CITATION = /(\d{1,2})\s*I?\s*&\s*N\s+Dec\.?\s*(\d{1,4})\s*\(([^()]*?(\d{4})[^()]*)\)/;

/** The entries of the DHS/AAO/INS Decisions page, volume by volume as listed. */
export function parsePrecedentPage(html: string, pageUrl: string): PrecedentPage {
  const notes: string[] = [];
  const body = sliceFrom(html, "field_body", ['<div class="node-updated-date', "</article>", "<footer"]);
  const pageUpdated = justiceGovUpdated(html);
  if (!body) return { recognized: false, entries: [], notes: ["The page has no body field."], pageUpdated, volumesListed: [] };
  const volumesListed = [...body.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2\s*>/gi)]
    .map((m) => /Volume\s+(\d{1,2})/i.exec(inlineText(m[1]))?.[1])
    .filter((v): v is string => Boolean(v))
    .map(Number);
  const entries: PrecedentEntry[] = [];
  for (const m of body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)) {
    const inner = m[1];
    const text = oneLine(inlineText(inner));
    if (!text || /^Return to the Top/i.test(text) || /^(?:Volume \d+\s*\|?\s*)+$/i.test(text)) continue;
    const link = anchors(inner).find((a) => !a.href.startsWith("#"));
    const cite = PRECEDENT_CITATION.exec(text);
    if (!cite || !link) {
      if (/I?\s*&\s*N\s+Dec/i.test(text)) notes.push(`An entry could not be read (${text.slice(0, 100)}); it was left out.`);
      continue;
    }
    const pdfUrl = resolveUrl(link.href, pageUrl);
    // The caption is everything before the citation; the bold part can stop short of it ("<strong>H-G-G</strong>-,").
    const strong = /<strong\b[^>]*>([\s\S]*?)<\/strong\s*>/i.exec(inner);
    const name = oneLine(text.slice(0, cite.index) || (strong ? inlineText(strong[1]) : ""))
      .replace(/^[,\s]+|[,\s]+$/g, "")
      .trim();
    if (!pdfUrl || !name) {
      notes.push(`An entry's ${pdfUrl ? "caption" : "link"} could not be read (${text.slice(0, 80)}).`);
      continue;
    }
    const parenthetical = oneLine(cite[3]);
    const year = Number(cite[4]);
    const issuer = oneLine(parenthetical.slice(0, parenthetical.indexOf(cite[4]))).replace(/[,\s]+$/, "") || null;
    const volume = Number(cite[1]);
    const page = Number(cite[2]);
    const after = oneLine(text.slice(cite.index + cite[0].length).replace(/\(PDF\)/gi, ""));
    const idFromLink = /\/vol\d{1,2}\/(\d{3,4})\.pdf$/i.exec(new URL(pdfUrl).pathname)?.[1];
    entries.push({
      volume,
      page,
      name,
      citation: `${volume} I&N Dec. ${page} (${parenthetical})`,
      parenthetical,
      issuer,
      year: Number.isInteger(year) ? year : null,
      note: after || null,
      pdfUrl,
      idNumber: idFromLink ? Number(idFromLink) : null,
      entryText: text,
    });
  }
  return { recognized: entries.length > 0, entries, notes, pageUpdated, volumesListed };
}

export type PrecedentHeader = {
  /** "Cite as 30 I&N Dec. 67 (AAO 2026)" as the decision prints it. */
  citeAs: string | null;
  /** The "Interim Decision #4248" number. */
  interimDecisionNumber: number | null;
  /** "September 23, 2026" from the "Decided" line. */
  decidedText: string | null;
  /** The official headnote: the paragraphs between the issuing office and the parties' representation, verbatim (lines unwrapped). */
  headnote: string | null;
};

const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const DECIDED = new RegExp(`\\bDecided(?:\\s+by\\s+[A-Za-z .'-]{2,60}?)?\\s+(${MONTH}\\.?\\s+\\d{1,2},\\s+\\d{4})`);
// What follows the headnote: the representation lines ("ON BEHALF OF PETITIONER:", "FOR THE APPLICANT:").
const AFTER_HEADNOTE = /^[ \t]*(?:ON BEHALF OF\b|FOR THE [A-Z]|FOR (?:PETITIONER|APPLICANT|RESPONDENT|OBLIGOR|APPELLANT)\b|BEFORE THE\b)/m;

/** The header of a precedent decision's text: its cite line, Interim Decision number, decision date and headnote. */
export function parsePrecedentHeader(text: string): PrecedentHeader {
  const head = text.slice(0, 12000);
  const cite = /Cite as\s+(\d{1,2}\s+I&N\s+Dec\.\s+\d{1,4}\s+\([^)]*\))/.exec(head);
  const id = /Interim\s+Decision\s*#\s*(\d{3,4})\b/i.exec(head);
  const decided = DECIDED.exec(head);
  let headnote: string | null = null;
  if (decided) {
    const afterDecided = head.slice(decided.index + decided[0].length);
    const office = /^[ \t]*Administrative Appeals Office[ \t]*$/m.exec(afterDecided);
    if (office) {
      const rest = afterDecided.slice(office.index + office[0].length);
      const end = rest.search(AFTER_HEADNOTE);
      const block = end > 0 ? rest.slice(0, end) : "";
      // Only a block that is plainly the headnote: on the first page, of a headnote's length.
      if (block && !/\[Page \d+\]/.test(block)) {
        const unwrapped = block
          .trim()
          .split(/\n(?=\(\d{1,2}\)\s)/)
          .map((para) => para.replace(/\s*\n\s*/g, " ").trim())
          .filter(Boolean)
          .join("\n");
        if (unwrapped.length >= 40 && unwrapped.length <= 6000) headnote = unwrapped;
      }
    }
  }
  return {
    citeAs: cite ? cite[1].replace(/\s+/g, " ") : null,
    interimDecisionNumber: id ? Number(id[1]) : null,
    decidedText: decided ? decided[1].replace(/\s+/g, " ") : null,
    headnote,
  };
}

// ---------------------------------------------------------------------------
// AAO Practice Manual (uscis.gov book pages)

export type ManualLink = { title: string; url: string };

/** The chapters the Table of Contents links, in order (the search page left out). */
export function parseManualToc(html: string, pageUrl: string): ManualLink[] {
  const tree = sliceFrom(html, /<div class="toc-tree"/i, ['<div class="current-date', "</article>"]);
  if (!tree) return [];
  const out: ManualLink[] = [];
  const seen = new Set<string>();
  for (const a of anchors(tree)) {
    const url = resolveUrl(a.href, pageUrl);
    if (!url || /\/search\/?$/.test(new URL(url).pathname)) continue;
    const key = new URL(url).pathname;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: oneLine(a.text), url });
  }
  return out;
}

export type ManualPage = {
  title: string | null;
  /** The page's body field (the chapter with its footnotes), HTML. */
  bodyHtml: string | null;
  /** "Last Reviewed/Updated: 10/30/2025", the date as printed. */
  reviewedText: string | null;
  /** The book's page links on the page ("Print Manual", "Table of Contents", previous and next). */
  links: ManualLink[];
};

/** One book page of the manual: its title, body field and "Last Reviewed/Updated" date. */
export function parseManualPage(html: string, pageUrl: string): ManualPage {
  const title = /<h1\b[^>]*class="[^"]*page-title[^"]*"[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html);
  const article = sliceFrom(html, /<article\b[^>]*node--type-(?:book|page)/i, ["</article>"]) ?? "";
  const body = sliceFrom(article, /<div class="[^"]*\bfield--name-body\b/i, [/<nav class="nav-sub-tree/i, /<div class="current-date/i, /<div class="prev-next/i]);
  const reviewed = /current-date__value">\s*([^<]*?)\s*<\/span>/i.exec(article)?.[1] ?? /Last Reviewed\/Updated:\s*(?:<[^>]+>\s*)*([0-9/]+)/i.exec(article)?.[1] ?? null;
  const links = anchors(article)
    .filter((a) => /^(?:Print Manual|Table of Contents|Previous|Next)$/i.test(oneLine(a.text)))
    .map((a) => ({ title: oneLine(a.text), url: resolveUrl(a.href, pageUrl) ?? "" }))
    .filter((l) => l.url);
  return { title: title ? oneLine(inlineText(title[1])) || null : null, bodyHtml: body, reviewedText: reviewed ? oneLine(reviewed) : null, links };
}

/** The visible text of a fragment on one line (for captions). */
export function captionText(fragment: string): string {
  return oneLine(htmlToText(fragment).replace(/\n+/g, " "));
}

/** What the stored text lacks when some or all of a PDF's pages are scans without a text layer; null when every page has text. */
export function textLayerNote(pageCount: number, pagesWithText: number): string | null {
  if (pagesWithText === 0) return "The PDF has no text layer (a scan); no OCR is run.";
  if (pagesWithText < pageCount) return `${pagesWithText} of the PDF's ${pageCount} pages ${pagesWithText === 1 ? "has" : "have"} a text layer; the others are scans, and no OCR is run, so their text is not stored.`;
  return null;
}
