// Fixed cold-process qualification, never a retry-until-match loop. The baseline matrix is preserved;
// two additional original/edited pairs cover the image edition at each selected viewport.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserSessionIdForPair } from "./download-browser-sessions.mjs";

export function retainFirstCapture({ directory, file, png, captureId, sha256, qualification, pairId, phase }) {
  // Preserve an existing authoritative file even if the caller reuses an evidence directory or
  // supplies a duplicate name. A rejected write must never be counted as a newly retained capture.
  writeFileSync(join(directory, file), png, { flag: "wx" });
  if (pairId) qualification.captured(pairId, phase, { captureId, sha256, file });
}

export function captureQualificationPlan(viewports) {
  return [
    ...viewports.map((viewport) => ({ viewport, trial: 0, kind: "baseline" })),
    ...viewports.flatMap((viewport) => [1, 2].map((trial) => ({ viewport, trial, kind: "cold_browser" }))),
  ];
}

export class CaptureQualification {
  constructor(plan, { diagnosticSubset = false } = {}) {
    this.expected = plan.map(({ viewport, trial }) => `${viewport.name}:${trial}`);
    this.sessionIds = new Map(plan.map((item) => [`${item.viewport.name}:${item.trial}`, browserSessionIdForPair(item)]));
    this.diagnosticSubset = diagnosticSubset;
    this.pairs = new Map();
    this.captureIds = new Set();
    this.files = new Set();
    this.violations = [];
    const selected = [...new Set(plan.map(({ viewport }) => viewport.name))];
    const expected = selected.flatMap((name) => [0, 1, 2].map((trial) => `${name}:${trial}`)).sort();
    if (!selected.length || selected.some((name) => !["390", "1440"].includes(name))
      || JSON.stringify([...this.expected].sort()) !== JSON.stringify(expected)
      || !diagnosticSubset && selected.length !== 2) this.violations.push("invalid_or_incomplete_fixed_plan");
  }

  begin(pairId, browserSessionId = this.sessionIds.get(pairId)) {
    if (!this.expected.includes(pairId) || this.pairs.has(pairId) || browserSessionId !== this.sessionIds.get(pairId)) { this.violations.push("unexpected_or_duplicate_pair"); return; }
    this.pairs.set(pairId, { pairId, browserSessionId, phases: {}, status: "started" });
  }

  captured(pairId, phase, { captureId, sha256, file }) {
    const pair = this.pairs.get(pairId);
    if (!pair || pair.status !== "started" || !["original", "edited"].includes(phase) || pair.phases[phase]
      || typeof captureId !== "string" || !/^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(captureId)
      || this.captureIds.has(captureId) || !/^[a-f\d]{64}$/.test(sha256) || !/^[a-z\d-]+\.png$/.test(file)
      || this.files.has(file) || phase === "edited" && !pair.phases.original) {
      this.violations.push("invalid_or_duplicate_first_capture"); return;
    }
    this.captureIds.add(captureId);
    this.files.add(file);
    pair.phases[phase] = { captureId, sha256, file, browserSessionId: pair.browserSessionId, status: "captured_uncompared" };
  }

  compared(pairId, phase, matched, metrics) {
    const capture = this.pairs.get(pairId)?.phases[phase];
    if (!capture || capture.status !== "captured_uncompared" || typeof matched !== "boolean"
      || !Number.isFinite(metrics?.mean) || metrics.mean < 0 || !Number.isFinite(metrics?.bad) || metrics.bad < 0 || metrics.bad > 1) {
      this.violations.push("invalid_or_duplicate_comparison"); return;
    }
    Object.assign(capture, { status: matched ? "passed" : "failed", matched, mean: metrics.mean, bad: metrics.bad });
  }

  finish(pairId, failedAssertions, exception = false) {
    const pair = this.pairs.get(pairId);
    if (!pair || pair.status !== "started" || !Number.isSafeInteger(failedAssertions) || failedAssertions < 0) {
      this.violations.push("invalid_or_duplicate_pair_completion"); return;
    }
    pair.failedAssertions = failedAssertions;
    pair.exception = exception === true;
    pair.status = !pair.exception && failedAssertions === 0 && ["original", "edited"].every((phase) => pair.phases[phase]?.status === "passed") ? "passed" : "failed_or_incomplete";
  }

  snapshot(browserSessions) {
    const sessions = Array.isArray(browserSessions?.sessions) ? browserSessions.sessions : [];
    const pairs = this.expected.map((pairId) => {
      const pair = this.pairs.get(pairId) ?? { pairId, browserSessionId: this.sessionIds.get(pairId), status: "not_attempted", phases: {} };
      const session = sessions.find((candidate) => candidate?.sessionId === pair.browserSessionId);
      return { ...pair, firstCaptureStatus: pair.status, browserSessionPassed: session?.passed === true,
        status: pair.status === "passed" && session?.passed !== true ? "failed_or_incomplete" : pair.status };
    });
    const captures = pairs.flatMap((pair) => Object.values(pair.phases));
    const capturesComplete = this.expected.length > 0 && pairs.every((pair) => ["passed", "failed_or_incomplete"].includes(pair.status))
      && captures.length === this.expected.length * 2 && captures.every((capture) => ["passed", "failed"].includes(capture.status));
    const expectedSessions = [...new Set(this.sessionIds.values())].sort();
    const isolationComplete = browserSessions?.schema === "ticketstub.download-browser-sessions.v1" && browserSessions.complete === true
      && Array.isArray(browserSessions.expectedSessions) && sessions.length === expectedSessions.length
      && JSON.stringify(sessions.map((session) => session?.sessionId).sort()) === JSON.stringify(expectedSessions)
      && JSON.stringify([...browserSessions.expectedSessions].sort()) === JSON.stringify(expectedSessions);
    const complete = capturesComplete && isolationComplete;
    return structuredClone({ schema: "ticketstub.first-capture-qualification.v2", scope: this.diagnosticSubset ? "diagnostic_subset" : "full_matrix",
      baselineBrowserProfileAndCacheShared: true, additionalPairs: "new_process_and_profile_at_each_pair_start",
      editedCaptureSharesItsPairProfile: true, coldAtScreenshotInstantClaim: false, throttling: "baseline_first_load_only",
      policy: "all_fixed_first_captures_must_pass_no_replacement_or_retry", expectedPairs: this.expected.length,
      expectedFirstCaptures: this.expected.length * 2, attemptedPairs: this.pairs.size, recordedFirstCaptures: captures.length,
      comparedFirstCaptures: captures.filter((capture) => ["passed", "failed"].includes(capture.status)).length,
      capturesComplete, isolationComplete, complete,
      // Diagnostic completeness and individual pair results remain available, but only the full
      // matrix may satisfy the consumer's final qualification assertion.
      passed: !this.diagnosticSubset && complete && browserSessions.passed === true && this.violations.length === 0 && pairs.every((pair) => pair.status === "passed"),
      violations: this.violations, pairs });
  }
}
