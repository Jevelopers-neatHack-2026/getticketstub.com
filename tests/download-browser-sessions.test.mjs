import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DownloadBrowserSessions, browserSessionIdForPair, observeBrowserIdentity, profileArgument } from "../scripts/lib/download-browser-sessions.mjs";
import { captureQualificationPlan } from "../scripts/lib/download-capture-qualification.mjs";

const plan = captureQualificationPlan([{ name: "390" }, { name: "1440" }]);
const expected = [...new Set(plan.map(browserSessionIdForPair))];
const empty = () => ({ actions: [], producers: [], downloads: [], violations: [], events: [] });

function connection(profile, overrides = {}) {
  const values = {
    "SystemInfo.getInfo": { commandLine: `chrome --token=SECRET_CANARY --user-data-dir=${profile} about:blank`, modelName: "PRIVATE_MODEL_CANARY", gpu: { sensitive: "GPU_CANARY" } },
    "SystemInfo.getProcessInfo": { processInfo: [{ type: "browser", id: 321 }, { type: "renderer", id: 322 }] },
    "Target.getTargets": { targetInfos: [{ type: "page", url: "about:blank" }] }, ...overrides,
  };
  return { conn: { send(method) { const value = values[method]; return typeof value === "function" ? value() : Promise.resolve(value); } } };
}

async function withProfile(run) {
  const start = Date.now(), path = mkdtempSync(join(tmpdir(), "ticketstub-chrome-"));
  try { return await run(path, start); }
  finally { rmSync(path, { recursive: true, force: true }); }
}

test("profile extraction is bounded, rejects ambiguous arguments and does not expose unrelated command data", () => {
  const path = join(tmpdir(), "ticketstub-chrome-Ab12cd");
  for (const argument of [`--user-data-dir=${path}`, `--user-data-dir="${path}"`, `"--user-data-dir=${path}"`, `--user-data-dir='${path}'`]) {
    assert.equal(profileArgument(`chrome --secret=SECRET_CANARY ${argument} about:blank`), path);
  }
  for (const value of [null, "", "x".repeat(16_385), "chrome --user-data-dir=relative", `chrome --user-data-dir=${path} --user-data-dir=${path}`,
    `chrome --user-data-dir=${path} --user-data-dir "broken`, `chrome --user-data-dir="${path}\nsecret"`]) assert.equal(profileArgument(value), null);
});

test("actual temporary profile creation plus protocol PID and blank targets ground a privacy-safe identity", async () => {
  await withProfile(async (path, start) => {
    const result = await observeBrowserIdentity(connection(path), start);
    assert.equal(result.profilePath, path);
    assert.equal(result.evidence.status, "established");
    assert.equal(result.evidence.browserPid, 321);
    assert.equal(result.evidence.initialTargetsBlank, true);
    assert.equal(result.evidence.observedBeforeApplicationNavigation, true);
    assert.equal(result.evidence.profile.taskOwnedTemporaryDirectory, true);
    assert.match(result.evidence.profile.pathSha256, /^[a-f0-9]{64}$/);
    assert.match(result.evidence.launcher.sha256, /^[a-f0-9]{64}$/);
    assert.ok(result.evidence.profile.birthtimeMs >= start - 1000);
    assert.doesNotMatch(JSON.stringify(result.evidence), /SECRET_CANARY|PRIVATE_MODEL_CANARY|GPU_CANARY|--user-data-dir/);
    assert.ok(!JSON.stringify(result.evidence).includes(path));
  });
});

test("unsupported, timed out and synchronously throwing identity protocols return fixed unavailable evidence", async () => {
  await withProfile(async (path, start) => {
    for (const behavior of [() => Promise.reject(new Error("secret=SECRET_CANARY")), () => new Promise(() => {}), () => { throw new Error("SECRET_CANARY"); }]) {
      const result = await observeBrowserIdentity(connection(path, { "SystemInfo.getInfo": behavior }), start, { timeoutMs: 5 });
      assert.deepEqual(result, { evidence: { status: "unavailable", code: "identity_protocol_unavailable" }, profilePath: null });
    }
  });
});

