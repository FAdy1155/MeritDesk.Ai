// The only shared list of library collectors (docs/LIBRARY.md, "Registry").
// Each group's folder exports its adapters from its index.ts; add one import
// line and one spread line per group, both in alphabetical order by folder
// name, and touch nothing else here.
import type { LibrarySourceAdapter } from "../types";
import { aaoDecisionsAdapters } from "./aao";
import { adminTribunalsAdapters } from "./admin-tribunals";
import { biaAgPrecedentsAdapters } from "./bia-ag-precedents";
import { biaUnpublishedAdapters } from "./bia-unpublished";
import { countryConditionsAdapters } from "./country-conditions";
import { dhsGuidanceAdapters } from "./dhs-guidance";
import { dosAdapters } from "./dos";
import { eoirGuidanceAdapters } from "./eoir-guidance";
import { eoirStatisticsAdapters } from "./eoir-statistics";
import { federalCourtsAdapters } from "./federal-courts";
import { otherAgenciesAdapters } from "./other-agencies";
import { reportsHistoryTreatiesAdapters } from "./reports-history-treaties";
import { statutesRegsAdapters } from "./statutes-regs";
import { uscisFormsTpsAdapters } from "./uscis-forms-tps";
import { uscisPolicyAdapters } from "./uscis-policy";

export const LIBRARY_ADAPTERS: readonly LibrarySourceAdapter[] = [
  ...aaoDecisionsAdapters,
  ...adminTribunalsAdapters,
  ...biaAgPrecedentsAdapters,
  ...biaUnpublishedAdapters,
  ...countryConditionsAdapters,
  ...dhsGuidanceAdapters,
  ...dosAdapters,
  ...eoirGuidanceAdapters,
  ...eoirStatisticsAdapters,
  ...federalCourtsAdapters,
  ...otherAgenciesAdapters,
  ...reportsHistoryTreatiesAdapters,
  ...statutesRegsAdapters,
  ...uscisFormsTpsAdapters,
  ...uscisPolicyAdapters,
];
