import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { summarizeNetworkProbe } from "../scripts/lib/check-result.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Run the actual dispatcher and network guard, unchanged, in a throwaway tree.
// Only the check process is synthetic: it lets the real CLI consume contradictory,
// missing and skipped reports without weakening any application check.
function runDispatcher(t, { output = "", errorOutput = "", exitCode = 0, suite = "creative", missingFixture = false, probeWarning = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ticketstub-verification-result-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of ["scripts/verify-product.mjs", "scripts/lib/fixture-network-guard.mjs", "scripts/lib/check-result.mjs"]) {
    if (!existsSync(join(ROOT, file))) continue; // Enables the same CLI regression on the pre-fix source.
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(ROOT, file), join(root, file));
  }
  if (!missingFixture) mkdirSync(join(root, "src/customer/studio/creative/fixtures"), { recursive: true });
  writeFileSync(join(root, "scripts/check-creative-adapter.mjs"), [
    `process.stdout.write(${JSON.stringify(output)});`,
    `process.stderr.write(${JSON.stringify(errorOutput)});`,
    `process.exitCode = ${exitCode};`,
  ].join("\n"));
  const evidenceDir = join(root, "evidence");
  const env = { ...process.env };
  if (probeWarning) {
    const warning = join(root, "probe-warning.mjs");
    writeFileSync(warning, "process.emitWarning(\"probe warning retained\", { code: \"ETICKETSTUB_TEST_WARNING\" });\n");
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --import ${pathToFileURL(warning).href}`.trim();
  }
  const run = spawnSync(process.execPath, [join(root, "scripts/verify-product.mjs"), "--suite", suite, "--mode", "fixture", "--evidence-dir", evidenceDir], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 15000,
  });
  assert.ifError(run.error);
  const files = existsSync(evidenceDir) ? readdirSync(evidenceDir) : [];
  const evidence = files.length === 1 ? JSON.parse(readFileSync(join(evidenceDir, files[0]), "utf8")) : null;
  return { ...run, evidence, step: evidence?.steps.find((s) => s.name === "scripts/check-creative-adapter.mjs") };
}

const detail = (run) => JSON.stringify({ status: run.status, stdout: run.stdout, stderr: run.stderr, evidence: run.evidence }, null, 2);

for (const scenario of [
  { name: "FAIL report despite zero child exit", output: "FAIL required assertion\n", passed: 0, failed: 1, skipped: 0 },
  { name: "a passing check cannot hide a later failure", output: "PASS first assertion\nFAIL second assertion\n", passed: 1, failed: 1, skipped: 0 },
  { name: "stderr failure despite zero child exit", output: "PASS first assertion\n", errorOutput: "FAIL second assertion\n", passed: 1, failed: 1, skipped: 0 },
  { name: "empty zero-exit report", output: "", passed: 0, failed: 0, skipped: 0 },
  { name: "unknown zero-exit report", output: "Everything looks good\n", passed: 0, failed: 0, skipped: 0 },
  { name: "nonzero child exit even with a passing report", output: "PASS first assertion\n", exitCode: 7, passed: 1, failed: 0, skipped: 0 },
  { name: "a required skipped check", output: "PASS first assertion\nskip required browser check: unavailable\n", passed: 1, failed: 0, skipped: 1 },
  { name: "a skip directive on an otherwise positive line", output: "ok 1 - browser check # SKIP browser unavailable\n", passed: 0, failed: 0, skipped: 1 },
  { name: "an indented failure after a passing check", output: "PASS first assertion\n   FAIL second assertion\n", passed: 1, failed: 1, skipped: 0 },
  { name: "an explicit not-ok result", output: "not ok 1 - required assertion\n", passed: 0, failed: 1, skipped: 0 },
  { name: "bare markers without a named result", output: "PASS\nOK:\nok\n", passed: 0, failed: 0, skipped: 0 },
  { name: "a contradictory TAP failure footer", output: "PASS first assertion\n# fail 1\n", passed: 1, failed: 1, skipped: 0 },
  { name: "a contradictory TAP skip footer", output: "PASS first assertion\n# skipped 1\n", passed: 1, failed: 0, skipped: 1 },
  { name: "a contradictory numeric failure summary", output: "PASS first assertion\n1 passed, 1 failed\n", passed: 1, failed: 1, skipped: 0 },
  { name: "a contradictory numeric skip summary", output: "PASS first assertion\n1 passed, 0 failed, 1 skipped\n", passed: 1, failed: 0, skipped: 1 },
  { name: "a prefixed failure summary with a samples path", output: "PASS first assertion\ndownload: 1 passed, 2 failed. Samples: /tmp/fixture-samples\n", passed: 1, failed: 2, skipped: 0 },
  { name: "an unquantified failure summary", output: "PASS first assertion\n1 checks passed, some failed.\n", passed: 1, failed: 0, skipped: 0, detail: "summary declares failures without a count" },
  { name: "a zero footer cannot erase a failure result", output: "PASS first assertion\nFAIL second assertion\n1 passed, 0 failed\n# fail 0\n", passed: 1, failed: 1, skipped: 0 },
  { name: "a repeated footer does not double-count the same failure", output: "PASS first assertion\nFAIL second assertion\n1 passed, 1 failed\n# fail 1\n", passed: 1, failed: 1, skipped: 0 },
  { name: "a repeated footer does not double-count the same skip", output: "PASS first assertion\nskip required browser check\n# skipped 1\n", passed: 1, failed: 0, skipped: 1 },
  { name: "cancelled and TODO results remain unfinished", output: "PASS first assertion\n# cancelled 1\n# todo 2\n", passed: 1, failed: 0, skipped: 3 },
  { name: "a positive summary is not a named passing result", output: "42 passed, 0 failed\n", passed: 0, failed: 0, skipped: 0 },
]) {
  test(`dispatcher rejects ${scenario.name} and retains its actual result`, (t) => {
    const run = runDispatcher(t, scenario);
    assert.equal(run.status, 1, detail(run));
    assert.equal(run.evidence.exitCode, 1);
    assert.equal(run.step.ok, false, detail(run));
    assert.equal(run.step.exitCode, scenario.exitCode ?? 0);
    assert.equal(run.step.passed, scenario.passed);
    assert.equal(run.step.failed, scenario.failed);
    assert.equal(run.step.skipped, scenario.skipped);
    assert.equal(run.step.detail, scenario.detail);
    assert.ok(run.stdout.includes(scenario.output));
    assert.ok(run.stdout.includes(scenario.errorOutput ?? ""));
  });
}

for (const scenario of [
  { name: "ok lines with ordinary summaries", output: "ok  first assertion\nok  second assertion\n\n2 passed, 0 failed\n", passed: 2 },
  { name: "PASS lines with CRLF", output: "PASS first assertion\r\nPASS second assertion\r\n", passed: 2 },
  { name: "the creative adapter's existing terminal assertion", output: "op -> engine operation / fields that did not travel\n  edit\nPENDING_ placeholders (1):\n  fixture-only\n\nOK: adapter output matches the creative-engine fixtures structurally.\n", passed: 1 },
  { name: "a passed assertion describing a safe skip outcome", output: "ok  lookup: no key is skipped, makes no request\n", passed: 1 },
  { name: "zero TAP negative counts", output: "ok 1 - first assertion\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0\n", passed: 1 },
  { name: "a prefixed summary with elapsed time", output: "PASS first assertion\npay-signin: 1 passed, 0 failed in 0.1s\n", passed: 1 },
  { name: "a check-count summary", output: "PASS first assertion\n1 checks passed.\n", passed: 1 },
]) {
  test(`dispatcher accepts ${scenario.name} without inventing check counts`, (t) => {
    const run = runDispatcher(t, scenario);
    assert.equal(run.status, 0, detail(run));
    assert.equal(run.evidence.exitCode, 0);
    assert.equal(run.step.ok, true);
    assert.equal(run.step.passed, scenario.passed);
    assert.equal(run.step.failed, 0);
    assert.equal(run.step.skipped, 0);
  });
}

test("unknown suites still fail before execution and produce no success evidence", (t) => {
  const run = runDispatcher(t, { suite: "unknown-suite", output: "PASS should not execute\n" });
  assert.equal(run.status, 2, detail(run));
  assert.match(run.stderr, /unknown suite/);
  assert.equal(run.evidence, null);
  assert.ok(!run.stdout.includes("PASS should not execute"));
});

test("missing required fixtures fail without running a successful child", (t) => {
  const run = runDispatcher(t, { missingFixture: true, output: "PASS should not execute\n" });
  assert.equal(run.status, 1, detail(run));
  assert.equal(run.evidence.exitCode, 1);
  assert.equal(run.step, undefined);
  assert.ok(run.evidence.steps.some((s) => s.ok === false && /missing/.test(s.detail)));
  assert.ok(!run.stdout.includes("PASS should not execute"));
});

test("network probe accepts its exact stdout token with stderr warnings and retains both streams", () => {
  const stdout = "ETICKETSTUB_FIXTURE_NETWORK\n", stderr = "(node:12) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental\n";
  assert.deepEqual(summarizeNetworkProbe(0, stdout, stderr), { exitCode: 0, stdout, stderr, ok: true });
});
for (const scenario of [
  { name: "nonzero exit with valid token", code: 7, stdout: "ETICKETSTUB_FIXTURE_NETWORK\n" },
  { name: "missing exit status", code: null, stdout: "ETICKETSTUB_FIXTURE_NETWORK\n" },
  { name: "unexpected token", code: 0, stdout: "REACHED\n" },
  { name: "missing token", code: 0, stdout: "" },
  { name: "additional stdout", code: 0, stdout: "ETICKETSTUB_FIXTURE_NETWORK\nREACHED\n" },
  { name: "token only on stderr", code: 0, stdout: "", stderr: "ETICKETSTUB_FIXTURE_NETWORK\n" },
]) test(`network probe rejects ${scenario.name}`, () => {
  assert.equal(summarizeNetworkProbe(scenario.code, scenario.stdout, scenario.stderr ?? "").ok, false);
});

test("actual dispatcher passes the real offline guard with inherited preload warnings and preserves diagnostics", (t) => {
  const run = runDispatcher(t, { output: "PASS synthetic fixture assertion\n", probeWarning: true });
  assert.equal(run.status, 0, detail(run));
  const probe = run.evidence.steps.find(s => s.name === "fixture mode refuses outbound network");
  assert.equal(probe.ok, true);
  assert.equal(probe.exitCode, 0);
  assert.equal(probe.stdout, "ETICKETSTUB_FIXTURE_NETWORK\n");
  assert.match(probe.stderr, /ETICKETSTUB_TEST_WARNING.*probe warning retained/);
  assert.match(run.stderr, /ETICKETSTUB_TEST_WARNING.*probe warning retained/);
});
