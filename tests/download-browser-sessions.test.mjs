import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DownloadBrowserSessions, browserSessionIdForPair, observeBrowserIdentity, profileArgument } from "../scripts/lib/download-browser-sessions.mjs";
import { captureQualificationPlan } from "../scripts/lib/download-capture-qualification.mjs";
import { runBrowserIdentityPreflight } from "../scripts/check-download-browser-identity.mjs";
import { cleanupDownloadProfile } from "../scripts/lib/download-profile-cleanup.mjs";

const plan = captureQualificationPlan([{ name: "390" }, { name: "1440" }]);
const expected = [...new Set(plan.map(browserSessionIdForPair))];
const empty = () => ({ actions: [], producers: [], downloads: [], violations: [], events: [] });
// Synthetic protocol rows reproduce the exact type/URL/subtype shapes in the retained
// Chrome154 preflight. They are not a native run or evidence of compositor readiness.
const observedBrowserUiTargets = () => [
  { type: "browser_ui", url: "chrome://omnibox-popup.top-chrome/omnibox_popup_aim.html" },
  { type: "browser_ui", url: "chrome://omnibox-popup.top-chrome/" },
];

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
    assert.equal(result.evidence.initialApplicationTargetsBlank, true);
    assert.equal(result.evidence.initialApplicationTargetCount, 1);
    assert.equal(result.evidence.initialBrowserUiTargetCount, 0);
    assert.deepEqual(result.evidence.initialTargets.recordedKinds, { blankApplication: 1, blankBrowser: 0, knownBrowserUi: 0, rejected: 0 });
    assert.equal(result.evidence.observedBeforeApplicationNavigation, true);
    assert.equal(result.evidence.profile.taskOwnedTemporaryDirectory, true);
    assert.match(result.evidence.profile.pathSha256, /^[a-f0-9]{64}$/);
    assert.match(result.evidence.launcher.sha256, /^[a-f0-9]{64}$/);
    assert.ok(result.evidence.profile.birthtimeMs >= start - 1000);
    assert.doesNotMatch(JSON.stringify(result.evidence), /SECRET_CANARY|PRIVATE_MODEL_CANARY|GPU_CANARY|--user-data-dir/);
    assert.ok(!JSON.stringify(result.evidence).includes(path));
  });
});

test("the observed omnibox UI forms qualify only alongside a blank application target, with truthful separate counts", async () => {
  await withProfile(async (path, start) => {
    const ui = observedBrowserUiTargets();
    for (const targets of [[], [ui[0]], [ui[1]], ui]) {
      const result = await observeBrowserIdentity(connection(path, { "Target.getTargets": {
        targetInfos: [{ type: "page", url: "about:blank" }, ...targets],
      } }), start);
      assert.equal(result.evidence.status, "established");
      assert.equal(result.profilePath, path);
      assert.equal(result.evidence.initialTargetsBlank, targets.length === 0, "built-in UI is never described as blank");
      assert.equal(result.evidence.initialApplicationTargetsBlank, true);
      assert.equal(result.evidence.initialTargetCount, 1 + targets.length);
      assert.equal(result.evidence.initialApplicationTargetCount, 1);
      assert.equal(result.evidence.initialBrowserUiTargetCount, targets.length);
      assert.deepEqual(result.evidence.initialTargets.recordedKinds,
        { blankApplication: 1, blankBrowser: 0, knownBrowserUi: targets.length, rejected: 0 });
      assert.deepEqual(result.evidence.initialTargets.reasons, []);
      assert.deepEqual(result.evidence.initialTargets.targets.slice(1).map((row) => row.browserUiUrlClass),
        targets.map((target) => target.url.endsWith(".html") ? "omnibox_popup_aim" : "omnibox_popup"));
      assert.ok(result.evidence.initialTargets.targets.every((row) => row.subtypeClass === "absent"));
      assert.doesNotMatch(JSON.stringify(result.evidence), /CANARY|chrome:\/\/|--user-data-dir/);
      assert.ok(!JSON.stringify(result.evidence).includes(path));
    }
  });
});

