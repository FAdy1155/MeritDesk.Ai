import { anchors, attrValue, inlineText, resolveUrl } from "../../extract/html";

// Pure parsers for the official pages and API answers the statutes and
// regulations collectors read (the formats themselves are in ./uslm.ts and
// ./ecfr-xml.ts):
//
// - the Office of the Law Revision Counsel's download page for the current
//   release point of the U.S. Code, https://uscode.house.gov/download.html;
// - the eCFR versioner API's titles and versions answers
//   (https://www.ecfr.gov/developers/documentation/api/v1);
// - the Government Publishing Office's text of The Constitution of the
//   United States of America As Amended (H. Doc. 110-50) on GovInfo, and
//   the MODS record that describes it.

// --- the OLRC download page ------------------------------------------------

export type UscTitleDownload = {
  /** The OLRC identifier of the title, "us/usc/t8" (the item's id attribute). */
  id: string;
  /** "Title 8 - Aliens and Nationality", as listed. */
  label: string;
  /** The page prints titles changed since the previous release point in bold (class usctitlechanged). */
  changedSinceLastRelease: boolean;
  /** The "Current Through" column ("119-120"). */
  currentThrough: string | null;
  /** The [XML] link, resolved against the page. */
  xmlUrl: string;
};

export type UscDownloadPage = {
  /** "Public Law 119-120 (10/07/2026)", as printed under "Current Release Point". */
  releasePointText: string | null;
  /** "119-120". */
  releasePoint: string | null;
  /** The date in the release point line ("10/07/2026"), as printed. */
  releasePointDateText: string | null;
  titles: UscTitleDownload[];
};

/** The release point and the per-title XML links of the OLRC's download page. */
export function parseUscDownloadPage(html: string, pageUrl: string): UscDownloadPage {
  const release = /Current Release Point\s*<\/[^>]+>\s*(?:<[^>]+>\s*)*([^<]*Public Law\s+(\d{2,3}-\d{1,4})[^<]*)/i.exec(html);
  const releasePointText = release ? inlineText(release[1]) : null;
  const releaseDate = releasePointText ? /\((\d{1,2}\/\d{1,2}\/\d{4})\)/.exec(releasePointText) : null;
  const titles: UscTitleDownload[] = [];
  for (const m of html.matchAll(/<div class="uscitem">([\s\S]*?)<\/div>\s*<\/div>/g)) {
    const item = m[1];
    const head = /<div class="(usctitle(?:changed)?|usctitleappendix)" id="([^"]+)"[^>]*>([\s\S]*?)<\/div>/.exec(item);
    if (!head || !/^us\/usc\/t\w+$/.test(head[2])) continue;
    const xml = anchors(item).find((a) => /^\[XML\]$/i.test(a.text) && /\.zip$/i.test(a.href));
    const url = xml ? resolveUrl(xml.href, pageUrl) : null;
    if (!url) continue;
    const currency = /<div class="itemcurrency">([\s\S]*?)<\/div>/.exec(item);
    titles.push({
      id: head[2],
      label: inlineText(head[3].replace(/<span class="footnote">[\s\S]*?<\/span>/g, "")),
      changedSinceLastRelease: head[1] === "usctitlechanged",
      currentThrough: currency ? inlineText(currency[1]) || null : null,
      xmlUrl: url,
    });
  }
  return {
    releasePointText,
    releasePoint: release ? release[2] : null,
    releasePointDateText: releaseDate ? releaseDate[1] : null,
    titles,
  };
}

// --- the eCFR versioner API ------------------------------------------------

export type EcfrTitleInfo = {
  number: number;
  name: string;
  latest_amended_on: string | null;
  latest_issue_date: string | null;
  up_to_date_as_of: string | null;
  reserved: boolean;
};

/** The titles answer (/api/versioner/v1/titles.json); null when it is not that shape. */
export function parseEcfrTitles(data: unknown): EcfrTitleInfo[] | null {
  const titles = (data as { titles?: unknown })?.titles;
  if (!Array.isArray(titles)) return null;
  const out: EcfrTitleInfo[] = [];
  for (const t of titles) {
    const r = t as Record<string, unknown>;
    if (typeof r.number !== "number" || typeof r.name !== "string") return null;
    const date = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    out.push({
      number: r.number,
      name: r.name,
      latest_amended_on: date(r.latest_amended_on),
      latest_issue_date: date(r.latest_issue_date),
      up_to_date_as_of: date(r.up_to_date_as_of),
      reserved: r.reserved === true,
    });
  }
  return out;
}

