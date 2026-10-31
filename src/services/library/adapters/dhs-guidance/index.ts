// DHS components' manuals and guidance (in the group "Other agency manuals and guidance").
import type { LibrarySourceAdapter } from "../../types";
import { cbpDirectivesAdapter } from "./cbp-directives";
import { cisOmbudsmanAdapter } from "./cis-ombudsman";
import { dhsHqGuidanceAdapter } from "./dhs-hq-guidance";
import { dhsManagementDirectivesAdapter } from "./dhs-management-directives";
import { everifyUserManualAdapter } from "./everify-user-manual";
import { iceDetentionStandardsAdapter } from "./ice-detention-standards";
import { icePolicyGuidanceAdapter } from "./ice-policy-guidance";
import { iceSevpGuidanceAdapter } from "./ice-sevp-guidance";
import { uscisAfmAdapter } from "./uscis-afm";
import { uscisAsylumTrainingAdapter } from "./uscis-asylum-training";
import { uscisM274Adapter } from "./uscis-m274";

export const dhsGuidanceAdapters: readonly LibrarySourceAdapter[] = [
  iceDetentionStandardsAdapter,
  icePolicyGuidanceAdapter,
  iceSevpGuidanceAdapter,
  cbpDirectivesAdapter,
  dhsHqGuidanceAdapter,
  dhsManagementDirectivesAdapter,
  cisOmbudsmanAdapter,
  uscisAsylumTrainingAdapter,
  uscisAfmAdapter,
  uscisM274Adapter,
  everifyUserManualAdapter,
];
