// The library's groups: what /library lists, in the catalog's order and
// words. The firm chose which official sources the library covers from a
// public catalog of an immigration-law research service, transcribed once
// for that purpose; this file keeps that catalog's group names,
// descriptions, coverage and refresh wording, nothing else. Counts, update
// dates, statuses and official links on the page are the app's own, from
// library_sources (written by the collectors in ./adapters/). The app does
// not use that service or link to it.
//
// Pure data: no server-only, so the UI, the probe script and the adapters
// all read it.

export type LibrarySection =
  | "Decisions"
  | "Statutes and regulations"
  | "Agency guidance and reference"
  | "Visa Bulletin"
  | "EOIR court and judge statistics";

export const LIBRARY_SECTIONS: readonly { section: LibrarySection; intro: string }[] = [
  {
    section: "Decisions",
    intro:
      "Administrative and court decisions, each with its official link. Unpublished Board and AAO decisions are labeled non-precedential.",
  },
  { section: "Statutes and regulations", intro: "Resolved to the section, with the official text." },
  {
    section: "Agency guidance and reference",
    intro: "Manuals, memoranda, forms, reports, and treaties, kept in sections so a citation lands on the right one.",
  },
  { section: "Visa Bulletin", intro: "Priority dates for every category and chargeability, month by month." },
  {
    section: "EOIR court and judge statistics",
    intro: "Statistics from the Executive Office for Immigration Review's published administrative case data.",
  },
];

export const LIBRARY_GROUP_CODES = [
  "bia-ag-precedents",
  "bia-unpublished",
  "aao-decisions",
  "circuit-courts",
  "district-courts",
  "supreme-court",
  "ocaho-balca",
  "ij-decisions",
  "state-criminal-decisions",
  "ina-title-8",
  "regulations",
  "constitution",
  "criminal-codes",
  "uscis-policy-manual",
  "uscis-policy-guidance",
  "uscis-forms-fees",
  "tps",
  "foreign-affairs-manual",
  "eoir-manuals-memos-forms",
  "other-agency-guidance",
  "country-conditions",
  "oversight-reports",
  "ina-legislative-history",
  "treaties",
  "visa-bulletin",
  "eoir-statistics",
] as const;

export type LibraryGroupCode = (typeof LIBRARY_GROUP_CODES)[number];

export type LibraryGroup = {
  code: LibraryGroupCode;
  section: LibrarySection;
  /** The catalog's name for the group. */
  name: string;
  /** The catalog's description. */
  description: string;
  /** The catalog's coverage line (null where the catalog states none). */
  coverage: string | null;
  /** The catalog's refresh wording (null where the catalog states none). */
  cadence: string | null;
  /** The whole group is out of the library's scope for now: shown as planned, never collected. */
  planned?: string;
  /** A part of the group is out of scope for now (shown under the group). */
  partlyPlanned?: string;
  /** What the group holds in this app when that differs from the catalog's wording. */
  scopeNote?: string;
};

