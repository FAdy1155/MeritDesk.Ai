// Administrative Appeals Office decisions: non-precedent, adopted and precedent decisions, and the AAO Practice Manual.
import type { LibrarySourceAdapter } from "../../types";
import { eoirAaoPrecedentsAdapter } from "./eoir-aao-precedents";
import { uscisAaoAdoptedAdapter } from "./uscis-aao-adopted";
import { uscisAaoNonPrecedentAdapter } from "./uscis-aao-non-precedent";
import { uscisAaoPracticeManualAdapter } from "./uscis-aao-practice-manual";

export const aaoDecisionsAdapters: readonly LibrarySourceAdapter[] = [
  uscisAaoNonPrecedentAdapter,
  eoirAaoPrecedentsAdapter,
  uscisAaoAdoptedAdapter,
  uscisAaoPracticeManualAdapter,
];
