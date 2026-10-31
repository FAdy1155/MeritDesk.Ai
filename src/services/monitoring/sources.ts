import type { LegalUpdateSourceKey } from "./types";

// The official sources the monitor checks, in the order a run checks them.
// Mirrors skills-content/eoir-weekly-update/references/sources.md sections
// 1-6 (AG and BIA precedent, EOIR policy memoranda, the two practice
// manuals, EOIR notices, the Federal Register items EOIR lists, and the
// federal courts of appeals per its per-circuit table), plus what the
// platform adds for its USCIS skills: USCIS form edition updates, USCIS
// Policy Manual updates, the EOIR Policy Manual's own table of changes, and
// the Federal Register API for DHS, USCIS, ICE, EOIR and State Department
// documents. Pure data: no server-only, so the UI and test scripts can read
// the labels.
//
// indexHosts: every host a listing fetch may reach, redirects included
// (https only, checked on every hop). documentHosts: the hosts an item's
// official link may be on, and so the only hosts a document read may reach.
// EOIR sources come first so the Federal Register API's copy of a document
// EOIR also lists is the one marked duplicate.

/**
 * "library": items the library's daily collection fed in
 * (src/services/library/legal-updates.ts), stored with the source key
 * "library:<adapter code>". They have no entry in SOURCES.
 */
export type SourceGroup = "eoir" | "federal_register" | "uscis" | "courts" | "library";

export type SourceDefinition = {
  key: LegalUpdateSourceKey;
  label: string;
  group: SourceGroup;
  /** The page a person would open to see what the monitor saw. */
  homeUrl: string;
  indexHosts: readonly string[];
  documentHosts: readonly string[];
  /** Court of appeals number, for the courts. */
  circuit?: number;
  /**
   * A source with no listing the monitor can read: reported on every run as
   * not checked (partial coverage), as sources.md says of the Second Circuit.
   */
  notCheckedReason?: string;
};

const JUSTICE = ["www.justice.gov", "justice.gov"] as const;