export const LIBRARY_GROUPS: readonly LibraryGroup[] = [
  // Decisions
  {
    code: "bia-ag-precedents",
    section: "Decisions",
    name: "Board of Immigration Appeals and Attorney General precedents",
    description:
      "Published decisions in Immigration and Nationality Decisions, volumes 1 through 30, including the Attorney General's decisions.",
    coverage: "Volumes 1 to 30, 1940 to the current volume",
    cadence: "Daily",
    scopeNote: "EOIR's AG and BIA decisions page links volumes 8 to 30, which are collected; volumes 1 to 7 are not linked there and are not collected yet.",
  },
  {
    code: "bia-unpublished",
    section: "Decisions",
    name: "Unpublished BIA decisions",
    description:
      "Non-precedent decisions released through EOIR's FOIA reading room. Every answer labels them non-precedential and links the decision PDF.",
    coverage: "2017 to the present, as EOIR has released them",
    cadence: "As EOIR releases them",
  },
  {
    code: "aao-decisions",
    section: "Decisions",
    name: "Administrative Appeals Office decisions",
    description: "Non-precedent decisions on appeals from USCIS petitions and applications, by form type.",
    coverage: "2005 to the present",
    cadence: "Daily",
    scopeNote: "AAO precedent and adopted decisions and the AAO Practice Manual are collected in this group too.",
  },
  {
    code: "circuit-courts",
    section: "Decisions",
    name: "Federal circuit court opinions",
    description: "Immigration opinions of the courts of appeals, published and unpublished.",
    coverage: "1920s to the present",
    cadence: "Daily",
    scopeNote:
      "From GovInfo's court opinions (each circuit from about 2004 to 2011 on). Earlier opinions, and the First, Second and Ninth Circuits' unpublished ones, come from CourtListener, which needs an API token and is off until the firm sets one.",
  },
  {
    code: "district-courts",
    section: "Decisions",
    name: "Federal district court decisions",
    description:
      "Immigration litigation in the district courts: habeas, mandamus, naturalization delay, and Administrative Procedure Act cases.",
    coverage: "Historical and current decisions",
    cadence: "Weekly",
    scopeNote:
      "From GovInfo's API (needs an api.data.gov key): cases with nature of suit 462, 463 or 465. Decisions before 2004 come from CourtListener (needs an API token). APA and mandamus suits coded otherwise are not found.",
  },
  {
    code: "supreme-court",
    section: "Decisions",
    name: "U.S. Supreme Court opinions",
    description:
      "Immigration and related decisions, with the syllabus, majority, concurrences, and dissents separated where the source supports it.",
    coverage: "1830s to the present",
    cadence: "As decided",
    scopeNote:
      "Every opinion of the Court since October Term 2018 from supremecourt.gov, and the immigration cases of the bound United States Reports from GovInfo.",
  },
  {
    code: "ocaho-balca",
    section: "Decisions",
    name: "OCAHO and BALCA decisions",
    description:
      "Employer-sanctions and document-fraud cases from the Office of the Chief Administrative Hearing Officer, and labor-certification appeals from the Board of Alien Labor Certification Appeals.",
    coverage: "BALCA from 1987, and OCAHO's published decisions",
    cadence: "Daily",
    scopeNote:
      "BALCA: the en banc decisions (1987 to the present) and the prevailing wage appeals that the OALJ caselists on dol.gov list, with their caselist facts, summaries and official links. The decision files are on www.oalj.dol.gov, whose robots.txt disallows automated access, so their text and BALCA's panel decisions are not collected.",
  },
  {
    code: "ij-decisions",
    section: "Decisions",
    name: "Immigration judge decisions",
    description: "Individual decisions reviewed one at a time for public release, with the basis for release recorded.",
    coverage: "Reviewed set",
    cadence: "As reviewed",
    scopeNote:
      "EOIR publishes no immigration judge decisions as such; this group holds the immigration judge decisions EOIR has released in its FOIA Library, with the basis for release as the library states it.",
  },
  {
    code: "state-criminal-decisions",
    section: "Decisions",
    name: "State court decisions on criminal statutes",
    description:
      "Opinions from the state courts in our collection that interpret criminal provisions relevant to immigration research.",
    coverage: "Selected state courts",
    cadence: "In batches, by state",
    planned: "Planned, not yet collected.",
  },
  // Statutes and regulations
  {
    code: "ina-title-8",
    section: "Statutes and regulations",
    name: "Immigration and Nationality Act and Title 8",
    description: "INA sections with their U.S. Code parallels and the statutory notes.",
    coverage: "Title 8 and statutory notes",
    cadence: "Checked daily",
  },
  {
    code: "regulations",
    section: "Statutes and regulations",
    name: "Immigration regulations",
    description: "The immigration parts of C.F.R. titles 6, 8, 19, 20, 21, 22, 28, 29, 42, and 45.",
    coverage: "Immigration-related titles and parts",
    cadence: "Daily",
    scopeNote: "Federal Register rules and notices on immigration are collected in this group too.",
  },
  {
    code: "constitution",
    section: "Statutes and regulations",
    name: "Constitution",
    description: "The provisions immigration cases turn on.",
    coverage: "Full text",
    cadence: "Static",
  },
  {
    code: "criminal-codes",
    section: "Statutes and regulations",
    name: "State and federal criminal codes",
    description:
      "The penal codes of 48 states with full text, four more as directories where the publisher restricts the text, and Title 18 with the Title 21 drug schedules.",
    coverage: "State penal codes and federal criminal provisions",
    cadence: "In batches",
    partlyPlanned: "State penal codes: planned, not yet collected. Federal criminal provisions (Title 18 and the Title 21 drug schedules) are collected.",
  },
  // Agency guidance and reference
  {
    code: "uscis-policy-manual",
    section: "Agency guidance and reference",
    name: "USCIS Policy Manual",
    description: "Every volume, part, and chapter, with memoranda tracked for whether they are still current against it.",
    coverage: "Volumes, parts, and chapters",
    cadence: "Daily",
  },
  {
    code: "uscis-policy-guidance",
    section: "Agency guidance and reference",
    name: "USCIS policy memoranda, alerts, and web guidance",
    description:
      "Policy memoranda, news and alerts, and standing web guidance, each reviewed for whether it remains in force.",
    coverage: "Memoranda, alerts, and web guidance",
    cadence: "Daily",
  },
  {
    code: "uscis-forms-fees",
    section: "Agency guidance and reference",
    name: "USCIS forms, fee schedule, and poverty guidelines",
    description: "Current form editions and instructions, the G-1055 fee schedule, and the I-864P guidelines.",
    coverage: "Forms, instructions, fees, and guidelines",
    cadence: "Daily",
  },
  {
    code: "tps",
    section: "Agency guidance and reference",
    name: "Temporary Protected Status designations",
    description: "The designation posture for every country, checked against the USCIS page.",
    coverage: "Country designations",
    cadence: "Daily",
  },
  {
    code: "foreign-affairs-manual",
    section: "Agency guidance and reference",
    name: "Foreign Affairs Manual",
    description: "The consular volumes and their appendices.",
    coverage: "Consular volumes and appendices",
    cadence: "Daily",
  },
  {
    code: "eoir-manuals-memos-forms",
    section: "Agency guidance and reference",
    name: "EOIR practice manuals, policy memoranda, and forms",
    description:
      "The BIA Practice Manual, the Immigration Court Practice Manual, EOIR policy memoranda, and EOIR forms.",
    coverage: "Practice manuals, memoranda, and forms",
    cadence: "Daily",
  },
  {
    code: "other-agency-guidance",
    section: "Agency guidance and reference",
    name: "Other agency manuals and guidance",
    description:
      "ICE guidance and detention standards, SEVP guidance, CBP guidance, Labor Department foreign labor certification, ORR policy guides, the Justice Manual's immigration litigation chapter, the E-Verify and Form I-9 handbooks, the naturalization guide, asylum officer training materials, and the retired Adjudicator's Field Manual.",
    coverage: "As published",
    cadence: "Daily",
    scopeNote:
      "Also the State Department's consular, reciprocity, adoption and exchange visitor guidance, SSA, USDA, CMS, CDC and OMB material on noncitizens, and the BLS and O*NET occupation descriptions (O*NET as excerpts and links). The Guide to Naturalization (M-476) is no longer published on uscis.gov and is not collected; HUD guidance is not collected (hud.gov refuses automated clients).",
  },
  {
    code: "country-conditions",
    section: "Agency guidance and reference",
    name: "Country conditions",
    description:
      "State Department Country Reports on Human Rights Practices, International Religious Freedom Reports, and Trafficking in Persons Reports, by country and year.",
    coverage: "By country, report series, and year",
    cadence: "Each annual release",
    scopeNote:
      "Also USCIRF's annual reports and country publications, the UK Home Office's Country Policy and Information Notes and EUAA's Country of Origin Information reports (the last two kept as metadata, a short excerpt and the official link).",
    partlyPlanned:
      "Not collected: the Canadian IRB's Responses to Information Requests (the IRB's listing works only through form submissions, and its terms bar commercial reproduction).",
  },
  {
    code: "oversight-reports",
    section: "Agency guidance and reference",
    name: "Oversight and research reports",
    description: "GAO reports, Congressional Research Service reports, and DHS Inspector General reports on immigration.",
    coverage: "Published immigration reports",
    cadence: "As published",
    scopeNote:
      "GAO reports from 1989 to 2008 come from GovInfo and later ones from GAO's reports feed as they are published; CRS reports are kept as CRS's summary and the official link (congress.gov refuses automated clients).",
  },
  {
    code: "ina-legislative-history",
    section: "Agency guidance and reference",
    name: "INA legislative history",
    description: "Committee reports and statutory history for the Act.",
    coverage: "Through 2007",
    cadence: "Static",
  },
  {
    code: "treaties",
    section: "Agency guidance and reference",
    name: "Treaties and international guidance",
    description:
      "The 1951 Refugee Convention and 1967 Protocol, the Convention Against Torture, and the UNHCR Handbook and Guidelines.",
    coverage: "Full text",
    cadence: "Static",
    scopeNote:
      "The Convention, the Protocol and the Convention Against Torture are kept as their UN depositary records with a short excerpt and the official link (the UN's terms bar reproduction); the UNHCR Handbook as its record and link (UNHCR's terms bar reuse). The UNHCR Guidelines on International Protection are not collected.",
  },
  // Visa Bulletin
  {
    code: "visa-bulletin",
    section: "Visa Bulletin",
    name: "Visa Bulletin",
    description:
      "Every monthly bulletin with its priority-date tables, and the chart USCIS designated for filing each month since October 2015.",
    coverage: "Monthly priority-date tables since December 2001",
    cadence: "Monthly, when the Department of State posts it",
  },
  // EOIR court and judge statistics (the catalog prints no table for it)
  {
    code: "eoir-statistics",
    section: "EOIR court and judge statistics",
    name: "EOIR court and judge statistics",
    description:
      "Judge and court profiles: historical caseloads, asylum and other protection outcomes, and processing times. Relief statistics: grants and denials of cancellation of removal, adjustment of status, voluntary departure, waivers, and other relief. BIA appeal statistics: appeals linked to completed immigration court proceedings, including remands, dismissals, denials, and pending appeals.",
    coverage: null,
    cadence: null,
    scopeNote: "Rates describe historical outcomes in EOIR's records; they do not predict an individual case.",
  },
];

