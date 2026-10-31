import { bookManualAdapter } from "./book-manual";

// The E-Verify User Manual (M-775), as USCIS's E-Verify program publishes it
// on e-verify.gov: a landing page, a page per section and a printable export
// of the whole manual, read section by section (./book-manual.ts).
// e-verify.gov's robots.txt asks for 10 seconds between requests; a run
// reads two pages. US government work: public domain.

export const everifyUserManualAdapter = bookManualAdapter({
  code: "everify_user_manual",
  name: "E-Verify User Manual M-775",
  description: "The E-Verify User Manual (M-775): how employers create, resolve and close E-Verify cases and administer their accounts, section by section.",
  coverage: "The current online edition, every section of the printable manual e-verify.gov links from the manual's page, with its table of changes.",
  landingUrl: "https://www.e-verify.gov/e-verify-user-manual",
  hosts: ["www.e-verify.gov", "e-verify.gov"],
  agency: "U.S. Citizenship and Immigration Services, E-Verify",
  designation: "M-775",
  manualTitle: "E-Verify User Manual",
});