test("nonblank or excessive targets, malformed command lines and ambiguous process identities cannot establish isolation", async () => {
  await withProfile(async (path, start) => {
    const cases = [
      [{ "Target.getTargets": { targetInfos: [{ type: "page", url: "https://private.invalid/SECRET_CANARY" }] } }, "identity_initial_targets_not_blank"],
      [{ "Target.getTargets": { targetInfos: Array.from({ length: 33 }, () => ({ type: "page", url: "about:blank" })) } }, "identity_initial_targets_not_blank"],
      [{ "SystemInfo.getInfo": { commandLine: "" } }, "identity_profile_argument_unavailable"],
      [{ "SystemInfo.getInfo": { commandLine: "x".repeat(16_385) } }, "identity_profile_argument_unavailable"],
      [{ "SystemInfo.getProcessInfo": { processInfo: [{ type: "browser", id: 0 }] } }, "identity_process_unavailable"],
      [{ "SystemInfo.getProcessInfo": { processInfo: [{ type: "browser", id: 321 }, { type: "browser", id: 322 }] } }, "identity_process_unavailable"],
      [{ "SystemInfo.getProcessInfo": { processInfo: Array.from({ length: 129 }, () => ({ type: "renderer", id: 1 })) } }, "identity_process_unavailable"],
    ];
    for (const [override, code] of cases) {
      const result = await observeBrowserIdentity(connection(path, override), start);
      assert.deepEqual(result, { evidence: { status: "unavailable", code }, profilePath: null });
    }
  });
});

test("a stale, absent, non-task or symlinked profile cannot masquerade as a newly launched directory", async () => {
  await withProfile(async (path, start) => {
    assert.equal((await observeBrowserIdentity(connection(path), start + 60_000)).evidence.code, "identity_profile_creation_unconfirmed");
    assert.equal((await observeBrowserIdentity(connection(join(path, "ticketstub-chrome-Ab12cd")), start)).evidence.code, "identity_profile_not_task_owned");
    const link = mkdtempSync(join(tmpdir(), "ticketstub-chrome-"));
    rmSync(link, { recursive: true });
    try {
      symlinkSync(path, link, "dir");
      assert.equal((await observeBrowserIdentity(connection(link), start)).evidence.code, "identity_profile_creation_unconfirmed");
    } finally { rmSync(link, { force: true }); }
    rmSync(path, { recursive: true });
    assert.equal((await observeBrowserIdentity(connection(path), start)).evidence.code, "identity_profile_stat_unavailable");
  });
});

// Synthetic lifecycle controls call the actual session manager. No native browser or network is started.
function harness(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "ticketstub-cold-control-")), trace = [], collectors = [], browsers = [];
  const manager = new DownloadBrowserSessions(directory, plan, {
    async launch() {
      const ordinal = browsers.length + 1;
      trace.push([ordinal, "launch"]);
      const browser = { ordinal, async newPage() { trace.push([ordinal, "newPage"]); }, async close() {
        trace.push([ordinal, "close"]);
        options.onClose?.(ordinal, collectors[ordinal - 1]);
        if (options.closeFails === ordinal) throw new Error("SECRET_CANARY");
      } };
      browsers.push(browser);
      if (options.launchFails === ordinal) throw new Error("SECRET_CANARY");
      return browser;
    },
    makeReceipts(browser) {
      const { ordinal } = browser;
      const collector = { data: empty(), async start() { trace.push([ordinal, "start"]); if (options.startFails === ordinal) throw new Error("SECRET_CANARY");
        if (options.startHeld === ordinal) await new Promise((resolve) => { collector.releaseStart = resolve; }); },
        snapshot() { trace.push([ordinal, "snapshot"]); return options.malformedSnapshot === ordinal ? { actions: null } : this.data; },
        stop() { trace.push([ordinal, "stop"]); if (options.stopFails === ordinal) throw new Error("SECRET_CANARY"); } };
      collectors[ordinal - 1] = collector;
      return collector;
    },
    async identify(browser) {
      const { ordinal } = browser;
      trace.push([ordinal, "identify"]);
      if (options.identityFails === ordinal) return { evidence: { status: "unavailable", code: "identity_protocol_unavailable" }, profilePath: null };
      return { profilePath: `/synthetic-profile-${ordinal}`, evidence: { status: "established", browserPid: options.reusePid ? 100 : ordinal + 100,
        profile: { pathSha256: String(options.reuseProfile ? 1 : ordinal).repeat(64) } } };
    },
    async version() { return { status: "recorded", product: "SyntheticControl/1.0" }; },
    removed(path) { return options.removalFails || !path ? "unavailable" : "confirmed_absent"; },
    collectorSetupTimeoutMs: options.startHeld ? 5 : 2000,
  });
  return { manager, trace, collectors, browsers, cleanup() { rmSync(directory, { recursive: true, force: true }); } };
}

