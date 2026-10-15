/**
 * Summarize the product check scripts' explicit result lines. Counts describe
 * emitted results, not assertions hidden inside a script. The creative adapter
 * emits one terminal `OK:` assertion; the other callers use `ok` or `PASS`.
 * Diagnostic tables and summary prose cannot stand in for a positive result.
 * A negative summary can reveal omitted results, but cannot erase result lines
 * or double-count the same failure/skip. TODO and cancelled checks are unfinished.
 */
export function summarizeCheckResult(exitCode, output) {
  const lines = typeof output === "string" ? output.split(/\r?\n/) : [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const summaries = { failed: 0, skipped: 0, cancelled: 0, todo: 0 };
  let unknownFailureCount = false;
  for (const raw of lines) {
    const line = raw.trimStart();
    const tapSummary = /^#\s+(fail|skipped|cancelled|todo)\s+(\d+)\s*$/i.exec(line);
    if (tapSummary) {
      const kind = tapSummary[1].toLowerCase() === "fail" ? "failed" : tapSummary[1].toLowerCase();
      summaries[kind] = Math.max(summaries[kind], Number(tapSummary[2]));
      continue;
    }
    // Existing callers print `N passed, M failed`, sometimes with a suite
    // prefix, elapsed time, or a samples path, and `N checks passed, some failed`.
    const summary = /^(?:[\w-]+:\s*)?\d+\s+(?:checks\s+)?passed\b(.*)$/i.exec(line);
    if (summary) {
      for (const [, count, kind] of summary[1].matchAll(/,\s*(\d+)\s+(failed|skipped|cancelled|todo)\b/gi)) {
        summaries[kind.toLowerCase()] = Math.max(summaries[kind.toLowerCase()], Number(count));
      }
      if (/^,\s*some failed\b/i.test(summary[1])) unknownFailureCount = true;
      continue;
    }
    // A TAP-style directive is a skipped required check even on an `ok` line.
    // In contrast, an ordinary passing label may describe a safe skip outcome.
    if (/^(?:skip(?:ped)?|todo)\b/i.test(line) || /\s#\s*(?:SKIP|TODO)\b/i.test(line)) {
      skipped++;
    } else if (/^(?:FAIL|not ok)\b/.test(line)) {
      failed++;
    } else if (/^(?:(?:ok|PASS)\s+|OK:\s+)\S/.test(line)) {
      passed++;
    }
  }
  failed = Math.max(failed, summaries.failed);
  skipped = Math.max(skipped, summaries.skipped + summaries.cancelled + summaries.todo);
  return {
    exitCode, passed, failed, skipped,
    ...(unknownFailureCount ? { detail: "summary declares failures without a count" } : {}),
    ok: exitCode === 0 && passed > 0 && failed === 0 && skipped === 0 && !unknownFailureCount,
  };
}

/** The network guard's self-check has one stdout token; stderr remains diagnostic evidence. */
export function summarizeNetworkProbe(exitCode, stdout, stderr) {
  return {
    exitCode, stdout, stderr,
    ok: exitCode === 0 && typeof stdout === "string" && stdout.trim() === "ETICKETSTUB_FIXTURE_NETWORK",
  };
}