export const SOURCES: readonly SourceDefinition[] = [
  {
    key: "eoir_ag_bia_precedent",
    label: "AG and BIA precedent decisions (EOIR, current volume)",
    group: "eoir",
    homeUrl: "https://www.justice.gov/eoir/ag-bia-decisions",
    indexHosts: JUSTICE,
    documentHosts: JUSTICE,
  },
  {
    key: "eoir_policy_memoranda",
    label: "EOIR policy memoranda",
    group: "eoir",
    homeUrl: "https://www.justice.gov/eoir/policy-manual-eoir/part-V/memoranda/pm",
    indexHosts: JUSTICE,
    documentHosts: JUSTICE,
  },
  {
    key: "eoir_icpm",
    label: "Immigration Court Practice Manual (Policy Manual Part II)",
    group: "eoir",
    homeUrl: "https://www.justice.gov/eoir/policy-manual-eoir/part-II/icpm",
    indexHosts: JUSTICE,
    documentHosts: JUSTICE,
  },
  {
    key: "eoir_bia_practice_manual",
    label: "BIA Practice Manual (Policy Manual Part III)",
    group: "eoir",
    homeUrl: "https://www.justice.gov/eoir/policy-manual-eoir/part-III/bia",
    indexHosts: JUSTICE,
    documentHosts: JUSTICE,
  },
  {
    key: "eoir_policy_manual_changes",
    label: "EOIR Policy Manual table of changes (Appendix O)",
    group: "eoir",
    homeUrl: "https://www.justice.gov/eoir/policy-manual-eoir/part-VII/appendices/o",
    indexHosts: JUSTICE,
    documentHosts: JUSTICE,
  },
  {
    key: "eoir_notices",
    label: "EOIR notices and press releases",
    group: "eoir",
    homeUrl: "https://www.justice.gov/eoir/notices-and-press-releases",
    indexHosts: JUSTICE,
    documentHosts: JUSTICE,
  },
  {
    key: "eoir_federal_register",
    label: "Federal Register items EOIR lists",
    group: "eoir",
    homeUrl: "https://www.justice.gov/eoir/federal-register-notices",
    indexHosts: JUSTICE,
    documentHosts: ["www.govinfo.gov"],
  },
  {
    key: "federal_register",
    label: "Federal Register (DHS, USCIS, ICE, EOIR and State Department immigration documents)",
    group: "federal_register",
    homeUrl: "https://www.federalregister.gov/",
    indexHosts: ["www.federalregister.gov"],
    documentHosts: ["www.govinfo.gov", "www.federalregister.gov"],
  },
  {
    key: "uscis_policy_manual_updates",
    label: "USCIS Policy Manual updates",
    group: "uscis",
    homeUrl: "https://www.uscis.gov/policy-manual/updates",
    indexHosts: ["www.uscis.gov"],
    documentHosts: ["www.uscis.gov"],
  },
  {
    key: "uscis_forms_updates",
    label: "USCIS forms updates (new form editions)",
    group: "uscis",
    homeUrl: "https://www.uscis.gov/forms/forms-updates",
    indexHosts: ["www.uscis.gov"],
    documentHosts: ["www.uscis.gov"],
  },
  {
    key: "ca5",
    label: "Fifth Circuit published opinions (binding in Houston)",
    group: "courts",
    circuit: 5,
    homeUrl: "https://www.ca5.uscourts.gov/opinions",
    indexHosts: ["www.ca5.uscourts.gov"],
    documentHosts: ["www.ca5.uscourts.gov"],
  },
  {
    key: "ca1",
    label: "First Circuit published opinions",
    group: "courts",
    circuit: 1,
    homeUrl: "https://www.ca1.uscourts.gov/opn/search-month",
    indexHosts: ["www.ca1.uscourts.gov"],
    documentHosts: ["www.ca1.uscourts.gov"],
  },
  {
    key: "ca2",
    label: "Second Circuit published opinions",
    group: "courts",
    circuit: 2,
    homeUrl: "https://ww3.ca2.uscourts.gov/decisions.html",
    indexHosts: [],
    documentHosts: ["ww3.ca2.uscourts.gov"],
    notCheckedReason:
      "The Second Circuit has no opinion list the monitor can read (its decisions page is a search form), so it is not checked automatically: partial coverage, as sources.md notes. Check it by hand.",
  },
  {
    key: "ca3",
    label: "Third Circuit precedential opinions",
    group: "courts",
    circuit: 3,
    homeUrl: "https://www2.ca3.uscourts.gov/recentop/week/recprec.htm",
    indexHosts: ["www2.ca3.uscourts.gov"],
    documentHosts: ["www2.ca3.uscourts.gov"],
  },
  {
    key: "ca4",
    label: "Fourth Circuit published opinions",
    group: "courts",
    circuit: 4,
    homeUrl: "https://www.ca4.uscourts.gov/opinions/recent-opinions/published-only",
    indexHosts: ["www.ca4.uscourts.gov"],
    documentHosts: ["www.ca4.uscourts.gov"],
  },
  {
    key: "ca6",
    label: "Sixth Circuit published opinions",
    group: "courts",
    circuit: 6,
    homeUrl: "https://www.opn.ca6.uscourts.gov/opinions/opinions.php",
    indexHosts: ["www.opn.ca6.uscourts.gov"],
    documentHosts: ["www.opn.ca6.uscourts.gov"],
  },
  {
    key: "ca7",
    label: "Seventh Circuit precedential opinions",
    group: "courts",
    circuit: 7,
    homeUrl: "https://media.ca7.uscourts.gov/cgi-bin/rssExec.pl?Time=month&Author=any&Case=any&Submit=Submit&OpsOnly=yes",
    indexHosts: ["media.ca7.uscourts.gov"],
    documentHosts: ["media.ca7.uscourts.gov"],
  },
  {
    key: "ca8",
    label: "Eighth Circuit published opinions",
    group: "courts",
    circuit: 8,
    homeUrl: "https://ecf.ca8.uscourts.gov/cgi-bin/opnByDate.pl",
    indexHosts: ["ecf.ca8.uscourts.gov"],
    documentHosts: ["ecf.ca8.uscourts.gov"],
  },
  {
    key: "ca9",
    label: "Ninth Circuit published opinions",
    group: "courts",
    circuit: 9,
    homeUrl: "https://www.ca9.uscourts.gov/opinions/index.xml",
    indexHosts: ["www.ca9.uscourts.gov"],
    documentHosts: ["cdn.ca9.uscourts.gov", "www.ca9.uscourts.gov"],
  },
  {
    key: "ca10",
    label: "Tenth Circuit published opinions",
    group: "courts",
    circuit: 10,
    homeUrl: "https://www.ca10.uscourts.gov/opinion/search/results?query=date%3Athisweek",
    indexHosts: ["www.ca10.uscourts.gov"],
    documentHosts: ["www.ca10.uscourts.gov"],
  },
  {
    key: "ca11",
    label: "Eleventh Circuit published opinions",
    group: "courts",
    circuit: 11,
    homeUrl: "https://media.ca11.uscourts.gov/opinions/rss/pubopnsfeed.php",
    indexHosts: ["media.ca11.uscourts.gov"],
    documentHosts: ["media.ca11.uscourts.gov"],
  },
];

const BY_KEY = new Map<string, SourceDefinition>(SOURCES.map((s) => [s.key, s]));

export function getSource(key: string): SourceDefinition | null {
  return BY_KEY.get(key) ?? null;
}

/**
 * The label shown for a legal_updates source key. A library-fed item's
 * label comes from its listing facts (the library source's name, recorded
 * when it was fed in).
 */
export function sourceLabel(key: string, listingFacts?: unknown): string {
  const known = BY_KEY.get(key)?.label;
  if (known) return known;
  if (key.startsWith("library:")) {
    const name = (listingFacts as { librarySource?: unknown } | null | undefined)?.librarySource;
    return typeof name === "string" && name ? `${name} (the app's library)` : "The app's library";
  }
  return key;
}

export const SOURCE_GROUP_LABELS: Record<SourceGroup, string> = {
  eoir: "EOIR",
  federal_register: "Federal Register",
  uscis: "USCIS",
  courts: "Courts of appeals",
  library: "Library collections",
};

export function sourceKeysInGroup(group: SourceGroup): LegalUpdateSourceKey[] {
  return SOURCES.filter((s) => s.group === group).map((s) => s.key);
}
