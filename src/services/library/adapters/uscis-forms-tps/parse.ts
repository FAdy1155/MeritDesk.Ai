import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { anchors, attrValue, htmlToDocumentText, inlineText, resolveUrl, tableRows } from "../../extract/html";

// Parsers for the uscis.gov pages this group reads, and for the Federal
// Register API's list of Temporary Protected Status documents. Pure (no
// network, no database), so they can be tried on saved pages.
//
// uscis.gov is a Drupal site with one layout for every node:
// - the content is an <article class="node node--type-<type>"> (forms are
//   "immigration-form", TPS pages "article", listings "page"), with the
//   page's <h1>, its body and, for a form, a "Form Details" section of
//   accordions (Forms and Document Downloads, Edition Date, Where to File,
//   Filing Fee, ...);
// - the "Last Reviewed/Updated" date is a <time> in its own block after it;
// - alerts are "messages" boxes in the body, with screen-reader-only labels
//   ("Alert Type info") that are not part of what the page says.
//
// Accordion panels are collapsed until their header is clicked. A panel
// with no header in front of it can never be opened, and the reader never
// sees it (the I-864P page has one, holding an earlier year's table): it is
// left out of the text, so a stale table is not read as the current one.

/** The index just past the element that opens at `from`, counting nested elements of the same tag; -1 when it never closes. */
export function balancedEnd(html: string, from: number, tag: string): number {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = from;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[0].endsWith("/>")) continue;
    depth += m[1] ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

/** The element (outer HTML) that opens at the first match of `opening`; null when absent or never closed. */
export function elementAt(html: string, opening: RegExp, tag: string): string | null {
  const m = opening.exec(html);
  if (!m) return null;
  const end = balancedEnd(html, m.index, tag);
  return end < 0 ? null : html.slice(m.index, end);
}

/** The part of `html` from the first match of `start` to the earliest of `ends` after it (or the end); null when `start` is missing. */
export function sliceFrom(html: string, start: string | RegExp, ends: (string | RegExp)[]): string | null {
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

/** Removes accordion panels that no header opens (see the file comment). */
export function dropOrphanAccordionPanels(html: string): { html: string; dropped: number } {
  const opening = /<div\b[^>]*class="[^"]*\baccordion__panel\b[^"]*"[^>]*>/gi;
  const cuts: [number, number][] = [];
  for (const m of html.matchAll(opening)) {
    const start = m.index ?? 0;
    const before = html.slice(Math.max(0, start - 3000), start).replace(/\s+$/, "");
    const headed = /<(h[1-6]|div|button|dt)\b[^>]*\baccordion__header\b[^>]*>(?:(?!<\/?\1\b)[\s\S])*<\/\1\s*>$/i.test(before);
    if (headed) continue;
    const end = balancedEnd(html, start, "div");
    if (end > start) cuts.push([start, end]);
  }
  let out = html;
  for (const [start, end] of cuts.reverse()) out = out.slice(0, start) + out.slice(end);
  return { html: out, dropped: cuts.length };
}

/** Text of an HTML fragment as a document: screen-reader-only labels left out. */
export function uscisText(fragment: string): string {
  return htmlToDocumentText(fragment.replace(/<span\b[^>]*class="[^"]*\busa-sr-only\b[^"]*"[^>]*>[\s\S]*?<\/span\s*>/gi, " "));
}

/**
 * A date written mm/dd/yy (USCIS states edition dates that way: "Dates are
 * listed in mm/dd/yy format") or mm/dd/yyyy, as YYYY-MM-DD. A two-digit year
 * is read as 20yy unless that is more than a year after `now`, then 19yy.
 */
export function parseSlashDate(text: string | null | undefined, now: Date): string | null {
  if (!text) return null;
  const m = /\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/.exec(text);
  if (!m) return null;
  let year = Number(m[3]);
  if (m[3].length === 2) {
    year += 2000;
    if (year > now.getUTCFullYear() + 1) year -= 100;
  }
  return parseStatedDate(`${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`);
}

export type StatedTime = { text: string; datetime: string | null };

function timeIn(fragment: string | null): StatedTime | null {
  if (!fragment) return null;
  const m = /<time\b([^>]*)>([\s\S]*?)<\/time\s*>/i.exec(fragment);
  if (!m) return null;
  const text = inlineText(m[2]);
  return text ? { text, datetime: attrValue(m[1], "datetime") } : null;
}

export type UscisPage = {
  /** The Drupal node type of the page's <article> ("immigration-form", "article", "page"); null when it has none. */
  nodeType: string | null;
  /** The <h1>'s inner HTML. */
  headingHtml: string | null;
  heading: string | null;
  /** The node's <article>, orphan accordion panels removed. */
  articleHtml: string | null;
  orphanPanelsDropped: number;
  /** "Last Reviewed/Updated" as the page states it. */
  lastReviewed: StatedTime | null;
  /** The text of each alert box in the article, in page order. */
  alerts: string[];
  /** The "Archived Content" warning, when the page carries one. */
  archivedNotice: string | null;
};

/** The parts of a uscis.gov node page every parser here starts from. */
export function readUscisPage(html: string): UscisPage {
  const opening = /<article\b[^>]*class="node node--type-([a-z0-9_-]+)[^"]*"[^>]*>/i;
  const nodeType = opening.exec(html)?.[1] ?? null;
  const article = elementAt(html, opening, "article");
  const cleaned = article ? dropOrphanAccordionPanels(article) : { html: null, dropped: 0 };
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(cleaned.html ?? html);
  const alerts: string[] = [];
  let archivedNotice: string | null = null;
  for (const box of (cleaned.html ?? "").matchAll(/<div\b[^>]*class="messages messages--([a-z]+)\b[^"]*"[^>]*>/gi)) {
    const end = balancedEnd(cleaned.html!, box.index ?? 0, "div");
    if (end < 0) continue;
    const text = uscisText(cleaned.html!.slice(box.index ?? 0, end)).replace(/\n{2,}/g, "\n");
    if (!text) continue;
    if (box[1].toLowerCase() === "warning" && /archived content/i.test(text)) archivedNotice = text.replace(/\s+/g, " ").trim();
    else alerts.push(text);
  }
  // Forms and listings print it in a block after the article, articles (the TPS pages) inside it.
  const reviewedBlock = sliceFrom(html, 'class="reviewed-date"', ["</time>"]);
  return {
    nodeType,
    headingHtml: h1 ? h1[1] : null,
    heading: h1 ? inlineText(h1[1]) || null : null,
    articleHtml: cleaned.html,
    orphanPanelsDropped: cleaned.dropped,
    lastReviewed: timeIn(reviewedBlock ? `${reviewedBlock}</time>` : null),
    alerts,
    archivedNotice,
  };
}

