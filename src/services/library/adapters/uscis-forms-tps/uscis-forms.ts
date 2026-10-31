import { parseStatedDate, utcDate } from "@/services/monitoring/parse/dates";
import { extractPdfText } from "../../extract/pdf";
import { sha256Hex } from "../../text";
import {
  LibraryLayoutError,
  type BackfillChunk,
  type DocumentRef,
  type FetchDocumentResult,
  type LibraryAdapterContext,
  type LibrarySourceAdapter,
} from "../../types";
import { isXfaPlaceholder, parseAllForms, parseFormPage, parseFormsUpdates, parseSlashDate, pdfFormFacts, type FormListing, type FormPage } from "./parse";
import { USCIS_AGENCY, USCIS_HOST, isUscisUrl, pathKey, readRunPage, recallPage } from "./run-pages";

// USCIS forms, as USCIS publishes them: every form on the All Forms page,
// each as its page (description, current edition date and the note on
// which editions are accepted, where to file, fee, checklist, special
// instructions) and as each PDF the page attaches under "Forms and Document
// Downloads" (the form, its instructions, supplements, worksheets and
// checklists), with the edition, OMB number and expiration date the PDF
// prints. G-1055 (the fee schedule) and I-864P (the poverty guidelines)
// have their own collectors in this folder and are left out here.
//
// - Daily: the All Forms page; the Forms Updates page back to a few days
//   before the last run (new editions); then the page of every form with a
//   new edition, plus a seventh of the forms in turn, so every form's page
//   and PDF list are read at least once a week. A page or PDF is fetched
//   again only when what its listing shows changed (page text, edition,
//   file size) or after recheckAfterDays, with a conditional GET.
// - Backfill: the All Forms list in its order, FORMS_PER_CHUNK forms a
//   chunk; the page of each, then its PDFs. The list is alphabetical, not
//   dated, so there is no "newest first".
// - uscis.gov's robots.txt asks for 10 seconds between requests: a form
//   with three PDFs costs about 40 seconds, so a chunk of 12 forms takes
//   about 9 minutes.
//
// US government work: public domain, stored in full. Form pages and PDFs
// are not law: precedential status not_applicable.

const ALL_FORMS_URL = "https://www.uscis.gov/forms/all-forms";
const FORMS_UPDATES_URL = "https://www.uscis.gov/forms/forms-updates";
const HOSTS = [USCIS_HOST] as const;
const FORMS_PER_CHUNK = 12;
const ROTATION_DAYS = 7;
/** Forms Updates rows this many days before the last daily run are read again (late postings, time zones). */
const UPDATE_OVERLAP_DAYS = 3;
const MAX_UPDATE_PAGES = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Collected by uscis_g1055 and uscis_i864p, in more detail. */
const OWN_COLLECTOR = new Set(["G-1055", "I-864P"]);

type PageListing = { kind: "form_page"; number: string; name: string; description: string | null };
type FileListing = {
  kind: "form_file";
  number: string;
  formName: string;
  formPageUrl: string;
  label: string;
  sizeText: string | null;
  pageEditionText: string | null;
  pageEditionDateText: string | null;
};
type Cursor = { offset: number };

function isCursor(value: unknown): value is Cursor {
  return Boolean(value) && Number.isInteger((value as Cursor).offset) && (value as Cursor).offset >= 0;
}

