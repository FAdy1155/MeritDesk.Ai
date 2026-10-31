// Country conditions: the State Department's human rights, religious
// freedom and trafficking reports, USCIRF, the UK Home Office's CPINs and
// EUAA's COI reports, by country.
import type { LibrarySourceAdapter } from "../../types";
import { dosHumanRightsReportsAdapter } from "./dos-human-rights-reports";
import { dosReligiousFreedomReportsAdapter } from "./dos-religious-freedom-reports";
import { dosTraffickingReportsAdapter } from "./dos-trafficking-reports";
import { euaaCoiAdapter } from "./euaa-coi";
import { ukHomeOfficeCpinAdapter } from "./uk-cpin";
import { uscirfReportsAdapter } from "./uscirf";

export const countryConditionsAdapters: readonly LibrarySourceAdapter[] = [
  dosHumanRightsReportsAdapter,
  dosReligiousFreedomReportsAdapter,
  dosTraffickingReportsAdapter,
  uscirfReportsAdapter,
  ukHomeOfficeCpinAdapter,
  euaaCoiAdapter,
];