// --- All Forms (https://www.uscis.gov/forms/all-forms) -------------------

export type FormListing = {
  /** The form number as listed ("I-130", "I-485 Supplement A"). */
  number: string;
  /** The form's name as listed ("Petition for Alien Relative"). */
  name: string;
  /** The listed title, number and name ("I-130 | Petition for Alien Relative"). */
  label: string;
  url: string;
  /** The listing's one-paragraph description of the form, verbatim. */
  description: string | null;
};

export type AllFormsParse = { forms: FormListing[]; rowsSeen: number; statedTotal: number | null; notes: string[] };

/** The All Forms view: one "views-row" per form, its linked "number | name" title and description, and the "1 - N of N" counter. */
export function parseAllForms(html: string, pageUrl: string): AllFormsParse {
  const view = sliceFrom(html, /class="[^"]*\bimmigration-forms\b/, ["</main>"]) ?? "";
  const notes: string[] = [];
  const forms: FormListing[] = [];
  const starts = [...view.matchAll(/<div class="views-row\b/g)].map((m) => m.index ?? 0);
  const footer = view.search(/<footer\b/);
  starts.forEach((start, i) => {
    const row = view.slice(start, starts[i + 1] ?? (footer > start ? footer : view.length));
    const titleField = sliceFrom(row, "views-field-title", ["views-field-body", "action-group"]) ?? "";
    const link = anchors(titleField)[0];
    const url = link ? resolveUrl(link.href, pageUrl) : null;
    const split = link ? /^(.+?)\s+\|\s+(.+)$/.exec(link.text) : null;
    if (!link || !url || !split) {
      notes.push(`An All Forms row without a "number | name" link was left out${link ? ` ("${link.text}")` : ""}.`);
      return;
    }
    const body = /views-field-body"[^>]*>\s*<div class="field-content">([\s\S]*?)<\/div>/i.exec(row);
    const description = body ? inlineText(body[1]) || null : null;
    forms.push({ number: split[1].trim(), name: split[2].trim(), label: link.text, url, description });
  });
  const counter = /view__counter-text">\s*\d+\s*-\s*\d+\s*<\/span>\s*of\s*(\d+)/i.exec(view);
  return { forms, rowsSeen: starts.length, statedTotal: counter ? Number(counter[1]) : null, notes };
}

// --- A form's page (https://www.uscis.gov/i-130) -------------------------

export type FormFile = {
  /** The link text without the size note ("Instructions for Form I-130"). */
  label: string;
  url: string;
  /** "(PDF, 280.13 KB)" as printed. */
  sizeText: string | null;
};

export type FormPage = UscisPage & {
  isFormPage: boolean;
  /** From the <h1> "I-130, <span>Petition for Alien Relative</span>". */
  number: string | null;
  name: string | null;
  /** The Edition Date panel's own text, verbatim ("04/01/24. You can find the edition date ..."). */
  editionText: string | null;
  /** The edition date at the start of it, as written ("04/01/24"). */
  editionDateText: string | null;
  /** The files in the page's "Forms and Document Downloads" (its attached files field), PDFs on uscis.gov only. */
  files: FormFile[];
  /** Attached links that are not PDFs on www.uscis.gov (left out). */
  otherAttachments: string[];
  /** The Form Details accordion headings, in order. */
  sections: string[];
  /** The article as document text. */
  text: string;
};

function attachedFiles(articleHtml: string, pageUrl: string): { files: FormFile[]; other: string[] } {
  const files: FormFile[] = [];
  const other: string[] = [];
  const seen = new Set<string>();
  for (const m of articleHtml.matchAll(/<div\b[^>]*class="[^"]*\bfield--name-field-attached-files\b[^"]*"[^>]*>/gi)) {
    const end = balancedEnd(articleHtml, m.index ?? 0, "div");
    const field = end > 0 ? articleHtml.slice(m.index ?? 0, end) : "";
    for (const a of anchors(field)) {
      const url = resolveUrl(a.href, pageUrl);
      const size = /<span\b[^>]*class="[^"]*\bfile-ext-info\b[^"]*"[^>]*>([\s\S]*?)<\/span\s*>/i.exec(a.inner);
      const label = inlineText(size ? a.inner.replace(size[0], " ") : a.inner);
      if (!url) continue;
      const parsed = new URL(url);
      if (parsed.hostname !== "www.uscis.gov" || !/\.pdf$/i.test(parsed.pathname)) {
        other.push(`${label || a.text} (${url})`);
        continue;
      }
      if (seen.has(parsed.pathname)) continue;
      seen.add(parsed.pathname);
      files.push({ label: label || parsed.pathname.split("/").pop()!, url: `https://www.uscis.gov${parsed.pathname}`, sizeText: size ? inlineText(size[1]) || null : null });
    }
  }
  return { files, other };
}

/** PDFs under /sites/default/files/document/forms/ that the text links (a form page written as an article has no attached files field). */
function linkedFormPdfs(articleHtml: string, pageUrl: string): FormFile[] {
  const files: FormFile[] = [];
  for (const a of anchors(articleHtml)) {
    const url = resolveUrl(a.href, pageUrl);
    if (!url || !isFormPdf(url) || files.some((f) => f.url === url)) continue;
    const size = /<span\b[^>]*class="[^"]*\bfile-ext-info\b[^"]*"[^>]*>([\s\S]*?)<\/span\s*>/i.exec(a.inner);
    const fromText = /\s*(\((?:PDF|DOCX?|XLSX?),[^)]*\))\s*$/i.exec(a.text);
    files.push({
      label: (size ? inlineText(a.inner.replace(size[0], " ")) : fromText ? a.text.slice(0, fromText.index) : a.text).trim() || new URL(url).pathname.split("/").pop()!,
      url,
      sizeText: size ? inlineText(size[1]) || null : fromText ? fromText[1] : null,
    });
  }
  return files;
}

