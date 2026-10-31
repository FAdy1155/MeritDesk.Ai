import { z } from "zod";
import { defineSkill } from "./types";
import { COUNTRY_CONDITIONS_FETCH_DOMAINS } from "../fetch-domains";

// The report is the whole deliverable: the skill hands its sources to the
// attorney (and, if asked, on to evidence-organizer), so there is no
// generated document and no generator tool. Sources come only from the
// server-side web tools, whose every result the runner writes to the run's
// verification log (docs/ADDING_A_SKILL.md 2.4).

// The six-year cutoff is an exact day. A publication date is as precise as
// the source itself states it; ISO form lets the cutoff be checked below.
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TO_DAY_MONTH_OR_YEAR = /^\d{4}(-\d{2}(-\d{2})?)?$/;

// One row of item 3's per-source table, in column order, plus url's
// companion retrievedAt (the research-skill addition, rule 2.1.3).
const sourceSchema = z.object({
  title: z.string(),
  publisher: z
    .string()
    .describe('"DOS" for the U.S. Department of State, "HRW" for Human Rights Watch, otherwise the publisher\'s name'),
  publicationDate: z
    .string()
    .regex(ISO_DATE_TO_DAY_MONTH_OR_YEAR)
    .describe("YYYY-MM-DD, or YYYY-MM or YYYY when the source states no more"),
  url: z.string().describe("Exactly as retrieved; never constructed"),
  retrievedAt: z
    .string()
    .describe("ISO time this run fetched the URL, from the web_fetch result; empty if not fetched in this run"),
  relevantFinding: z.string().describe("One or two sentences, paraphrased"),
  claimCorroborated: z.string(),
});

// Mirrors skills-content/country-conditions-research/SKILL.md "Output format", items 1-5.
export const countryConditionsResearchOutputSchema = z.object({
  researchProfile: z
    .object({
      countryOrRegion: z.string().describe("The country, plus the region or city when the harm is localized"),
      protectedGrounds: z.array(z.enum(["race", "religion", "nationality", "political_opinion", "PSG"])),
      harm: z.string(),
      persecutor: z
        .string()
        .describe("Who, and whether a state actor or a private actor the state cannot or will not control"),
      stateProtectionIssue: z.string(),
      timeframe: z.string(),
    })
    .describe("Identifying client details minimized"),
  recencyCutoffApplied: z.object({
    cutoffDate: z
      .string()
      .regex(ISO_DAY)
      .describe(
        "YYYY-MM-DD: today minus 6 years, or the firm's stricter cutoff. Take today's date from this run (a date given in the request, or a web_fetch result's retrieved_at), never from memory"
      ),
    firmRule: z.string().optional().describe("The practice profile's recency rule, only when it is stricter than 6 years"),
  }),
  sourcedEvidenceByClaim: z.array(
    z.object({
      claim: z.string().describe("The claim, or the element of the claim, these sources back"),
      sources: z.array(sourceSchema),
    })
  ),
  gaps: z.array(
    z.object({
      claimOrElement: z.string(),
      recommendation: z.enum(["expert_declaration", "more_targeted_research"]),
    })
  ),
  verificationNote: z.string(),
});
export type CountryConditionsResearchOutput = z.infer<typeof countryConditionsResearchOutputSchema>;

const GAP_RECOMMENDATION: Record<CountryConditionsResearchOutput["gaps"][number]["recommendation"], string> = {
  expert_declaration: "consider commissioning an expert declaration",
  more_targeted_research: "run more targeted research",
};

/**
 * True only when a source's publication date is confirmed on or after the
 * cutoff (SKILL.md hard rule 1). Both are schema-validated ISO strings, so
 * they compare as text. A year- or month-only date that falls in the
 * cutoff's own year or month cannot be confirmed, so it does not pass.
 */
function confirmedWithinCutoff(publicationDate: string, cutoffDate: string): boolean {
  if (publicationDate.length === cutoffDate.length) return publicationDate >= cutoffDate;
  return publicationDate > cutoffDate.slice(0, publicationDate.length);
}

/**
 * The earliest cutoff hard rule 1 allows at `now`: the UTC date six years
 * back, less one day, because the model may have taken "today" in the firm's
 * time zone or before the run crossed midnight UTC (a run is capped at three
 * hours). Feb 29 falls back to Feb 28.
 */
export function sixYearCutoffFloor(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear() - 6, now.getUTCMonth(), now.getUTCDate() - 1)).toISOString().slice(0, 10);
}

/**
 * Item 4's gaps are what the SKILL.md routes to the firm (expert declaration
 * or more research). A source the report lists without having fetched it,
 * or whose date is not confirmed within the cutoff, breaks one of the
 * SKILL.md's two hard rules, so it is flagged too. The cutoff the report
 * applied is the model's own reading of "today", so it is also held to the
 * run date: a cutoff earlier than six years before `now` is flagged, and
 * sources are checked against the later of the two. The runner calls this
 * once, when the run completes, so `now` is the run date. A stricter firm
 * rule is not checked here: the practice profile does not reach this
 * function, only the report does.
 */
export function countryConditionsResearchEscalationFlags(
  output: CountryConditionsResearchOutput,
  now: Date = new Date()
): string[] {
  const reported = output.recencyCutoffApplied.cutoffDate;
  const floor = sixYearCutoffFloor(now);
  const cutoff = reported < floor ? floor : reported;
  const sources = output.sourcedEvidenceByClaim.flatMap((group) => group.sources);
  return [
    ...new Set([
      ...(reported < floor
        ? [`Reported recency cutoff ${reported} is earlier than six years before this run (${floor}); sources are checked against ${floor}`]
        : []),
      ...output.gaps.map((g) => `No qualifying source for: ${g.claimOrElement} (${GAP_RECOMMENDATION[g.recommendation]})`),
      ...sources
        .filter((s) => !s.retrievedAt.trim())
        .map((s) => `Source not retrieved in this run; open and date it before use: ${s.title} (${s.url})`),
      ...sources
        .filter((s) => !confirmedWithinCutoff(s.publicationDate, cutoff))
        .map((s) => `Source not confirmed within the ${cutoff} recency cutoff: ${s.title}, dated ${s.publicationDate}`),
    ]),
  ];
}

export const countryConditionsResearch = defineSkill({
  name: "country-conditions-research",
  label: "Run country conditions research",
  category: "asylum",
  kind: "research",
  description:
    "Gathers recent, retrieved country-conditions sources (State Department and Human Rights Watch first, nothing older than 6 years) that corroborate the specific claims in the client's declaration.",
  outputSchema: countryConditionsResearchOutputSchema,
  extractEscalationFlags: (output) => countryConditionsResearchEscalationFlags(output),
  tools: ["search_library", "lookup_library_citation", "read_library_document"],
  // Accepted sources and tiers come from the practice profile, so search
  // stays open (2.4): DOS and HRW are the SKILL.md's priority, not its limit.
  // web_fetch opens only the country-conditions hosts in fetch-domains.ts,
  // since the run reads the client's declaration; a source elsewhere is
  // reported as a search result, not as retrieved.
  serverTools: ["web_search", { name: "web_fetch", allowedDomains: COUNTRY_CONDITIONS_FETCH_DOMAINS }],
  maxIterations: 24,
  needsNote: true,
  notePlaceholder:
    "Case note for Run country conditions research (optional): sources to prioritize, the claims or issues to focus on, or a claim summary if no declaration is uploaded.",
  applicableCaseTypes: ["asylum_affirmative", "asylum_defensive", "withholding_cat"],
});
