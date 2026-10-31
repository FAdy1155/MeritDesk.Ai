import "server-only";
import crypto from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

let cachedClient: S3Client | null = null;
function s3Client(): S3Client {
  if (!cachedClient) {
    cachedClient = new S3Client({
      region: requireEnv("AWS_REGION"),
      // The SDK's default (WHEN_SUPPORTED) adds a CRC32 checksum to every
      // PutObject. A presigned PUT has no body when it is signed, so the URL
      // would carry the checksum of an empty body and S3 would reject the
      // browser's upload as not matching it. Checksums only where S3 requires one.
      requestChecksumCalculation: "WHEN_REQUIRED",
    });
  }
  return cachedClient;
}

/**
 * Every object the app writes is encrypted with SSE-KMS. The bucket's
 * default encryption (README "AWS") covers a write that leaves it out, and
 * the bucket policy there can refuse one; the app asks for it on every write
 * anyway, and a presigned PUT carries it as a signed header the browser must
 * send (see getUploadUrl).
 */
const SERVER_SIDE_ENCRYPTION = "aws:kms" as const;

export function documentsBucket(): string {
  return requireEnv("S3_DOCUMENTS_BUCKET");
}

/**
 * A short-TTL presigned PUT URL for the browser to upload directly to S3.
 * The object key is namespaced by tenant/matter so a leaked URL for one
 * upload can't be reused to write into another tenant's or matter's path
 * (the app-layer check on read, via getDownloadUrl, is what actually
 * enforces isolation — this key shape just avoids accidental collisions).
 *
 * The URL can be used again until it expires, so the key's current bytes
 * are never trusted after the malware scan: the scan records the S3 object
 * version it read (documents.s3_version_id, which needs bucket versioning)
 * and every later read passes that version.
 *
 * The presigner signs x-amz-server-side-encryption as a header (S3 does not
 * take it from the query string), so the browser's PUT must send exactly the
 * returned `headers`, and the bucket's CORS rule must allow them (README
 * "AWS"). Content-Type is not signed; it is sent so S3 stores the type.
 */
export async function getUploadUrl(params: {
  tenantId: string;
  matterId: string;
  documentId: string;
  fileName: string;
  contentType: string;
}): Promise<{ url: string; headers: Record<string, string>; key: string; bucket: string }> {
  const bucket = documentsBucket();
  const key = `tenants/${params.tenantId}/matters/${params.matterId}/documents/${params.documentId}/${params.fileName}`;
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: params.contentType,
    ServerSideEncryption: SERVER_SIDE_ENCRYPTION,
  });
  const url = await getSignedUrl(s3Client(), command, { expiresIn: 300 });
  const headers = {
    "Content-Type": params.contentType,
    "x-amz-server-side-encryption": SERVER_SIDE_ENCRYPTION,
  };
  return { url, headers, key, bucket };
}

/** Thrown by getObjectBytes for an object over the caller's size cap. */
export class S3ObjectTooLargeError extends Error {
  constructor(
    readonly sizeBytes: number,
    readonly maxBytes: number
  ) {
    super(`Stored file is ${sizeBytes} bytes, over the ${maxBytes}-byte limit for this operation`);
    this.name = "S3ObjectTooLargeError";
  }
}

/**
 * An S3 version id that identifies one immutable object version, or null.
 * S3 omits it when the bucket has never had versioning, and reports "null"
 * while versioning is suspended; in both cases a later PUT to the key
 * replaces the bytes, so there is no version to pin.
 */
export function pinnableVersionId(versionId: string | null | undefined): string | null {
  return versionId && versionId !== "null" ? versionId : null;
}

/**
 * Server-side read of a stored object's bytes, for the worker (the skill
 * runner attaching a matter document to the model, the document-ingest job
 * scanning and extracting it). With versionId it reads exactly that object
 * version (the one the malware scan read), whatever has been written to the
 * key since; without one, the key's current object. Also returns the
 * version id S3 reports for what it read (null when there is nothing to
 * pin, see pinnableVersionId). Checks the object's size before reading the
 * body and refuses anything over maxBytes, so an oversized upload can't
 * exhaust the worker's memory. A missing object surfaces as the SDK's
 * NoSuchKey error (err.name === "NoSuchKey").
 */
export async function getObjectVersionBytes(params: {
  bucket: string;
  key: string;
  versionId?: string | null;
  maxBytes: number;
}): Promise<{ bytes: Buffer; versionId: string | null }> {
  const res = await s3Client().send(
    new GetObjectCommand({ Bucket: params.bucket, Key: params.key, VersionId: params.versionId ?? undefined })
  );
  const sizeBytes = res.ContentLength ?? 0;
  if (sizeBytes > params.maxBytes) {
    // Drop the connection instead of reading a body we are going to discard.
    (res.Body as { destroy?: () => void } | undefined)?.destroy?.();
    throw new S3ObjectTooLargeError(sizeBytes, params.maxBytes);
  }
  if (!res.Body) throw new Error(`S3 returned no body for ${params.key}`);
  const bytes = await res.Body.transformToByteArray();
  return {
    bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    versionId: pinnableVersionId(res.VersionId),
  };
}

/** getObjectVersionBytes for callers that only need the bytes. */
export async function getObjectBytes(params: {
  bucket: string;
  key: string;
  versionId?: string | null;
  maxBytes: number;
}): Promise<Buffer> {
  return (await getObjectVersionBytes(params)).bytes;
}

/** Lifetime of a presigned download URL (recorded on each document.download audit entry). */
export const DOWNLOAD_URL_EXPIRES_SECONDS = 300;

