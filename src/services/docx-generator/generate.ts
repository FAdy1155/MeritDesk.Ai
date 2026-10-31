import "server-only";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  execUntrusted,
  makeWorkSubdir,
  readToolOutput,
  TOOL_OUTPUT_LIMITS,
  writeWorkFile,
} from "@/services/sandbox/untrusted-exec";

/**
 * Runs on the worker image (Node + Python3 + LibreOffice + poppler-utils —
 * see README.md "Deployment (Fly.io)"), not on this Windows dev machine or
 * the Next.js app image. If python3/soffice/pdftoppm aren't on PATH, these
 * functions fail with a clear ENOENT-derived message rather than hanging.
 *
 * Every tool here reads bytes that came from outside the app (a Word file a
 * user uploaded, or a spec the model wrote from case documents), so each
 * one runs through execUntrusted: no secrets in its environment, and on the
 * worker image as an unprivileged user with no network access (see
 * src/services/sandbox/untrusted-exec.ts). Their output files are read back
 * with readToolOutput.
 */

export type DocxGenerationResult = {
  workDir: string;
  docxPath: string;
  pdfPath: string;
  pageImagePaths: string[];
};

/**
 * The app's own generator scripts: the generic builder below, and adapted
 * copies of firm scripts that had to change for multi-tenancy (e.g.
 * i130-expedite/make_expedite_letter.py, whose letterhead and signer come
 * from the spec). Resolved from the working directory, like skills-content/:
 * the worker runs from the repo root (/app in Dockerfile.worker, which copies src/).
 */
export const DOCX_TEMPLATES_DIR = path.join(process.cwd(), "src", "services", "docx-generator", "templates");

/**
 * The generic, firm-neutral builder behind the generate_document tool (see
 * templates/make_document.py and src/services/skill-runner/document-spec.ts).
 */
export const GENERIC_DOCUMENT_SCRIPT = path.join(DOCX_TEMPLATES_DIR, "make_document.py");

/**
 * A file the generator reads next to its spec.json (a signature image). The
 * name must be a plain file name; the spec refers to it by that name.
 */
export type GeneratorInputFile = { name: string; bytes: Buffer };

const INPUT_FILE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/;

/**
 * Runs a Python generator script (a skill's bundled script under
 * skills-content/, or one of the app's templates under DOCX_TEMPLATES_DIR)
 * against a JSON spec, in a fresh temp directory, with any inputFiles
 * written next to spec.json. The script itself enforces the ASCII gate and
 * required-field checks; we don't duplicate that validation here, we just
 * surface its stderr on failure.
 */
export async function runPythonDocxGenerator(params: {
  scriptPath: string;
  spec: Record<string, unknown>;
  outputFileName: string;
  inputFiles?: GeneratorInputFile[];
}): Promise<{ workDir: string; docxPath: string }> {
  for (const file of params.inputFiles ?? []) {
    if (!INPUT_FILE_NAME.test(file.name) || file.name === "spec.json" || file.name === params.outputFileName) {
      throw new Error(`Generator input file name not allowed: ${file.name}`);
    }
  }
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "docxgen-"));
  const specPath = path.join(workDir, "spec.json");
  const docxPath = path.join(workDir, params.outputFileName);

  try {
    await fs.writeFile(specPath, JSON.stringify(params.spec, null, 2), "utf-8");
    for (const file of params.inputFiles ?? []) {
      await fs.writeFile(path.join(workDir, file.name), file.bytes);
    }
    await execUntrusted("python3", [params.scriptPath, specPath, docxPath], { workDir, timeoutMs: 60_000 });
  } catch (err) {
    await cleanupWorkDir(workDir);
    throw new Error(`Python docx generator failed: ${describeExecError(err)}`);
  }
  // The work directory lives on for the run (render_and_qa_docx reads its
  // page images); input files such as a signature image are not kept there.
  for (const file of params.inputFiles ?? []) {
    await fs.rm(path.join(workDir, file.name), { force: true });
  }

  return { workDir, docxPath };
}

