// Statutes and regulations: Title 8 and the INA, the immigration regulations,
// the Constitution, and the federal criminal provisions (Title 18, the
// Controlled Substances Act and the drug schedules).
import type { LibrarySourceAdapter } from "../../types";
import { govinfoConstitutionAdapter } from "./constitution";
import { ecfr21Cfr1308Adapter, ecfrImmigrationRegulationsAdapter } from "./ecfr";
import { olrcUscTitle18Adapter, olrcUscTitle21ControlledSubstancesAdapter, olrcUscTitle8Adapter } from "./uscode";

export const statutesRegsAdapters: readonly LibrarySourceAdapter[] = [
  olrcUscTitle8Adapter,
  ecfrImmigrationRegulationsAdapter,
  govinfoConstitutionAdapter,
  olrcUscTitle18Adapter,
  olrcUscTitle21ControlledSubstancesAdapter,
  ecfr21Cfr1308Adapter,
];
