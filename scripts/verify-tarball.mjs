#!/usr/bin/env node
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const allowedBare = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
]);
const entries = [
  ...Object.values(manifest.exports ?? {}).map(entry => typeof entry === "string" ? entry : entry?.default),
  ...(manifest.pi?.extensions ?? []),
].filter(Boolean).map(entry => entry.replace(/^\.\//, ""));

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const work = mkdtempSync(join(tmpdir(), "usage-bars-pack-"));
const failures = [];
try {
  const tarball = execSync(`npm pack --pack-destination "${work}" --silent`, {
    cwd: ROOT,
    encoding: "utf8",
  }).trim().split("\n").pop().trim();
  execFileSync("tar", ["-xzf", tarball], { cwd: work, encoding: "utf8" });

  const packageRoot = join(work, "package");
  const seen = new Set();
  const pending = [...entries];
  if (pending.length === 0) failures.push("no entry points found in exports or pi.extensions");

  while (pending.length > 0) {
    const relativePath = pending.pop();
    if (seen.has(relativePath)) continue;
    seen.add(relativePath);

    const absolutePath = join(packageRoot, relativePath);
    if (!existsSync(absolutePath)) {
      failures.push(`${relativePath} is imported but missing from the tarball`);
      continue;
    }

    const source = stripComments(readFileSync(absolutePath, "utf8"));
    const imports = /\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']/g;
    let match;
    while ((match = imports.exec(source)) !== null) {
      const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
      if (!specifier.startsWith(".")) {
        const dependency = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0];
        if (!specifier.startsWith("node:") && !allowedBare.has(dependency)) {
          failures.push(`${relativePath} imports undeclared dependency "${specifier}"`);
        }
        continue;
      }
      let importedPath = posix.normalize(posix.join(posix.dirname(relativePath), specifier)).replace(/\.js$/, ".ts");
      if (!importedPath.endsWith(".ts")) importedPath += ".ts";
      pending.push(importedPath);
    }
  }

  if (failures.length > 0) {
    console.error("tarball verification failed:");
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log(`packed ${tarball}`);
  console.log(`reachable modules verified: ${seen.size}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
