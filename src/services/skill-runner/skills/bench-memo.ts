import { z } from "zod";
import { defineSkill } from "./types";
import { LEGAL_AUTHORITY_FETCH_DOMAINS } from "../fetch-domains";

// Mirrors skills-content/bench-memo/SKILL.md "Deliverables", items 1-4.
// Item 1 (the memo) is the Word document generate_document builds in the
// SKILL.md's "Format, follow it exactly" layout: the centered title block
// (header_lines with show_title false), the nine numbered sections as
// headings, bulleted one-idea lines, bold **SAY:** and **Authority:** leads,
// at the default 12 point type. The report carries its id and what the
// attorney checks before the hearing: the Tier One items the run did not
// have ("Intake": the skill would have asked for them before drafting) and
// what "Self check before delivering" left open. The SKILL.md bundles no
// references, scripts or assets.
//
// Dates: the SKILL.md prints three ("Prepared [date]", the bench note's date
// the citations were verified, and each citation's verification date) and
// forbids inventing one. The runner does not state today's date (a run date
// line in the matter context is a pending shared change), so the
// descriptions below send the model to the sources it does have (that line
// once it exists, the attorney's note, web_fetch's retrieved_at) and to a
// bracketed gap otherwise.
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DAY_OR_EMPTY = /^(\d{4}-\d{2}-\d{2})?$/;

export const benchMemoOutputSchema = z.object({
  benchMemo: z.object({
    generatedBenchMemoDocumentId: z
      .string()
      .describe("document_id returned by generate_document for the final memo; empty if none could be generated"),
    notGeneratedReason: z
      .string()
      .optional()
      .describe("Why no Word document could be generated; only when generatedBenchMemoDocumentId is empty"),
    pageCount: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe("Pages in the final memo as rendered by render_and_qa_docx; null if it could not be rendered"),
    preparedDate: z
      .string()
      .regex(ISO_DAY_OR_EMPTY)
      .describe(
        "YYYY-MM-DD printed on the title block's Prepared line, taken only from a run date stated in the matter context or from the attorney's note; never from memory or a page's own date. Empty when neither gives one: the memo then prints a bracketed gap on that line, listed in gapList"
      ),
    sectionsInOrder: z.array(z.string()).describe("The memo's numbered section headings, as printed, in order"),
    tierOneMissing: z
      .array(z.string())
      .describe(
        "Intake Tier One items (1-11) that neither the matter's documents nor the attorney's note supplied, named as the skill lists them; the memo carries a bracketed gap for each. Empty when Tier One is complete."
      ),
    selfCheck: z
      .object({
        blocking: z.array(z.string()),
        shouldFix: z.array(z.string()),
        optional: z.array(z.string()),
      })
      .describe(
        "Self check before delivering, by the skill's three tiers: what is still open in the final memo, one finding per entry; empty lists when it passes"
      ),
  }),
  gapList: z.array(
    z.object({
      bracketedItem: z.string().describe("The bracketed gap as it appears in the memo"),
      whatWouldCloseIt: z.string(),
    })
  ),
  citationTable: z.array(
    z.object({
      citation: z.string().describe("The authority in the memo's short form, with its year"),
      verified: z.boolean().describe("true only if confirmed in this run"),
      dateVerified: z
        .string()
        .regex(ISO_DAY)
        .optional()
        .describe(
          "YYYY-MM-DD: the date part of the retrieved_at on the web_fetch result that confirmed this authority; the memo's section 1 bench note gives this date as the date the citations were verified, or a bracketed gap when none was. Omit when verified is false or that result had no retrieved_at; never a date from memory"
        ),
      reverifyNote: z.string().describe("The note to reverify it the morning of the hearing"),
      url: z.string().optional().describe("The page it was confirmed on, exactly as retrieved"),
    })
  ),
  crossExposureList: z.array(z.string()).describe("The questions to expect from the trial attorney, one per entry"),
});
export type BenchMemoOutput = z.infer<typeof benchMemoOutputSchema>;

export const benchMemo = defineSkill({
  name: "bench-memo",
  label: "Draft bench memo",
  category: "eoir",
  kind: "build",
  description:
    "Drafts the podium bench memo for an EOIR individual merits hearing as a Word document, nine sections in hearing order, with a gap list, a citation table and the cross questions to expect.",
  outputSchema: benchMemoOutputSchema,
  // What the skill treats as blocking: a missing memo, the Tier One items it
  // cannot draft without, and the self check's Blocking tier. "A citation
  // not verified" is one of those; an unverified authority the model did
  // not name there is added from the citation table, so none slips through.
  extractEscalationFlags: (output) => {
    const { benchMemo: memo, citationTable } = output;
    const flags = [
      ...(memo.generatedBenchMemoDocumentId.trim()
        ? []
        : [`No bench memo was generated in this run${memo.notGeneratedReason ? `: ${memo.notGeneratedReason}` : "."}`]),
      ...memo.tierOneMissing.map((item) => `Tier One intake item missing, memo drafted with a bracket: ${item}`),
      ...memo.selfCheck.blocking,
    ];
    for (const row of citationTable) {
      if (!row.verified && !memo.selfCheck.blocking.some((b) => b.includes(row.citation))) {
        flags.push(`Citation not verified in this run: ${row.citation}`);
      }
    }
    return flags;
  },
  // read_prior_skill_reports: "Before anything" says to pull claim-evaluation's
  // element scoring, evidence-organizer's exhibit index and
  // country-conditions-research's sourced reports where they exist ("do not
  // re-derive what has already been done"); those exist only as the earlier
  // runs' reports. brief-draft's argument is its Word draft, a matter document.
  tools: ["read_prior_skill_reports", "generate_document", "render_and_qa_docx", "search_library", "lookup_library_citation", "read_library_document", "search_eoir_judges", "eoir_judge_profile", "query_eoir_stats"],
  // The citation table needs each authority's verification date, and the
  // self check blocks on an unverified citation, so the run retrieves the
  // authorities it cites. Search stays open (the SKILL.md names no
  // sources); web_fetch opens the legal-authority hosts in fetch-domains.ts
  // only, since the run reads the whole case file.
  // Confirming a caption, citation and date needs only the top of a page,
  // and the case file already fills most of the context window, so fetched
  // pages are cut well below the 30000-token default.
  serverTools: [
    "web_search",
    { name: "web_fetch", maxContentTokens: 10_000, allowedDomains: LEGAL_AUTHORITY_FETCH_DOMAINS },
  ],
  maxIterations: 24,
  // The Intake Tier One items the record rarely shows. The other skills'
  // reports come from read_prior_skill_reports, so the note no longer asks
  // for them.
  needsNote: true,
  notePlaceholder:
    "Case note for Draft bench memo (optional): hearing date and time, judge, and in person or by WebEx; interpreter language and dialect; the relief ladder in order and the relief you expect to win on; the particular social group formulation word for word; the cross vulnerabilities you expect and your answers; counsel appearing, name and title; what you know of the judge's practice; and the date to print on the memo's Prepared line.",
  // Any matter that can be in removal proceedings, as for the other EOIR
  // skills (eoir-motion-self-review): the SKILL.md covers cancellation,
  // adjustment and other relief argued in the alternative, so a VAWA or
  // I-130 matter before the court qualifies too. Affirmative asylum and I-90
  // matters are not before EOIR.
  applicableCaseTypes: ["asylum_defensive", "withholding_cat", "cancellation", "vawa", "i130"],
});
