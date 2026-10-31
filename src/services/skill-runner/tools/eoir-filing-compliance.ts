import "server-only";
import crypto from "node:crypto";
import { z } from "zod";
// Types only: tools.ts imports this module for its registry.
import type { SkillTool, ToolExecutionContext } from "../tools";
import type { VerificationLogEntry } from "../verification-log";

// eoir-filing-compliance's Step 3 says to check 8 CFR 1003.38 and 1003.3 on
// eCFR, and its checklists say to verify 8 CFR 1003.38 there before
// reporting an appeal deadline. The eCFR's web pages
// (www.ecfr.gov/current/title-8/...) send automated clients to a "Request
// Access" page on unblock.federalregister.gov, which says programmatic access
// is limited to the developer APIs; a server-side fetch gets that page, not
// the regulation. This tool reads the section through the eCFR's public
// versioner API instead: read-only, one host, fixed paths, and nothing from
// the model but a title, a section number and an offset. Nothing in it is
// specific to this skill; any skill that must check current CFR text can
// list its key.
//
// Every call that reaches the API is written to the run's verification log
// as a fetch_uscis_page entry, as i90-packet-build's blank-form fetch is: the
// same app-recorded retrieval of an allow-listed government source, shown on
// the matter page as a "government page".

const ECFR_API = "https://www.ecfr.gov/api/versioner/v1";
const ECFR_FETCH_TIMEOUT_MS = 15_000;
// A section's XML is a few kilobytes (8 CFR 1003.1, one of the longest in
// the chapter, is under 50 KB); reading stops here.
const MAX_ECFR_BODY_BYTES = 2 * 1024 * 1024;
// Text one call returns at most; the model asks for the rest with offset,
// and the result always says when there is more.
const MAX_SECTION_CHARS = 40_000;
// JSON around the tool result in every later request, on top of the text.
const RESULT_JSON_OVERHEAD_BYTES = 200;

export const fetchEcfrSectionInputSchema = z.object({
  section: z
    .string()
    .trim()
    .regex(
      /^\d{1,5}[a-z]?\.\d{1,5}[a-z0-9-]*$/i,
      'section must be a CFR section number alone, such as 1003.38 (no title, "CFR", section sign or paragraph)'
    ),
  title: z.number().int().min(1).max(50).optional(),
  offset: z.number().int().min(0).optional(),
});

const titlesResponseSchema = z.object({
  titles: z.array(
    z.object({
      number: z.number(),
      up_to_date_as_of: z.string().nullable().optional(),
      reserved: z.boolean().optional(),
    })
  ),
});

const versionsResponseSchema = z.object({
  content_versions: z.array(z.object({ date: z.string().optional() })),
  meta: z.object({ latest_amendment_date: z.string().nullable().optional() }).optional(),
});

type EcfrResponse = { status: number; text: string } | { status: number | string; problem: string };

/** One GET on the eCFR API: no redirects followed, body read up to MAX_ECFR_BODY_BYTES. */
async function getEcfr(url: string): Promise<EcfrResponse> {
  try {
    // Node's fetch asks for a compressed response by default, which the
    // API requires.
    const res = await fetch(url, { signal: AbortSignal.timeout(ECFR_FETCH_TIMEOUT_MS), redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      return {
        status: res.status,
        problem: `the eCFR answered with HTTP ${res.status}, a redirect to ${res.headers.get("location") ?? "an unnamed page"}, instead of the regulation; nothing from it was read`,
      };
    }
    if (!res.body) return { status: res.status, text: "" };
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ECFR_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return { status: "too_large", problem: `the response was larger than ${MAX_ECFR_BODY_BYTES / (1024 * 1024)} MB` };
      }
      chunks.push(value);
    }
    return { status: res.status, text: Buffer.concat(chunks).toString("utf-8") };
  } catch (err) {
    return { status: 0, problem: err instanceof Error ? err.message : String(err) };
  }
}

function decodeCodePoint(code: number): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
}

