import type { LibrarySourceAdapter } from "../../types";
import { stateReportsAdapter } from "./state-reports";

// The State Department's International Religious Freedom Reports, one
// document per country and report year: www.state.gov for 2016 onward, the
// 2009-2017.state.gov archive for 2001 to 2015 (including the July-December
// 2010 report, folder "2010_5"). The 1999 and 2000 reports are on another
// archive site (1997-2001.state.gov) and are not collected. See
// ./state-reports.ts for how both sites are read.

export const dosReligiousFreedomReportsAdapter: LibrarySourceAdapter = stateReportsAdapter({
  code: "dos_religious_freedom_reports",
  name: "International Religious Freedom Reports (State Department)",
  description:
    "The State Department's annual Report on International Religious Freedom, one document per country and year, read from each country's report page on www.state.gov and, for earlier years, the Department's 2009-2017 archive site.",
  coverage:
    "Every country page of the reports www.state.gov lists in its report sitemaps (the 2016 report onward), and the archived reports for 2001 to 2015 that the series page links on 2009-2017.state.gov. The 1999 and 2000 reports, on the 1997-2001 archive site, are not collected.",
  series: "religious_freedom",
  seriesName: "Report on International Religious Freedom",
  officialUrl: "https://www.state.gov/international-religious-freedom-reports/",
  wwwPath: /^\/reports\/(\d{4})-report-on-international-religious-freedom\/(.+)$/i,
  archiveIndexUrl: "https://www.state.gov/international-religious-freedom-reports/",
  archiveYearIndexPath: /^\/j\/drl\/rls\/irf\/([^/]+)\/index\.htm$/,
  archiveCountryPath: (dir) => new RegExp(String.raw`^/j/drl/rls/irf/${dir}/(?:(af|eap|eur|nea|sca|sa|wha)/)?\d+\.htm$`),
  archiveHubPath: (dir) => new RegExp(String.raw`^/j/drl/rls/irf/${dir}/c\d+\.htm$`),
});
