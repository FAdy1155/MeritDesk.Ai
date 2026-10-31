import { parseStatedDate } from "@/services/monitoring/parse/dates";
import { htmlToDocumentText } from "../../extract/html";
import { LibraryLayoutError, type BackfillChunk, type DocumentRef, type FetchDocumentResult, type LibraryAdapterContext, type LibrarySourceAdapter } from "../../types";
import { cachedPage, chunkOf, fingerprintOf } from "./common";
import { parsePomsSection, parsePomsToc } from "./parse";

// The Social Security Administration's Program Operations Manual System
// (POMS), the subchapters on noncitizens, on secure.ssa.gov:
//
// - SI 00502: SSI eligibility of aliens (qualified alien categories, the
//   seven-year limit, sponsor deeming, evidence of alien status);
// - RM 10211: Social Security numbers for noncitizens (evidence of
//   immigration status and work authorization);
// - RS 00204: the lawful presence requirement for benefit payments;
// - RS 02635: deportation and removal (nonpayment of benefits).
//
// Each POMS section is one document: its citation ("SI 00502.100"), title,
// effective dates and transmittal ("TN 73 (09-26)") as the page states
// them. secure.ssa.gov's robots.txt allows /poms.nsf/ and sets no
// Crawl-delay. US government work: public domain, stored in full.

const HOSTS = ["secure.ssa.gov", "policy.ssa.gov"] as const;
const SUBCHAPTERS = [
  { url: "https://secure.ssa.gov/poms.nsf/lnx/0500502000", label: "SI 00502 Aliens" },
  { url: "https://secure.ssa.gov/poms.nsf/lnx/0110211000", label: "RM 10211 Evidence for SSNs: noncitizens" },
  { url: "https://secure.ssa.gov/poms.nsf/lnx/0300204000", label: "RS 00204 Lawful presence payment provisions" },
  { url: "https://secure.ssa.gov/poms.nsf/lnx/0302635000", label: "RS 02635 Deportation" },
] as const;

type Listing = { citation: string; subchapter: string };

async function readAll(ctx: LibraryAdapterContext): Promise<DocumentRef[]> {
  const refs: DocumentRef[] = [];
  const seen = new Set<string>();
  for (const sub of SUBCHAPTERS) {
    const { text, response } = await cachedPage(ctx, sub.url);
    const sections = parsePomsToc(text, response.url);
    if (sections.length === 0) throw new LibraryLayoutError(sub.url, "no section links in the table of contents");
    for (const s of sections) {
      if (seen.has(s.citation)) continue;
      seen.add(s.citation);
      refs.push({ externalId: `POMS ${s.citation}`, url: s.url, title: s.citation, fingerprint: fingerprintOf(s.citation, s.url), listing: { citation: s.citation, subchapter: sub.label } satisfies Listing });
    }
  }
  return refs;
}

export const ssaPomsAlienAdapter: LibrarySourceAdapter = {
  code: "ssa_poms_alien_eligibility",
  group: "other-agency-guidance",
  name: "SSA POMS: noncitizen eligibility and evidence",
  description:
    "The Social Security Administration's operating instructions on noncitizens: SSI eligibility of aliens, Social Security numbers for noncitizens, the lawful presence payment rules and nonpayment after removal.",
  coverage: "Every section listed in POMS subchapters SI 00502, RM 10211, RS 00204 and RS 02635, regional supplements included.",
  cadence: "Daily",
  officialUrl: SUBCHAPTERS[0].url,
  hosts: HOSTS,
  license: "public_domain",
  staleAfterHours: 48,
  recheckAfterDays: 30,

  async listUpdates(ctx) {
    return { refs: await readAll(ctx) };
  },
  async backfill(ctx, cursor): Promise<BackfillChunk> {
    const { items, nextCursor, progress } = chunkOf(await readAll(ctx), cursor, 250);
    return { refs: items, nextCursor, progress };
  },
  async fetchDocument(ctx, ref): Promise<FetchDocumentResult> {
    const listing = ref.listing as Listing | undefined;
    const { text, response } = await ctx.http.getText(ref.url, { expect: "html", conditional: ref.known ?? null });
    if (response.notModified) return { kind: "not_modified" };
    const section = parsePomsSection(text);
    if (!section) return { kind: "skip", reason: `${ref.url} is not a POMS section page in the layout this collector reads.` };
    const effectiveFrom = section.effectiveText ? parseStatedDate(section.effectiveText.split(/\s+-\s+/)[0]) : null;
    return {
      kind: "document",
      document: {
        externalId: ref.externalId,
        docType: "manual_section",
        title: `POMS ${section.citation} ${section.title}`,
        citations: [`POMS ${section.citation}`],
        agency: "Social Security Administration",
        effectiveDate: effectiveFrom,
        precedentialStatus: "not_applicable",
        officialUrl: response.url,
        text: htmlToDocumentText(section.html),
        metadata: {
          citation: section.citation,
          subchapter: listing?.subchapter ?? null,
          ...(section.transmittal ? { transmittal: section.transmittal } : {}),
          ...(section.effectiveText ? { statedDates: { effective: section.effectiveText } } : {}),
        },
        fetch: { response },
      },
    };
  },
};
