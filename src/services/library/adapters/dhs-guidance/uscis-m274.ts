import { bookManualAdapter } from "./book-manual";

// USCIS's Handbook for Employers (M-274), guidance for completing Form I-9,
// as USCIS publishes it on I-9 Central: a landing page, a page per section
// and a printable export of the whole handbook, read section by section
// (./book-manual.ts). uscis.gov's robots.txt asks for 10 seconds between
// requests; a run reads two pages. US government work: public domain.

export const uscisM274Adapter = bookManualAdapter({
  code: "uscis_m274_handbook",
  name: "Handbook for Employers M-274 (USCIS)",
  description: "USCIS's Handbook for Employers (M-274): guidance for completing Form I-9, Employment Eligibility Verification, section by section.",
  coverage: "The current online edition, every section of the printable handbook USCIS links from the M-274 page; USCIS does not keep earlier editions online.",
  landingUrl: "https://www.uscis.gov/i-9-central/form-i-9-resources/handbook-for-employers-m-274",
  hosts: ["www.uscis.gov", "uscis.gov"],
  agency: "U.S. Citizenship and Immigration Services",
  designation: "M-274",
  manualTitle: "Handbook for Employers M-274",
});