test("known UI URLs cannot qualify a content or worker target, or a target with any supplied subtype", async () => {
  await withProfile(async (path, start) => {
    for (const target of observedBrowserUiTargets()) {
      const changedTargets = [
        ...["page", "tab", "browser", "service_worker", "background_page", "worker", "UNKNOWN_CANARY"].map((type) => ({ ...target, type })),
        ...["prerender", "", null, "SUBTYPE_CANARY"].map((subtype) => ({ ...target, subtype })),
      ];
      for (const changed of changedTargets) {
        const result = await observeBrowserIdentity(connection(path, { "Target.getTargets": {
          targetInfos: [{ type: "page", url: "about:blank" }, changed],
        } }), start);
        assert.equal(result.evidence.status, "unavailable");
        assert.equal(result.evidence.initialTargets.recordedKinds.knownBrowserUi, 0);
        assert.equal(result.evidence.initialTargets.recordedKinds.rejected, 1);
        assert.ok(result.evidence.initialTargets.reasons.includes(changed.type === "browser_ui" ? "target_subtype_unaccepted" : "target_url_unaccepted"));
        assert.doesNotMatch(JSON.stringify(result.evidence), /CANARY|chrome:\/\//);
      }
    }
  });
});

test("an empty inventory, browser descriptor or recognized UI cannot substitute for a blank application target", async () => {
  await withProfile(async (path, start) => {
    for (const targetInfos of [[], [{ type: "browser", url: "" }], observedBrowserUiTargets(),
      [{ type: "page", url: "about:blank", subtype: "prerender" }, ...observedBrowserUiTargets()]]) {
      const result = await observeBrowserIdentity(connection(path, { "Target.getTargets": { targetInfos } }), start);
      assert.equal(result.evidence.status, "unavailable");
      assert.equal(result.profilePath, path, "the independent cleanup handle is retained");
      assert.ok(result.evidence.initialTargets.reasons.includes("blank_application_target_missing"));
      assert.equal(result.evidence.initialTargets.recordedKinds.blankApplication, 0);
    }
    const withDescriptor = await observeBrowserIdentity(connection(path, { "Target.getTargets": {
      targetInfos: [{ type: "page", url: "about:blank" }, { type: "browser", url: "" }, ...observedBrowserUiTargets()],
    } }), start);
    assert.equal(withDescriptor.evidence.status, "established");
    assert.deepEqual(withDescriptor.evidence.initialTargets.recordedKinds,
      { blankApplication: 1, blankBrowser: 1, knownBrowserUi: 2, rejected: 0 });
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
      assert.equal(result.evidence.status, "unavailable");
      assert.equal(result.evidence.code, code);
      assert.equal(result.profilePath, override["Target.getTargets"] ? path : null);
      assert.doesNotMatch(JSON.stringify(result.evidence), /SECRET_CANARY|private\.invalid/);
    }
  });
});