async function readAllForms(ctx: LibraryAdapterContext): Promise<FormListing[]> {
  const { text, response } = await ctx.http.getText(ALL_FORMS_URL, { expect: "html" });
  const parsed = parseAllForms(text, response.url);
  for (const note of parsed.notes) ctx.note(note);
  if (parsed.forms.length < 50) throw new LibraryLayoutError(ALL_FORMS_URL, `only ${parsed.forms.length} form rows were read`);
  // The page lists every form at once today; if it starts paging, this collector must follow the pages.
  if (parsed.statedTotal !== null && parsed.statedTotal !== parsed.rowsSeen) {
    throw new LibraryLayoutError(ALL_FORMS_URL, `the page counts ${parsed.statedTotal} forms but shows ${parsed.rowsSeen}`);
  }
  const seen = new Set<string>();
  return parsed.forms.filter((form) => {
    if (OWN_COLLECTOR.has(form.number.toUpperCase())) return false;
    if (!isUscisUrl(form.url)) {
      ctx.note(`${form.label}: its link (${form.url}) is not on ${USCIS_HOST}; left out.`);
      return false;
    }
    const key = pathKey(form.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Paths of the form pages the Forms Updates list shows a new edition for on or after `from` (YYYY-MM-DD). */
async function formsUpdatedSince(ctx: LibraryAdapterContext, from: string): Promise<Set<string>> {
  const updated = new Set<string>();
  let url: string | null = FORMS_UPDATES_URL;
  // Always read in full: the conditional listing GET of this page belongs to
  // uscis_form_updates (the validators are kept per URL, one source each).
  for (let pageNo = 0; url && pageNo < MAX_UPDATE_PAGES; pageNo++) {
    const { text, response } = await ctx.http.getText(url, { expect: "html" });
    const parsed = parseFormsUpdates(text, response.url);
    if (parsed.rows.length === 0) throw new LibraryLayoutError(url, "no update rows with a linked title");
    let older = false;
    for (const row of parsed.rows) {
      const posted = parseStatedDate(row.date?.text) ?? parseStatedDate(row.date?.datetime);
      if (posted && posted < from) older = true;
      else updated.add(pathKey(row.formUrl));
    }
    if (older) break;
    url = parsed.nextUrl;
  }
  return updated;
}

/** Reads one form's page and returns its refs: the page, then each PDF it attaches. */
async function formRefs(ctx: LibraryAdapterContext, form: FormListing): Promise<DocumentRef[]> {
  const { text, response } = await readRunPage(ctx, form.url);
  const page = parseFormPage(text, response.url, form.number);
  if (!page.isFormPage) {
    ctx.note(`${form.label}: ${form.url} is not a form page (a "${page.nodeType ?? "unknown"}" page); left out.`);
    recallPage(ctx, form.url, { forget: true });
    return [];
  }
  if (!page.editionDateText) ctx.note(`Form ${form.number}: its page states no edition date.`);
  for (const other of page.otherAttachments) ctx.note(`Form ${form.number}: attachment not collected (not a PDF on ${USCIS_HOST}): ${other}`);
  const pageListing: PageListing = { kind: "form_page", number: form.number, name: form.name, description: form.description };
  const refs: DocumentRef[] = [
    {
      externalId: `Form ${form.number}`,
      url: form.url,
      title: `Form ${form.number}, ${form.name}`,
      fingerprint: sha256Hex(
        [page.text, page.editionText ?? "", form.description ?? "", ...page.files.map((f) => `${f.url}|${f.label}|${f.sizeText ?? ""}`)].join("\u0000")
      ).slice(0, 32),
      listing: pageListing,
    },
  ];
  for (const file of page.files) {
    const listing: FileListing = {
      kind: "form_file",
      number: form.number,
      formName: form.name,
      formPageUrl: response.url,
      label: file.label,
      sizeText: file.sizeText,
      pageEditionText: page.editionText,
      pageEditionDateText: page.editionDateText,
    };
    refs.push({
      externalId: `file ${new URL(file.url).pathname}`,
      url: file.url,
      title: file.label,
      fingerprint: sha256Hex([file.url, file.label, file.sizeText ?? "", page.editionDateText ?? ""].join("\u0000")).slice(0, 32),
      listing,
    });
  }
  return refs;
}

/**
 * The refs of each form in turn. A form page that cannot be read is noted
 * and left for its next turn; when most of them fail, the run fails.
 */
async function refsFor(ctx: LibraryAdapterContext, forms: FormListing[]): Promise<DocumentRef[]> {
  const refs: DocumentRef[] = [];
  const ids = new Set<string>();
  let failed = 0;
  let lastError: unknown = null;
  for (const form of forms) {
    let formRefList: DocumentRef[];
    try {
      formRefList = await formRefs(ctx, form);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      failed++;
      lastError = err;
      ctx.note(`Form ${form.number}: its page could not be read (${err instanceof Error ? err.message : String(err)}); it is read again on its next turn.`);
      continue;
    }
    // A PDF attached to two form pages is one document (listed with the first).
    for (const ref of formRefList) {
      if (ids.has(ref.externalId)) continue;
      ids.add(ref.externalId);
      refs.push(ref);
    }
  }
  if (failed > 0 && failed * 2 >= forms.length) throw lastError;
  return refs;
}

async function pageDocument(ctx: LibraryAdapterContext, ref: DocumentRef, listing: PageListing): Promise<FetchDocumentResult> {
  const read = recallPage(ctx, ref.url, { forget: true }) ?? (await ctx.http.getText(ref.url, { expect: "html", conditional: ref.known ?? null }));
  if (read.response.notModified) return { kind: "not_modified" };
  const page: FormPage = parseFormPage(read.text, read.response.url, listing.number);
  if (!page.isFormPage) return { kind: "skip", reason: `${ref.url} is no longer a form page.` };
  const number = page.number ?? listing.number;
  const name = page.name ?? listing.name;
  return {
    kind: "document",
    document: {
      externalId: ref.externalId,
      docType: "form",
      title: `Form ${number}, ${name}`,
      citations: [`Form ${number}`],
      agency: USCIS_AGENCY,
      editionDate: parseSlashDate(page.editionDateText, ctx.now),
      precedentialStatus: "not_applicable",
      officialUrl: read.response.url,
      text: page.text,
      metadata: {
        kind: "form_page",
        formNumber: number,
        formName: name,
        ...(listing.description ? { summary: listing.description, summaryKind: "the form's description on USCIS's All Forms page" } : {}),
        editionText: page.editionText,
        files: page.files,
        sections: page.sections,
        alerts: page.alerts,
        lastReviewedUpdated: page.lastReviewed?.text ?? null,
        statedDates: { edition: page.editionDateText, lastReviewedUpdated: page.lastReviewed?.text ?? null },
        listedOn: ALL_FORMS_URL,
        ...(page.otherAttachments.length ? { otherAttachments: page.otherAttachments } : {}),
        ...(page.orphanPanelsDropped ? { hiddenPanelsLeftOut: page.orphanPanelsDropped } : {}),
      },
      fetch: { response: read.response },
    },
  };
}

async function fileDocument(ctx: LibraryAdapterContext, ref: DocumentRef, listing: FileListing): Promise<FetchDocumentResult> {
  const response = await ctx.http.get(ref.url, { expect: "pdf", conditional: ref.known ?? null });
  if (response.notModified) return { kind: "not_modified" };
  const pdf = await extractPdfText(response.body);
  const facts = pdfFormFacts(pdf.text);
  // A dynamic (XFA) form's text layer holds only a "Please wait..." message, not the form.
  const xfa = isXfaPlaceholder(pdf.text);
  const hasText = pdf.pagesWithText > 0 && !xfa;
  const fileEdition = parseSlashDate(facts.editionText, ctx.now);
  const pageEdition = parseSlashDate(listing.pageEditionDateText, ctx.now);
  if (pdf.truncated) ctx.note(`${ref.externalId}: only the first ${pdf.pagesRead} page(s) of ${pdf.pageCount} were read (size caps).`);
  return {
    kind: "document",
    document: {
      externalId: ref.externalId,
      docType: "form",
      title: listing.label,
      citations: [],
      // EOIR forms USCIS also accepts (EOIR-29) are issued by EOIR, as the PDF prints.
      agency: /^EOIR-/i.test(listing.number) && /Executive Office for Immigration Review/.test(pdf.text) ? "Executive Office for Immigration Review" : USCIS_AGENCY,
      // The edition the file itself prints; the form page's edition is in the metadata.
      editionDate: fileEdition,
      precedentialStatus: "not_applicable",
      officialUrl: ref.url,
      originalUrl: response.url !== ref.url ? response.url : null,
      text: hasText ? pdf.text : "",
      textKind: hasText ? "full" : "none",
      metadata: {
        kind: "form_file",
        formNumber: listing.number,
        formName: listing.formName,
        formPage: listing.formPageUrl,
        fileLabel: listing.label,
        sizeText: listing.sizeText,
        editionPrinted: facts.editionText,
        ...(facts.revisionText ? { revisionPrinted: facts.revisionText } : {}),
        pageEditionText: listing.pageEditionText,
        // Whether a form or its instructions prints the edition its page states (checklists and guides have their own).
        ...(fileEdition && pageEdition && /^(?:Instructions for )?Form\s/i.test(listing.label) ? { editionAgreesWithPage: fileEdition === pageEdition } : {}),
        ombNumber: facts.ombNumber,
        expiresPrinted: facts.expiresText,
        statedDates: { edition: facts.editionText, revision: facts.revisionText, expires: facts.expiresText, pageEdition: listing.pageEditionDateText },
        pageCount: pdf.pageCount,
        ...(xfa ? { textNote: "The PDF is a dynamic (XFA) form; its text layer holds only the viewer's placeholder message, so no text is stored." } : {}),
        ...(pdf.pagesWithText === 0 ? { textNote: "The PDF has no text layer; no OCR is run." } : {}),
      },
      original: { bytes: response.body, contentType: "application/pdf", extension: "pdf" },
      fetch: { response, extraction: { method: pdf.method, pages: pdf.pageCount, pagesWithText: pdf.pagesWithText, ms: pdf.ms, truncated: pdf.truncated } },
    },
  };
}

export const uscisFormsAdapter: LibrarySourceAdapter = {
  code: "uscis_forms",
  group: "uscis-forms-fees",
  name: "USCIS forms and instructions",
  description:
    "Every form on USCIS's All Forms page: the form's page (current edition date and which editions USCIS accepts, where to file, fees, evidence checklist, special instructions) and each PDF it attaches (the form, its instructions, supplements and checklists), with the edition each PDF prints.",
  coverage:
    "The forms USCIS's All Forms page lists (about 100), their current pages and the PDFs attached to them; earlier editions only as stored versions from when this collector read them. G-1055 and I-864P are in their own collectors.",
  cadence: "Daily: new editions from USCIS's Forms Updates page; every form page re-read at least weekly",
  officialUrl: ALL_FORMS_URL,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 21,

  async listUpdates(ctx, since) {
    const forms = await readAllForms(ctx);
    const updated = since ? await formsUpdatedSince(ctx, utcDate(new Date(since.getTime() - UPDATE_OVERLAP_DAYS * DAY_MS))) : new Set<string>();
    const turn = Math.floor(ctx.now.getTime() / DAY_MS) % ROTATION_DAYS;
    const chosen = forms.filter((form, i) => i % ROTATION_DAYS === turn || updated.has(pathKey(form.url)));
    const fromUpdates = forms.filter((form) => updated.has(pathKey(form.url))).length;
    ctx.note(`Read ${chosen.length} of ${forms.length} form pages: ${fromUpdates} with a new edition on Forms Updates, the rest today's share of the weekly round.`);
    return { refs: await refsFor(ctx, chosen) };
  },

  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const forms = await readAllForms(ctx);
    const offset = isCursor(cursor) ? cursor.offset : 0;
    if (offset >= forms.length) {
      if (offset > 0) ctx.note(`The cursor (form ${offset + 1}) is past the ${forms.length} forms listed now; the history walk ends here.`);
      return { refs: [], nextCursor: null, progress: "every listed form is done" };
    }
    const slice = forms.slice(offset, offset + FORMS_PER_CHUNK);
    const next = offset + FORMS_PER_CHUNK;
    return {
      refs: await refsFor(ctx, slice),
      nextCursor: next < forms.length ? { offset: next } : null,
      progress: `forms ${offset + 1} to ${offset + slice.length} of ${forms.length} (${slice[0].number} to ${slice[slice.length - 1].number})`,
    };
  },

  async fetchDocument(ctx, ref) {
    const listing = ref.listing as PageListing | FileListing | undefined;
    if (listing?.kind === "form_page") return pageDocument(ctx, ref, listing);
    if (listing?.kind === "form_file") return fileDocument(ctx, ref, listing);
    return { kind: "skip", reason: `${ref.externalId}: the listing data is missing.` };
  },

  legalUpdateItem(document) {
    // A form new to the All Forms page; new editions of known forms reach the
    // updates through the monitor's Forms Updates source and uscis_form_updates.
    if (document.metadata?.kind !== "form_page") return null;
    const edition = typeof document.metadata.editionText === "string" ? document.metadata.editionText : null;
    const editionDate = (document.metadata.statedDates as { edition?: string | null } | undefined)?.edition ?? null;
    const summary = typeof document.metadata.summary === "string" ? document.metadata.summary : null;
    return {
      itemType: "USCIS form update",
      excerpt: [document.title, summary, edition ? `Edition Date: ${edition}` : null].filter(Boolean).join("\n"),
      publishedDateText: editionDate ? `Edition Date: ${editionDate}` : null,
      listedOnUrl: ALL_FORMS_URL,
    };
  },
};

