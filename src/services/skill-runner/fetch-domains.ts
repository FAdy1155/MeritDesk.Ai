// The sites web_fetch may open in skills whose SKILL.md does not limit its
// sources itself. Every matter skill has the client's case file in context,
// and web_fetch opens any URL that has appeared in the conversation, matter
// documents and fetched pages included. Open to the whole web, a document
// written to steer the model ("follow the link for each letter of the
// client's A-number") could send case details to a server its author reads,
// one fetched path at a time. Limited to these hosts (subdomains included),
// a fetch can reach only official, intergovernmental, established NGO and
// major press sites, none of which hands its request logs to a document's
// author. web_search stays open: results only list pages, and a page on
// another site can still be cited, as a search result the verification log
// marks as not retrieved (README "Web research and the verification log").
//
// Bare lowercase hostnames, no scheme or path (server-tools.ts checks them).
// A firm whose accepted sources (PRACTICE_PROFILE.md) include another site
// adds it here; an organization-level allow list in the Claude Console must
// include every entry, or the API rejects the request.

/** Statutes, regulations, agency guidance and court decisions. */
export const LEGAL_AUTHORITY_FETCH_DOMAINS = [
  // Federal government: EOIR and the BIA/AG precedents, the courts, the U.S.
  // Code, the CFR, the Federal Register, agency manuals.
  "justice.gov",
  "uscourts.gov",
  "supremecourt.gov",
  "govinfo.gov",
  "ecfr.gov",
  "federalregister.gov",
  "regulations.gov",
  "congress.gov",
  "uscode.house.gov",
  "uscis.gov",
  "state.gov",
  "dhs.gov",
  "ice.gov",
  "cbp.gov",
  // Free case law and statute collections.
  "law.cornell.edu",
  "courtlistener.com",
  "justia.com",
  "findlaw.com",
] as const;

/** Country-conditions reporting: government, intergovernmental, NGO and press sources. */
export const COUNTRY_CONDITIONS_FETCH_DOMAINS = [
  // Governments.
  "state.gov",
  "uscirf.gov",
  "congress.gov",
  "loc.gov",
  "justice.gov",
  "uscis.gov",
  "gov.uk",
  "irb.gc.ca",
  "irb-cisr.gc.ca",
  "euaa.europa.eu",
  // Intergovernmental.
  "unhcr.org",
  "refworld.org",
  "ohchr.org",
  "un.org",
  "unodc.org",
  "unicef.org",
  "reliefweb.int",
  "oas.org",
  "ecoi.net",
  // Non-governmental organizations and research.
  "hrw.org",
  "amnesty.org",
  "freedomhouse.org",
  "crisisgroup.org",
  "cpj.org",
  "rsf.org",
  "frontlinedefenders.org",
  "humanrightsfirst.org",
  "minorityrights.org",
  "ilga.org",
  "outrightinternational.org",
  "insightcrime.org",
  "wola.org",
  "acleddata.com",
  "cfr.org",
  // Press.
  "reuters.com",
  "apnews.com",
  "bbc.com",
  "bbc.co.uk",
  "aljazeera.com",
  "theguardian.com",
  "nytimes.com",
  "washingtonpost.com",
  "npr.org",
  "france24.com",
  "dw.com",
  "voanews.com",
  "rferl.org",
  "elpais.com",
] as const;

/** Both lists, each host once: for a skill that researches country conditions and verifies authority. */
export const RESEARCH_FETCH_DOMAINS: readonly string[] = [
  ...new Set<string>([...COUNTRY_CONDITIONS_FETCH_DOMAINS, ...LEGAL_AUTHORITY_FETCH_DOMAINS]),
];
