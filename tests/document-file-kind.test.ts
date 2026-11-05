import assert from "node:assert/strict";
import test from "node:test";
import { detectFileKind, looksLikePdf, sniffImageMediaType } from "@/lib/documents/file-kind";

test("file signatures override a misleading PDF name or MIME type", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00]);
  assert.equal(sniffImageMediaType(jpeg), "image/jpeg");
  assert.deepEqual(detectFileKind({ bytes: jpeg, mimeType: "application/pdf", fileName: "evidence.pdf" }), {
    kind: "image",
    mediaType: "image/jpeg",
  });
});

test("PDF signature is recognized even when metadata claims plain text", () => {
  const pdf = Buffer.from(`${" ".repeat(80)}%PDF-1.7\nbody`);
  assert.equal(looksLikePdf(pdf), true);
  assert.deepEqual(detectFileKind({ bytes: pdf, mimeType: "text/plain", fileName: "evidence.txt" }), { kind: "pdf" });
});

test("a PDF extension without PDF bytes is not treated as a PDF", () => {
  const fake = Buffer.from("MZ\u0000\u0001not a pdf");
  assert.equal(looksLikePdf(fake), false);
  assert.deepEqual(detectFileKind({ bytes: fake, mimeType: "application/pdf", fileName: "evidence.pdf" }), { kind: "other" });
});

test("DOCX classification requires ZIP bytes and a Word declaration", () => {
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
  assert.deepEqual(
    detectFileKind({ bytes: zip, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", fileName: "evidence.docx" }),
    { kind: "docx" }
  );
  assert.deepEqual(detectFileKind({ bytes: zip, mimeType: "application/octet-stream", fileName: "evidence.bin" }), { kind: "other" });
});