test("rejected startup targets retain bounded safe classes without accepting internal, worker or nonblank targets", async () => {
  await withProfile(async (path, start) => {
    const targets = [
      { type: "page", url: "chrome://PRIVATE_CANARY/?SECRET_CANARY", title: "PRIVATE_TITLE_CANARY" },
      { type: "service_worker", url: "chrome-extension://PRIVATE_EXTENSION_CANARY/worker.js" },
      { type: "SECRET_TYPE_CANARY", url: `data:image/svg+xml,SECRET_CANARY${"x".repeat(4096)}`, subtype: "SECRET_SUBTYPE_CANARY" },
      { type: "page", url: "https://private.invalid/SECRET_CANARY", subtype: "prerender" },
    ];
    const result = await observeBrowserIdentity(connection(path, { "Target.getTargets": { targetInfos: targets } }), start);
    assert.equal(result.evidence.status, "unavailable");
    assert.equal(result.profilePath, path, "a validated task profile remains available only for cleanup");
    assert.equal(result.evidence.profileCleanupEvidence, "validated_independently_of_target_qualification");
    assert.deepEqual(result.evidence.initialTargets, { status: "rejected", reasons: ["target_url_unaccepted", "target_type_unaccepted", "target_subtype_unaccepted", "blank_application_target_missing"],
      observedCount: 4, recordedCount: 4, omittedCount: 0, limit: 32, allTargetsBlank: false,
      recordedKinds: { blankApplication: 0, blankBrowser: 0, knownBrowserUi: 0, rejected: 4 }, targets: [
        { typeClass: "page", urlClass: "chrome_internal", subtypeClass: "absent" },
        { typeClass: "service_worker", urlClass: "chrome_extension", subtypeClass: "absent" },
        { typeClass: "unrecognized", urlClass: "over_cap", subtypeClass: "unrecognized" },
        { typeClass: "page", urlClass: "https", subtypeClass: "prerender" },
      ] });
    assert.doesNotMatch(JSON.stringify(result.evidence), /CANARY|private\.invalid|chrome:\/\/|chrome-extension:\/\/|data:image/);
    assert.ok(!JSON.stringify(result.evidence).includes(path));
  });
});

test("target response omissions, over-cap inventories and protocol failure remain distinguishable and fail closed", async () => {
  await withProfile(async (path, start) => {
    const invalid = await observeBrowserIdentity(connection(path, { "Target.getTargets": {} }), start);
    assert.deepEqual(invalid.evidence.initialTargets.reasons, ["target_response_invalid"]);
    const over = await observeBrowserIdentity(connection(path, { "Target.getTargets": {
      targetInfos: Array.from({ length: 33 }, () => ({ type: "page", url: "about:blank" })),
    } }), start);
    assert.equal(over.evidence.status, "unavailable");
    assert.deepEqual(over.evidence.initialTargets.reasons, ["target_count_over_cap"]);
    assert.equal(over.evidence.initialTargets.recordedCount, 32);
    assert.equal(over.evidence.initialTargets.omittedCount, 1);
    assert.equal(over.evidence.initialTargets.allTargetsBlank, null, "an omitted target cannot be claimed blank");
    assert.deepEqual(over.evidence.initialTargets.recordedKinds, { blankApplication: 32, blankBrowser: 0, knownBrowserUi: 0, rejected: 0 });
    const unsupported = await observeBrowserIdentity(connection(path, { "Target.getTargets": () => Promise.reject(new Error("SECRET_CANARY")) }), start);
    assert.equal(unsupported.evidence.status, "unavailable");
    assert.deepEqual(unsupported.evidence.initialTargets.reasons, ["target_protocol_unavailable"]);
    for (const result of [invalid, over, unsupported]) {
      assert.equal(result.profilePath, path);
      assert.equal(result.evidence.profile.taskOwnedTemporaryDirectory, true);
      assert.doesNotMatch(JSON.stringify(result.evidence), /SECRET_CANARY/);
    }
  });
});

