import type { ListingParse, ParsedItem } from "../types";
import { parseStatedDate } from "./dates";
import { anchors, attrValue, decodeEntities, htmlToText, inlineText, resolveUrl, sliceBetween } from "./html";

// Parsers for the two uscis.gov listings the platform adds to the skill's
// sources: Forms Updates (new form editions) and Policy Manual updates.

function rowsAfter(html: string, startMarker: string, rowMarker: RegExp): string[] {
  const region = sliceBetween(html, startMarker, ["<footer", 'class="pager', "</main>"]) ?? "";
  const starts: number[] = [];
  for (const m of region.matchAll(rowMarker)) starts.push(m.index ?? 0);
  return starts.map((start, i) => region.slice(start, starts[i + 1] ?? region.length));
}

function timeOf(fragment: string): { text: string | null; datetime: string | null } {
  const m = /<time\b([^>]*)>([\s\S]*?)<\/time\s*>/i.exec(fragment);
  if (!m) return { text: null, datetime: null };
  return { text: inlineText(m[2]) || null, datetime: attrValue(m[1], "datetime") };
}

/**
 * https://www.uscis.gov/forms/forms-updates: one "views-row" per update,
 * with the linked title ("Update to Form I-485, ... New Edition Dated
 * 09/18/26."), the display date and the edition note.
 */
export function parseUscisFormsUpdates(html: string, pageUrl: string): ListingParse {
  const rows = rowsAfter(html, "forms-updates-listing", /<div class="views-row\b/g);
  const items: ParsedItem[] = [];
  const notes: string[] = [];
  for (const row of rows) {
    const titleField = sliceBetween(row, "views-field-title", ["views-field-field-display-date"]) ?? "";
    const link = anchors(titleField)[0];
    const url = link ? resolveUrl(link.href, pageUrl) : null;
    if (!link || !url || !link.text) {
      notes.push("A forms update row without a linked title was left out.");
      continue;
    }
    const date = timeOf(row);
    const descriptionField = sliceBetween(row, "views-field-field-description", ["</div></div>"]) ?? "";
    const description = inlineText(descriptionField.replace(/^[^>]*>/, ""));
    items.push({
      externalId: `${url} | ${link.text}`,
      itemType: "USCIS form update",
      title: link.text,
      citation: null,
      officialUrl: url,
      documentUrl: null,
      publishedDateText: date.text,
      publishedOn: parseStatedDate(date.datetime) ?? parseStatedDate(date.text),
      excerpt: [link.text, description].filter(Boolean).join("\n"),
    });
  }
  return { items, rowsSeen: rows.length, recognized: rows.length > 0, notes, indexText: rows.map((r) => inlineText(r)).join("\n") };
}

/**
 * https://www.uscis.gov/policy-manual/updates: one "pm-updates" block per
 * update, with its header ("POLICY ALERT - ...", "Technical Update - ..."),
 * date, summary paragraph, the "Read More" document link when there is one,
 * and the Affected Sections list.
 */
export function parseUscisPolicyManualUpdates(html: string, pageUrl: string): ListingParse {
  const blocks = rowsAfter(html, "pm-resources", /<div class="pm-updates">/g);
  const items: ParsedItem[] = [];
  const notes: string[] = [];
  for (const block of blocks) {
    const header = /<div class="pm-resource__update_header">([\s\S]*?)<\/div>/i.exec(block);
    const headerText = header ? inlineText(header[1]) : "";
    if (!headerText) {
      notes.push("A Policy Manual update without a header was left out.");
      continue;
    }
    const date = timeOf(block);
    const body = sliceBetween(block, "field--name-body", ["</div>"]);
    const summary = body ? htmlToText(body.replace(/^[^>]*>/, "")) : "";
    const readMore = /<a\b([^>]*class="btn btn--anchor"[^>]*)>/i.exec(block);
    const readMoreUrl = readMore ? resolveUrl(attrValue(readMore[1], "href") ?? "", pageUrl) : null;
    const affected = [...block.matchAll(/<p class="affected-sections">([\s\S]*?)<\/p>/gi)].map((m) => {
      const a = anchors(m[1])[0];
      return { text: a ? a.text : inlineText(m[1]), url: a ? resolveUrl(a.href, pageUrl) : null };
    });
    const officialUrl = readMoreUrl ?? affected.find((a) => a.url)?.url ?? pageUrl;
    const affectedLine = affected.length ? `Affected Sections: ${affected.map((a) => a.text).join("; ")}` : "";
    items.push({
      externalId: `${date.datetime ?? date.text ?? ""} | ${headerText}`,
      itemType: "USCIS Policy Manual update",
      title: decodeEntities(headerText),
      citation: null,
      officialUrl,
      documentUrl: null,
      publishedDateText: date.text,
      publishedOn: parseStatedDate(date.datetime) ?? parseStatedDate(date.text),
      excerpt: [headerText, summary, affectedLine].filter(Boolean).join("\n"),
      listingFacts: affected.length ? { affectedSections: affected.map((a) => a.text).join("; ") } : undefined,
    });
  }
  return { items, rowsSeen: blocks.length, recognized: blocks.length > 0, notes, indexText: blocks.map((b) => inlineText(b)).join("\n") };
}