function isFormPdf(url: string): boolean {
  const u = new URL(url);
  return u.hostname === "www.uscis.gov" && /^\/sites\/default\/files\/document\/forms\/[^/]+\.pdf$/i.test(u.pathname);
}

/**
 * One form's page: number, name, edition, attached files and text. Form
 * pages are "immigration-form" nodes; a few forms (G-325R) have an
 * "article" page instead, taken as the form's page when its heading starts
 * with `expectedNumber` (the number All Forms lists), its PDFs from the
 * links in its text.
 */
export function parseFormPage(html: string, pageUrl: string, expectedNumber?: string): FormPage {
  const page = readUscisPage(html);
  const article = page.articleHtml ?? "";
  const split = page.headingHtml ? /^([\s\S]*?)<span\b[^>]*>([\s\S]*?)<\/span\s*>/i.exec(page.headingHtml) : null;
  const plain = !split || !inlineText(split[1]) ? /^([A-Z]{1,5}-\d+[A-Z0-9]*(?:\s+Supplement\s+[A-Z0-9]+)?),\s+(.+)$/.exec(page.heading ?? "") : null;
  const number = plain ? plain[1] : split ? inlineText(split[1]).replace(/,\s*$/, "").trim() || null : null;
  const name = plain ? plain[2] : split ? inlineText(split[2]) || null : null;
  const isFormPage =
    page.nodeType === "immigration-form" ||
    (page.nodeType === "article" && Boolean(expectedNumber && number && number.toUpperCase() === expectedNumber.toUpperCase()));

  // The Edition Date panel holds a block of the Forms Updates view with the current edition and its note.
  const editionView = sliceFrom(article, /class="[^"]*\bforms-updates-listing\b/, []);
  const editionRow = editionView ? elementAt(editionView, /<div class="first last">/, "div") : null;
  const editionText = editionRow ? uscisText(editionRow).replace(/\s*\n\s*/g, "\n").replace(/\s+\./, ".").trim() || null : null;
  const editionDateText = editionText ? (/^\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\b/.exec(editionText)?.[1] ?? null) : null;

  const attached = attachedFiles(article, pageUrl);
  const files = attached.files.length || page.nodeType === "immigration-form" ? attached.files : linkedFormPdfs(article, pageUrl);
  const other = attached.other;
  const sections = [...article.matchAll(/<div\b[^>]*class="accordion__header"[^>]*>([\s\S]*?)<\/div\s*>/gi)].map((m) => inlineText(m[1])).filter(Boolean);
  return {
    ...page,
    isFormPage,
    number,
    name,
    editionText,
    editionDateText,
    files,
    otherAttachments: other,
    sections,
    text: article ? uscisText(article) : "",
  };
}

