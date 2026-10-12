// Cold qualification owns a new launcher process/profile per additional pair. The baseline
// retains its existing shared session. No image capture, export, readiness wait or retry lives here.
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { launchBrowser } from "./cdp.mjs";
import { browserProvenance } from "./download-capture-diagnostics.mjs";
import { DownloadReceipts } from "./download-receipts.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const LAUNCHER_SHA256 = digest(readFileSync(new URL("./cdp.mjs", import.meta.url)));
const MAX_COMMAND_CHARS = 16_384;
const CLOCK_RESOLUTION_MS = 1000; // filesystem birth-time precision, not a browser delay

async function bounded(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("identity_timeout")), ms); })]); }
  finally { clearTimeout(timer); }
}

export const browserSessionIdForPair = ({ viewport, trial }) => trial === 0 ? "baseline" : `cold-${viewport.name}-${trial}`;

/** Only the throwaway profile argument is extracted. Raw command lines/model/GPU data never leave this function. */
export function profileArgument(commandLine) {
  if (typeof commandLine !== "string" || !commandLine.length || commandLine.length > MAX_COMMAND_CHARS) return null;
  const pattern = /(?:^|\s)(?:"--user-data-dir=([^"\r\n]+)"|'--user-data-dir=([^'\r\n]+)'|--user-data-dir=(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+)))(?=\s|$)/g;
  const matches = [...commandLine.matchAll(pattern)];
  // A malformed second spelling must not be hidden by the successful first match.
  if (matches.length !== 1 || (commandLine.match(/--user-data-dir\b/g) ?? []).length !== 1) return null;
  const path = matches[0].slice(1).find((value) => value !== undefined);
  return path && path.length <= 1024 && isAbsolute(path) ? path : null;
}

/** Experimental SystemInfo is evidence of the actual process/profile, never a compositor readiness condition. */
export async function observeBrowserIdentity(browser, launchStartedAt, { timeoutMs = 2000, now = Date.now } = {}) {
  const unavailable = (code) => ({ evidence: { status: "unavailable", code }, profilePath: null });
  const calls = ["SystemInfo.getInfo", "SystemInfo.getProcessInfo", "Target.getTargets"];
  const results = await Promise.allSettled(calls.map((method) => bounded(Promise.resolve().then(() => browser.conn.send(method)), timeoutMs)));
  if (results.some((result) => result.status !== "fulfilled")) return unavailable("identity_protocol_unavailable");
  const [info, processInfo, targets] = results.map((result) => result.value);
  const profilePath = profileArgument(info?.commandLine);
  if (!profilePath) return unavailable("identity_profile_argument_unavailable");
  if (!Array.isArray(processInfo?.processInfo) || processInfo.processInfo.length > 128) return unavailable("identity_process_unavailable");
  const browsers = processInfo.processInfo.filter((process) => process?.type === "browser");
  if (browsers.length !== 1 || !Number.isSafeInteger(browsers[0].id) || browsers[0].id <= 0) return unavailable("identity_process_unavailable");
  if (!Array.isArray(targets?.targetInfos) || targets.targetInfos.length > 32
    || targets.targetInfos.some((target) => !["page", "tab", "browser"].includes(target?.type) || !["", "about:blank"].includes(target?.url))) {
    return unavailable("identity_initial_targets_not_blank");
  }
  try {
    if (!/^ticketstub-chrome-[a-zA-Z0-9_-]{6}$/.test(basename(profilePath)) || realpathSync(dirname(profilePath)) !== realpathSync(tmpdir())) {
      return unavailable("identity_profile_not_task_owned");
    }
    const stat = lstatSync(profilePath), observedAt = now();
    if (!stat.isDirectory() || stat.isSymbolicLink() || !Number.isFinite(stat.birthtimeMs) || stat.birthtimeMs <= 0
      || !Number.isFinite(launchStartedAt) || stat.birthtimeMs < launchStartedAt - CLOCK_RESOLUTION_MS
      || stat.birthtimeMs > observedAt + CLOCK_RESOLUTION_MS) return unavailable("identity_profile_creation_unconfirmed");
    return { profilePath, evidence: { status: "established", method: "SystemInfo.getInfo/getProcessInfo+Target.getTargets+filesystem",
      browserPid: browsers[0].id, initialTargetCount: targets.targetInfos.length, initialTargetsBlank: true,
      observedBeforeApplicationNavigation: true, launchStartedAt, observedAt,
      profile: { pathSha256: digest(realpathSync(profilePath)), device: stat.dev, inode: stat.ino,
        birthtimeMs: stat.birthtimeMs, creationClockResolutionMs: CLOCK_RESOLUTION_MS, taskOwnedTemporaryDirectory: true },
      launcher: { path: "scripts/lib/cdp.mjs", sha256: LAUNCHER_SHA256, contract: "one_mkdtemp_and_spawn_per_launchBrowser_call" } } };
  } catch { return unavailable("identity_profile_stat_unavailable"); }
}

