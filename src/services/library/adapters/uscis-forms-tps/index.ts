// USCIS forms, fee schedule and poverty guidelines (group uscis-forms-fees), and Temporary Protected Status designations (group tps).
import type { LibrarySourceAdapter } from "../../types";
import { uscisFormUpdatesAdapter } from "./uscis-form-updates";
import { uscisFormsAdapter } from "./uscis-forms";
import { uscisG1055Adapter } from "./uscis-g1055";
import { uscisI864pAdapter } from "./uscis-i864p";
import { uscisTpsAdapter } from "./uscis-tps";

export const uscisFormsTpsAdapters: readonly LibrarySourceAdapter[] = [
  uscisFormsAdapter,
  uscisFormUpdatesAdapter,
  uscisG1055Adapter,
  uscisI864pAdapter,
  uscisTpsAdapter,
];
