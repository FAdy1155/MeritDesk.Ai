import { BIA_DECISION_GROUPS, PROTECTION_APPLICATIONS } from "./aggregate";

// What every EOIR statistics result states: the definitions the counts
// follow, the caution that rates are historical, and the threshold below
// which a count is flagged as small. Pure data, shared by the loader (stored
// with each snapshot), the queries, the skill tools and the page.

export const EOIR_STATS_SOURCE_CODE = "eoir_case_data";

export const NOT_A_PREDICTION =
  "These rates describe historical outcomes in EOIR's records. They do not predict the outcome of any individual case, which turns on its own facts, law and evidence.";

/** A denominator below this is flagged as too small to read much into. */
export const SMALL_N = 10;

export const DEFINITIONS = {
  source:
    "Computed by this app from EOIR's public case data release (the \"EOIR Case Data\" file in EOIR's FOIA library), as aggregate counts. EOIR does not publish these figures itself; the app's grouping and rates are its own.",
  fiscalYear: "Fiscal year of the completion date (FY 2025 is October 1, 2024 to September 30, 2025).",
  completion:
    "A completion is a proceeding (B_TblProceeding) with a completion date (COMP_DATE). Each proceeding counts once; a case can have several proceedings (after a change of venue, a transfer or a reopening), and riders (family members' cases) are counted as their own proceedings.",
  outcome:
    "Outcome: the immigration judge's decision code (DEC_CODE) when the proceeding has one, otherwise the other-completion code (OTHER_COMP: change of venue, transfer, administrative closure and similar), with EOIR's description from the release's lookup table for the case type.",
  judge: "The judge is the proceeding's IJ_CODE (the judge assigned when it completed); the court is its BASE_CITY_CODE.",
  represented:
    "Represented: EOIR's tbl_RepsAssigned lists at least one attorney or representative for the respondent at the immigration court level (STRATTYLEVEL COURT, STRATTYTYPE ALIEN) on the case, at any time; the timing relative to the completion is not checked.",
  custody: "Custody: the proceeding's CUSTODY code (D detained, R released, N never detained); EOIR notes custody data comes from DHS.",
  nationality: "Nationality: the proceeding's NAT code, with EOIR's name for it.",
  processingTime:
    "Processing time: days from INPUT_DATE (the date the proceeding was received by the court) to COMP_DATE. Percentiles come from 30-day bins (accurate to within 30 days); the mean is exact.",
  applications:
    "Applications: each application for relief (tbl_Court_Appln) on a completed proceeding, counted in that proceeding's completion year, with the judge's decision on it (APPL_DEC).",
  applicationRates: `Granted: decision codes whose EOIR description contains GRANT; denied: DENY. Grant rate of decided = granted / (granted + denied). Grant share of all = granted / all applications on completed proceedings, including abandoned, withdrawn, not adjudicated and other. Nationality is available for ${PROTECTION_APPLICATIONS.join(", ")} (asylum, withholding, CAT).`,
  appeals:
    "Appeals: appeals and motions to the Board from an immigration judge (tblAppeal category IJ) linked to a completed proceeding, counted in that proceeding's completion year, by appeal type, who filed it and the Board's decision; pending means no Board decision date yet.",
  biaGrouping: `Board decision grouping (the app's, from EOIR's codes): ${Object.entries(BIA_DECISION_GROUPS)
    .map(([g, codes]) => `${g.replace(/_/g, " ")}: ${codes.join(", ")}`)
    .join("; ")}; every other code is "other".`,
  privacy: "Only aggregate counts are kept: no case number, name, address, A-number or other record of a person is stored.",
  smallNumbers: `Counts below ${SMALL_N} are flagged: a rate on so few cases says little.`,
} as const;