function profileRemoval(profilePath) {
  if (!profilePath) return "unavailable";
  try { lstatSync(profilePath); return "still_present"; }
  catch (error) { return error?.code === "ENOENT" ? "confirmed_absent" : "unavailable"; }
}

/** Preserve each collector through its browser shutdown, then aggregate without dropping duplicate/late events. */
export class DownloadBrowserSessions {
  constructor(directory, plan, { launch = launchBrowser, makeReceipts = (browser, path) => new DownloadReceipts(browser, path),
    identify = observeBrowserIdentity, version = (browser) => browserProvenance(browser.conn), removed = profileRemoval,
    collectorSetupTimeoutMs = 2000 } = {}) {
    this.directory = directory;
    this.expected = [...new Set(plan.map(browserSessionIdForPair))];
    this.dependencies = { launch, makeReceipts, identify, version, removed, collectorSetupTimeoutMs };
    this.entries = new Map();
    this.profiles = new Set();
    this.processes = new Set();
    this.violations = [];
  }

  fault(sessionId, code) {
    const safe = /^[a-z_]{1,64}$/.test(code) ? code : "session_failure";
    const entry = this.entries.get(sessionId);
    if (entry) entry.record.faults.push(safe);
    else this.violations.push({ sessionId, code: safe });
  }

  async open(sessionId) {
    if (!this.expected.includes(sessionId) || this.entries.has(sessionId)) {
      this.fault(sessionId, "unexpected_or_duplicate_browser_session");
      throw new Error("unexpected_or_duplicate_browser_session");
    }
    const record = { sessionId, mode: sessionId === "baseline" ? "baseline_shared" : "cold_browser", launchOrdinal: this.entries.size + 1,
      setup: "starting", collectorSetupTimeoutMs: this.dependencies.collectorSetupTimeoutMs,
      shutdown: "not_attempted", collectorSnapshot: "not_recorded", collectorStopped: false, faults: [] };
    const entry = { record, browser: null, receipts: null, profilePath: null, snapshot: null, closed: false };
    this.entries.set(sessionId, entry);
    let stage = "browser_launch_failed";
    try {
      const startedAt = Date.now();
      entry.browser = await this.dependencies.launch();
      stage = "collector_setup_failed";
      record.directory = mkdtempSync(join(this.directory, `native-downloads-${sessionId}-`));
      entry.receipts = this.dependencies.makeReceipts(entry.browser, record.directory);
      await bounded(Promise.resolve().then(() => entry.receipts.start()), record.collectorSetupTimeoutMs);
      stage = "browser_identity_failed";
      const identity = await this.dependencies.identify(entry.browser, startedAt);
      record.identity = identity.evidence;
      entry.profilePath = identity.profilePath;
      record.version = await this.dependencies.version(entry.browser);
      if (record.identity.status === "established") {
        const profile = record.identity.profile.pathSha256, pid = record.identity.browserPid;
        if (this.profiles.has(profile) || this.processes.has(pid)) {
          stage = "browser_profile_or_process_reused";
          throw new Error(stage);
        }
        this.profiles.add(profile); this.processes.add(pid);
      } else if (record.mode === "cold_browser") throw new Error(stage);
      record.setup = "ready";
      return { browser: entry.browser, receipts: entry.receipts, sessionId, version: record.version };
    } catch {
      record.setup = "failed";
      this.fault(sessionId, stage);
      throw new Error(stage);
    }
  }

