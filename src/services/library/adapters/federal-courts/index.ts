// Federal courts: the courts of appeals (circuit-courts), the district
// courts (district-courts) and the Supreme Court (supreme-court), from
// GovInfo, the Supreme Court's site and CourtListener.
import type { LibrarySourceAdapter } from "../../types";
import { courtlistenerAppealsAdapter } from "./courtlistener-appeals";
import { courtlistenerDistrictAdapter } from "./courtlistener-district";
import { govinfoUsReportsAdapter } from "./govinfo-us-reports";
import { govinfoUscourtsAppealsAdapter } from "./govinfo-uscourts-appeals";
import { govinfoUscourtsDistrictAdapter } from "./govinfo-uscourts-district";
import { scotusOpinionsAdapter } from "./scotus-opinions";

export const federalCourtsAdapters: readonly LibrarySourceAdapter[] = [
  govinfoUscourtsAppealsAdapter,
  courtlistenerAppealsAdapter,
  govinfoUscourtsDistrictAdapter,
  courtlistenerDistrictAdapter,
  scotusOpinionsAdapter,
  govinfoUsReportsAdapter,
];