export type EcfrVersion = {
  /** The date the version took effect in the eCFR. */
  date: string;
  amendment_date: string;
  issue_date: string;
  /** "1003.38", or "Appendix E to Part 62". */
  identifier: string;
  name: string;
  part: string;
  subpart: string | null;
  substantive: boolean;
  removed: boolean;
  type: string;
};

export type EcfrVersionsPage = { versions: EcfrVersion[]; page: number | null; totalPages: number | null };

/** One versions answer (/api/versioner/v1/versions/title-N.json); null when it is not that shape. */
export function parseEcfrVersions(data: unknown): EcfrVersionsPage | null {
  const d = data as { content_versions?: unknown; meta?: Record<string, unknown> };
  if (!d || !Array.isArray(d.content_versions)) return null;
  const versions: EcfrVersion[] = [];
  for (const v of d.content_versions) {
    const r = v as Record<string, unknown>;
    const str = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : null);
    const date = str("date");
    const identifier = str("identifier");
    const part = str("part");
    if (!date || !identifier || part === null) return null;
    versions.push({
      date,
      amendment_date: str("amendment_date") ?? date,
      issue_date: str("issue_date") ?? date,
      identifier,
      name: str("name") ?? "",
      part,
      subpart: str("subpart"),
      substantive: r.substantive === true,
      removed: r.removed === true,
      type: str("type") ?? "section",
    });
  }
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);
  return { versions, page: num(d.meta?.page), totalPages: num(d.meta?.total_pages) };
}

// --- GovInfo: MODS and the Constitution's text --------------------------------

export type GovInfoMods = {
  title: string | null;
  dateIssued: string | null;
  /** "H. Doc. 110-50". */
  documentCitation: string | null;
  detailsUrl: string | null;
  htmlUrl: string | null;
  pdfUrl: string | null;
};

/** The facts a GovInfo package's MODS record states that the Constitution collector uses. */
export function parseGovInfoMods(xml: string): GovInfoMods {
  const tag = (re: RegExp) => {
    const m = re.exec(xml);
    return m ? inlineText(m[1]) || null : null;
  };
  const url = (label: string) => {
    for (const m of xml.matchAll(/<url\b([^>]*)>([\s\S]*?)<\/url>/g)) {
      if (attrValue(m[1], "displayLabel") === label) return inlineText(m[2]) || null;
    }
    return null;
  };
  return {
    title: tag(/<titleInfo>\s*<title>([\s\S]*?)<\/title>/),
    dateIssued: tag(/<dateIssued\b[^>]*>([\s\S]*?)<\/dateIssued>/),
    documentCitation: tag(/<identifier type="congressional document citation">([\s\S]*?)<\/identifier>/),
    detailsUrl: url("Content Detail"),
    htmlUrl: url("HTML rendition"),
    pdfUrl: url("PDF rendition"),
  };
}

export type ConstitutionProvision = {
  /** Stable id: "preamble", "article-I-section-8", "article-V", "amendment-XIV". */
  id: string;
  kind: "preamble" | "article_section" | "article" | "amendment";
  /** "Article I", "Amendment XIV" (the GPO text prints amendments as "Article [XIV.]"). */
  article: string | null;
  /** The section number for an article section ("8"). */
  section: string | null;
  /** Section numbers inside an amendment (["1", "2", ...]). */
  sections: string[];
  /** The heading as printed ("Article I.", "Article [I.]", "Article XIV."). */
  printedHeading: string | null;
  /** The provision's text, reflowed, clause markers as "[1]", footnote references as "[note 12]", its footnotes at the end. */
  text: string;
  /** The notes the text refers to, by number, verbatim (reflowed). */
  footnotes: { num: string; text: string }[];
  /** For an amendment: the "Proposal and Ratification" paragraphs the text prints after it. */
  proposalAndRatification: string | null;
  /** "Ratification was completed on July 9, 1868." as printed, when the text states it. */
  ratificationCompletedText: string | null;
};

