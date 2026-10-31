// Text extraction with pdf.js (the pdfjs-dist legacy build, which runs in
// Node without a browser or poppler), in a worker thread that
// src/services/library/extract/pdf.ts starts for one PDF and terminates
// when it answers, times out or exceeds its memory cap. Plain JavaScript on
// purpose: it runs without the TypeScript loader the worker process uses.
//
// The PDF comes from an official government or court site, but it is still
// parsed as untrusted input: eval is off (isEvalSupported: false, so a
// font's code is never compiled), no system fonts, no font faces, no XFA,
// and nothing is fetched (the data is passed in; CMaps, standard fonts and
// wasm decoders are read from pdfjs-dist's own files on disk).
import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

const { data, maxPages, maxChars, pdfjsDir } = workerData;

async function main() {
  const pdfjs = await import(pathToFileURL(`${pdfjsDir}/legacy/build/pdf.mjs`).href);
  const loadingTask = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    disableAutoFetch: true,
    disableStream: true,
    stopAtErrors: false,
    verbosity: 0,
    cMapUrl: `${pdfjsDir}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${pdfjsDir}/standard_fonts/`,
    wasmUrl: `${pdfjsDir}/wasm/`,
    iccUrl: `${pdfjsDir}/iccs/`,
  });
  try {
    const doc = await loadingTask.promise;
    const pageCount = doc.numPages;
    const parts = [];
    let chars = 0;
    let pagesRead = 0;
    let pagesWithText = 0;
    let truncated = pageCount > maxPages;
    for (let p = 1; p <= Math.min(pageCount, maxPages); p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let text = "";
      let lastY = null;
      for (const item of content.items) {
        if (typeof item.str !== "string") continue;
        const y = Array.isArray(item.transform) ? item.transform[5] : null;
        // A new baseline starts a new line even when the item carries no end-of-line flag.
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 1 && text && !text.endsWith("\n")) text += "\n";
        text += item.str;
        if (item.hasEOL) text += "\n";
        if (y !== null) lastY = y;
      }
      page.cleanup();
      pagesRead++;
      const trimmed = text.replace(/[ \t]+\n/g, "\n").trim();
      if (trimmed) pagesWithText++;
      const block = `[Page ${p}]\n${trimmed}\n`;
      parts.push(block);
      chars += block.length;
      if (chars > maxChars) {
        truncated = true;
        break;
      }
    }
    parentPort.postMessage({ ok: true, text: parts.join("\n"), pageCount, pagesRead, pagesWithText, truncated });
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
}

main().catch((err) => {
  parentPort.postMessage({ ok: false, error: String((err && err.message) || err).slice(0, 500), name: (err && err.name) || "Error" });
});
