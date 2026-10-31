// EOIR practice manuals, policy memoranda, forms and immigration court pages.
import type { LibrarySourceAdapter } from "../../types";
import { eoirFormsAdapter } from "./forms";
import { eoirImmigrationCourtsAdapter } from "./immigration-courts";
import {
  eoirBiaPracticeManualAdapter,
  eoirIcpmAdapter,
  eoirOcahoPracticeManualAdapter,
  eoirPolicyManualGeneralAdapter,
} from "./policy-manual";
import { eoirPolicyMemorandaAdapter } from "./policy-memoranda";

export const eoirGuidanceAdapters: readonly LibrarySourceAdapter[] = [
  eoirIcpmAdapter,
  eoirBiaPracticeManualAdapter,
  eoirPolicyManualGeneralAdapter,
  eoirOcahoPracticeManualAdapter,
  eoirPolicyMemorandaAdapter,
  eoirFormsAdapter,
  eoirImmigrationCourtsAdapter,
];
