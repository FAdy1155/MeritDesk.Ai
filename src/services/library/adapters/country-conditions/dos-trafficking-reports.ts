import type { LibrarySourceAdapter } from "../../types";
import { stateReportsAdapter } from "./state-reports";

// The State Department's Trafficking in Persons Report country narratives:
// www.state.gov for the 2017 report onward (one page per country), the
// 2009-2017.state.gov archive for 2001 to 2016. In the archive the 2013 to
// 2016 reports have per-country pages (2016's behind its "Country
// Narratives" page, which moves to them with a meta refresh); the earlier
// years publish the narratives as a few pages or PDFs each covering a range
// of countries ("Country Narratives: Countries A Through F"), a tier (2001)
// or a region (2004), collected one document each, with the countries whose
// narrative headings the text contains in metadata.countries. The tier a
// country's narrative states in its heading ("GUATEMALA (Tier 2)") is kept
// in metadata.tier. See ./state-reports.ts.

export const dosTraffickingReportsAdapter: LibrarySourceAdapter = stateReportsAdapter({
  code: "dos_trafficking_reports",
  name: "Trafficking in Persons Report country narratives (State Department)",
  description:
    "The country narratives of the State Department's annual Trafficking in Persons Report, with each country's tier, read from www.state.gov and, for earlier years, the Department's 2009-2017 archive site.",
  coverage:
    "Every country page of the reports www.state.gov lists in its report sitemaps (the 2017 report onward); in the archive, the 2013 to 2016 reports' country pages and, for 2001 to 2012, the grouped narrative pages or PDFs each year's report page links.",
  series: "trafficking",
  seriesName: "Trafficking in Persons Report",
  officialUrl: "https://www.state.gov/reports-office-to-monitor-and-combat-trafficking-in-persons/",
  wwwPath: /^\/reports\/(\d{4})-trafficking-in-persons-report(?:-\d+)?\/(.+)$/i,
  archiveIndexUrl: "https://2009-2017.state.gov/j/tip/rls/tiprpt/index.htm",
  archiveYearIndexPath: /^\/j\/tip\/rls\/tiprpt\/(\d{4})\/index\.htm$/,
  archiveCountryPath: (dir) => new RegExp(String.raw`^/j/tip/rls/tiprpt/countries/${dir}/\d+\.htm$`),
  narratives: {
    hubText: /^country narratives$/i,
    hubPath: (dir) => new RegExp(String.raw`^/j/tip/rls/tiprpt/(?:countries/)?${dir}/(?:\d+|index)\.htm$`),
    // "Country Narratives: Countries A Through F", "Countries H through P", and in 2001 "Country Narratives - Tier 1".
    groupedText: /country narratives?\b.*\b[A-Z]\s*(?:-|through|to)\s*[A-Z]\b|countries [A-Z] (?:through|to) [A-Z]\b|country narratives?\s*[-:]+\s*tier\b/i,
    hubGroupedText: /^(?:Africa|East Asia and (?:the )?Pacific|Europe and Eurasia|Near East|South Asia|Western Hemisphere|Special Cases?)$/i,
    groupedPath: (dir) => new RegExp(String.raw`^/(?:j/tip/rls/tiprpt/${dir}/\d+\.htm|documents/organization/\d+\.pdf)$`),
  },
});