/** What a form PDF prints about itself: the edition in its footer, its OMB number and expiration date. */
export function pdfFormFacts(text: string): { editionText: string | null; revisionText: string | null; ombNumber: string | null; expiresText: string | null } {
  // Current footers read "Form I-102 Edition 04/01/24 Page 1 of 5"; others "Form G-1256 08/10/15 Page 1 of 2"
  // or "Form N-400 Instructions 01/20/25 Page 1 of 29".
  const edition =
    /\bEdition\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\b/i.exec(text) ??
    /\bForm\s+[A-Z]{1,5}-\d+[A-Z0-9]*(?:,?\s+Supplement\s+[A-Z0-9]+)?(?:\s+Instructions)?\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(?:[A-Z]\s+)?Page\s+\d+\s+of\s+\d+/i.exec(text);
  // EOIR's forms print a revision month instead ("Rev. 02/2026", "Exp. 07/31/2028").
  const revision = /\bRev\.\s+(\d{1,2}\/\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/.exec(text);
  const omb = /\bOMB\s+No\.?\s*(\d{4}\s*-\s*\d{4})/i.exec(text);
  const expires = /\b(?:Expires|Exp\.)\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\b/i.exec(text);
  return {
    editionText: edition ? edition[1] : null,
    revisionText: revision ? revision[1] : null,
    ombNumber: omb ? omb[1].replace(/\s+/g, "") : null,
    expiresText: expires ? expires[1] : null,
  };
}

/** True when a PDF's text layer is only the placeholder of a dynamic (XFA) form, not the form itself. */
export function isXfaPlaceholder(text: string): boolean {
  return /your PDF viewer may not be able to display this type of document/i.test(text) && text.replace(/\[Page \d+\]/g, "").trim().length < 2_000;
}

// --- Forms Updates (https://www.uscis.gov/forms/forms-updates) -----------

export type FormUpdateRow = {
  /** "Update to Form I-130, Petition for Alien Relative. New Edition Dated 04/01/24." */
  title: string;
  /** The form page the row links. */
  formUrl: string;
  /** The display date as printed ("October 09, 2026") and its datetime attribute. */
  date: StatedTime | null;
  /** The row's description, verbatim ("Edition Date: 04/01/24. You can find ..."). */
  description: string;
  formNumber: string | null;
  formName: string | null;
  /** "04/01/24", from the title (else the description). */
  editionDateText: string | null;
};

export type FormsUpdatesParse = { rows: FormUpdateRow[]; rowsSeen: number; statedTotal: number | null; nextUrl: string | null; notes: string[] };

/** One page of the Forms Updates view: a "views-row" per update, the counter "1 - 10 of 439" and the pager's Next link. */
export function parseFormsUpdates(html: string, pageUrl: string): FormsUpdatesParse {
  const view = sliceFrom(html, /class="[^"]*\bforms-updates-listing block-1\b/, ['class="rss-feed', "</main>"]) ?? "";
  const notes: string[] = [];
  const rows: FormUpdateRow[] = [];
  const starts = [...view.matchAll(/<div class="views-row\b/g)].map((m) => m.index ?? 0);
  const footer = view.search(/<footer\b/);
  starts.forEach((start, i) => {
    const row = view.slice(start, starts[i + 1] ?? (footer > start ? footer : view.length));
    const titleField = sliceFrom(row, "views-field-title", ["views-field-field-display-date"]) ?? "";
    const link = anchors(titleField)[0];
    const formUrl = link ? resolveUrl(link.href, pageUrl) : null;
    if (!link || !formUrl || !link.text) {
      notes.push("A Forms Updates row without a linked title was left out.");
      return;
    }
    const descriptionField = sliceFrom(row, "views-field-field-description", []);
    const description = descriptionField ? inlineText(descriptionField.replace(/^[^>]*>/, "")) : "";
    const t = /^Update to Form\s+(.+?),\s+(.+?)\.?\s+New Edition Dated\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\.?\s*$/i.exec(link.text);
    const descriptionEdition = /Edition Date:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i.exec(description)?.[1] ?? null;
    rows.push({
      title: link.text,
      formUrl,
      date: timeIn(row),
      description,
      formNumber: t ? t[1].trim() : null,
      formName: t ? t[2].trim() : null,
      editionDateText: t ? t[3] : descriptionEdition,
    });
  });
  const counter = /view__counter-text">\s*\d+\s*-\s*\d+\s*<\/span>\s*of\s*(\d+)/i.exec(view);
  const next = /<a\b([^>]*\brel="next"[^>]*)>/i.exec(view);
  const nextHref = next ? attrValue(next[1], "href") : null;
  return { rows, rowsSeen: starts.length, statedTotal: counter ? Number(counter[1]) : null, nextUrl: nextHref ? resolveUrl(nextHref, pageUrl) : null, notes };
}

/**
 * A stable identifier for a Forms Updates row: the form page's path, the
 * edition it announces and the date it was posted. USCIS posts some editions
 * more than once, with different notes (I-485's 01/20/25 edition on March
 * 3, 2025, "the currently effective version", and on March 8, "Starting
 * April 3, 2025, we will accept only ..."): each posting is its own entry.
 */
export function formUpdateId(row: FormUpdateRow): string {
  const path = new URL(row.formUrl).pathname.toLowerCase();
  const posted = parseStatedDate(row.date?.text) ?? parseStatedDate(row.date?.datetime);
  return row.editionDateText && posted ? `${path} edition ${row.editionDateText} posted ${posted}` : `${path} | ${row.title} | ${row.date?.text ?? ""}`;
}

// --- G-1055, Fee Schedule (https://www.uscis.gov/g-1055) -----------------

export type FeeOption = { id: string; marker: string | null; label: string };

export type G1055Page = FormPage & {
  /** The fee schedule PDF the page links under Downloads. */
  pdf: { label: string; url: string } | null;
  /** The "Select a Form for Fee Information" choices. */
  options: FeeOption[];
  /** The page's own GET filter for the fee entries: its action URL and field name. */
  filter: { action: string; field: string } | null;
};

/** The G-1055 page: the form page parts, the PDF link, the per-form fee choices and the filter form that shows one. */
export function parseG1055Page(html: string, pageUrl: string): G1055Page {
  const page = parseFormPage(html, pageUrl);
  let pdf: G1055Page["pdf"] = null;
  for (const a of anchors(page.articleHtml ?? "")) {
    const url = resolveUrl(a.href, pageUrl);
    if (url && /\/g-1055[^/]*\.pdf$/i.test(new URL(url).pathname)) {
      pdf = { label: a.text, url };
      break;
    }
  }
  const select = elementAt(html, /<select\b[^>]*\bid="form-fee-title"[^>]*>/i, "select") ?? "";
  const options: FeeOption[] = [];
  for (const m of select.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option\s*>/gi)) {
    const id = attrValue(m[1], "value");
    const label = inlineText(m[2]);
    if (!id || !/^\d+$/.test(id) || !label) continue;
    options.push({ id, marker: attrValue(m[1], "data-marker"), label });
  }
  const form = elementAt(html, /<form\b[^>]*\bid="views-exposed-form-form-fee-listing-form-fee-items"[^>]*>/i, "form");
  const formTag = form ? /^<form\b([^>]*)>/i.exec(form) : null;
  const action = formTag ? attrValue(formTag[1], "action") : null;
  const method = formTag ? (attrValue(formTag[1], "method") ?? "get").toLowerCase() : null;
  const input = form ? /<input\b([^>]*\btype="text"[^>]*)>/i.exec(form) : null;
  const field = input ? attrValue(input[1], "name") : null;
  const actionUrl = action ? resolveUrl(action, pageUrl) : null;
  return { ...page, pdf, options, filter: actionUrl && field && method === "get" ? { action: actionUrl, field } : null };
}

/**
 * The URL the page's own fee filter (a GET form: action /g-1055, one text
 * field) requests for one of the choices it lists: what a visitor's browser
 * asks for when picking that form, not an address made up here.
 */
export function feeEntryUrl(filter: { action: string; field: string }, optionId: string): string {
  const url = new URL(filter.action);
  url.search = "";
  url.searchParams.set(filter.field, optionId);
  return url.toString();
}

export type FeeEntry = {
  /** The entry's heading ("I-130, Petition for Alien Relative"). */
  heading: string | null;
  headings: number;
  /** The entry as document text (heading, link to the form page, fee table, notes). */
  text: string;
  /** "Visit the I-130 page for more information." link. */
  formPageUrl: string | null;
};

/** The fee entry the filter shows on the G-1055 page. */
export function parseFeeEntry(html: string, pageUrl: string): FeeEntry {
  const block = sliceFrom(html, /class="[^"]*\bform-fee-listing-form_fee_items\b/, [/<div id="block-uscis-design-lastreviewedupdateddate"/, "</main>"]) ?? "";
  const headings = [...block.matchAll(/<h2\b[^>]*class="form-fee-title"[^>]*>([\s\S]*?)<\/h2\s*>/gi)];
  const first = headings[0];
  const content = first ? block.slice(first.index ?? 0) : "";
  const visit = sliceFrom(content, "form-fee-visit-link", ["</div>"]);
  const link = visit ? anchors(visit)[0] : undefined;
  // The "File Online" button under the entry is a link to the online account, not part of the fee information.
  const withoutButtons = content.replace(/<div\b[^>]*class="file-online-link[^"]*"[^>]*>[\s\S]*?<\/div\s*>/gi, " ");
  return {
    heading: first ? inlineText(first[1]) || null : null,
    headings: headings.length,
    text: content ? uscisText(withoutButtons) : "",
    formPageUrl: link ? resolveUrl(link.href, pageUrl) : null,
  };
}