const BY_CODE = new Map<string, LibraryGroup>(LIBRARY_GROUPS.map((g) => [g.code, g]));

export function getLibraryGroup(code: string): LibraryGroup | null {
  return BY_CODE.get(code) ?? null;
}

export function isLibraryGroupCode(code: string): code is LibraryGroupCode {
  return BY_CODE.has(code);
}

/**
 * The order backfill walks history in: immigration core first (BIA and AG
 * precedents, statutes and regulations, the USCIS Policy Manual, the EOIR
 * manuals, the FAM, the Visa Bulletin, the circuits and the Supreme Court,
 * AAO, unpublished BIA), then the rest in catalog order. A source's
 * adapter can still set its own backfillPriority.
 */
export const BACKFILL_GROUP_ORDER: readonly LibraryGroupCode[] = [
  "bia-ag-precedents",
  "ina-title-8",
  "regulations",
  "uscis-policy-manual",
  "eoir-manuals-memos-forms",
  "foreign-affairs-manual",
  "visa-bulletin",
  "circuit-courts",
  "supreme-court",
  "aao-decisions",
  "bia-unpublished",
  ...LIBRARY_GROUP_CODES.filter(
    (code) =>
      ![
        "bia-ag-precedents",
        "ina-title-8",
        "regulations",
        "uscis-policy-manual",
        "eoir-manuals-memos-forms",
        "foreign-affairs-manual",
        "visa-bulletin",
        "circuit-courts",
        "supreme-court",
        "aao-decisions",
        "bia-unpublished",
      ].includes(code)
  ),
];

/** A group's place in BACKFILL_GROUP_ORDER (0 first). */
export function backfillRank(group: LibraryGroupCode): number {
  const at = BACKFILL_GROUP_ORDER.indexOf(group);
  return at < 0 ? BACKFILL_GROUP_ORDER.length : at;
}