/**
 * A presigned GET URL. With versionId the URL serves exactly that object
 * version (the one the malware scan read), never whatever was written to the
 * key after it; reading a version needs s3:GetObjectVersion on the bucket.
 */
export async function getDownloadUrl(params: { bucket: string; key: string; versionId?: string | null }): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: params.bucket,
    Key: params.key,
    VersionId: params.versionId ?? undefined,
  });
  return getSignedUrl(s3Client(), command, { expiresIn: DOWNLOAD_URL_EXPIRES_SECONDS });
}

/**
 * Stores an attorney's signature image, already validated and re-serialized
 * by sanitizeSignatureImage (src/lib/firm-identity/signature-image.ts).
 * Signatures live in their own key namespace under the tenant,
 * tenants/<tenant>/firm-signatures/<attorney>/<upload>.<ext>, apart from
 * matter documents, and every upload gets a fresh key, so a stored signature
 * is never overwritten in place. Only the server writes here (there is no
 * presigned PUT for signatures). Returns the version id to pin reads to.
 */
export async function putFirmSignature(params: {
  tenantId: string;
  attorneyId: string;
  mediaType: "image/png" | "image/jpeg";
  body: Buffer;
}): Promise<{ key: string; bucket: string; versionId: string | null }> {
  const bucket = documentsBucket();
  const extension = params.mediaType === "image/png" ? "png" : "jpg";
  const key = `tenants/${params.tenantId}/firm-signatures/${params.attorneyId}/${crypto.randomUUID()}.${extension}`;
  const res = await s3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: params.body,
      ContentType: params.mediaType,
      ServerSideEncryption: SERVER_SIDE_ENCRYPTION,
    })
  );
  return { key, bucket, versionId: pinnableVersionId(res.VersionId) };
}

/** Lifetime of a signature preview URL (recorded on each firm_signature.preview audit entry). */
export const SIGNATURE_PREVIEW_URL_EXPIRES_SECONDS = 60;

/**
 * A short-lived presigned GET for previewing a signature image in the Firm
 * page, pinned to the stored version. The response headers are fixed by the
 * signature itself: the validated image type, shown inline, never cached.
 */
export async function getFirmSignaturePreviewUrl(params: {
  bucket: string;
  key: string;
  versionId: string | null;
  mediaType: "image/png" | "image/jpeg";
}): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: params.bucket,
    Key: params.key,
    VersionId: params.versionId ?? undefined,
    ResponseContentType: params.mediaType,
    ResponseContentDisposition: "inline",
    ResponseCacheControl: "no-store, private",
  });
  return getSignedUrl(s3Client(), command, { expiresIn: SIGNATURE_PREVIEW_URL_EXPIRES_SECONDS });
}

/**
 * Direct server-side upload for content the app itself produced (a skill's
 * generated docx), as opposed to getUploadUrl's presigned browser flow for
 * user-supplied files. Returns the new object's version id (null without
 * bucket versioning) so reads can be pinned to it like scanned uploads.
 */
export async function putGeneratedDocument(params: {
  tenantId: string;
  matterId: string;
  documentId: string;
  fileName: string;
  contentType: string;
  body: Buffer;
}): Promise<{ key: string; bucket: string; versionId: string | null }> {
  const bucket = documentsBucket();
  const key = `tenants/${params.tenantId}/matters/${params.matterId}/documents/${params.documentId}/${params.fileName}`;
  const res = await s3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: params.body,
      ContentType: params.contentType,
      ServerSideEncryption: SERVER_SIDE_ENCRYPTION,
    })
  );
  return { key, bucket, versionId: pinnableVersionId(res.VersionId) };
}

/**
 * The bucket for the library's original files (LIBRARY_S3_BUCKET, else the
 * documents bucket). They are not tenant data: public, official documents
 * under the global library/ prefix, never under tenants/.
 */
export function libraryBucket(): string {
  return process.env.LIBRARY_S3_BUCKET?.trim() || documentsBucket();
}

/** A key segment from an external id: letters, digits, dot, dash and underscore only. */
function librarySegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 120) || "document";
}

/**
 * Stores an original file the library fetched (with LIBRARY_STORE_ORIGINALS
 * on, public domain sources only), content-addressed so every version of a
 * document keeps its own file: library/<source>/<external id>/<sha256>.<ext>.
 * Written only by the library worker. Returns the key.
 */
export async function putLibraryOriginal(params: {
  code: string;
  externalId: string;
  sha256: string;
  contentType: string;
  extension: string;
  bytes: Buffer;
}): Promise<string> {
  const key = `library/${librarySegment(params.code)}/${librarySegment(params.externalId)}/${params.sha256}.${librarySegment(params.extension)}`;
  await s3Client().send(
    new PutObjectCommand({
      Bucket: libraryBucket(),
      Key: key,
      Body: params.bytes,
      ContentType: params.contentType,
      ServerSideEncryption: SERVER_SIDE_ENCRYPTION,
    })
  );
  return key;
}

/** A short-lived presigned GET for a library original, shown inline. Keys outside library/ are refused. */
export async function getLibraryOriginalUrl(key: string, contentType: string | null): Promise<string> {
  if (!key.startsWith("library/")) throw new Error("Not a library original.");
  const command = new GetObjectCommand({
    Bucket: libraryBucket(),
    Key: key,
    ...(contentType ? { ResponseContentType: contentType } : {}),
    ResponseContentDisposition: "inline",
  });
  return getSignedUrl(s3Client(), command, { expiresIn: DOWNLOAD_URL_EXPIRES_SECONDS });
}
