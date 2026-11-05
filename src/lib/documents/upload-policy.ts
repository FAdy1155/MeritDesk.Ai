export const UPLOADABLE_DOCUMENT_TYPES = ["uploaded_evidence", "receipt_notice", "other"] as const;
export type UploadableDocumentType = (typeof UPLOADABLE_DOCUMENT_TYPES)[number];

/** Keep browser uploads within the worker's scan and extraction limit. */
export const MAX_DOCUMENT_UPLOAD_BYTES = 150 * 1024 * 1024;

const MIME_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
const CONTROL_OR_PATH_SEPARATOR = /[\\/\u0000-\u001f\u007f]/;

export type DocumentUploadMetadata = {
  fileName: string;
  contentType: string;
  sizeBytes: number;
  type: UploadableDocumentType;
};

/** Validate browser-controlled upload metadata before creating a row or presigned URL. */
export function validateDocumentUploadMetadata(input: unknown): DocumentUploadMetadata {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid document upload.");
  }
  const value = input as Record<string, unknown>;
  if (typeof value.fileName !== "string") throw new Error("Choose a file with a valid name.");
  const fileName = value.fileName.trim();
  if (!fileName || fileName.length > 255 || fileName === "." || fileName === ".." || CONTROL_OR_PATH_SEPARATOR.test(fileName)) {
    throw new Error("The file name must be 1 to 255 characters and cannot contain path separators or control characters.");
  }
  if (typeof value.contentType !== "string" || value.contentType.length > 255 || !MIME_TYPE.test(value.contentType.trim())) {
    throw new Error("The file type is invalid. Choose the file again and retry.");
  }
  if (!Number.isSafeInteger(value.sizeBytes) || (value.sizeBytes as number) < 1) {
    throw new Error("The file is empty or its size could not be verified.");
  }
  if ((value.sizeBytes as number) > MAX_DOCUMENT_UPLOAD_BYTES) {
    throw new Error("Files must be 150 MB or smaller so they can be scanned safely.");
  }
  if (typeof value.type !== "string" || !UPLOADABLE_DOCUMENT_TYPES.includes(value.type as UploadableDocumentType)) {
    throw new Error("Choose a valid document type.");
  }
  return {
    fileName,
    contentType: value.contentType.trim().toLowerCase(),
    sizeBytes: value.sizeBytes as number,
    type: value.type as UploadableDocumentType,
  };
}