async function runAll(h) {
  for (const id of expected) {
    try { await h.manager.open(id); } catch { /* required failures stay in manager evidence; attempt every planned session */ }
    await h.manager.close(id);
  }
  return h.manager.snapshot();
}

test("baseline launches once and each extra pair gets its own collector before navigation and one shutdown", async () => {
  const h = harness();
  try {
    for (const id of expected) {
      const session = await h.manager.open(id);
      await session.browser.newPage();
      await h.manager.close(id);
    }
    await h.manager.closeAll();
    const record = h.manager.snapshot();
    assert.equal(h.browsers.length, 5); assert.equal(record.expectedColdSessions, 4);
    assert.equal(record.complete, true); assert.equal(record.passed, true);
    assert.equal(new Set(record.sessions.map((item) => item.directory)).size, 5);
    assert.equal(new Set(record.sessions.map((item) => item.identity.browserPid)).size, 5);
    assert.equal(new Set(record.sessions.map((item) => item.identity.profile.pathSha256)).size, 5);
    for (let ordinal = 1; ordinal <= 5; ordinal++) assert.deepEqual(h.trace.filter(([id]) => id === ordinal).map(([, action]) => action),
      ["launch", "start", "identify", "newPage", "close", "snapshot", "stop"]);
  } finally { h.cleanup(); }
});

test("an attempted session cannot relaunch or silently reuse another session's process or profile", async () => {
  for (const options of [{}, { reusePid: true }, { reuseProfile: true }]) {
    const h = harness(options);
    try {
      await h.manager.open("baseline");
      if (options.reusePid || options.reuseProfile) await assert.rejects(h.manager.open("cold-390-1"), /browser_profile_or_process_reused/);
      else await assert.rejects(h.manager.open("baseline"), /unexpected_or_duplicate_browser_session/);
      await h.manager.closeAll();
      assert.equal(h.browsers.length, options.reusePid || options.reuseProfile ? 2 : 1);
      assert.equal(h.manager.snapshot().passed, false);
    } finally { h.cleanup(); }
  }
});

test("launch, collector and identity setup failures stay failed while every later fixed session can run", async () => {
  for (const options of [{ launchFails: 2 }, { startFails: 2 }, { identityFails: 2 }]) {
    const h = harness(options);
    try {
      const record = await runAll(h);
      assert.equal(record.sessions.length, 5); assert.equal(h.browsers.length, 5);
      assert.equal(record.sessions[1].setup, "failed"); assert.equal(record.sessions[1].passed, false);
      assert.ok(record.sessions.slice(2).every((session) => session.passed));
      assert.equal(record.passed, false);
      assert.doesNotMatch(JSON.stringify(record), /SECRET_CANARY/);
    } finally { h.cleanup(); }
  }
});

