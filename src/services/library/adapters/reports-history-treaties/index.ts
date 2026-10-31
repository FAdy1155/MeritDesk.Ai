// Oversight and research reports (GAO, CRS, DHS OIG), INA legislative history, and treaties and international guidance.
import type { LibrarySourceAdapter } from "../../types";
import { congressTreatiesAdapter } from "./congress-treaties";
import { crsReportsAdapter } from "./crs-reports";
import { dhsOigReportsAdapter } from "./dhs-oig-reports";
import { gaoReportsAdapter } from "./gao-reports";
import { govinfoGaoReportsAdapter } from "./govinfo-gao-reports";
import { govinfoInaLegislativeHistoryAdapter } from "./govinfo-ina-legislative-history";
import { unTreatiesAdapter } from "./un-treaties";
import { unhcrHandbookAdapter } from "./unhcr-handbook";

export const reportsHistoryTreatiesAdapters: readonly LibrarySourceAdapter[] = [
  gaoReportsAdapter,
  govinfoGaoReportsAdapter,
  crsReportsAdapter,
  dhsOigReportsAdapter,
  govinfoInaLegislativeHistoryAdapter,
  unTreatiesAdapter,
  congressTreatiesAdapter,
  unhcrHandbookAdapter,
];
