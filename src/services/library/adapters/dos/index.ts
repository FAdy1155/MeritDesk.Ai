// Department of State sources: the Foreign Affairs Manual's consular
// volumes, the Visa Bulletin (with the chart USCIS designates for filing
// each month), consular post and NVC instructions, reciprocity and civil
// documents, intercountry adoption, BridgeUSA (J-1) guidance and press
// releases on visas.
import type { LibrarySourceAdapter } from "../../types";
import { dosAdoptionAdapter } from "./adoption";
import { dosBridgeUsaAdapter } from "./bridgeusa";
import { dosConsularPostsAdapter } from "./consular-posts";
import { dosFamAdapter } from "./fam";
import { dosPressReleasesAdapter } from "./press-releases";
import { dosReciprocityAdapter } from "./reciprocity";
import { uscisFilingChartsAdapter } from "./uscis-filing-charts";
import { dosVisaBulletinAdapter } from "./visa-bulletin";

export const dosAdapters: readonly LibrarySourceAdapter[] = [
  dosFamAdapter,
  dosVisaBulletinAdapter,
  uscisFilingChartsAdapter,
  dosConsularPostsAdapter,
  dosReciprocityAdapter,
  dosAdoptionAdapter,
  dosBridgeUsaAdapter,
  dosPressReleasesAdapter,
];