// --- I-864P, HHS Poverty Guidelines (https://www.uscis.gov/i-864p) -------

export type GuidelineTable = {
  /** The accordion heading the table is under ("For Alaska"). */
  heading: string;
  /** Header cells, verbatim. */
  columns: string[];
  /** Body rows, cells verbatim. */
  rows: string[][];
};

/** The poverty guideline tables under their headings (a table no header opens is not one; see the file comment). */
export function parseGuidelineTables(articleHtml: string): GuidelineTable[] {
  const out: GuidelineTable[] = [];
  const re = /<(h[1-6]|div)\b[^>]*class="accordion__header"[^>]*>([\s\S]*?)<\/\1\s*>\s*(<div\b[^>]*class="accordion__panel"[^>]*>)/gi;
  for (const m of articleHtml.matchAll(re)) {
    const panelStart = (m.index ?? 0) + m[0].length - m[3].length;
    const end = balancedEnd(articleHtml, panelStart, "div");
    const panel = end > 0 ? articleHtml.slice(panelStart, end) : "";
    const table = elementAt(panel, /<table\b[^>]*>/i, "table");
    if (!table) continue;
    const head = /<thead\b[^>]*>([\s\S]*?)<\/thead\s*>/i.exec(table);
    const body = /<tbody\b[^>]*>([\s\S]*?)<\/tbody\s*>/i.exec(table);
    out.push({
      heading: inlineText(m[2]).replace(/:\s*$/, ""),
      columns: head ? (tableRows(head[1])[0] ?? []).map((c) => inlineText(c)) : [],
      rows: body ? tableRows(body[1]).map((r) => r.map((c) => inlineText(c))) : [],
    });
  }
  return out;
}

