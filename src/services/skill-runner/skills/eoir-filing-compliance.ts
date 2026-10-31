import { z } from "zod";
import { defineSkill } from "./types";

// Mirrors skills-content/eoir-filing-compliance/SKILL.md "Step 5: Report",
// the report template: its header (the filing title, then the bold Venue,
// Filing type, Manual, Checked and Live-manual verification items), then its
// sections in template order: Verdict, Failures, Fixes, Could not verify,
// Deadline check, Passed checks. Step 4's PASS / FAIL / FIX / CANNOT VERIFY
// statuses land in Passed checks, Failures, Fixes and Could not verify; N/A
// items have no section in the template, so none here. Step 3's volatile
// items (fees, appeal and briefing deadlines, call-up deadlines) are what
// "Live-manual verification" reports on, each with the URL checked or, when
// the live source could not be reached, the URL the attorney should confirm.
// The skill drafts nothing ("Deliver the report in chat"), so there is no
// generated document.

// Every cite the report carries (rule 2.1.6): manual sections such as
// ICPM 2.2(e)(1) or BIA PM 3.4(d), 8 CFR sections, and the occasional INA
// section or BIA precedent the checklists name. No min(1) anywhere: an
// item with no cite is visible as such rather than pushed into an invented one.
const citationSchema = z.object({
  citation: z
    .string()
    .describe("Exactly as in the bundled checklist or the live manual or regulation; never invented or renumbered from memory"),
  verified: z
    .boolean()
    .describe("true only if quoted from the bundled checklist or confirmed on the live source in this run"),
  url: z.string().optional().describe("The page it was confirmed on in this run, exactly as retrieved"),
});

// "For each: what is wrong, where in the packet, the cite, and the exact fix."
// Shared by Failures and Fixes ("Numbered, same format").
const defectSchema = z.object({
  whatIsWrong: z.string(),
  whereInThePacket: z.string().describe("The document by file name, and the page, section or form part"),
  cites: z
    .array(citationSchema)
    .describe("The manual section cite and, where one exists, the regulation (8 CFR) cite"),
  exactFix: z.string(),
});

