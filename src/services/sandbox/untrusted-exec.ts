import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { slotsForTool } from "@/services/queue/concurrency";

const execFileAsync = promisify(execFile);

/**
 * Runs the external parsers that read untrusted bytes (clamscan, pdfinfo,
 * pdftotext, python-docx, LibreOffice, pdftoppm, and the Python document
 * generators, whose spec the model wrote from case documents) with as little
 * of the worker's authority as this machine allows:
 *
 * - A minimal environment (PATH, HOME/TMPDIR in the job's work directory,
 *   a UTF-8 locale) instead of the worker's, which holds DATABASE_URL,
 *   QUEUE_DATABASE_URL, ANTHROPIC_API_KEY and the AWS keys.
 * - On the worker image (Linux, worker running as root, UNTRUSTED_TOOLS_UID
 *   and UNTRUSTED_TOOLS_UID_COUNT set by Dockerfile.worker):
 *   - as an unprivileged user leased for this one call from a pool of
 *     UNTRUSTED_TOOLS_UID_COUNT users (uid = gid, from UNTRUSTED_TOOLS_UID
 *     up), via util-linux `setpriv`, so two calls running at the same time
 *     (two tenants' jobs) never share an identity;
 *   - in new network and PID namespaces (`unshare --net --pid --fork
 *     --kill-child`): no network, so a document's linked resources are
 *     never fetched and a parser exploit cannot reach the database, S3,
 *     Anthropic or Fly's private network; and every process the tool starts
 *     dies with it, on exit or timeout, so nothing outlives the call;
 *   - with resource limits (`prlimit`): no file over TOOL_MAX_FILE_BYTES
 *     (a runaway output fails instead of filling the disk) and at most
 *     TOOL_MAX_PROCESSES processes and threads.
 * - The job's work directory belongs to root and to the leased user's group
 *   (mode 0770) only while the call runs, then to root alone: other pool
 *   users, whatever job they run for, can never enter it, and the tool
 *   cannot rename or replace the directory itself (it does not own its entry
 *   in the sticky /tmp). Before the uid goes back to the pool, any process
 *   still running as it is killed.
 * - With UNTRUSTED_TOOLS_SANDBOX=required (set by Dockerfile.worker), a
 *   worker where that isolation is not available refuses to run the tools at
 *   all, so the scan or render fails closed with a clear message instead of
 *   running them with the worker's full authority.
 *
 * On a dev machine (Windows, or not root) only the minimal environment
 * applies; the tools usually are not installed there anyway.
 *
 * Outputs a tool wrote must be read back with readToolOutput (or
 * readToolOutputHead), which refuse symlinks, hard links, files a sandbox
 * user did not create and anything over the caller's size cap, so a
 * compromised tool cannot make the worker (root) read a file it may not, or
 * run it out of memory. Files the worker writes into a work directory a tool
 * has already run in go through writeWorkFile, which never follows a link a
 * tool left there.
 */

/** RLIMIT_FSIZE for every tool: the largest file it may write. */
const TOOL_MAX_FILE_BYTES = 1024 * 1024 * 1024;
/** RLIMIT_NPROC for every tool: processes and threads of its (leased, otherwise unused) uid. */
const TOOL_MAX_PROCESSES = 256;
/** How long to wait for a leased uid's leftover processes to die before quarantining the uid. */
const REAP_TIMEOUT_MS = 5_000;

type SandboxMode =
  /** Leased unprivileged users, no network, PID namespace, resource limits. */
  | { kind: "isolated"; uidBase: number; uidCount: number }
  /** Leased unprivileged users and resource limits, but the namespaces failed: network still reachable. */
  | { kind: "unprivileged"; uidBase: number; uidCount: number }
  /** Same user as the worker; minimal environment only. */
  | { kind: "none"; reason: string };

let sandboxModePromise: Promise<SandboxMode> | null = null;

function parseId(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return id > 0 ? id : null;
}

function setprivArgs(uid: number): string[] {
  // gid = uid: each pool user has a group of its own.
  return [`--reuid=${uid}`, `--regid=${uid}`, "--clear-groups", "--no-new-privs", "--"];
}

function prlimitArgs(): string[] {
  return ["prlimit", `--fsize=${TOOL_MAX_FILE_BYTES}`, `--nproc=${TOOL_MAX_PROCESSES}`, "--"];
}

const NAMESPACE_ARGS = ["unshare", "--net", "--pid", "--fork", "--kill-child", "--"];

