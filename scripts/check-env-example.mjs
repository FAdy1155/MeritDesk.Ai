#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const examplePath = path.join(root, ".env.example");
const sourceRoots = ["src", "scripts"];
const sourceFiles = [
  "next.config.ts",
  "drizzle.config.ts",
  "eslint.config.mjs",
  "postcss.config.mjs",
];

const platformProvided = new Set([
  "CI",
  "HOME",
  "HOSTNAME",
  "NODE_ENV",
  "NODE_OPTIONS",
  "PATH",
  "PORT",
  "PWD",
  "TMPDIR",
  "TZ",
  "USER",
]);

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if ([".git", ".next", "node_modules", "dist", "coverage"].includes(entry.name)) return [];
      return walk(full);
    }
    return /\.(?:[cm]?js|tsx?)$/.test(entry.name) ? [full] : [];
  });
}

if (!fs.existsSync(examplePath)) {
  console.error("Missing .env.example");
  process.exit(1);
}

const documented = new Set();
for (const line of fs.readFileSync(examplePath, "utf8").split(/\r?\n/)) {
  const match = /^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
  if (match) documented.add(match[1]);
}

const files = [
  ...sourceRoots.flatMap((dir) => walk(path.join(root, dir))),
  ...sourceFiles.map((file) => path.join(root, file)).filter((file) => fs.existsSync(file)),
];
const references = new Map();
const patterns = [
  /\bprocess\s*\.\s*env\s*\?*\.\s*([A-Z][A-Z0-9_]*)/g,
  /\bprocess\s*\.\s*env\s*\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g,
];

for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const name = match[1];
      if (platformProvided.has(name)) continue;
      const relative = path.relative(root, file).replaceAll(path.sep, "/");
      const entries = references.get(name) ?? new Set();
      entries.add(relative);
      references.set(name, entries);
    }
  }
}

const missing = [...references.entries()]
  .filter(([name]) => !documented.has(name))
  .sort(([a], [b]) => a.localeCompare(b));

if (missing.length) {
  console.error("Environment variables referenced in source but absent from .env.example:");
  for (const [name, locations] of missing) {
    console.error(`  ${name}: ${[...locations].join(", ")}`);
  }
  console.error("\nDocument each variable (including optional variables) or add a narrowly justified platform-variable exception.");
  process.exit(1);
}

console.log(`Environment contract OK: ${references.size} referenced variables are documented in .env.example (${files.length} source files scanned).`);
console.log("Note: computed process.env[key] access is not statically discoverable and requires manual review.");
