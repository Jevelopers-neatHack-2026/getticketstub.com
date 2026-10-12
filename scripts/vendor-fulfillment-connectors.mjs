#!/usr/bin/env node
// Vendors the Prodigi callback reconciler and sandbox adapter from one pinned fulfillment-connectors commit into
// src/server/vendor/fulfillment-connectors, and writes MANIFEST.json with each file's SHA-256.
//
// fulfillment-connectors is a private package with no published build, so (like agent-harness) it is vendored, not
// installed. Unlike agent-harness it is TypeScript compiled for ES2022 (private fields, BigInt literals), which this
// app's tsconfig (target ES2017) cannot type-check as source. So the script builds the pinned commit with that
// repo's own locked toolchain (`npm ci`, `tsc -p tsconfig.json`) and copies the compiled dist files: the runtime
// JavaScript closure of prodigi-callbacks.js, and the declaration files its types reference. The output of a
// locked tsc is deterministic, so re-running this for the same commit reproduces MANIFEST.json exactly.
// tests/prodigi-callbacks.test.mjs fails if a vendored file drifts from the manifest.
//
//   node scripts/vendor-fulfillment-connectors.mjs <40-hex fulfillment-connectors commit>
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "Jevelopers-neatHack-2026/fulfillment-connectors";
/** Runtime closure of prodigi-callbacks.js (what Node and Next load). */
const RUNTIME = ["prodigi-callbacks", "prodigi-sandbox", "prodigi-secrets", "provider-matrix", "security"];
/** Declarations only: types the runtime modules' .d.ts files import. */
const TYPES_ONLY = ["types", "quotes", "catalog", "contracts"];
export const VENDORED_FILES = [
  ...RUNTIME.flatMap((name) => [`dist/${name}.js`, `dist/${name}.d.ts`]),
  ...TYPES_ONLY.map((name) => `dist/${name}.d.ts`),
];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEST = join(ROOT, "src", "server", "vendor", "fulfillment-connectors");

async function main() {
  const commit = process.argv[2] ?? "";
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    console.error("usage: node scripts/vendor-fulfillment-connectors.mjs <40-hex fulfillment-connectors commit>");
    process.exit(2);
  }
  const work = mkdtempSync(join(tmpdir(), "vendor-fulfillment-connectors-"));
  try {
    // A private repository: fetch the pinned tarball through the GitHub CLI's credentials.
    const archive = join(work, "source.tar.gz");
    writeFileSync(archive, execFileSync("gh", ["api", `repos/${REPO}/tarball/${commit}`], { maxBuffer: 256 * 1024 * 1024 }));
    const src = join(work, "src");
    mkdirSync(src);
    execFileSync("tar", ["-xzf", archive, "-C", src, "--strip-components=1"]);
    execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--engine-strict=false"], { cwd: src, stdio: "inherit" });
    execFileSync("npx", ["--no-install", "tsc", "-p", "tsconfig.json"], { cwd: src, stdio: "inherit" });
    const tsc = JSON.parse(readFileSync(join(src, "node_modules", "typescript", "package.json"), "utf8")).version;
    rmSync(DEST, { recursive: true, force: true });
    const files = {};
    for (const file of VENDORED_FILES) {
      const bytes = readFileSync(join(src, file));
      mkdirSync(dirname(join(DEST, file)), { recursive: true });
      writeFileSync(join(DEST, file), bytes);
      files[file] = createHash("sha256").update(bytes).digest("hex");
    }
    const manifest = { repository: `https://github.com/${REPO}`, commit, build: `tsc ${tsc} -p tsconfig.json`, files };
    writeFileSync(join(DEST, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`vendored ${VENDORED_FILES.length} files from ${REPO}@${commit.slice(0, 7)} (tsc ${tsc})`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