async function probe(command: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(command, args, { timeout: 15_000, env: minimalEnv(process.cwd()) });
    return true;
  } catch {
    return false;
  }
}

async function detectSandboxMode(): Promise<SandboxMode> {
  if (process.platform !== "linux") return { kind: "none", reason: `not Linux (${process.platform})` };
  const uidBase = parseId(process.env.UNTRUSTED_TOOLS_UID);
  if (uidBase === null) return { kind: "none", reason: "UNTRUSTED_TOOLS_UID is not set" };
  const uidCount = parseId(process.env.UNTRUSTED_TOOLS_UID_COUNT) ?? 1;
  if (process.getuid?.() !== 0) {
    return { kind: "none", reason: "the worker is not running as root, so it cannot switch tools to another user" };
  }
  const [first, ...probeTail] = [...NAMESPACE_ARGS, ...prlimitArgs(), "setpriv", ...setprivArgs(uidBase), "true"];
  if (await probe(first, probeTail)) return { kind: "isolated", uidBase, uidCount };
  const [limits, ...limitTail] = [...prlimitArgs(), "setpriv", ...setprivArgs(uidBase), "true"];
  if (await probe(limits, limitTail)) return { kind: "unprivileged", uidBase, uidCount };
  return { kind: "none", reason: "prlimit and setpriv (util-linux) could not switch to the sandbox user" };
}

function sandboxMode(): Promise<SandboxMode> {
  sandboxModePromise ??= detectSandboxMode();
  return sandboxModePromise;
}

/** One line for the worker's startup log: how untrusted tools will run here. */
export async function describeUntrustedToolSandbox(): Promise<string> {
  const mode = await sandboxMode();
  const required = sandboxRequired() ? " (UNTRUSTED_TOOLS_SANDBOX=required)" : "";
  switch (mode.kind) {
    case "isolated": {
      const pool = mode.uidCount > 1 ? `${mode.uidCount} uids from ${mode.uidBase}, one per call` : `uid ${mode.uidBase}, one call at a time`;
      return `isolated: ${pool}, no network, own PID namespace, file and process limits, minimal environment${required}`;
    }
    case "unprivileged":
      return `PARTIAL: ${mode.uidCount} uid(s) from ${mode.uidBase} and a minimal environment, but NO network or PID isolation (unshare failed)${required}`;
    case "none":
      return `NONE: minimal environment only, same user as the worker (${mode.reason})${required}`;
  }
}

function sandboxRequired(): boolean {
  return process.env.UNTRUSTED_TOOLS_SANDBOX === "required";
}

/**
 * The environment a tool gets: no secrets. Windows needs a few system
 * variables for any program (or the python3 Store alias) to start at all.
 */
function minimalEnv(workDir: string): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: workDir,
    TMPDIR: workDir,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PYTHONDONTWRITEBYTECODE: "1",
  };
  if (process.platform === "win32") {
    for (const name of ["SystemRoot", "SYSTEMROOT", "windir", "PATHEXT", "COMSPEC", "LOCALAPPDATA", "TEMP", "TMP"]) {
      if (process.env[name]) env[name] = process.env[name];
    }
  }
  // ProcessEnv (with Next's typing) insists on NODE_ENV; tools get none on purpose.
  return env as NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// The uid pool
// ---------------------------------------------------------------------------

const freeUids: number[] = [];
const uidWaiters: ((uid: number) => void)[] = [];
let uidPoolReady = false;

function leaseUid(mode: { uidBase: number; uidCount: number }): Promise<number> {
  if (!uidPoolReady) {
    for (let i = 0; i < mode.uidCount; i++) freeUids.push(mode.uidBase + i);
    uidPoolReady = true;
  }
  const uid = freeUids.shift();
  if (uid !== undefined) return Promise.resolve(uid);
  return new Promise((resolve) => uidWaiters.push(resolve));
}

function returnUid(uid: number): void {
  const waiter = uidWaiters.shift();
  if (waiter) waiter(uid);
  else freeUids.push(uid);
}

function isPoolUid(mode: SandboxMode, uid: number): boolean {
  return mode.kind !== "none" && uid >= mode.uidBase && uid < mode.uidBase + mode.uidCount;
}

