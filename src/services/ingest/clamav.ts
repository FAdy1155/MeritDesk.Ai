import "server-only";
import { execUntrusted, UntrustedToolSandboxError } from "@/services/sandbox/untrusted-exec";

/**
 * One clamscan run over one file, shared by the document-ingest job's scan
 * of uploads (./ingest.ts) and the form tools' scan of blank forms they
 * download from uscis.gov (src/services/skill-runner/tools/shared/
 * uscis-forms.ts). It returns what happened, not a verdict: each caller
 * turns the outcome into its own status and message, and each treats
 * anything but "clean" as not clean (fail closed).
 *
 * clamscan (not clamdscan) on purpose: the worker image runs no clamd
 * daemon, and clamscan takes its size limits on the command line, so
 * --alert-exceeds-max reliably reports a file too big to scan fully instead
 * of passing it as clean (clamd applies its own clamd.conf limits and passes
 * oversized files silently unless that config says otherwise). The cost is
 * loading the signature database on every scan. Runs through execUntrusted:
 * no secrets in its environment, and on the worker image as an unprivileged
 * user with no network.
 */
export type ClamScanOutcome =
  /** Exit code 0: no virus found. */
  | { kind: "clean" }
  /**
   * Exit code 1 with a FOUND line. limitsExceeded: the signature is
   * Heuristics.Limits.Exceeded..., i.e. the file was too big to scan fully,
   * which is never clean.
   */
  | { kind: "found"; signature: string; limitsExceeded: boolean }
  /** clamscan is not on PATH (code ENOENT). */
  | { kind: "not_installed" }
  /** Not run at all: the sandbox it requires is not available on this worker. */
  | { kind: "sandbox_refused"; message: string }
  /**
   * Anything else (exit code 2, a timeout, a signal). stdout and stderr are
   * as the process error carried them (undefined when it carried none), so
   * each caller can summarize them the way it always has.
   */
  | {
      kind: "failed";
      exitCode: number | null;
      timedOut: boolean;
      stdout: string | undefined;
      stderr: string | undefined;
      message: string;
    };

export async function runClamScan(
  filePath: string,
  options: {
    /** The scan's working directory (sandboxed tools read and write only there). */
    workDir: string;
    /** The largest file the caller scans; sets --max-filesize, and --max-scansize at four times it. */
    maxFileBytes: number;
    timeoutMs: number;
  }
): Promise<ClamScanOutcome> {
  const maxMb = Math.ceil(options.maxFileBytes / (1024 * 1024));
  try {
    await execUntrusted(
      "clamscan",
      [
        "--no-summary",
        "--stdout",
        `--max-filesize=${maxMb}M`,
        // Room for archives (a .docx is a zip) that expand while scanning.
        `--max-scansize=${maxMb * 4}M`,
        "--alert-exceeds-max=yes",
        filePath,
      ],
      { workDir: options.workDir, timeoutMs: options.timeoutMs }
    );
    return { kind: "clean" };
  } catch (err) {
    if (err instanceof UntrustedToolSandboxError) return { kind: "sandbox_refused", message: err.message };
    const e = err as Error & { code?: string | number; stdout?: string; stderr?: string; killed?: boolean };
    if (e.code === "ENOENT") return { kind: "not_installed" };
    // Exit codes: 0 no virus found, 1 virus found, 2 an error occurred.
    const found = /: (.+) FOUND\s*$/m.exec(e.stdout ?? "");
    if (e.code === 1 && found) {
      const signature = found[1].trim();
      return { kind: "found", signature, limitsExceeded: signature.startsWith("Heuristics.Limits.Exceeded") };
    }
    return {
      kind: "failed",
      exitCode: typeof e.code === "number" ? e.code : null,
      timedOut: Boolean(e.killed),
      stdout: e.stdout,
      stderr: e.stderr,
      message: e.message,
    };
  }
}
