import assert from "node:assert/strict";
import test from "node:test";
import { MAX_DOCUMENT_UPLOAD_BYTES, validateDocumentUploadMetadata } from "@/lib/documents/upload-policy";

const valid = {
  fileName: "notice.pdf",
  contentType: "application/pdf",
  sizeBytes: 1024,
  type: "receipt_notice",
};

test("accepts valid upload metadata and normalizes MIME type", () => {
  assert.deepEqual(validateDocumentUploadMetadata({ ...valid, contentType: "Application/PDF" }), {
    ...valid,
    contentType: "application/pdf",
  });
});

test("rejects uploads larger than the scan limit", () => {
  assert.throws(() => validateDocumentUploadMetadata({ ...valid, sizeBytes: MAX_DOCUMENT_UPLOAD_BYTES + 1 }));
});

test("rejects empty uploads", () => {
  assert.throws(() => validateDocumentUploadMetadata({ ...valid, sizeBytes: 0 }));
});

test("rejects path separators and control characters in file names", () => {
  assert.throws(() => validateDocumentUploadMetadata({ ...valid, fileName: "../notice.pdf" }));
  assert.throws(() => validateDocumentUploadMetadata({ ...valid, fileName: "notice\n.pdf" }));
});

test("rejects malformed MIME values and non-uploadable document types", () => {
  assert.throws(() => validateDocumentUploadMetadata({ ...valid, contentType: "application pdf" }));
  assert.throws(() => validateDocumentUploadMetadata({ ...valid, type: "generated_letter" }));
});