/** Pids of every process whose real, effective, saved or filesystem uid is `uid` (from /proc). */
async function processesOf(uid: number): Promise<number[]> {
  const pids: number[] = [];
  for (const entry of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let status: string;
    try {
      status = await fs.readFile(`/proc/${entry}/status`, "utf8");
    } catch {
      continue; // exited meanwhile
    }
    const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
    if (uids && uids.slice(1).some((id) => Number(id) === uid)) pids.push(Number(entry));
  }
  return pids;
}

/**
 * Kills whatever still runs as a leased uid. The PID namespace already ends
 * every process of a call when it exits; this also covers the "unprivileged"
 * mode and a namespace whose teardown has not finished. True when none is
 * left, so the uid can go to another call.
 */
async function reapUid(uid: number): Promise<boolean> {
  const deadline = Date.now() + REAP_TIMEOUT_MS;
  for (;;) {
    const pids = await processesOf(uid);
    if (pids.length === 0) return true;
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Sets the owner, group and mode of the work directory itself through a
 * descriptor opened without following links, so a path swapped for a
 * symlink is refused rather than followed.
 */
async function setWorkDirAccess(workDir: string, gid: number, mode: number): Promise<void> {
  const handle = await fs.open(workDir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    await handle.chown(0, gid);
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

/**
 * Gives the leased user everything inside the work directory (inputs the
 * worker wrote, outputs of earlier calls). Runs only while no sandboxed
 * process can touch the tree (the previous call's uid was reaped, this
 * call's tool has not started, the directory is root's), and lchown never
 * follows a link, so the walk cannot be steered outside the directory.
 */
async function chownContents(dir: string, uid: number): Promise<void> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    await fs.lchown(full, uid, uid);
    if (entry.isDirectory()) await chownContents(full, uid);
  }
}

export class UntrustedToolSandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UntrustedToolSandboxError";
  }
}

/**
 * execFile for a tool that reads untrusted bytes, in `workDir` (which must
 * hold its inputs and receive its outputs, and must have been created by
 * fs.mkdtemp). Resolves with stdout/stderr like a promisified execFile and
 * rejects with the same error shape (code, stdout, stderr, killed); a binary
 * missing inside the sandbox is reported with code "ENOENT", as it would be
 * without one.
 */
export async function execUntrusted(
  command: string,
  args: string[],
  options: { workDir: string; timeoutMs: number; maxBuffer?: number }
): Promise<{ stdout: string; stderr: string }> {
  const mode = await sandboxMode();
  if (sandboxRequired() && mode.kind !== "isolated") {
    throw new UntrustedToolSandboxError(
      `refused to run ${command}: this worker cannot isolate it (${await describeUntrustedToolSandbox()}), ` +
        "and UNTRUSTED_TOOLS_SANDBOX=required"
    );
  }

  const exec = (file: string, argv: string[]) =>
    execFileAsync(file, argv, {
      cwd: options.workDir,
      env: minimalEnv(options.workDir),
      timeout: options.timeoutMs,
      // unshare --kill-child takes the namespace down with it.
      killSignal: "SIGKILL",
      maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
      encoding: "utf8",
    });

  const run = async (): Promise<{ stdout: string; stderr: string }> => {
    if (mode.kind === "none") return exec(command, args);
    // Leased inside the slot wait below (LibreOffice and ClamAV), never
    // before it: every caller takes a slot first and a uid second, so the
    // two waits cannot deadlock each other.
    const uid = await leaseUid(mode);
    let reaped = false;
    try {
      await setWorkDirAccess(options.workDir, uid, 0o770);
      await chownContents(options.workDir, uid);
      const dropUser = [...prlimitArgs(), "setpriv", ...setprivArgs(uid), command, ...args];
      const [file, ...argv] = mode.kind === "isolated" ? [...NAMESPACE_ARGS, ...dropUser] : dropUser;
      try {
        return await exec(file, argv);
      } catch (err) {
        // setpriv exits 127 with "failed to execute <command>" when the binary
        // is not on PATH; report it the way execFile reports a missing binary.
        const e = err as Error & { code?: string | number; stderr?: string };
        if (e.code === 127 && /failed to execute/i.test(e.stderr ?? "")) e.code = "ENOENT";
        throw e;
      }
    } finally {
      reaped = await reapUid(uid);
      // Root's alone again: no pool user, this one included, can enter it.
      await setWorkDirAccess(options.workDir, 0, 0o700).catch((err) =>
        console.error(`[sandbox] could not lock ${path.basename(options.workDir)} after ${command}: ${String(err)}`)
      );
      if (reaped) {
        returnUid(uid);
      } else {
        // Never handed to another call while something still runs as it.
        console.error(`[sandbox] uid ${uid} still has processes after ${command}; it stays out of the pool until restart`);
      }
    }
  };

  // LibreOffice and clamscan are memory heavy: the command waits for one of
  // their few in-process slots (src/services/queue/concurrency.ts) before it
  // starts, so its timeout counts from the start, not from the wait.
  const slots = slotsForTool(command);
  return slots ? slots.run(run) : run();
}