// --- Temporary Protected Status (https://www.uscis.gov/humanitarian/temporary-protected-status)

export type TpsCountryLink = {
  /** The country as the page names it ("Burma (Myanmar)"). */
  country: string;
  url: string;
  /** "current" under "Countries Currently Designated for TPS", "previous" under "Countries Previously Designated for TPS". */
  listing: "current" | "previous";
  /** The heading it was listed under, verbatim. */
  listedUnder: string;
};

/** The two country lists on the TPS page, each the panel after its accordion heading. */
export function parseTpsCountryLists(articleHtml: string, pageUrl: string): { countries: TpsCountryLink[]; headingsFound: string[] } {
  const countries: TpsCountryLink[] = [];
  const headingsFound: string[] = [];
  const re = /<(h[1-6]|div)\b[^>]*class="accordion__header"[^>]*>([\s\S]*?)<\/\1\s*>\s*(<div\b[^>]*class="accordion__panel"[^>]*>)/gi;
  for (const m of articleHtml.matchAll(re)) {
    const heading = inlineText(m[2]);
    const which = /^Countries Currently Designated for TPS$/i.test(heading) ? "current" : /^Countries Previously Designated for TPS$/i.test(heading) ? "previous" : null;
    if (!which) continue;
    headingsFound.push(heading);
    const panelStart = (m.index ?? 0) + m[0].length - m[3].length;
    const end = balancedEnd(articleHtml, panelStart, "div");
    const panel = end > 0 ? articleHtml.slice(panelStart, end) : "";
    for (const li of panel.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)) {
      const a = anchors(li[1])[0];
      const url = a ? resolveUrl(a.href, pageUrl) : null;
      if (!a || !url || !a.text) continue;
      countries.push({ country: a.text, url, listing: which, listedUnder: heading });
    }
  }
  return { countries, headingsFound };
}

// Other names Federal Register titles use for countries USCIS lists
// ("... for Salvadoran Temporary Protected Status Beneficiaries", "Designation
// of Syrian Arab Republic ..."). Matching only: nothing is stored from it.
const OTHER_NAMES: Record<string, string[]> = {
  afghanistan: ["Afghan"],
  "burma (myanmar)": ["Burmese"],
  cameroon: ["Cameroonian"],
  "el salvador": ["Salvadoran"],
  ethiopia: ["Ethiopian"],
  guinea: ["Guinean"],
  haiti: ["Haitian"],
  honduras: ["Honduran"],
  lebanon: ["Lebanese"],
  liberia: ["Liberian"],
  nepal: ["Nepalese", "Nepali"],
  nicaragua: ["Nicaraguan"],
  "sierra leone": ["Sierra Leonean"],
  somalia: ["Somali"],
  "south sudan": ["South Sudanese"],
  sudan: ["Sudanese"],
  syria: ["Syrian Arab Republic", "Syrian"],
  ukraine: ["Ukrainian"],
  venezuela: ["Venezuelan"],
  yemen: ["Yemeni"],
};

/** The names a country goes by in titles and alerts: "Burma (Myanmar)" also as "Burma" and "Myanmar", "Haiti" as "Haitian". */
export function countryNames(country: string): string[] {
  const names = [country];
  const m = /^(.+?)\s*\((.+)\)\s*$/.exec(country);
  if (m) names.push(m[1].trim(), m[2].trim());
  names.push(...(OTHER_NAMES[country.toLowerCase()] ?? []));
  return names;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The countries (from `countries`) a text names. Longer names are matched
 * first and blanked out, so "South Sudan" is not also read as "Sudan".
 */
export function countriesNamedIn(text: string, countries: readonly string[]): string[] {
  const names = countries.flatMap((country) => countryNames(country).map((name) => ({ country, name }))).sort((a, b) => b.name.length - a.name.length);
  let rest = text.replace(/\u2019/g, "'");
  const found = new Set<string>();
  for (const { country, name } of names) {
    const re = new RegExp(`(^|[^\\p{L}])${escapeRegExp(name)}s?(?=$|[^\\p{L}])`, "giu");
    if (re.test(rest)) {
      found.add(country);
      rest = rest.replace(re, (whole: string, lead: string) => `${lead}${" ".repeat(whole.length - lead.length)}`);
    }
  }
  return [...found];
}

export type TpsFact = { label: string; value: string; links: { text: string; url: string }[] };

export type CitedNotice = { text: string; url: string | null; documentNumber: string | null; citation: string | null };

export type TpsPosture = Partial<
  Record<
    | "designatedThrough"
    | "terminationEffective"
    | "reRegistrationPeriod"
    | "initialRegistrationPeriod"
    | "registrationPeriod"
    | "eadAutoExtendedThrough"
    | "continuousResidenceSince"
    | "continuousPhysicalPresenceSince"
    | "designationDate"
    | "currentDesignationDate",
    { label: string; text: string; date: string | null; endDate?: string | null }
  >
>;

export type TpsCountryPage = UscisPage & {
  /** The key-facts table at the top of the page, rows in order, verbatim. */
  facts: TpsFact[];
  posture: TpsPosture;
  /** Federal Register notices the page links or cites. */
  cited: CitedNotice[];
  text: string;
};

/** "90 FR 5953", "84 FRN 59403", "90 Fed. Reg 58028" written as "<volume> FR <page>". */
export function frCitationKey(text: string): string | null {
  const m = /\b(\d{2,3})\s*(?:FRN?|Fed\.?\s*Reg\.?)\s*(\d{1,3}(?:,\d{3})+|\d{1,6})\b/i.exec(text);
  return m ? `${Number(m[1])} FR ${Number(m[2].replace(/,/g, ""))}` : null;
}

/** The Federal Register document number in a federalregister.gov link (/documents/2025/01/17/2025-00626/..., /public-inspection/2026-10704/...). */
export function frDocumentNumberFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)federalregister\.gov$/i.test(u.hostname)) return null;
    const m = /^\/(?:documents\/\d{4}\/\d{2}\/\d{2}|d|public-inspection)\/([A-Z]?\d{2,4}-\d{3,6})(?:\/|$)/i.exec(u.pathname);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Every Federal Register notice a fragment links or cites as "<volume> FR <page>" / "<volume> Fed. Reg. <page>". */
