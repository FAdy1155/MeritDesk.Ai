import { DrizzleQueryError } from "drizzle-orm";

// Error text that may be written to the worker's logs, stored as a pg-boss
// job's output (a table without RLS, kept for days) or logged by Next for a
// failed Server Action. Several libraries put the data they were handling
// into their error messages:
// - Drizzle's DrizzleQueryError: "Failed query: <sql> params: <every bound
//   value>" (a skill report, a case note, a client's A-number).
// - The Postgres error under it: `detail` can hold the failing row ("Failing
//   row contains (...)") and data exceptions (SQLSTATE class 22) quote the
//   rejected value in the message itself.
// - The Anthropic SDK's unparseable streamed tool input: "... JSON: <the
//   partial tool input>" (a drafted declaration).
// - The AWS SDK: an AccessDenied message names the object's ARN, and object
//   keys carry the uploaded file's name.
// These helpers keep what is needed to debug (error class, SQLSTATE,
// constraint, HTTP status) and drop the data.

/**
 * What withTenantContext / withServiceContext (src/db/client.ts) throw in
 * place of a Drizzle or Postgres error: the SQLSTATE and constraint survive
 * (callers test `code === "23505"`), the bound values and the row do not.
 */
export class DatabaseQueryError extends Error {
  readonly code: string | undefined;
  readonly constraint: string | undefined;

  constructor(message: string, code: string | undefined, constraint: string | undefined) {
    super(message);
    this.name = "DatabaseQueryError";
    this.code = code;
    this.constraint = constraint;
  }
}

type PostgresErrorFields = { code?: unknown; constraint?: unknown; table?: unknown; severity?: unknown };

function isPostgresError(err: unknown): err is Error & PostgresErrorFields {
  if (!(err instanceof Error)) return false;
  const { code, severity } = err as PostgresErrorFields;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && typeof severity === "string";
}

function postgresMessage(err: Error & PostgresErrorFields): string {
  const code = err.code as string;
  // Class 22 (data exception) messages quote the value that was rejected.
  const text = code.startsWith("22") ? err.message.split(":")[0] : err.message;
  const constraint = typeof err.constraint === "string" ? ` (constraint ${err.constraint})` : "";
  const table = typeof err.table === "string" ? ` on ${err.table}` : "";
  return `${text}${constraint}${table} [SQLSTATE ${code}]`;
}

/**
 * The error to rethrow for a database failure, or the error itself when it
 * did not come from the database (an expected refusal a callback threw).
 */
export function sanitizeDatabaseError(err: unknown): unknown {
  const pg = err instanceof DrizzleQueryError ? err.cause : err;
  if (isPostgresError(pg)) {
    return new DatabaseQueryError(
      `Database query failed: ${postgresMessage(pg)}`,
      pg.code as string,
      typeof pg.constraint === "string" ? pg.constraint : undefined
    );
  }
  if (err instanceof DrizzleQueryError) {
    // A failure below the driver (connection lost, timeout): its own message carries no data.
    return new DatabaseQueryError(
      `Database query failed: ${err.cause instanceof Error ? `${err.cause.name}: ${err.cause.message}` : "unknown error"}`,
      undefined,
      undefined
    );
  }
  return err;
}

/** A statement Postgres cancelled (SQLSTATE 57014), as statement_timeout does, after sanitizeDatabaseError. */
export function isQueryCanceledError(err: unknown): boolean {
  return err instanceof DatabaseQueryError && err.code === "57014";
}

/** An AWS SDK service error (it carries $metadata with the HTTP status). */
function awsStatus(err: Error): number | null {
  const metadata = (err as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
  return metadata && typeof metadata.httpStatusCode === "number" ? metadata.httpStatusCode : null;
}

/**
 * A one-line description of `err` safe for logs and the job table: no
 * bound query values, no tool input, no object keys. Used for every error
 * the worker logs or hands back to pg-boss.
 */
export function safeErrorMessage(err: unknown): string {
  const sanitized = sanitizeDatabaseError(err);
  if (!(sanitized instanceof Error)) return String(sanitized).slice(0, 500);
  if (sanitized instanceof DatabaseQueryError) return sanitized.message;
  const status = awsStatus(sanitized);
  if (status !== null) return `${sanitized.name} (S3 HTTP ${status})`;
  // The Anthropic SDK's streamed tool-input parse error ends with the input itself.
  const jsonAt = sanitized.message.indexOf(". JSON: ");
  const message = jsonAt >= 0 ? `${sanitized.message.slice(0, jsonAt)}. (Tool input not logged.)` : sanitized.message;
  return message.slice(0, 2000);
}

/** For console.error / console.warn: the error's class and safe message, never the object (whose inspection prints its properties and cause). */
export function describeErrorForLog(err: unknown): string {
  const sanitized = sanitizeDatabaseError(err);
  const name = sanitized instanceof Error ? sanitized.name : typeof sanitized;
  const message = safeErrorMessage(err);
  return message.startsWith(name) ? message : `${name}: ${message}`;
}
