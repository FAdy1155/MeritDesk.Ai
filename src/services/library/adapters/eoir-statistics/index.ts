// EOIR court and judge statistics: EOIR's public case data release.
import type { LibrarySourceAdapter } from "../../types";
import { eoirCaseDataAdapter } from "./eoir-case-data";

export const eoirStatisticsAdapters: readonly LibrarySourceAdapter[] = [eoirCaseDataAdapter];