/** Output caps for readToolOutput: what each kind of file a tool writes may reach. */
export const TOOL_OUTPUT_LIMITS = {
  /** A generated or filled document (docx or PDF), exhibits included. */
  document: 100 * 1024 * 1024,
  /** One rendered page image. */
  pageImage: 10 * 1024 * 1024,
  /** A script's JSON report or field list. */
  report: 10 * 1024 * 1024,
} as const;

/**
 * Opens a file a sandboxed tool wrote, refusing a symlink, a file with other
 * hard links, or (when tools run as sandbox users) a file no pool user owns:
 * otherwise a compromised tool could point its "output" at a file only the
 * worker may read, and the worker would store or send its contents.
 */
async function openToolOutput(filePath: string): Promise<{ handle: FileHandle; size: number }> {
  const mode = await sandboxMode();
  // O_NOFOLLOW is POSIX only; on Windows the lstat check below still applies.
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const [linkStat, stat] = await Promise.all([fs.lstat(filePath), handle.stat()]);
    if (
      linkStat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.nlink > 1 ||
      linkStat.ino !== stat.ino ||
      (mode.kind !== "none" && !isPoolUid(mode, stat.uid))
    ) {
      throw new Error(`refused to read ${path.basename(filePath)}: it is not a plain file written by the tool`);
    }
    return { handle, size: stat.size };
  } catch (err) {
    await handle.close();
    throw err;
  }
}

/**
 * Reads a file a sandboxed tool wrote (see openToolOutput), refusing one over
 * maxBytes instead of reading it into memory.
 */
export async function readToolOutput(filePath: string, options: { maxBytes: number }): Promise<Buffer>;
export async function readToolOutput(filePath: string, options: { maxBytes: number; encoding: "utf-8" }): Promise<string>;
export async function readToolOutput(
  filePath: string,
  options: { maxBytes: number; encoding?: "utf-8" }
): Promise<Buffer | string> {
  const { handle, size } = await openToolOutput(filePath);
  try {
    if (size > options.maxBytes) {
      throw new Error(
        `refused to read ${path.basename(filePath)}: the tool wrote ${size} bytes, over the ${options.maxBytes}-byte limit`
      );
    }
    const bytes = await handle.readFile();
    return options.encoding ? bytes.toString("utf-8") : bytes;
  } finally {
    await handle.close();
  }
}

/**
 * The first maxBytes of a file a sandboxed tool wrote (see openToolOutput),
 * however large it is, and its full size: for text extraction, which keeps a
 * prefix of a long output instead of refusing it.
 */
export async function readToolOutputHead(filePath: string, maxBytes: number): Promise<{ bytes: Buffer; totalBytes: number }> {
  const { handle, size } = await openToolOutput(filePath);
  try {
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return { bytes: buffer.subarray(0, filled), totalBytes: size };
  } finally {
    await handle.close();
  }
}

/**
 * Writes a file into a work directory a sandboxed tool may already have run
 * in. Whatever the tool left at that name (a symlink to a file elsewhere, a
 * hard link) is removed first, and the new file is created exclusively
 * (O_EXCL never follows a link), so the worker, running as root, only ever
 * writes the file it means to.
 */
export async function writeWorkFile(workDir: string, name: string, data: string | Buffer): Promise<string> {
  if (name !== path.basename(name) || name === "." || name === "..") {
    throw new Error(`writeWorkFile takes a plain file name, not ${name}`);
  }
  const filePath = path.join(workDir, name);
  await fs.rm(filePath, { force: true });
  await fs.writeFile(filePath, data, { flag: "wx" });
  return filePath;
}

/**
 * Creates a fresh directory inside a work directory a tool may already have
 * run in, the same way: a name nothing in the directory has, created
 * exclusively. Returns its path.
 */
export async function makeWorkSubdir(workDir: string, prefix: string): Promise<string> {
  const dir = path.join(workDir, `${prefix}-${crypto.randomUUID()}`);
  await fs.mkdir(dir);
  return dir;
}