test("unknown browser UI URLs remain rejected, including a blank URL", async () => {
  await withProfile(async (path, start) => {
    for (const url of ["about:blank", "chrome://PRIVATE_CANARY/?SECRET_CANARY"]) {
      const result = await observeBrowserIdentity(connection(path, { "Target.getTargets": {
        targetInfos: [{ type: "page", url: "about:blank" }, { type: "browser_ui", url, title: "TITLE_CANARY" }],
      } }), start);
      assert.equal(result.evidence.status, "unavailable");
      assert.equal(result.evidence.code, "identity_initial_targets_not_blank");
      assert.equal(result.profilePath, path);
      assert.deepEqual(result.evidence.initialTargets.reasons, url === "about:blank"
        ? ["target_type_unaccepted"] : ["target_type_unaccepted", "target_url_unaccepted"]);
      assert.deepEqual(result.evidence.initialTargets.targets[1], { typeClass: "browser_ui",
        urlClass: url === "about:blank" ? "about_blank" : "chrome_internal", browserUiUrlClass: "unrecognized", subtypeClass: "absent" });
      assert.doesNotMatch(JSON.stringify(result.evidence), /CANARY|chrome:\/\//);
    }
  });
});

test("only observed exact UI URL forms qualify; tab search, URL variants and unknown forms remain rejected", async () => {
  await withProfile(async (path, start) => {
    const cases = [
      ["chrome://tab-search.top-chrome/", "tab_search"],
      ["chrome://omnibox-popup.top-chrome/", "omnibox_popup"],
      ["chrome://omnibox-popup.top-chrome/omnibox_popup_aim.html", "omnibox_popup_aim"],
      ["chrome://tab-search.top-chrome/?SECRET_CANARY", "unrecognized"],
      ["chrome://omnibox-popup.top-chrome/#SECRET_CANARY", "unrecognized"],
      ["chrome://omnibox-popup.top-chrome/?SECRET_CANARY", "unrecognized"],
      ["chrome://omnibox-popup.top-chrome/omnibox_popup_aim.html?SECRET_CANARY", "unrecognized"],
      ["chrome://omnibox-popup.top-chrome/omnibox_popup_aim.html#SECRET_CANARY", "unrecognized"],
      ["chrome://omnibox-popup.top-chrome.evil.invalid/", "unrecognized"],
      ["chrome://SECRET_CANARY@omnibox-popup.top-chrome/", "unrecognized"],
      ["chrome://omnibox-popup.top-chrome:80/", "unrecognized"],
      ["chrome://OMNIBOX-POPUP.top-chrome/", "unrecognized"],
      ["chrome://omnibox-popup.top-chrome/%6fmnibox_popup_aim.html", "unrecognized"],
      ["chrome://omnibox-popup.top-chrome/./omnibox_popup_aim.html", "unrecognized"],
      ["chrome-extension://omnibox-popup.top-chrome/", "unrecognized"],
      ["chrome://PRIVATE_CANARY/", "unrecognized"],
      ["https://SECRET_CANARY/", "unrecognized"],
      [`chrome://SECRET_CANARY/${"x".repeat(4096)}`, "unrecognized"],
    ];
    for (const [url, name] of cases) {
      const accepted = ["omnibox_popup", "omnibox_popup_aim"].includes(name);
      const result = await observeBrowserIdentity(connection(path, { "Target.getTargets": {
        targetInfos: [{ type: "page", url: "about:blank" }, { type: "browser_ui", url }],
      } }), start);
      assert.equal(result.evidence.status, accepted ? "established" : "unavailable");
      assert.deepEqual(result.evidence.initialTargets.reasons, accepted ? [] : ["target_type_unaccepted", "target_url_unaccepted"]);
      assert.equal(result.evidence.initialTargets.targets[1].browserUiUrlClass, name);
      assert.doesNotMatch(JSON.stringify(result.evidence), /CANARY|chrome:\/\/|https:\/\//);
    }
    const content = await observeBrowserIdentity(connection(path, { "Target.getTargets": {
      targetInfos: [{ type: "page", url: "chrome://tab-search.top-chrome/" }],
    } }), start);
    assert.equal(content.evidence.status, "unavailable");
    assert.equal(content.evidence.initialTargets.targets[0].browserUiUrlClass, undefined);
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
  const directory = mkdtempSync(join(tmpdir(), "ticketstub-cold-control-")), trace = [], collectors = [], browsers = [], launchOptions = [];
  const manager = new DownloadBrowserSessions(directory, plan, {
    async launch(optionsForLaunch) {
      launchOptions.push(structuredClone(optionsForLaunch));
      const ordinal = browsers.length + 1;
      trace.push([ordinal, "launch"]);
      const browser = { ordinal, async newPage() { trace.push([ordinal, "newPage"]); }, async close() {
        trace.push([ordinal, "close"]);
        options.onClose?.(ordinal, collectors[ordinal - 1]);
        if (options.closeFails === ordinal) throw new Error("SECRET_CANARY");
        if (options.cleanupMissing === ordinal) return undefined;
        return { profileCleanup: options.cleanupIncomplete === ordinal
          ? { status: "incomplete", reason: "cleanup_deadline", complete: false, attempts: [{ ordinal: 1, remove: { status: "timed_out" } }] }
          : { status: "confirmed_absent", complete: true, attempts: [] } };
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
  return { manager, trace, collectors, browsers, launchOptions, cleanup() { rmSync(directory, { recursive: true, force: true }); } };
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

test("the actual manager requests download isolation for baseline and every additional pair", async () => {
  const h = harness();
  try {
    const result = await runAll(h);
    assert.equal(result.passed, true);
    assert.deepEqual(result.expectedSessions, ["baseline", "cold-390-1", "cold-390-2", "cold-1440-1", "cold-1440-2"]);
    assert.deepEqual(h.launchOptions, expected.map(() => ({ downloadIsolation: true })));
    assert.ok(result.sessions.every((session) => session.launchPolicy === "download_extension_isolation_requested"));
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

test("missing or incomplete cleanup never relabels confirmed exit or qualifies from later profile absence", async () => {
  for (const options of [{ cleanupIncomplete: 2 }, { cleanupMissing: 2 }]) {
    const h = harness(options);
    try {
      const record = await runAll(h);
      const session = record.sessions[1];
      assert.equal(session.shutdown, "confirmed_process_exit");
      assert.equal(session.profileRemoval, "confirmed_absent");
      assert.equal(session.profileCleanup.complete, false);
      assert.equal(session.complete, false); assert.equal(session.passed, false);
      assert.equal(record.complete, false); assert.equal(record.passed, false);
      assert.ok(session.faults.includes("profile_cleanup_incomplete"));
      assert.ok(record.sessions.slice(2).every((item) => item.passed));
      await assert.rejects(h.manager.closeAll(), /browser_session_cleanup_unconfirmed/);
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

// Actual identity parsing, filesystem/profile removal and manager/preflight code; only
// the browser protocol/collector are synthetic. No app navigation or native process occurs.
function identityPreflightDependencies(nonblank, launchOptions = [], targets) {
  let profile;
  return {
    async launch(optionsForLaunch) {
      launchOptions.push(structuredClone(optionsForLaunch));
      profile = mkdtempSync(join(tmpdir(), "ticketstub-chrome-"));
      return { ...connection(profile, { "Target.getTargets": {
        targetInfos: targets ?? [{ type: "page", url: nonblank ? "chrome://SECRET_CANARY" : "about:blank" }],
      } }),
        newPage() { throw new Error("preflight must not create an application page"); },
        async close() { return { profileCleanup: await cleanupDownloadProfile(profile) }; } };
    },
    makeReceipts() { return { async start() {}, snapshot: empty, stop() {} }; },
    async version() { return { status: "recorded", product: "SyntheticControl/1.0" }; },
  };
}

test("known failed baseline identity stays failed after independently confirmed real profile removal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticketstub-identity-control-"));
  try {
    const sessions = new DownloadBrowserSessions(directory, [{ viewport: { name: "390" }, trial: 0 }], identityPreflightDependencies(true));
    await sessions.open("baseline");
    await sessions.closeAll();
    const record = sessions.snapshot();
    assert.equal(record.complete, true);
    assert.equal(record.sessions[0].profileRemoval, "confirmed_absent");
    assert.equal(record.sessions[0].identity.status, "unavailable");
    assert.ok(record.sessions[0].faults.includes("browser_identity_failed"));
    assert.equal(record.passed, false, "successful cleanup never rescues a rejected identity");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("identity-only preflight retains both the rejected target evidence and successful cleanup without application navigation", async () => {
  for (const nonblank of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), "ticketstub-identity-control-"));
    try {
      const launchOptions = [];
      const result = await runBrowserIdentityPreflight(directory, identityPreflightDependencies(nonblank, launchOptions));
      assert.deepEqual(launchOptions, [{ downloadIsolation: true }]);
      const saved = JSON.parse(readFileSync(join(directory, "browser-identity-preflight.json"), "utf8"));
      assert.deepEqual(saved, result);
      assert.equal(result.passed, !nonblank);
      assert.equal(result.source.status, "recorded");
      assert.equal(result.browserSessions.sessions.length, 1);
      const session = result.browserSessions.sessions[0];
      assert.equal(session.profileRemoval, "confirmed_absent");
      assert.equal(session.shutdown, "confirmed_process_exit");
      assert.equal(session.identity.status, nonblank ? "unavailable" : "established");
      assert.equal(session.collectorSnapshot, "recorded_after_shutdown_attempt");
      for (const key of ["actions", "producers", "downloads", "events"]) assert.equal(result.browserSessions.downloadReceipts[key].length, 0);
      if (nonblank) {
        assert.deepEqual(session.identity.initialTargets.reasons, ["target_url_unaccepted", "blank_application_target_missing"]);
        assert.ok(result.faults.includes("identity_preflight_setup_failed"));
      }
      assert.doesNotMatch(JSON.stringify(result), /SECRET_CANARY/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test("the observed UI shape passes the actual manager/preflight only with complete independent profile cleanup", async () => {
  for (const incompleteCleanup of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), "ticketstub-identity-control-"));
    try {
      const launchOptions = [], dependencies = identityPreflightDependencies(false, launchOptions,
        [{ type: "page", url: "about:blank" }, ...observedBrowserUiTargets()]);
      if (incompleteCleanup) {
        const launch = dependencies.launch;
        dependencies.launch = async (options) => {
          const browser = await launch(options), close = browser.close;
          browser.close = async () => {
            await close(); // actual task directory is removed, but the independent receipt is incomplete
            return { profileCleanup: { status: "incomplete", reason: "cleanup_deadline", complete: false, attempts: [] } };
          };
          return browser;
        };
      }
      const result = await runBrowserIdentityPreflight(directory, dependencies);
      assert.deepEqual(launchOptions, [{ downloadIsolation: true }]);
      assert.deepEqual(JSON.parse(readFileSync(join(directory, "browser-identity-preflight.json"), "utf8")), result);
      assert.equal(result.passed, !incompleteCleanup);
      const session = result.browserSessions.sessions[0];
      assert.equal(session.identity.status, "established");
      assert.equal(session.identity.initialTargetsBlank, false);
      assert.equal(session.identity.initialApplicationTargetsBlank, true);
      assert.equal(session.identity.initialApplicationTargetCount, 1);
      assert.equal(session.identity.initialBrowserUiTargetCount, 2);
      assert.equal(session.shutdown, "confirmed_process_exit");
      assert.equal(session.profileRemoval, "confirmed_absent");
      assert.equal(session.collectorSnapshot, "recorded_after_shutdown_attempt");
      assert.equal(session.collectorStopped, true);
      assert.equal(session.complete, !incompleteCleanup);
      assert.equal(session.passed, !incompleteCleanup);
      if (incompleteCleanup) assert.ok(session.faults.includes("profile_cleanup_incomplete"));
      for (const key of ["actions", "producers", "downloads", "events"]) assert.equal(result.browserSessions.downloadReceipts[key].length, 0);
      assert.doesNotMatch(JSON.stringify(result), /CANARY|chrome:\/\/|--user-data-dir/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});
