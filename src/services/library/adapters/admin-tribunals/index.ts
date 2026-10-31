// OCAHO and BALCA decisions, and the immigration judge decisions EOIR has
// released (groups ocaho-balca and ij-decisions). The OCAHO Practice Manual
// is collected with the other EOIR Policy Manual parts in ../eoir-guidance/.
import type { LibrarySourceAdapter } from "../../types";
import { balcaDecisionsAdapter } from "./balca-decisions";
import { balcaEnBancSummariesAdapter } from "./balca-en-banc-summaries";
import { ijDecisionsAdapter } from "./ij-decisions";
import { ocahoDecisionsAdapter } from "./ocaho-decisions";

export const adminTribunalsAdapters: readonly LibrarySourceAdapter[] = [
  ocahoDecisionsAdapter,
  balcaDecisionsAdapter,
  balcaEnBancSummariesAdapter,
  ijDecisionsAdapter,
];