/** The eCFR's section XML as plain text, one paragraph per line. */
function ecfrXmlToText(xml: string): string {
  return xml
    .replace(/<\?xml[^>]*\?>/g, "")
    .replace(/<\/(HEAD|HED|P|FP|CITA|EDNOTE|NOTE|AUTH|SOURCE|EXTRACT|PSPACE|ROW|TTITLE)>/gi, "\n")
    .replace(/<\/?(I|E|B|SU|FR|AC)\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => decodeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => decodeCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function isIsoDate(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export const fetchEcfrSectionTool: SkillTool = {
  definition: {
    name: "fetch_ecfr_section",
    description:
      "Fetch the current text of one Code of Federal Regulations section from the eCFR (www.ecfr.gov) through the eCFR's public API, to verify a regulation such as 8 CFR 1003.38 or 1003.3 against its current text before relying on it. " +
      "The eCFR's own web pages turn automated clients away, so this is the way to read a section here. " +
      "Give the section number alone (1003.38); title defaults to 8 (Aliens and Nationality). " +
      'Returns the section text as of the eCFR\'s "up to date as of" date, the date the section was last amended, and the URL fetched. ' +
      `At most ${MAX_SECTION_CHARS} characters per call: a longer section says so and takes offset for the rest. ` +
      "Every call is logged with its URL and timestamp in this run's verification log.",
    input_schema: {
      type: "object",
      properties: {
        section: { type: "string", description: 'The section number alone, e.g. 1003.38 (not "8 CFR 1003.38", no section sign or paragraph)' },
        title: { type: "integer", minimum: 1, maximum: 50, description: "CFR title (default 8)" },
        offset: { type: "integer", minimum: 0, description: "Character offset to continue a long section from (default 0)" },
      },
      required: ["section"],
    },
  },
  execute: async (input, ctx: ToolExecutionContext) => {
    const parsed = fetchEcfrSectionInputSchema.safeParse(input ?? {});
    if (!parsed.success) {
      return {
        content: `Input validation failed: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}. Call fetch_ecfr_section again with corrected input.`,
        isError: true,
      };
    }
    const { section } = parsed.data;
    const title = parsed.data.title ?? 8;
    const offset = parsed.data.offset ?? 0;
    const cite = `${title} CFR ${section}`;
    const query = new URLSearchParams({ section }).toString();

    // One log entry per call: the request that failed, or the text fetched.
    const log = (url: string, status: number | string, extra: Partial<VerificationLogEntry> = {}) => {
      ctx.verificationLog.push({ source: "fetch_uscis_page", url, fetchedAt: new Date().toISOString(), status, ...extra });
    };
    const failure = (url: string, status: number | string, why: string) => {
      log(url, status);
      return {
        content: `[Tried ${url} - ${new Date().toISOString()}] Could not read ${cite} from the eCFR: ${why}. Nothing from this call verifies the regulation.`,
        isError: true,
      };
    };

    // The date the eCFR's text for this title is current to.
    const titlesUrl = `${ECFR_API}/titles.json`;
    const titles = await getEcfr(titlesUrl);
    if ("problem" in titles) return failure(titlesUrl, titles.status, titles.problem);
    if (titles.status !== 200) return failure(titlesUrl, titles.status, `the eCFR's title list answered HTTP ${titles.status}`);
    let titleList: z.infer<typeof titlesResponseSchema>;
    try {
      titleList = titlesResponseSchema.parse(JSON.parse(titles.text));
    } catch {
      return failure(titlesUrl, "unreadable", "the eCFR's title list was not in the expected format");
    }
    const titleEntry = titleList.titles.find((t) => t.number === title);
    if (!titleEntry || titleEntry.reserved) return failure(titlesUrl, "not_found", `the eCFR has no current Title ${title}`);
    const upToDateAsOf = titleEntry.up_to_date_as_of;
    if (!isIsoDate(upToDateAsOf)) {
      return failure(titlesUrl, "unreadable", `the eCFR gave no "up to date as of" date for Title ${title}`);
    }

    // When the section last changed. Not essential: without it the text is
    // still returned, saying the history could not be read.
    const versionsUrl = `${ECFR_API}/versions/title-${title}.json?${query}`;
    const versions = await getEcfr(versionsUrl);
    let lastAmended: string | null = null;
    if (!("problem" in versions) && versions.status === 200) {
      try {
        const history = versionsResponseSchema.parse(JSON.parse(versions.text));
        if (history.content_versions.length === 0) {
          return failure(versionsUrl, "not_found", `the eCFR has no section ${cite}`);
        }
        const latest = history.meta?.latest_amendment_date;
        lastAmended = isIsoDate(latest) ? latest : null;
      } catch {
        lastAmended = null;
      }
    }

    const textUrl = `${ECFR_API}/full/${upToDateAsOf}/title-${title}.xml?${query}`;
    const full = await getEcfr(textUrl);
    if ("problem" in full) return failure(textUrl, full.status, full.problem);
    if (full.status === 404) return failure(textUrl, 404, `the eCFR has no text for section ${cite} as of ${upToDateAsOf}`);
    if (full.status !== 200) return failure(textUrl, full.status, `the eCFR answered HTTP ${full.status}`);
    const text = ecfrXmlToText(full.text);
    if (!text) return failure(textUrl, "empty", "the eCFR returned no text for the section");
    if (offset >= text.length) {
      return failure(textUrl, "bad_offset", `the section has ${text.length} characters, so offset ${offset} is past the end`);
    }

    // Cut a long section at a paragraph break where one is near.
    let end = Math.min(text.length, offset + MAX_SECTION_CHARS);
    if (end < text.length) {
      const lineBreak = text.lastIndexOf("\n", end);
      if (lineBreak > offset + MAX_SECTION_CHARS / 2) end = lineBreak + 1;
    }
    const header = [
      `[Fetched ${textUrl} - HTTP ${full.status} - ${new Date().toISOString()}]`,
      `${cite} as published in the eCFR, up to date as of ${upToDateAsOf}; ` +
        (lastAmended ? `this section was last amended ${lastAmended}.` : "its amendment history could not be read."),
    ];
    if (offset > 0 || end < text.length) {
      header.push(
        `Characters ${offset + 1}-${end} of ${text.length} are shown.` +
          (end < text.length ? ` The section continues: call fetch_ecfr_section again with offset ${end} for the rest.` : "")
      );
    }
    const content = `${header.join("\n")}\n\n${text.slice(offset, end)}`;

    // Everything a tool returns is resent with every later request of the run.
    const cost = Buffer.byteLength(JSON.stringify(content), "utf8") + RESULT_JSON_OVERHEAD_BYTES;
    if (ctx.requestBytes.used + cost > ctx.requestBytes.limit) {
      log(textUrl, "request_limit");
      return {
        content: `${cite} was read, but the conversation is too close to the API's request size limit to add its text. Report the regulation as not verified in this run.`,
        isError: true,
      };
    }
    ctx.requestBytes.used += cost;
    log(textUrl, full.status, {
      contentHash: crypto.createHash("sha256").update(content).digest("hex").slice(0, 16),
      title: `${cite} (eCFR, up to date as of ${upToDateAsOf})`,
    });
    return { content };
  },
};
