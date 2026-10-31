import type { LibrarySourceAdapter } from "../../types";
import { stateReportsAdapter } from "./state-reports";

// The State Department's Country Reports on Human Rights Practices, one
// document per country (or area) and report year: www.state.gov for 2016
// onward, the 2009-2017.state.gov archive for 1999 to 2015 (where the 1999
// and 2000 reports list their countries on region pages). See
// ./state-reports.ts for how both sites are read.

export const dosHumanRightsReportsAdapter: LibrarySourceAdapter = stateReportsAdapter({
  code: "dos_human_rights_reports",
  name: "Country Reports on Human Rights Practices (State Department)",
  description:
    "The State Department's annual Country Reports on Human Rights Practices, one document per country or area and year, read from each country's report page on www.state.gov and, for earlier years, the Department's 2009-2017 archive site.",
  coverage:
    "Every country page of the reports www.state.gov lists in its report sitemaps (the 2016 report onward), and the archived reports for 1999 to 2015 that the series page links on 2009-2017.state.gov. Reports before 1999 are not on either site.",
  series: "human_rights",
  seriesName: "Country Reports on Human Rights Practices",
  officialUrl: "https://www.state.gov/reports-bureau-of-democracy-human-rights-and-labor/country-reports-on-human-rights-practices/",
  wwwPath: /^\/reports\/(\d{4})-country-reports-on-human-rights-practices\/(.+)$/i,
  archiveIndexUrl: "https://www.state.gov/reports-bureau-of-democracy-human-rights-and-labor/country-reports-on-human-rights-practices/",
  archiveYearIndexPath: /^\/j\/drl\/rls\/hrrpt\/([^/]+)\/index\.htm$/,
  archiveCountryPath: (dir) => new RegExp(String.raw`^/j/drl/rls/hrrpt/${dir}/(?:(af|eap|eur|nea|sca|sa|wha)/)?\d+\.htm$`),
  // Region pages: "c<number>.htm" (1999, 2001 to 2004), or a region folder's index (2000, where South Asia is "sa").
  archiveHubPath: (dir) => new RegExp(String.raw`^/j/drl/rls/hrrpt/${dir}/(?:c\d+\.htm|(?:af|eap|eur|nea|sca|sa|wha)/index\.htm)$`),
});
