#!/usr/bin/env node
// Refresh an owned runtime from one immutable source revision. No local .env or
// untracked files are copied. Existing assembly-evidence tooling verifies these
// manifests alongside the harness manifest.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [component, source, commit] = process.argv.slice(2);
if (!["creative-engine", "cost-intelligence"].includes(component) || !source || !/^[a-f0-9]{40}$/.test(commit ?? "")) {
  throw new Error("usage: node scripts/vendor-creative-runtime.mjs <creative-engine|cost-intelligence> <source checkout> <40-hex commit>");
}
const cleanEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
const command = (name, args, cwd) => execFileSync(name, args, { cwd, env: cleanEnv, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 << 20 });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const work = mkdtempSync(join(tmpdir(), `ticketstub-vendor-${component}-`));
const destination = join(root, "src/server/vendor", component);
const files = {};
const copy = (relative, bytes) => {
  mkdirSync(dirname(join(destination, relative)), { recursive: true });
  writeFileSync(join(destination, relative), bytes);
  files[relative] = hash(bytes);
};
try {
  const archive = join(work, "source.tar");
  writeFileSync(archive, command("git", ["--no-replace-objects", "archive", commit], resolve(source)));
  command("tar", ["-xf", archive, "-C", work], root);
  // Never erase an existing target until the complete new input has been built.
  let runtimeArchive;
  if (component === "cost-intelligence") {
    command("npm", ["ci", "--ignore-scripts"], work);
    command("npm", ["run", "build", "--silent"], work);
    const packed = JSON.parse(command("npm", ["pack", "--ignore-scripts", "--json"], work));
    runtimeArchive = readFileSync(join(work, packed[0].filename));
  } else {
    const packed = JSON.parse(command("npm", ["pack", "--ignore-scripts", "--json"], work));
    runtimeArchive = readFileSync(join(work, packed[0].filename));
  }
  rmSync(destination, { recursive: true, force: true });
  if (component === "creative-engine") {
    const paths = command("git", ["--no-replace-objects", "ls-tree", "-r", "--name-only", commit, "src", "package.json"], resolve(source)).toString("utf8").trim().split("\n");
    for (const path of paths) copy(path, readFileSync(join(work, path)));
    copy("runtime.tgz", runtimeArchive);
  } else {
    copy("runtime.tgz", runtimeArchive);
    for (const name of readdirSync(join(work, "migrations")).filter((file) => file.endsWith(".sql")).sort()) {
      copy(`migrations/${name}`, readFileSync(join(work, "migrations", name)));
    }
    copy("SOURCE_LOCK.json", Buffer.from(`${JSON.stringify({ sourcePackageLockSha256: hash(readFileSync(join(work, "package-lock.json"))), node: process.versions.node, npm: command("npm", ["--version"], work).toString("utf8").trim() }, null, 2)}\n`));
  }
  writeFileSync(join(destination, "MANIFEST.json"), `${JSON.stringify({ repository: `https://github.com/Jevelopers-neatHack-2026/${component}`, commit, files }, null, 2)}\n`);
  console.log(`vendored ${component}@${commit.slice(0, 7)} (${Object.keys(files).length} files)`);
} finally { rmSync(work, { recursive: true, force: true }); }