export const eoirFilingComplianceOutputSchema = z.object({
  filingTitle: z.string().describe("The filing's title as it appears on its cover page, or as the attorney named it"),
  venue: z.string().describe("The Immigration Court by name, or BIA"),
  filingType: z.string().describe("Motion (which kind), application package, evidence packet, pre-hearing brief, appeal brief, Notice of Appeal, witness list, etc."),
  manual: z.enum(["ICPM_Part_II", "BIA_PM_Part_III"]),
  // The matter context states the run's date in UTC (prompt.ts
  // buildUserContext): a Houston evening run reads as the next day, the safe
  // side for a deadline margin. The attorney's note can state the local date.
  checked: z
    .string()
    .describe(
      'Date of this check, YYYY-MM-DD: today\'s date as the attorney\'s note gives it, or else the "Date of this run" in the matter context (a UTC date, so it can be one day after the firm\'s local date); "date not stated" only if neither gives one, never an assumed date'
    ),
  liveManualVerification: z.object({
    status: z
      .enum(["done", "not_available"])
      .describe("not_available when any volatile item could not be checked against the live source; those items are flagged below"),
    volatileItems: z
      .array(
        z.object({
          item: z.string().describe("The fee, appeal or briefing deadline, or call-up deadline the report relies on"),
          url: z
            .string()
            .describe("The live page or eCFR section it was checked on, exactly as the fetch result gives it; or, if not verified, the URL the attorney should confirm it at"),
          verified: z
            .boolean()
            .describe(
              "true only if the live manual or regulation text read in this run states it; a fetch that failed, or returned an access, error or search page or a page cut off before the item, does not count"
            ),
          result: z
            .string()
            .describe("What the live source says, any conflict with the bundled checklist, or why it could not be verified"),
        })
      )
      .describe("Step 3's volatile items this filing turns on; empty when none applies"),
  }),
  verdict: z.object({
    label: z.enum(["READY_TO_FILE", "FILE_AFTER_FIXES", "DO_NOT_FILE_YET"]),
    why: z.string().describe("One sentence"),
  }),
  failures: z
    .array(defectSchema)
    .describe(
      "Defects that will cause rejection, exclusion, or denial, ordered by severity: jurisdictional and deadline problems first, then rejection-triggering defects (service, fee, signature, translation), then format. Empty when none found."
    ),
  fixes: z
    .array(defectSchema)
    .describe("Curable defects and risks, in the same format and order. Empty when none found."),
  couldNotVerify: z
    .array(
      z.object({
        whatCouldNotBeChecked: z.string(),
        whatTheAttorneyShouldConfirm: z.string(),
      })
    )
    .optional()
    .describe("What the documents provided do not let you check; omit when there is nothing"),
  deadlineCheck: z.object({
    deadlines: z.array(
      z.object({
        governingDeadline: z.string().describe("The deadline and the rule that sets it, including any scheduling or standing order"),
        dayCount: z
          .string()
          .describe("Your count: the trigger date as day 0, calendar days, any weekend or holiday rollover, ending in the due date"),
        margin: z
          .string()
          .describe(
            'Calendar days from the planned filing date to the due date, or, when the attorney gave none, from the date in "checked", saying which one was used; when neither date is known, say the margin cannot be computed'
          ),
        cuttingItClose: z
          .boolean()
          .nullable()
          .describe(
            'Whether the filing date is cutting it close (filing is receipt-based, no postmark rule); null whenever the margin cannot be computed, including when "checked" is "date not stated" and no planned filing date was given'
          ),
        manualRegulationConflict: z
          .string()
          .optional()
          .describe("Where the manual and the regulation conflict: both periods, and that the shorter one was used as the safe deadline"),
        cites: z.array(citationSchema),
      })
    ),
    noDeadlineStatement: z.string().optional().describe("Why no deadline applies; only when deadlines is empty"),
  }),
  passedChecks: z
    .array(
      z.object({
        category: z.string().describe("The category checked and passed, in a few words"),
        cites: z.array(citationSchema),
      })
    )
    .describe("One compact entry per category checked and passed"),
});
export type EoirFilingComplianceOutput = z.infer<typeof eoirFilingComplianceOutputSchema>;

