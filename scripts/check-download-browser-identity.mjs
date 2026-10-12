// A single strict native identity preflight. It never creates an application page,
// captures an image or substitutes for the full six-pair download qualification.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DownloadBrowserSessions } from "./lib/download-browser-sessions.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SOURCE_FILES = ["scripts/check-download-browser-identity.mjs", "scripts/lib/download-browser-sessions.mjs",
  "scripts/lib/cdp.mjs", "scripts/lib/download-profile-cleanup.mjs", "scripts/lib/download-receipts.mjs", "scripts/lib/download-capture-diagnostics.mjs"];

function sourceEvidence() {
  try {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("source_revision_unavailable");
    const dirty = !!execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return { status: "recorded", revision, dirty, files: Object.fromEntries(SOURCE_FILES.map((path) => [path,
      createHash("sha256").update(readFileSync(join(ROOT, path))).digest("hex")])) };
  } catch { return { status: "unavailable", code: "source_evidence_unavailable" }; }
}

export async function runBrowserIdentityPreflight(directory, dependencies) {
  mkdirSync(directory, { recursive: true });
  const startedAt = new Date().toISOString(), faults = [];
  const sessions = new DownloadBrowserSessions(directory, [{ viewport: { name: "preflight" }, trial: 1 }], dependencies);
  try { await sessions.open("cold-preflight-1"); }
  catch { faults.push("identity_preflight_setup_failed"); }
  finally {
    try { await sessions.closeAll(); }
    catch { faults.push("identity_preflight_cleanup_failed"); }
  }
  const browserSessions = sessions.snapshot(), source = sourceEvidence();
  const receipts = browserSessions.downloadReceipts;
  const noDownloadActivity = ["actions", "producers", "downloads", "events"].every((key) => receipts[key].length === 0);
  if (!noDownloadActivity) faults.push("identity_preflight_unexpected_download_activity");
  if (source.status !== "recorded") faults.push("source_evidence_unavailable");
  const result = { schema: "ticketstub.browser-identity-preflight.v1", mode: "native_identity_only_no_application_navigation",
    scope: "one_new_process_and_profile_not_the_full_capture_matrix", startedAt, finishedAt: new Date().toISOString(),
    node: process.version, source, passed: browserSessions.passed && !faults.length, faults, browserSessions };
  writeFileSync(join(directory, "browser-identity-preflight.json"), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--evidence-dir") throw new Error("invalid_arguments");
    const result = await runBrowserIdentityPreflight(resolve(process.argv[3]));
    console.log(`${result.passed ? "PASS" : "FAIL"} download browser identity preflight (one session, no application navigation)`);
    process.exitCode = result.passed ? 0 : 1;
  } catch {
    console.error("FAIL download browser identity preflight (arguments or evidence unavailable)");
    process.exitCode = 1;
  }
}
