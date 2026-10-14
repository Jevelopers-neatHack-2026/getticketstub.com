import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runAllProductSuites } from "../scripts/lib/product-suite-all.mjs";

const source = { gitSha: "a".repeat(40), gitDirty: false, node: process.version };
const receiptName = (suite, milliseconds = "000") => `${suite}-2026-10-13T00-00-00-${milliseconds}Z.json`;
function fixtureReceipt(suite) {
  return {
    suite, mode: "fixture", ...source, exitCode: 0, blockedNetwork: [],
    counts: { passed: 3, failed: 0, skipped: 0 },
    steps: [
      { name: "fixture mode refuses outbound network", ok: true },
      { name: "synthetic assertion for aggregate control", ok: true },
      { name: "no outbound network attempted", ok: true },
    ],
  };
}
function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "ticketstub-all-control-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, evidenceDir: join(root, "evidence"), dispatcher: join(root, "synthetic-dispatcher.mjs"), getSource: () => ({ ...source }), log() {} };
}
async function control(t, mutation, options = {}) {
  const config = workspace(t);
  const calls = [];
  const report = await runAllProductSuites({
    ...config, suites: ["first", "middle", "last"], ...options,
    runChild: async (call) => {
      calls.push(call);
      const receipt = fixtureReceipt(call.suite);
      const state = { receipt, process: { exitCode: 0, signal: null }, write: true };
      if (call.suite === "middle") await mutation?.(state, call);
      if (state.write) writeFileSync(join(call.directory, receiptName(call.suite)), JSON.stringify(state.receipt));
      return state.process;
    },
  });
  return { ...config, report, calls };
}