export function citedNotices(fragment: string, pageUrl: string): CitedNotice[] {
  const out: CitedNotice[] = [];
  const seen = new Set<string>();
  for (const a of anchors(fragment)) {
    const url = resolveUrl(a.href, pageUrl);
    const documentNumber = url ? frDocumentNumberFromUrl(url) : null;
    if (!documentNumber) continue;
    const citation = frCitationKey(a.text);
    const key = `${documentNumber}|${citation ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: a.text, url, documentNumber, citation });
  }
  const text = inlineText(fragment);
  for (const m of text.matchAll(/\b\d{2,3}\s*(?:FRN?|Fed\.?\s*Reg\.?)\s*(?:\d{1,3}(?:,\d{3})+|\d{1,6})\b/gi)) {
    const citation = frCitationKey(m[0]);
    if (!citation || out.some((c) => c.citation === citation)) continue;
    out.push({ text: m[0], url: null, documentNumber: null, citation });
  }
  return out;
}

const POSTURE_LABELS: [keyof TpsPosture, RegExp][] = [
  ["eadAutoExtendedThrough", /\b(?:EAD|Employment Authorization)\b.*\bextended\b/i],
  ["terminationEffective", /\btermination effective\b/i],
  ["currentDesignationDate", /\bcurrent TPS designation date\b/i],
  ["designationDate", /\bTPS designation date\b/i],
  ["reRegistrationPeriod", /\bre-?registration period\b/i],
  ["initialRegistrationPeriod", /\binitial registration period\b/i],
  ["registrationPeriod", /^registration period\b/i],
  ["continuousResidenceSince", /\bcontinuous residence\b/i],
  ["continuousPhysicalPresenceSince", /\bcontinuous physical presence\b/i],
  ["designatedThrough", /\b(?:designated|continued|extended)\s+through\b/i],
];

/** The posture fields a facts table states, by label; only labels recognized here, each with its stated text and the date(s) that parse. */
export function postureFromFacts(facts: TpsFact[]): TpsPosture {
  const posture: TpsPosture = {};
  for (const fact of facts) {
    const key = POSTURE_LABELS.find(([, re]) => re.test(fact.label))?.[0];
    if (!key || posture[key]) continue;
    const isPeriod = key === "reRegistrationPeriod" || key === "initialRegistrationPeriod" || key === "registrationPeriod";
    const parts = isPeriod ? fact.value.split(/\s+(?:[-\u2013\u2014]|through|to)\s+/i) : [fact.value];
    const date = parseStatedDate(parts[0]);
    posture[key] = isPeriod ? { label: fact.label, text: fact.value, date, endDate: parts[1] ? parseStatedDate(parts[1]) : null } : { label: fact.label, text: fact.value, date };
  }
  return posture;
}

/** A TPS country page: its key-facts table, the posture it states, the Federal Register notices it cites, and its text. */
export function parseTpsCountryPage(html: string, pageUrl: string): TpsCountryPage {
  const page = readUscisPage(html);
  const article = page.articleHtml ?? "";
  const facts: TpsFact[] = [];
  // The key-facts table: label cells ending in ":" with one value cell each.
  for (const table of article.matchAll(/<table\b[^>]*>/gi)) {
    const end = balancedEnd(article, table.index ?? 0, "table");
    const rows = end > 0 ? tableRows(article.slice(table.index ?? 0, end)) : [];
    const pairs = rows.filter((r) => r.length === 2 && /:\s*$/.test(inlineText(r[0])));
    if (pairs.length < 2 || pairs.length < rows.length - 1) continue;
    for (const [labelHtml, valueHtml] of pairs) {
      facts.push({
        label: inlineText(labelHtml).replace(/:\s*$/, ""),
        // A cell holding a list (the Federal Register citations) keeps its items apart.
        value: uscisText(valueHtml)
          .split("\n")
          .map((line) => line.replace(/^-\s+/, "").trim())
          .filter(Boolean)
          .join("; "),
        links: anchors(valueHtml)
          .map((a) => ({ text: a.text, url: resolveUrl(a.href, pageUrl) ?? "" }))
          .filter((l) => l.url),
      });
    }
    break;
  }
  return { ...page, facts, posture: postureFromFacts(facts), cited: citedNotices(article, pageUrl), text: article ? uscisText(article) : "" };
}

// --- Federal Register API (https://www.federalregister.gov/api/v1/documents.json)

export type FrNotice = {
  documentNumber: string;
  title: string;
  type: string | null;
  publicationDate: string | null;
  effectiveOn: string | null;
  citation: string | null;
  htmlUrl: string | null;
  pdfUrl: string | null;
  action: string | null;
  dates: string | null;
  agencies: string[];
};

type FrApiDocument = {
  document_number?: unknown;
  title?: unknown;
  type?: unknown;
  publication_date?: unknown;
  effective_on?: unknown;
  citation?: unknown;
  html_url?: unknown;
  pdf_url?: unknown;
  action?: unknown;
  dates?: unknown;
  agencies?: unknown;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** One page of the Federal Register API's document search, as notices; null when the answer is not that API's shape. */
export function parseFrDocumentsPage(data: unknown): { count: number; notices: FrNotice[]; nextPageUrl: string | null } | null {
  const d = data as { count?: unknown; results?: unknown; next_page_url?: unknown };
  if (!d || typeof d !== "object" || typeof d.count !== "number" || (d.count > 0 && !Array.isArray(d.results))) return null;
  const notices: FrNotice[] = [];
  for (const r of (Array.isArray(d.results) ? d.results : []) as FrApiDocument[]) {
    const documentNumber = str(r.document_number);
    const title = str(r.title);
    if (!documentNumber || !title) continue;
    notices.push({
      documentNumber,
      title,
      type: str(r.type),
      publicationDate: str(r.publication_date),
      effectiveOn: str(r.effective_on),
      citation: str(r.citation),
      htmlUrl: str(r.html_url),
      pdfUrl: str(r.pdf_url),
      action: str(r.action),
      dates: str(r.dates),
      agencies: Array.isArray(r.agencies) ? (r.agencies as { name?: unknown }[]).map((a) => str(a?.name)).filter((n): n is string => Boolean(n)) : [],
    });
  }
  return { count: d.count, notices, nextPageUrl: str(d.next_page_url) };
}

/** A Federal Register title about TPS ("... for Temporary Protected Status", "... Under Temporary Protected Status Program"). */
export function isTpsTitle(title: string): boolean {
  return /\bTemporary Protected Status\b/i.test(title);
}

export type FederalRegisterCheck = {
  noticesFound: number;
  newestNotice: FrNotice | null;
  /** Whether the USCIS pages cite the newest notice (null when none was found). */
  newestNoticeCitedByUscis: boolean | null;
  newestNoticeCitedByUscisPage: FrNotice | null;
  /** Notices published after the newest one the USCIS pages cite, which they do not cite. */
  laterNoticesNotCited: FrNotice[];
  /** Notices published after the page's Last Reviewed/Updated date. */
  noticesAfterPageReviewed: FrNotice[];
  /** The comparison in one sentence. */
  note: string;
};

/** Compares the notices the USCIS pages cite with the TPS notices the Federal Register lists for the country (newest first). */
export function checkAgainstFederalRegister(params: {
  country: string;
  cited: CitedNotice[];
  notices: FrNotice[];
  pageReviewedIso: string | null;
}): FederalRegisterCheck {
  const numbers = new Set(params.cited.map((c) => c.documentNumber?.toUpperCase()).filter(Boolean));
  const citations = new Set(params.cited.map((c) => c.citation).filter(Boolean));
  const isCited = (n: FrNotice) => numbers.has(n.documentNumber.toUpperCase()) || (n.citation ? citations.has(frCitationKey(n.citation)) : false);
  const notices = [...params.notices].sort((a, b) => (b.publicationDate ?? "").localeCompare(a.publicationDate ?? ""));
  const newest = notices[0] ?? null;
  const newestCited = notices.find(isCited) ?? null;
  const later = notices.filter((n) => !isCited(n) && (!newestCited || (n.publicationDate ?? "") > (newestCited.publicationDate ?? "")));
  const afterReviewed = params.pageReviewedIso ? notices.filter((n) => (n.publicationDate ?? "") > params.pageReviewedIso!) : [];
  const describe = (n: FrNotice) => `${n.citation ?? n.documentNumber} (${n.documentNumber}, published ${n.publicationDate ?? "date not stated"}): ${n.title}`;
  let note: string;
  if (!newest) note = `The Federal Register search found no notice on Temporary Protected Status whose title names ${params.country}.`;
  else if (later.length === 0) note = `The USCIS pages cite the newest Federal Register notice on TPS whose title names ${params.country}: ${describe(newest)}.`;
  else
    note = `The Federal Register lists ${later.length} notice(s) on TPS naming ${params.country} that the USCIS pages do not cite, published after ${newestCited ? `the newest one they cite (${newestCited.citation ?? newestCited.documentNumber})` : "any they cite"}; the newest is ${describe(later[0])}.`;
  return {
    noticesFound: notices.length,
    newestNotice: newest,
    newestNoticeCitedByUscis: newest ? isCited(newest) : null,
    newestNoticeCitedByUscisPage: newestCited,
    laterNoticesNotCited: later,
    noticesAfterPageReviewed: afterReviewed,
    note,
  };
}