export type ConstitutionParse = { provisions: ConstitutionProvision[]; recognized: boolean; notes: string[] };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * The date a ratification sentence states ("Ratification was completed on
 * July 9, 1868.") as YYYY-MM-DD. The shared date reader takes years from
 * 1900 on only; the amendments were ratified from 1791, so this one reads
 * the edition's own "Month D, YYYY" for any year from 1787.
 */
export function ratificationDate(text: string | null): string | null {
  const m = /\b(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4})\b/.exec(text ?? "");
  if (!m) return null;
  const [year, month, day] = [Number(m[3]), MONTHS.indexOf(m[1]) + 1, Number(m[2])];
  if (year < 1787 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const DASHES = /^-{60,}\s*$/;

function reflow(lines: string[]): string[] {
  // The GPO text is hard-wrapped: a paragraph opens with a four-space indent
  // (hanging lines of the preamble use eight), headings and signature columns
  // are indented further, and a blank line ends a paragraph.
  const paragraphs: string[] = [];
  let current: string | null = null;
  const flush = () => {
    if (current !== null && current.trim()) paragraphs.push(current.replace(/\s+/g, " ").trim());
    current = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    // A short rule under a heading is layout, not text.
    if (!line.trim() || /^\s*-{3,}\s*$/.test(line)) {
      flush();
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent === 4 || (indent > 0 && indent !== 8) || current === null) {
      flush();
      current = line.trim();
      if (indent >= 10 || (indent > 0 && indent < 4)) flush();
    } else {
      // A hyphen that only splits a word across lines ("Thirty-\neighth") is printed as part of the word.
      current = /[A-Za-z]-$/.test(current) ? `${current}${line.trim()}` : `${current} ${line.trim()}`;
    }
  }
  flush();
  return paragraphs;
}

/**
 * The signers under Article VII are printed in two columns of states
 * (Delaware, Maryland, ... on the left; New Hampshire, Massachusetts, ... on
 * the right); read line by line they interleave. The left column is read
 * first, then the right, each name on its own line.
 */
function readSignerColumns(lines: string[]): string[] {
  const from = lines.findIndex((l) => /\[Signed also by the deputies/.test(l));
  const to = lines.findIndex((l, i) => i > from && /^\s*Attest:/.test(l));
  if (from < 0 || to < 0) return lines;
  const left: string[] = [];
  const right: string[] = [];
  for (const line of lines.slice(from + 1, to)) {
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    (indent >= 30 ? right : left).push(`  ${line.trim()}`);
  }
  return [...lines.slice(0, from + 1), "", ...left, ...right, "", ...lines.slice(to)];
}

/** Clause markers ("\2\No Person") open a paragraph; any other numbered marker refers to a footnote; letter markers are superscript letters in the signatures ("Presid\t\."). */
function renderMarkers(paragraph: string, footnoteRefs: Set<string>): string {
  let text = paragraph.replace(/^((?:Section \d+\.\s*)?)\\(\d+)\\\s*/, (_m, section: string, n: string) => `${section}[${n}] `);
  text = text.replace(/\\(\d+)\\/g, (_m, n: string) => {
    footnoteRefs.add(n);
    return ` [note ${n}]`;
  });
  return text.replace(/\\([A-Za-z]{1,3})\\/g, "$1").replace(/\s+\[note/g, " [note");
}

/**
 * The provisions of the Constitution in the GPO text: the preamble, each
 * section of Articles I to IV, Articles V to VII, and each amendment, with
 * the footnotes each refers to. Proposed amendments that were not
 * ratified, the historical note and the index are left out.
 */
export function parseConstitutionText(html: string): ConstitutionParse {
  const notes: string[] = [];
  const pre = /<pre>([\s\S]*?)<\/pre>/i.exec(html)?.[1];
  if (!pre) return { provisions: [], recognized: false, notes: ["The page has no <pre> text."] };
  const all = pre.replace(/\r\n?/g, "\n").split("\n");

  // Footnotes sit between lines of dashes wherever a printed page ended; take them out of the flow.
  const body: string[] = [];
  const footnotes = new Map<string, string[]>();
  let inNotes = false;
  let currentNote: string | null = null;
  for (const line of all) {
    if (DASHES.test(line)) {
      inNotes = !inNotes;
      currentNote = null;
      continue;
    }
    if (!inNotes) {
      body.push(line);
      continue;
    }
    if (/^\s*\*\s\*\s\*\s\*\s\*\s*$/.test(line)) {
      if (currentNote) footnotes.get(currentNote)?.push("");
      continue;
    }
    const start = /^\\(\d+)\\(.*)$/.exec(line);
    if (start) {
      // The index at the end of the document has its own notes numbered from 1; the first definition of a number is the Constitution's.
      currentNote = footnotes.has(start[1]) ? null : start[1];
      if (currentNote) footnotes.set(currentNote, [`    ${start[2]}`]);
    } else if (currentNote) {
      const lines = footnotes.get(currentNote)!;
      // A footnote's paragraphs after a "* * * * *" separator open at the margin.
      lines.push(lines[lines.length - 1] === "" ? `    ${line.trim()}` : line);
    }
  }
  const footnoteText = (n: string) => {
    const lines = footnotes.get(n);
    return lines ? reflow(lines).join("\n") : null;
  };

  const begin = body.findIndex((l) => /^\s*CONSTITUTION OF THE UNITED STATES(?:\\\d+\\)?\s*$/.test(l));
  const amendmentsAt = body.findIndex((l) => /^\s*ARTICLES IN ADDITION TO, AND AMENDMENT OF/.test(l));
  const end = body.findIndex((l) => /^\s*PROPOSED AMENDMENTS TO THE CONSTITUTION NOT RATIFIED/.test(l));
  if (begin < 0 || amendmentsAt < begin || end < amendmentsAt) {
    return { provisions: [], recognized: false, notes: ["The Constitution's heading, the amendments heading or the unratified amendments heading was not found."] };
  }

  type Segment = { heading: string | null; article: string | null; amendment: boolean; lines: string[]; headingLines: string[] };
  const segments: Segment[] = [{ heading: null, article: null, amendment: false, lines: [], headingLines: [body[begin]] }];
  for (let i = begin + 1; i < end; i++) {
    const line = body[i];
    const original = i < amendmentsAt ? /^\s{10,}Article ([IVX]+)\.\s*$/.exec(line) : null;
    const amendment = i > amendmentsAt ? /^\s{10,}Article \[?([IVXL]+)\.?\]?\.?\s*((?:\\\d+\\)?)\s*$/.exec(line) : null;
    if (original || amendment) {
      segments.push({ heading: line.trim(), article: (original ?? amendment)![1], amendment: Boolean(amendment), lines: [], headingLines: [] });
      continue;
    }
    if (i === amendmentsAt) {
      // The heading of the amendments (with its footnote) opens the first amendment's segment.
      const heading: string[] = [];
      while (i < end && body[i].trim() && !/^\s{10,}Article /.test(body[i])) heading.push(body[i++]);
      i--;
      segments.push({ heading: null, article: null, amendment: true, lines: [], headingLines: heading });
      continue;
    }
    segments[segments.length - 1].lines.push(line);
  }

  const provisions: ConstitutionProvision[] = [];
  const pendingHeading: string[] = [];
  for (const seg of segments) {
    if (!seg.article) {
      // The Constitution's own heading (before the preamble) or the amendments' heading.
      pendingHeading.push(...seg.headingLines.map((l) => l.trim()).filter(Boolean));
      if (!seg.amendment && seg.lines.some((l) => l.trim())) {
        const refs = new Set<string>();
        const heading = renderMarkers(pendingHeading.join(" "), refs);
        pendingHeading.length = 0;
        const paragraphs = reflow(seg.lines).map((p) => renderMarkers(p, refs));
        provisions.push(makeProvision({ id: "preamble", kind: "preamble", article: null, section: null, sections: [], printedHeading: heading, paragraphs, refs, footnoteText }));
      }
      continue;
    }
    const refs = new Set<string>();
    const lead = pendingHeading.length ? renderMarkers(pendingHeading.join(" "), refs) : null;
    pendingHeading.length = 0;
    const printedHeading = renderMarkers(seg.heading ?? "", refs);
    const paragraphs = reflow(seg.amendment ? seg.lines : readSignerColumns(seg.lines));
    if (seg.amendment) {
      const pr = paragraphs.findIndex((p) => /^Proposal and Ratification$/i.test(p));
      const textParas = (pr >= 0 ? paragraphs.slice(0, pr) : paragraphs).map((p) => renderMarkers(p, refs));
      const after = pr >= 0 ? paragraphs.slice(pr).map((p) => renderMarkers(p, refs)) : [];
      const sections = textParas.map((p) => /^Section (\d+)\./.exec(p)?.[1]).filter((s): s is string => Boolean(s));
      const ratified = after.map((p) => /Ratification was completed on [^.]*\./.exec(p)?.[0]).find(Boolean) ?? null;
      provisions.push(
        makeProvision({
          id: `amendment-${seg.article}`,
          kind: "amendment",
          article: `Amendment ${seg.article}`,
          section: null,
          sections,
          printedHeading: lead ? `${lead}\n\n${printedHeading}` : printedHeading,
          paragraphs: [...textParas, ...after],
          refs,
          footnoteText,
          proposalAndRatification: after.length ? after.join("\n") : null,
          ratificationCompletedText: ratified,
        })
      );
      continue;
    }
    // An original article: one provision per section when it has sections.
    const sectionStarts = paragraphs.map((p, i) => (/^Section \d+\./.test(p) ? i : -1)).filter((i) => i >= 0);
    if (sectionStarts.length === 0) {
      provisions.push(
        makeProvision({
          id: `article-${seg.article}`,
          kind: "article",
          article: `Article ${seg.article}`,
          section: null,
          sections: [],
          printedHeading,
          paragraphs: paragraphs.map((p) => renderMarkers(p, refs)),
          refs,
          footnoteText,
        })
      );
      continue;
    }
    if (sectionStarts[0] > 0) notes.push(`Article ${seg.article} has text before its first section; it was kept with section 1.`);
    sectionStarts.forEach((startAt, k) => {
      const from = k === 0 ? 0 : startAt;
      const to = k + 1 < sectionStarts.length ? sectionStarts[k + 1] : paragraphs.length;
      const sectionRefs = new Set<string>(k === 0 ? refs : []);
      const paras = paragraphs.slice(from, to).map((p) => renderMarkers(p, sectionRefs));
      const section = /^Section (\d+)\./.exec(paragraphs[startAt])![1];
      provisions.push(
        makeProvision({
          id: `article-${seg.article}-section-${section}`,
          kind: "article_section",
          article: `Article ${seg.article}`,
          section,
          sections: [],
          printedHeading,
          paragraphs: paras,
          refs: sectionRefs,
          footnoteText,
        })
      );
    });
  }
  return { provisions, recognized: provisions.length > 0, notes };
}

function makeProvision(p: {
  id: string;
  kind: ConstitutionProvision["kind"];
  article: string | null;
  section: string | null;
  sections: string[];
  printedHeading: string | null;
  paragraphs: string[];
  refs: Set<string>;
  footnoteText: (n: string) => string | null;
  proposalAndRatification?: string | null;
  ratificationCompletedText?: string | null;
}): ConstitutionProvision {
  const footnotes = [...p.refs]
    .sort((a, b) => Number(a) - Number(b))
    .map((num) => ({ num, text: p.footnoteText(num) ?? "" }))
    .filter((f) => f.text);
  const parts = [p.printedHeading, ...p.paragraphs].filter((x): x is string => Boolean(x && x.trim()));
  const text = [parts.join("\n\n"), footnotes.length ? footnotes.map((f) => `[note ${f.num}] ${f.text}`).join("\n\n") : ""].filter(Boolean).join("\n\nNotes\n\n");
  return {
    id: p.id,
    kind: p.kind,
    article: p.article,
    section: p.section,
    sections: p.sections,
    printedHeading: p.printedHeading,
    text,
    footnotes,
    proposalAndRatification: p.proposalAndRatification ?? null,
    ratificationCompletedText: p.ratificationCompletedText ?? null,
  };
}
