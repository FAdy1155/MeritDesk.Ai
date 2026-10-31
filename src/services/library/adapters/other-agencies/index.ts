// Other federal agencies' immigration guidance (DOL, ORR, DOJ, CDC, SSA,
// USDA, CMS, OMB, BLS, O*NET), and the Federal Register and Regulations.gov
// immigration documents (in the group "Immigration regulations").
import type { LibrarySourceAdapter } from "../../types";
import { cdcTechnicalInstructionsAdapter } from "./cdc";
import { cmsMedicaidImmigrantAdapter } from "./cms-medicaid";
import { dojIerLettersAdapter, dojJusticeManualAdapter } from "./doj";
import { dolOflcAnnouncementsAdapter, dolOflcFaqsAdapter } from "./dol-oflc";
import { dolWhdImmigrationAdapter } from "./dol-whd";
import { federalRegisterAdapter } from "./federal-register";
import { blsOohAdapter, onetOccupationsAdapter } from "./occupations";
import { ombPraSupportingStatementsAdapter } from "./omb-pra";
import { orrRefugeeLettersAdapter, orrUacPolicyGuideAdapter, orrUrmPolicyGuideAdapter } from "./orr";
import { regulationsGovAdapter } from "./regulations-gov";
import { ssaPomsAlienAdapter } from "./ssa-poms";
import { usdaFnsNoncitizenAdapter } from "./usda-fns";

export const otherAgenciesAdapters: readonly LibrarySourceAdapter[] = [
  federalRegisterAdapter,
  regulationsGovAdapter,
  dolOflcAnnouncementsAdapter,
  dolOflcFaqsAdapter,
  dolWhdImmigrationAdapter,
  orrUacPolicyGuideAdapter,
  orrUrmPolicyGuideAdapter,
  orrRefugeeLettersAdapter,
  dojJusticeManualAdapter,
  dojIerLettersAdapter,
  cdcTechnicalInstructionsAdapter,
  ssaPomsAlienAdapter,
  usdaFnsNoncitizenAdapter,
  cmsMedicaidImmigrantAdapter,
  ombPraSupportingStatementsAdapter,
  blsOohAdapter,
  onetOccupationsAdapter,
];
