import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const COUNT_KEYS = ["passed", "failed", "skipped"];
const validCount = (value) => Number.isSafeInteger(value) && value >= 0;
const validCounts = (counts) => counts && COUNT_KEYS.every((key) => validCount(counts[key]));

function readSource(root) {
  const git = (...args) => {
    try {
      return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  const status = git("status", "--porcelain");
  return { gitSha: git("rev-parse", "HEAD"), gitDirty: status === null ? null : status !== "", node: process.version };
}

function spawnLeaf({ root, command }) {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { cwd: root, stdio: "inherit" });
    child.once("error", (error) => resolve({ exitCode: null, signal: null, errorCode: error.code ?? "spawn_error" }));
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

function inspectReceipt({ suite, directory, source, processResult }) {
  const result = { suite, ...processResult, receipt: null, counts: null, faults: [] };
  if (processResult.exitCode !== 0 || processResult.signal || processResult.errorCode) result.faults.push("child_did_not_exit_successfully");
  try {
    // Match the dispatcher's timestamped wrapper, keeping each suite's auxiliary
    // JSON (a11y-detail, pay-signin-checks, agent-journey) as separate evidence.
    const receiptName = new RegExp(`^${suite}-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z\\.json$`);
    const files = readdirSync(directory).filter((name) => receiptName.test(name));
    if (files.length !== 1) {
      result.faults.push("exactly_one_fresh_leaf_receipt_required");
      return result;
    }
    const file = join(directory, files[0]);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) {
      result.faults.push("invalid_leaf_receipt_file");
      return result;
    }
    const bytes = readFileSync(file);
    result.receipt = { file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    const data = JSON.parse(bytes);
    if (data.suite !== suite || data.mode !== "fixture") result.faults.push("receipt_suite_or_mode_mismatch");
    if (data.gitSha !== source.gitSha || data.gitDirty !== source.gitDirty || data.node !== source.node) result.faults.push("receipt_source_or_runtime_mismatch");
    if (data.exitCode !== 0) result.faults.push("receipt_exit_not_successful");
    if (!validCounts(data.counts)) result.faults.push("invalid_or_missing_counts");
    else {
      result.counts = Object.fromEntries(COUNT_KEYS.map((key) => [key, data.counts[key]]));
      if (data.counts.passed === 0 || data.counts.failed !== 0 || data.counts.skipped !== 0) result.faults.push("required_results_not_all_passed");
    }
    if (!Array.isArray(data.blockedNetwork) || data.blockedNetwork.length !== 0) result.faults.push("network_evidence_not_clear");
    if (!Array.isArray(data.steps) || data.steps.length === 0) result.faults.push("missing_required_steps");
    else {
      if (!data.steps.every((step) => step && step.ok === true && (step.exitCode === undefined || step.exitCode === 0))) result.faults.push("required_step_not_passed");
      for (const name of ["fixture mode refuses outbound network", "no outbound network attempted"]) {
        if (!data.steps.some((step) => step?.name === name && step.ok === true)) result.faults.push(`missing_${name.replaceAll(" ", "_")}`);
      }
      const totals = { passed: 0, failed: 0, skipped: 0 };
      let countsValid = true;
      for (const step of data.steps) {
        for (const key of COUNT_KEYS) {
          const count = step?.[key] ?? (key === "passed" ? Number(step?.ok === true) : key === "failed" ? Number(step?.ok !== true) : 0);
          if (!validCount(count)) countsValid = false;
          else totals[key] += count;
        }
      }
      if (!countsValid || !validCounts(data.counts) || !COUNT_KEYS.every((key) => totals[key] === data.counts[key])) result.faults.push("step_counts_disagree_with_receipt");
    }
  } catch (error) {
    result.faults.push(error instanceof SyntaxError ? "malformed_leaf_receipt" : "unreadable_leaf_receipt");
  }
  return result;
}

/**
 * Run the current declared leaf catalog serially. This is local fixture coverage,
 * not the correlated specialist integration journey or an accepted release.
 * Fresh per-leaf directories prevent a prior receipt from qualifying this run.
 * Continue after failures so the report retains every attempted required suite.
 */
export async function runAllProductSuites({ root, dispatcher, suites, evidenceDir, runChild = spawnLeaf, getSource = readSource, log = console.log }) {
  if (!Array.isArray(suites) || suites.length === 0 || new Set(suites).size !== suites.length || suites.some((suite) => !/^[a-z][a-z0-9-]*$/.test(suite) || suite === "all")) {
    throw new Error("all requires a nonempty unique leaf-suite catalog");
  }
  const startedAt = new Date().toISOString();
  const source = getSource(root);
  mkdirSync(evidenceDir, { recursive: true });
  const runDirectory = mkdtempSync(join(evidenceDir, "all-"));
  const results = [];
  for (const suite of suites) {
    const directory = join(runDirectory, suite);
    mkdirSync(directory);
    const command = [process.execPath, dispatcher, "--suite", suite, "--mode", "fixture", "--evidence-dir", directory];
    log(`all (fixture): running ${suite}`);
    let processResult;
    try {
      processResult = await runChild({ root, command, suite, directory });
    } catch {
      processResult = { exitCode: null, signal: null, errorCode: "child_launch_failed" };
    }
    if (!processResult || typeof processResult !== "object") processResult = { exitCode: null, signal: null, errorCode: "missing_child_result" };
    const result = inspectReceipt({ suite, directory, source, processResult });
    result.command = command;
    if (result.receipt) result.receipt.file = relative(evidenceDir, result.receipt.file);
    results.push(result);
    log(`${result.faults.length ? "FAIL" : "PASS"} all leaf ${suite}${result.faults.length ? `: ${result.faults.join(", ")}` : ""}`);
  }
  const faults = [];
  if (!/^[a-f0-9]{40}$/.test(source.gitSha ?? "") || source.gitDirty !== false) faults.push("clean_pinned_source_required");
  const finalSource = getSource(root);
  if (source.gitSha !== finalSource.gitSha || source.gitDirty !== finalSource.gitDirty) faults.push("source_changed_during_run");
  const counts = results.reduce((sum, result) => {
    if (result.counts) for (const key of COUNT_KEYS) sum[key] += result.counts[key];
    return sum;
  }, { passed: 0, failed: 0, skipped: 0 });
  if (!validCounts(counts)) faults.push("aggregate_counts_out_of_range");
  const passed = faults.length === 0 && results.length === suites.length && results.every((result) => result.faults.length === 0);
  const report = {
    schema: "ticketstub-product-all/1", suite: "all", mode: "fixture",
    scope: "every declared app leaf fixture suite; integration journey and release acceptance are separate",
    startedAt, finishedAt: new Date().toISOString(), ...source, finalSource,
    requiredSuites: suites, results, counts, unreportedSuites: results.filter((result) => !result.counts).map((result) => result.suite),
    faults, passed, exitCode: passed ? 0 : 1,
  };
  const file = join(runDirectory, "all.json");
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  log(`all (fixture): ${counts.passed} reported passed, ${counts.failed} reported failed, ${counts.skipped} reported skipped; ${results.filter((result) => result.faults.length).length} unqualified suites -> exit ${report.exitCode}\nevidence: ${file}`);
  return { ...report, file };
}