// Written into each job's fresh LibreOffice profile before it loads a
// document (user/registrymodifications.xcu). Defense in depth behind the
// sandbox's missing network: never update or fetch linked content when a
// document loads (Writer "Update links when loading": 0 is Never), block
// linked resources from untrusted referers, and never run macros.
const LIBREOFFICE_HARDENED_REGISTRY = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
</oor:items>
`;

/**
 * Converts a docx to PDF via headless LibreOffice. Uses a per-job
 * UserInstallation profile directory — concurrent jobs sharing the default
 * profile collide on lock files and can silently corrupt or hang the
 * conversion (a well-known LibreOffice headless gotcha) — seeded with the
 * hardened settings above. The profile is a new directory with a name
 * nothing in workDir has: the generator that ran there first was sandboxed,
 * and the worker (root) never writes through anything it may have left.
 */
export async function convertDocxToPdf(workDir: string, docxPath: string): Promise<string> {
  const profileDir = await makeWorkSubdir(workDir, "lo-profile");
  await fs.mkdir(path.join(profileDir, "user"));
  await writeWorkFile(path.join(profileDir, "user"), "registrymodifications.xcu", LIBREOFFICE_HARDENED_REGISTRY);
  const profileUrl = pathToFileURL(profileDir).toString();

  try {
    await execUntrusted(
      "soffice",
      [
        "--headless",
        "--norestore",
        `-env:UserInstallation=${profileUrl}`,
        "--convert-to",
        "pdf",
        "--outdir",
        workDir,
        docxPath,
      ],
      // A long brief, on a cold LibreOffice profile, can take most of a minute.
      { workDir, timeoutMs: 180_000 }
    );
  } catch (err) {
    throw new Error(`LibreOffice conversion failed: ${describeExecError(err)}`);
  }

  const pdfPath = path.join(workDir, `${path.basename(docxPath, path.extname(docxPath))}.pdf`);
  await fs.access(pdfPath).catch(() => {
    throw new Error(`LibreOffice did not produce the expected output at ${pdfPath}`);
  });
  return pdfPath;
}

/**
 * Rasterizes each PDF page to a JPEG for the model's visual self-QA step.
 * 100 dpi at JPEG quality 75: legible for layout checks, and small, since
 * every page image shown to the model is resent with every later request
 * of the run (the API takes at most 32 MB per request).
 */
export async function rasterizePdfPages(workDir: string, pdfPath: string): Promise<string[]> {
  const prefix = path.join(workDir, "page");
  try {
    await execUntrusted("pdftoppm", ["-jpeg", "-jpegopt", "quality=75", "-r", "100", pdfPath, prefix], {
      workDir,
      timeoutMs: 120_000,
    });
  } catch (err) {
    throw new Error(`pdftoppm rasterization failed: ${describeExecError(err)}`);
  }

  const files = await fs.readdir(workDir);
  return files
    .filter((f) => f.startsWith("page") && f.endsWith(".jpg"))
    .sort()
    .map((f) => path.join(workDir, f));
}

/** A page image or document a tool wrote, read safely and within its size cap (see readToolOutput). */
export async function readGeneratedFile(filePath: string, kind: "document" | "pageImage"): Promise<Buffer> {
  return readToolOutput(filePath, { maxBytes: TOOL_OUTPUT_LIMITS[kind] });
}

export async function cleanupWorkDir(workDir: string): Promise<void> {
  await fs.rm(workDir, { recursive: true, force: true });
}

function describeExecError(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
    return "required binary not found on PATH (python3/soffice/pdftoppm must be installed on the worker image)";
  }
  if (err instanceof Error) {
    const withOutput = err as Error & { stderr?: string; stdout?: string };
    const output = withOutput.stderr?.trim() || withOutput.stdout?.trim() || err.message;
    // Windows ships a "python3" that only opens the Microsoft Store.
    if (/Python was not found/i.test(output)) {
      return "python3 is not installed on this machine (only the Windows Store alias is); document generation runs on the worker image";
    }
    return output;
  }
  return String(err);
}

/** Convenience: run the full generate -> convert -> rasterize pipeline. */
export async function generateDocxWithPreview(params: {
  scriptPath: string;
  spec: Record<string, unknown>;
  outputFileName: string;
  inputFiles?: GeneratorInputFile[];
}): Promise<DocxGenerationResult> {
  const { workDir, docxPath } = await runPythonDocxGenerator(params);
  try {
    const pdfPath = await convertDocxToPdf(workDir, docxPath);
    const pageImagePaths = await rasterizePdfPages(workDir, pdfPath);
    return { workDir, docxPath, pdfPath, pageImagePaths };
  } catch (err) {
    // Nothing was stored yet, so a failed preview leaves nothing behind.
    await cleanupWorkDir(workDir);
    throw err;
  }
}

/**
 * Renders an existing .docx (e.g. one stored on the matter by an earlier
 * run) to page images, without generating anything: writes the bytes to a
 * fresh temp directory, converts to PDF, rasterizes. The caller cleans up
 * workDir with cleanupWorkDir.
 */
export async function renderDocxToImages(params: {
  docxBytes: Buffer;
  fileName: string;
}): Promise<{ workDir: string; pageImagePaths: string[] }> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "docxrender-"));
  try {
    // The stored name is for display; the temp copy gets a fixed, safe one.
    const docxPath = path.join(workDir, "document.docx");
    await fs.writeFile(docxPath, params.docxBytes);
    const pdfPath = await convertDocxToPdf(workDir, docxPath);
    const pageImagePaths = await rasterizePdfPages(workDir, pdfPath);
    return { workDir, pageImagePaths };
  } catch (err) {
    await cleanupWorkDir(workDir);
    throw new Error(`Could not render ${params.fileName}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function uniqueTempName(base: string, ext: string): string {
  return `${base}-${crypto.randomUUID()}${ext}`;
}