test("all preserves the declared order, uses isolated receipt directories and joins exact receipt digests", async (t) => {
  const run = await control(t);
  assert.equal(run.report.exitCode, 0);
  assert.deepEqual(run.calls.map((call) => call.suite), ["first", "middle", "last"]);
  assert.equal(new Set(run.calls.map((call) => call.directory)).size, 3);
  assert.deepEqual(run.report.counts, { passed: 9, failed: 0, skipped: 0 });
  for (const [index, result] of run.report.results.entries()) {
    assert.deepEqual(result.command, [process.execPath, run.dispatcher, "--suite", run.calls[index].suite, "--mode", "fixture", "--evidence-dir", run.calls[index].directory]);
    const bytes = readFileSync(join(run.evidenceDir, result.receipt.file));
    assert.equal(result.receipt.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(result.receipt.bytes, bytes.length);
  }
  assert.deepEqual(JSON.parse(readFileSync(run.report.file)).requiredSuites, ["first", "middle", "last"]);
  assert.match(run.report.scope, /integration journey and release acceptance are separate/);
});

for (const [name, mutation, fault] of [
  ["a failed child with a successful-looking receipt", (s) => { s.process.exitCode = 7; }, "child_did_not_exit_successfully"],
  ["a signaled child with a zero exit code", (s) => { s.process.signal = "SIGTERM"; }, "child_did_not_exit_successfully"],
  ["a missing child receipt", (s) => { s.write = false; }, "exactly_one_fresh_leaf_receipt_required"],
  ["duplicate timestamped leaf receipts", (s, call) => { writeFileSync(join(call.directory, receiptName("middle", "001")), JSON.stringify(s.receipt)); }, "exactly_one_fresh_leaf_receipt_required"],
  ["malformed leaf JSON", (s, call) => { s.write = false; writeFileSync(join(call.directory, receiptName("middle")), "{"); }, "malformed_leaf_receipt"],
  ["wrong suite provenance", (s) => { s.receipt.suite = "first"; }, "receipt_suite_or_mode_mismatch"],
  ["a live-mode receipt", (s) => { s.receipt.mode = "live"; }, "receipt_suite_or_mode_mismatch"],
  ["a different revision", (s) => { s.receipt.gitSha = "b".repeat(40); }, "receipt_source_or_runtime_mismatch"],
  ["a dirty child checkout", (s) => { s.receipt.gitDirty = true; }, "receipt_source_or_runtime_mismatch"],
  ["a different Node runtime", (s) => { s.receipt.node = "v0.0.0"; }, "receipt_source_or_runtime_mismatch"],
  ["a reported nonzero exit", (s) => { s.receipt.exitCode = 1; }, "receipt_exit_not_successful"],
  ["missing counts", (s) => { delete s.receipt.counts; }, "invalid_or_missing_counts"],
  ["invalid negative counts", (s) => { s.receipt.counts.failed = -1; }, "invalid_or_missing_counts"],
  ["zero positive results", (s) => { s.receipt.counts.passed = 0; }, "required_results_not_all_passed"],
  ["a required skipped assertion", (s) => { s.receipt.counts.skipped = 1; s.receipt.steps[1] = { name: "missing required control", ok: false, passed: 0, failed: 0, skipped: 1 }; s.receipt.counts.passed = 2; }, "required_results_not_all_passed"],
  ["a required failed assertion", (s) => { s.receipt.steps[1].ok = false; s.receipt.counts = { passed: 2, failed: 1, skipped: 0 }; }, "required_step_not_passed"],
  ["a contradictory successful step", (s) => { s.receipt.steps[1].exitCode = 1; }, "required_step_not_passed"],
  ["invented counts", (s) => { s.receipt.counts.passed = 900; }, "step_counts_disagree_with_receipt"],
  ["missing required steps", (s) => { s.receipt.steps = []; }, "missing_required_steps"],
  ["an absent guard self-check", (s) => { s.receipt.steps[0].name = "unrelated positive"; }, "missing_fixture_mode_refuses_outbound_network"],
  ["missing network-attempt evidence", (s) => { delete s.receipt.blockedNetwork; }, "network_evidence_not_clear"],
  ["an actual outbound-attempt record", (s) => { s.receipt.blockedNetwork = ["synthetic forbidden attempt"]; }, "network_evidence_not_clear"],
  ["a launcher exception", () => { throw new Error("synthetic launch failure"); }, "child_did_not_exit_successfully"],
  ["an absent launcher result", (s) => { s.process = undefined; }, "child_did_not_exit_successfully"],
]) {
  test(`all rejects ${name} and still records the later required suite`, async (t) => {
    const run = await control(t, mutation);
    assert.equal(run.report.exitCode, 1);
    assert.equal(run.report.passed, false);
    assert.ok(run.report.results[1].faults.includes(fault), JSON.stringify(run.report.results[1]));
    assert.equal(run.report.results[2].suite, "last");
    assert.deepEqual(run.report.results[2].faults, []);
    assert.equal(run.calls.length, 3);
  });
}

test("all preserves failed and skipped totals rather than replacing them with an aggregate pass count", async (t) => {
  const run = await control(t, (s) => {
    s.receipt.steps[1] = { name: "synthetic mixed outcome", ok: false, passed: 2, failed: 3, skipped: 4 };
    s.receipt.counts = { passed: 4, failed: 3, skipped: 4 };
  });
  assert.deepEqual(run.report.counts, { passed: 10, failed: 3, skipped: 4 });
  assert.equal(run.report.exitCode, 1);
});

for (const [suite, auxiliary] of [["a11y", "a11y-detail.json"], ["pay-signin", "pay-signin-checks.json"], ["agent", "agent-journey.json"]]) {
  test(`all retains ${auxiliary} without confusing it with the required wrapper`, async (t) => {
    const config = workspace(t);
    let auxiliaryFile;
    const report = await runAllProductSuites({
      ...config, suites: [suite],
      runChild: async (call) => {
        auxiliaryFile = join(call.directory, auxiliary);
        writeFileSync(auxiliaryFile, JSON.stringify({ fixture: "synthetic auxiliary control" }));
        writeFileSync(join(call.directory, receiptName(suite)), JSON.stringify(fixtureReceipt(suite)));
        return { exitCode: 0, signal: null };
      },
    });
    assert.equal(report.exitCode, 0);
    assert.equal(report.results[0].counts.passed, 3);
    assert.match(report.results[0].receipt.file, /2026-10-13T00-00-00-000Z\.json$/);
    assert.deepEqual(JSON.parse(readFileSync(auxiliaryFile)), { fixture: "synthetic auxiliary control" });
  });
}

test("auxiliary and malformed-name files cannot replace a missing timestamped wrapper", async (t) => {
  const config = workspace(t);
  const report = await runAllProductSuites({
    ...config, suites: ["agent"],
    runChild: async (call) => {
      for (const name of ["agent-journey.json", "agent-2026-10-13.json", "agent-2026-10-13T00-00-00-000Z.json.extra"]) {
        writeFileSync(join(call.directory, name), JSON.stringify(fixtureReceipt("agent")));
      }
      return { exitCode: 0, signal: null };
    },
  });
  assert.equal(report.exitCode, 1);
  assert.deepEqual(report.unreportedSuites, ["agent"]);
  assert.ok(report.results[0].faults.includes("exactly_one_fresh_leaf_receipt_required"));
});

test("a missing result is explicitly unreported, even if a prior output directory has a passing receipt", async (t) => {
  const config = workspace(t);
  mkdirSync(config.evidenceDir);
  writeFileSync(join(config.evidenceDir, receiptName("middle")), JSON.stringify(fixtureReceipt("middle")));
  const report = await runAllProductSuites({ ...config, suites: ["middle"], runChild: async () => ({ exitCode: 0, signal: null }) });
  assert.equal(report.exitCode, 1);
  assert.deepEqual(report.unreportedSuites, ["middle"]);
  assert.deepEqual(report.counts, { passed: 0, failed: 0, skipped: 0 });
});

for (const suites of [[], ["first", "first"], ["all"], ["../outside"]]) {
  test(`invalid catalog ${JSON.stringify(suites)} launches no children`, async (t) => {
    let calls = 0;
    await assert.rejects(runAllProductSuites({ ...workspace(t), suites, runChild: async () => { calls++; } }), /leaf-suite catalog/);
    assert.equal(calls, 0);
  });
}

test("all refuses source changes and an unpinned or dirty source", async (t) => {
  let reads = 0;
  const changed = await control(t, undefined, { getSource: () => ({ ...source, gitSha: (++reads === 1 ? "a" : "b").repeat(40) }) });
  assert.equal(changed.report.exitCode, 1);
  assert.ok(changed.report.faults.includes("source_changed_during_run"));
  const dirty = await control(t, undefined, { getSource: () => ({ ...source, gitDirty: true }) });
  assert.ok(dirty.report.faults.includes("clean_pinned_source_required"));
});

test("the real launcher passes fixture arguments to a new process and retains its actual exit", async (t) => {
  const config = workspace(t);
  writeFileSync(config.dispatcher, `import { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst args=process.argv.slice(2);\nconst suite=args[args.indexOf('--suite')+1];\nconst directory=args[args.indexOf('--evidence-dir')+1];\nif(args[args.indexOf('--mode')+1]!=='fixture')process.exit(9);\nwriteFileSync(join(directory,suite+'-2026-10-13T00-00-00-000Z.json'),JSON.stringify({...${JSON.stringify(fixtureReceipt("synthetic"))},suite}));\nprocess.exitCode=7;\n`);
  const report = await runAllProductSuites({ ...config, suites: ["synthetic"] });
  assert.equal(report.exitCode, 1);
  assert.equal(report.results[0].exitCode, 7);
  assert.equal(report.results[0].counts.passed, 3);
  assert.ok(report.results[0].receipt.sha256);
});

test("the actual CLI dispatches all required leaves and retains missing-fixture failures", (t) => {
  const config = workspace(t);
  const repo = fileURLToPath(new URL("..", import.meta.url));
  for (const path of ["scripts/verify-product.mjs", "scripts/lib/product-suite-all.mjs", "scripts/lib/check-result.mjs", "scripts/lib/fixture-network-guard.mjs"]) {
    mkdirSync(dirname(join(config.root, path)), { recursive: true });
    copyFileSync(join(repo, path), join(config.root, path));
  }
  const run = spawnSync(process.execPath, [join(config.root, "scripts/verify-product.mjs"), "--suite", "all", "--mode", "fixture", "--evidence-dir", config.evidenceDir], {
    cwd: config.root, encoding: "utf8", timeout: 20000,
  });
  assert.ifError(run.error);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.doesNotMatch(run.stderr, /unknown suite "all"/);
  const directories = readdirSync(config.evidenceDir);
  assert.equal(directories.length, 1);
  const report = JSON.parse(readFileSync(join(config.evidenceDir, directories[0], "all.json")));
  for (const required of ["foundation", "access", "approval", "order-auth", "finance-context", "research", "creative", "review", "capabilities", "messages", "a11y", "pay-signin", "agent", "download", "production", "degraded", "mail-off", "backup-drill"]) {
    assert.ok(report.requiredSuites.includes(required), required);
    const result = report.results.find((item) => item.suite === required);
    assert.equal(result.exitCode, 1, JSON.stringify(result));
    assert.ok(result.counts.failed > 0);
    assert.ok(result.receipt.sha256);
  }
  assert.equal(report.results.length, report.requiredSuites.length);
  assert.equal(report.exitCode, 1);
  assert.equal(report.counts.passed, 0);
});