  async close(sessionId) {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.closed) return;
    entry.closed = true;
    const { record } = entry;
    if (entry.browser) {
      try { await entry.browser.close(); record.shutdown = "confirmed_process_exit"; }
      catch { record.shutdown = "unconfirmed_process_exit"; this.fault(sessionId, "browser_shutdown_failed"); }
    } else { record.shutdown = "missing_browser_handle"; this.fault(sessionId, "browser_shutdown_unavailable"); }
    try { record.profileRemoval = this.dependencies.removed(entry.profilePath); }
    catch { record.profileRemoval = "unavailable"; }
    if (record.profileRemoval !== "confirmed_absent") this.fault(sessionId, "profile_cleanup_unconfirmed");
    // Snapshot AFTER close: late producers/native events during shutdown still count. If exit is
    // unconfirmed the observation window is explicitly incomplete and can never qualify the pair.
    if (entry.receipts) {
      try {
        const snapshot = structuredClone(entry.receipts.snapshot());
        if (!["actions", "producers", "downloads", "violations", "events"].every((key) => Array.isArray(snapshot?.[key]))) throw new Error("invalid_collector_snapshot");
        entry.snapshot = snapshot; record.collectorSnapshot = "recorded_after_shutdown_attempt";
      }
      catch { this.fault(sessionId, "collector_snapshot_failed"); }
      try { entry.receipts.stop(); record.collectorStopped = true; }
      catch { this.fault(sessionId, "collector_stop_failed"); }
    } else this.fault(sessionId, "collector_missing");
  }

  async closeAll() {
    for (const sessionId of this.entries.keys()) await this.close(sessionId);
    if ([...this.entries.values()].some(({ record }) => record.shutdown !== "confirmed_process_exit" || record.profileRemoval !== "confirmed_absent" || !record.collectorStopped)) {
      throw new Error("browser_session_cleanup_unconfirmed");
    }
  }

  snapshot() {
    const sessions = this.expected.map((sessionId) => {
      const entry = this.entries.get(sessionId);
      if (!entry) return { sessionId, setup: "not_attempted", passed: false, faults: ["browser_session_missing"] };
      const { record, snapshot } = entry;
      const complete = record.shutdown === "confirmed_process_exit" && record.profileRemoval === "confirmed_absent"
        && record.collectorStopped && !!snapshot;
      return { ...record, complete, passed: complete && record.setup === "ready" && !record.faults.length
        && !snapshot.violations.length && (record.mode === "baseline_shared" || record.identity?.status === "established"),
        downloadReceipts: snapshot };
    });
    const receipts = { schema: "ticketstub.download-receipts.multisession.v1",
      directories: sessions.filter((session) => session.directory).map(({ sessionId, directory }) => ({ sessionId, directory })),
      actions: [], producers: [], downloads: [], violations: [...this.violations], events: [] };
    for (const session of sessions) {
      for (const key of ["actions", "producers", "downloads", "violations", "events"]) {
        for (const row of session.downloadReceipts?.[key] ?? []) receipts[key].push({ ...row, browserSessionId: session.sessionId });
      }
    }
    // IDs belong to their browser session. Never deduplicate equal inner IDs from different
    // processes or lose their different directory/Blob evidence; each local collector still audits ambiguity.
    return structuredClone({ schema: "ticketstub.download-browser-sessions.v1", expectedSessions: this.expected,
      expectedColdSessions: this.expected.filter((id) => id !== "baseline").length,
      complete: sessions.length > 0 && sessions.every((session) => session.complete === true),
      passed: sessions.length > 0 && sessions.every((session) => session.passed) && !receipts.violations.length,
      policy: "baseline_shared_four_additional_pair_processes_and_profiles_no_reuse", sessions, downloadReceipts: receipts });
  }
}
