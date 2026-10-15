#!/usr/bin/env node
// Copies the agent-harness TicketStub hand-off modules, byte for byte, from one pinned harness commit into
// src/server/vendor/agent-harness, and writes MANIFEST.json with each file's SHA-256. The harness repo owns this
// code; it is vendored instead of installed as a package so the app does not pull the harness's Neatlogs SDK
// dependency tree (which this path never loads). tests/harness-handoff.test.mjs fails if a file drifts.
//
//   node scripts/vendor-agent-harness.mjs <40-hex agent-harness commit>
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "Jevelopers-neatHack-2026/agent-harness";
export const VENDORED_FILES = [
  "src/integrations/ticketstub/index.js",
  "src/integrations/ticketstub/index.d.ts",
  "src/observability/private/neatlogs-config.js",
  "src/observability/private/neatlogs-live.js",
  "src/observability/private/neatlogs-otlp.js",
  "src/observability/private/neatlogs-delivery-queue.js",
  "src/observability/private/neatlogs-sdk-mapper.js",
  "src/decisions/index.js",
  "src/decisions/index.d.ts",
  "src/development/index.js",
  "src/development/index.d.ts",
  "src/adapters/jev/http-transport.js",
  "src/adapters/jev/address-policy.js",
  "src/adapters/jev/request-validation.js",
  "src/adapters/jev/response-validation.js",
  "src/adapters/jev/safe-json.js",
];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEST = join(ROOT, "src", "server", "vendor", "agent-harness");

async function main() {
  const commit = process.argv[2] ?? "";
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    console.error("usage: node scripts/vendor-agent-harness.mjs <40-hex agent-harness commit>");
    process.exit(2);
  }
  const response = await fetch(`https://codeload.github.com/${REPO}/tar.gz/${commit}`, { redirect: "error" });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  const work = mkdtempSync(join(tmpdir(), "vendor-agent-harness-"));
  try {
    const archive = join(work, "source.tar.gz");
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    const prefix = `agent-harness-${commit}`;
    execFileSync("tar", ["-xzf", archive, "-C", work, ...VENDORED_FILES.map((file) => `${prefix}/${file}`)]);
    rmSync(DEST, { recursive: true, force: true });
    const files = {};
    for (const file of VENDORED_FILES) {
      const bytes = readFileSync(join(work, prefix, file));
      mkdirSync(dirname(join(DEST, file)), { recursive: true });
      writeFileSync(join(DEST, file), bytes);
      files[file] = createHash("sha256").update(bytes).digest("hex");
    }
    const manifest = { repository: `https://github.com/${REPO}`, commit, files };
    writeFileSync(join(DEST, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`vendored ${VENDORED_FILES.length} files from ${REPO}@${commit.slice(0, 7)}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