export const eoirFilingCompliance = defineSkill({
  name: "eoir-filing-compliance",
  label: "Run filing compliance check",
  category: "eoir",
  kind: "review",
  description:
    "Checks an EOIR filing against the Immigration Court or BIA Practice Manual before it goes out and reports every compliance defect with a section cite and a fix.",
  outputSchema: eoirFilingComplianceOutputSchema,
  // The report has no flags item, so this collects what the SKILL.md treats
  // as blocking or sends to the attorney: a DO NOT FILE YET verdict, every
  // failure, a manual / regulation deadline conflict ("flag the conflict"),
  // a deadline cutting it close or with no margin computed (no planned
  // filing date and no date for the check, so "cutting it close" could not
  // be tested), every volatile item not verified live ("say clearly ... and
  // give the URLs for the attorney to confirm"), and every CANNOT VERIFY item
  // ("never guess these into a PASS"). Fixes are curable and stay in the
  // report.
  extractEscalationFlags: (output) => {
    const flags: string[] = [];
    if (output.verdict.label === "DO_NOT_FILE_YET") flags.push(`DO NOT FILE YET: ${output.verdict.why}`);
    for (const f of output.failures) {
      flags.push(`FAIL: ${f.whatIsWrong} (${f.whereInThePacket}). Fix: ${f.exactFix}`);
    }
    for (const d of output.deadlineCheck.deadlines) {
      if (d.manualRegulationConflict) {
        flags.push(`Manual and regulation conflict on ${d.governingDeadline}: ${d.manualRegulationConflict}`);
      }
      if (d.cuttingItClose) flags.push(`Cutting it close: ${d.governingDeadline} (margin: ${d.margin})`);
      if (d.cuttingItClose === null) flags.push(`Margin to the deadline not computed: ${d.governingDeadline} (${d.margin})`);
    }
    const unverified = output.liveManualVerification.volatileItems.filter((v) => !v.verified);
    for (const v of unverified) flags.push(`Not verified against the live source: ${v.item}. Confirm at ${v.url}`);
    if (output.liveManualVerification.status === "not_available" && unverified.length === 0) {
      flags.push("Live-manual verification not available: fees and deadlines were not verified against the live manual.");
    }
    for (const c of output.couldNotVerify ?? []) {
      flags.push(`CANNOT VERIFY: ${c.whatCouldNotBeChecked}. Confirm: ${c.whatTheAttorneyShouldConfirm}`);
    }
    return flags;
  },
  // fetch_ecfr_section (tools/eoir-filing-compliance.ts) is Step 3's eCFR
  // check of 8 CFR 1003.38 and 1003.3. The eCFR's web pages send automated
  // clients to a "Request Access" page instead of the regulation, and a
  // fetch that lands on it still comes back as a successful one; the tool
  // reads the section through the eCFR's API.
  // render_and_qa_docx shows the pages of a filing uploaded as Word (PDFs
  // already reach the model as pages), by the document_id the inventory
  // prints (prompt.ts inventoryLine), so a Word filing's format items
  // (pagination, cover page, spacing, signatures) can be checked rather than
  // coming back CANNOT VERIFY. It reserves RESERVED_TOOL_IMAGE_SLOTS of the
  // matter's native images (run.ts).
  // No fetch_uscis_page, although docs/ADDING_A_SKILL.md section 7 names it:
  // it returns only the first 20,000 characters of a page's text, without
  // saying so, and the manual chapters Step 3 checks are longer (ICPM 2.1's
  // individual calendar call-up rule and BIA PM 3.7(d) both start past that
  // point), so the model could report an item as absent, or unverified, from
  // a page cut short. web_fetch reads the whole chapter.
  tools: ["fetch_ecfr_section", "render_and_qa_docx", "search_library", "lookup_library_citation", "read_library_document"],
  // The manual chapters and the EOIR fee page are on justice.gov, and the
  // bundled checklists' update entries point to the FY 2027 fee rule on
  // govinfo.gov. The web tools are limited to those sources: search finds
  // the manual chapter or rule, and web_fetch reads it, PDFs included.
  // ecfr.gov is left out for the reason above.
  serverTools: [
    { name: "web_search", allowedDomains: ["justice.gov/eoir", "govinfo.gov"] },
    { name: "web_fetch", allowedDomains: ["justice.gov", "govinfo.gov"] },
  ],
  // A report, not a draft: the default maxTokens. More requests than a
  // report-only skill: live checks on the manual chapters, the fee page, the
  // fee rule and two eCFR sections, each a round trip, and page renders of a
  // Word filing in calls of at most 20 pages.
  maxIterations: 20,
  // Step 1 asks for posture facts the packet may not show, and marks the
  // affected items CANNOT VERIFY without them.
  needsNote: true,
  notePlaceholder:
    "Case note for Run filing compliance check (optional): the venue (which Immigration Court, or the BIA) and the filing type; detained or non-detained; next hearing type, date and time; for a BIA filing, the date of the IJ decision; any scheduling or standing order deadline; represented or pro se; ECAS or paper; the date you plan to file.",
  // Any matter that can be in removal proceedings, as for the other EOIR
  // skills (eoir-motion-self-review): a VAWA or I-130 matter can have
  // filings before the court too. Affirmative asylum and I-90 matters are
  // not before EOIR.
  applicableCaseTypes: ["asylum_defensive", "withholding_cat", "cancellation", "vawa", "i130"],
});
