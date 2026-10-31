// USCIS policy: the Policy Manual and its updates (group uscis-policy-manual),
// and USCIS's memoranda, news and alerts, FOIA reading room, TRIG exemption
// authorities, web guidance and other policy documents (group
// uscis-policy-guidance).
import type { LibrarySourceAdapter } from "../../types";
import { uscisFoiaReadingRoomAdapter } from "./foia-reading-room";
import { uscisNewsroomAdapter } from "./newsroom";
import { uscisPolicyDocumentsAdapter } from "./policy-documents";
import { uscisPolicyManualAdapter } from "./policy-manual";
import { uscisPolicyManualUpdatesAdapter } from "./policy-manual-updates";
import { uscisPolicyMemorandaAdapter } from "./policy-memoranda";
import { uscisTrigExemptionsAdapter } from "./trig-exemptions";
import { uscisWebGuidanceAdapter } from "./web-guidance";

export const uscisPolicyAdapters: readonly LibrarySourceAdapter[] = [
  uscisPolicyManualAdapter,
  uscisPolicyManualUpdatesAdapter,
  uscisPolicyMemorandaAdapter,
  uscisNewsroomAdapter,
  uscisFoiaReadingRoomAdapter,
  uscisTrigExemptionsAdapter,
  uscisWebGuidanceAdapter,
  uscisPolicyDocumentsAdapter,
];