test("late shutdown events and violations remain in the aggregate and invalidate their original session", async () => {
  const h = harness({ onClose(ordinal, collector) { if (ordinal === 2) {
    collector.data.events.push({ event: "late_producer", producerId: "late" });
    collector.data.violations.push({ code: "producer_after_terminal" });
  } } });
  try {
    const record = await runAll(h);
    assert.equal(record.sessions[1].collectorSnapshot, "recorded_after_shutdown_attempt");
    assert.equal(record.sessions[1].passed, false); assert.equal(record.passed, false);
    assert.deepEqual(record.downloadReceipts.events, [{ event: "late_producer", producerId: "late", browserSessionId: "cold-390-1" }]);
    assert.deepEqual(record.downloadReceipts.violations, [{ code: "producer_after_terminal", browserSessionId: "cold-390-1" }]);
  } finally { h.cleanup(); }
});

test("an unanswered collector setup times out once, closes its browser and still attempts every later session", async () => {
  const h = harness({ startHeld: 2 });
  try {
    const record = await runAll(h);
    assert.equal(h.browsers.length, 5);
    assert.equal(record.sessions[1].setup, "failed");
    assert.ok(record.sessions[1].faults.includes("collector_setup_failed"));
    assert.equal(record.sessions[1].shutdown, "confirmed_process_exit");
    assert.equal(record.sessions[1].collectorStopped, true);
    assert.equal(record.sessions[1].passed, false);
    assert.ok(record.sessions.slice(2).every((session) => session.passed));
    assert.equal(record.passed, false);
    h.collectors[1].releaseStart();
    await Promise.resolve();
    assert.deepEqual(h.manager.snapshot(), record, "late setup completion cannot revise the failed outcome");
    assert.equal(h.trace.filter(([ordinal, action]) => ordinal === 2 && action === "start").length, 1);
  } finally { h.cleanup(); }
});

test("unconfirmed process/profile cleanup or missing final collector state fails without dropping other sessions", async () => {
  for (const options of [{ closeFails: 2 }, { removalFails: true }, { stopFails: 2 }, { malformedSnapshot: 2 }]) {
    const h = harness(options);
    try {
      const record = await runAll(h);
      assert.equal(record.passed, false); assert.equal(record.complete, false);
      assert.equal(record.sessions[1].passed, false); assert.equal(record.sessions.length, 5);
      if (!options.removalFails) assert.ok(record.sessions.slice(2).every((session) => session.passed));
      assert.equal(h.trace.filter(([, action]) => action === "stop").length, 5);
    } finally { h.cleanup(); }
  }
});

test("aggregation keeps equal inner IDs in different browser sessions with every native directory and row", async () => {
  const h = harness({ onClose(ordinal, collector) {
    collector.data.actions.push({ id: "same-action", status: "download" });
    collector.data.producers.push({ producerId: "same-producer" });
    collector.data.downloads.push({ guid: "same-guid", state: "completed", sha256: String(ordinal).repeat(64) });
    collector.data.events.push({ event: "completed", guid: "same-guid" });
  } });
  try {
    const record = await runAll(h);
    assert.equal(record.passed, true);
    for (const key of ["actions", "producers", "downloads", "events"]) {
      assert.equal(record.downloadReceipts[key].length, 5);
      assert.deepEqual(record.downloadReceipts[key].map((row) => row.browserSessionId), expected);
    }
    assert.equal(record.downloadReceipts.directories.length, 5);
    assert.equal(new Set(record.downloadReceipts.downloads.map((row) => row.sha256)).size, 5);
    h.collectors[0].data.events.push({ event: "after_snapshot_synthetic_mutation" });
    assert.equal(record.downloadReceipts.events.length, 5);
  } finally { h.cleanup(); }
});

test("a never-attempted fixed session remains explicit and cannot be claimed complete", async () => {
  const h = harness();
  try {
    await h.manager.open("baseline"); await h.manager.closeAll();
    const record = h.manager.snapshot();
    assert.equal(record.complete, false); assert.equal(record.passed, false);
    assert.equal(record.sessions.filter((session) => session.setup === "not_attempted").length, 4);
    assert.ok(record.sessions.slice(1).every((session) => session.faults.includes("browser_session_missing")));
  } finally { h.cleanup(); }
});
