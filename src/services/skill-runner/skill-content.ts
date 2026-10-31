import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// Reads a skill's content from skills-content/<name>/. Server-side only in
// practice (node:fs), but deliberately NOT marked "server-only": the seed
// script (src/db/seed-skills.ts) runs under plain tsx/Node, where importing
// "server-only" throws. Never import this from client code.

export const SKILLS_CONTENT_DIR = path.join(process.cwd(), "skills-content");

export type ReferenceFile = { path: string; content: string };

// Git's autocrlf turns these files into CRLF on Windows checkouts and LF
// everywhere else; normalize so the prompt and the content hash are the
// same no matter which machine reads them.
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export async function readSkillMarkdown(skillName: string): Promise<string> {
  const filePath = path.join(SKILLS_CONTENT_DIR, skillName, "SKILL.md");
  try {
    return normalizeLineEndings(await fs.readFile(filePath, "utf-8"));
  } catch (err) {
    throw new Error(
      `Cannot read ${filePath}: ${err instanceof Error ? err.message : String(err)}. ` +
        `A registered skill's name must match its skills-content/<name>/ directory.`
    );
  }
}

/**
 * Every references/*.md file bundled with the skill, sorted by file name so
 * the prompt order and the content hash are deterministic. Other files under
 * references/ (and anything in assets/ or scripts/) are not inlined.
 */
export async function loadBundledReferences(skillName: string): Promise<ReferenceFile[]> {
  const refsDir = path.join(SKILLS_CONTENT_DIR, skillName, "references");
  let files: string[];
  try {
    files = await fs.readdir(refsDir);
  } catch {
    return []; // this skill has no bundled references directory
  }
  const mdFiles = files.filter((f) => f.endsWith(".md")).sort();
  return Promise.all(
    mdFiles.map(async (f) => ({
      path: `references/${f}`,
      content: normalizeLineEndings(await fs.readFile(path.join(refsDir, f), "utf-8")),
    }))
  );
}

/** sha256 over SKILL.md plus every bundled reference, each prefixed with its path. */
export function computeSkillContentHash(skillMarkdown: string, referenceFiles: ReferenceFile[]): string {
  const hash = crypto.createHash("sha256");
  hash.update("SKILL.md\n");
  hash.update(skillMarkdown);
  // Plain code-unit order (not localeCompare), so the hash can't vary with the machine's locale.
  for (const ref of [...referenceFiles].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`\n\u0000${ref.path}\n`);
    hash.update(ref.content);
  }
  return hash.digest("hex");
}

export async function readSkillContent(skillName: string) {
  const [skillMarkdown, referenceFiles] = await Promise.all([
    readSkillMarkdown(skillName),
    loadBundledReferences(skillName),
  ]);
  return { skillMarkdown, referenceFiles, contentHash: computeSkillContentHash(skillMarkdown, referenceFiles) };
}
