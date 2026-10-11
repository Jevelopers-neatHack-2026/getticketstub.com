import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// scripts/summarize-ops-telemetry.mjs as an operator runs it: JSON lines on stdin, a summary on stdout.
// Every fixture is synthetic; private-looking values are seeded so their absence from all output can be checked.
const script = fileURLToPath(new URL("../scripts/summarize-ops-telemetry.mjs", import.meta.url));
const run = (lines, args = []) => {
  const r = spawnSync(process.execPath, [script, ...args], { input: lines.join("\n") + "\n", encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
};
const json = (lines, args = []) => JSON.parse(run(lines, ["--format=json", ...args]).out);

const SEED = "seedprivate7c2e";
let n = 0;
const opId = () => `op_${String(++n).padStart(16, "A")}`;
const rec = (name, fields, env = {}) => JSON.stringify({ schema: "ticketstub.ops/1", name, at: 1_791_000_000_000 + n, environment: "production", mode: "live", operationId: opId(), fields, ...env });
const api = (fields, env) => rec("api_request", { route: "agent", operation: "agent_reply", status: 200, outcome: "success", durationMs: 10, dependency: "provider", fallback: "none", attempts: 1, ...fields }, env);
const attempt = (fields, env) => rec("provider_attempt", { attemptId: `att_${String(++n).padStart(16, "B")}`, attempt: 1, capability: "agent", provider: "openrouter", phase: "generate", model: "anthropic/test-model", outcome: "ok", durationMs: 100, costSource: "unknown", usageReported: false, ...fields }, env);

test("latency percentiles, outcomes and statuses per route", () => {
  const lines = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((ms) => api({ durationMs: ms }));
  lines.push(api({ status: 429, outcome: "rate_limited", code: "provider_rate_limited", durationMs: 50 }));
  const s = json(lines);
  assert.equal(s.apiRequests.length, 1);
  const g = s.apiRequests[0];
  assert.equal(g.requests, 11);
  assert.deepEqual(g.latencyMs, { n: 11, p50: 6, p95: 50, max: 50 });
  assert.deepEqual(g.outcome, { success: 10, rate_limited: 1 });
  assert.deepEqual(g.status, { 200: 10, 429: 1 });
  assert.deepEqual(g.code, { provider_rate_limited: 1 });
  assert.equal(g.attempts, 11);
});

test("cost stays unknown unless the provider reported it, and is never called billed spend", () => {
  const none = json([attempt({}), attempt({ costSource: "provider_reported" })]); // the second: reported but out of range, dropped
  const c = none.providerAttempts[0].cost;
  assert.equal(c.providerReportedUsd, null); assert.equal(c.reportedAttempts, 0); assert.equal(c.unknownAttempts, 2);
  assert.equal(none.providerAttempts[0].tokens.input.sum, null);
  const text = run([attempt({})]).out;
  assert.match(text, /cost \(provider-reported, not billed spend\): unknown from 0\/1 attempts; unknown for 1/);
  assert.match(text, /tokens: input=unknown/);
  assert.ok(!/\$0(\D|$)/.test(text), "unknown cost is not printed as $0");

  const some = json([attempt({ costUsd: 0.25, costSource: "provider_reported", inputTokens: 10, outputTokens: 2, usageReported: true }), attempt({ costUsd: 0.5, costSource: "provider_reported", inputTokens: 5, usageReported: true }), attempt({})]);
  const p = some.providerAttempts[0];
  assert.deepEqual(p.cost, { providerReportedUsd: 0.75, reportedAttempts: 2, unknownAttempts: 1, coverage: 0.6667, note: "provider-reported, not billed spend" });
  assert.deepEqual(p.tokens.input, { sum: 15, reportedAttempts: 2 }); assert.deepEqual(p.tokens.output, { sum: 2, reportedAttempts: 1 });
});

test("provider failures, upstream statuses and source fetches stay separate from AI usage", () => {
  const s = json([
    attempt({ outcome: "error", code: "provider_unavailable", upstreamStatus: 503 }),
    attempt({ outcome: "timeout", code: "provider_request_cancelled" }),
    rec("source_fetch", { source: "weather_geocode", outcome: "network_error", durationMs: 30 }),
    rec("source_fetch", { source: "event_page", outcome: "http_error", upstreamStatus: 404, durationMs: 20 }),
    rec("source_parse", { parser: "schema_org", outcome: "ok", facts: 3, date: true }),
  ]);
  const p = s.providerAttempts[0];
  assert.deepEqual(p.outcome, { error: 1, timeout: 1 }); assert.deepEqual(p.upstreamStatus, { 503: 1 });
  assert.deepEqual(s.sourceFetches.map((g) => [g.source, g.outcome]), [["weather_geocode", { network_error: 1 }], ["event_page", { http_error: 1 }]]);
  assert.ok(s.sourceFetches.every((g) => !("cost" in g) && !("tokens" in g)));
  assert.deepEqual(s.sourceParses, [{ environment: "production", mode: "live", parser: "schema_org", parses: 1, facts: 3, withDate: 1 }]);
});

test("environment and mode filters keep demo and preview apart from production", () => {
  const lines = [api({}), api({}, { mode: "demo" }), api({}, { environment: "preview" })];
  const s = json(lines, ["--environment=production", "--mode=live"]);
  assert.equal(s.input.accepted, 1); assert.equal(s.input.filteredOut, 2);
  assert.deepEqual(s.scope, { "production/live": 1 });
});

test("hosting prefixes and Docker json-file wrappers are read; the prefix is never echoed", () => {
  const line = api({});
  const s = json([
    `2026-10-11T19:40:00.000Z stdout F ${line}`,
    `web.1 | ${SEED} user@example.com https://example.com/?q=${SEED} ${api({})}`,
    JSON.stringify({ log: `${api({})}\n`, stream: "stdout", time: "2026-10-11T19:40:00Z" }),
    JSON.stringify({ message: api({}) }),
  ]);
  assert.equal(s.input.accepted, 4);
});

test("seeded private values and identifiers never reach the output; bad records are rejected whole", () => {
  const lines = [
    `request from ${SEED}@example.com to https://example.com/s/${SEED}?token=${SEED}`,
    `prompt: tell me about ${SEED}`,
    api({ prompt: `about ${SEED}` }), // unknown field
    api({ code: `https://example.com/${SEED}` }), // URL as a code
    api({ code: `zz_${SEED}` }), // well-formed but unknown code: counted as "other"
    api({ route: SEED }), // not in the enum
    api({}, { url: `https://example.com/${SEED}` }), // extra envelope field
    api({}, { operationId: `op_${SEED}@example.com` }),
    attempt({ model: `${SEED}@example.com` }),
    attempt({ model: `anthropic/model?key=${SEED}` }),
    attempt({ model: "Jane Doe" }), // valid shape for the sanitizer, but not a printable model name
    attempt({ returnedModel: `sk-or-v1-${SEED}abcdefabcdefabcdefabcdef` }),
    `{"schema":"ticketstub.ops/1","name":"api_request","fields":{"x":"${SEED}"`, // truncated JSON
    `{"schema":"ticketstub.ops/1","pad":"${SEED.repeat(2000)}"}`, // oversize
    api({}),
  ];
  const r = run(lines);
  const j = run(lines, ["--format=json"]);
  for (const out of [r.all, j.all]) {
    for (const bad of [SEED, "@", "http", "example", "Jane", "op_", "att_", "sk-", "prompt", "token="]) assert.ok(!out.includes(bad), `leaked ${bad}`);
  }
  const s = JSON.parse(j.out);
  assert.equal(s.input.ignoredNonOps, 2);
  assert.deepEqual(s.input.rejected, { unknown_field: 1, bad_value: 5, unknown_envelope_field: 1, bad_envelope: 1, invalid_json: 1, oversize_line: 1 });
  assert.equal(s.input.accepted, 3);
  assert.deepEqual(s.apiRequests[0].code, { other: 1 });
  assert.deepEqual(s.providerAttempts.map((p) => p.model), ["other_model"]);
});

test("--strict fails on rejected records; bad arguments are refused without being echoed", () => {
  assert.equal(run([api({})], ["--strict"]).code, 0);
  assert.equal(run([api({ prompt: "x" })], ["--strict"]).code, 1);
  const bad = run([api({})], [`--environment=${SEED}`]);
  assert.equal(bad.code, 2); assert.ok(!bad.all.includes(SEED)); assert.match(bad.err, /usage:/);
});

test("distinct groups are capped, and the overflow group carries no record's labels", () => {
  const lines = [];
  for (let i = 0; i < 60; i++) lines.push(attempt({ model: `openai/m${i}` }));
  const s = json(lines);
  assert.equal(s.providerAttempts.length, 51);
  const other = s.providerAttempts.at(-1);
  assert.equal(other.model, "other"); assert.equal(other.attempts, 10);
});

test("without filters, environments are never pooled: production latency is not hidden by preview", () => {
  const lines = [];
  for (let i = 0; i < 20; i++) lines.push(api({ durationMs: 100 }), attempt({ durationMs: 100 }));
  for (let i = 0; i < 20; i++) lines.push(api({ durationMs: 10_000 }, { environment: "preview" }), attempt({ durationMs: 10_000 }, { environment: "preview" }));
  const s = json(lines);
  for (const table of [s.apiRequests, s.providerAttempts]) {
    assert.deepEqual(table.map((g) => [g.environment, g.mode, g.latencyMs.p95]), [["production", "live", 100], ["preview", "live", 10_000]]);
  }
  const text = run(lines).out;
  assert.match(text, /\[production\/live\] agent\/agent_reply: requests=20 n=20 p50=100ms p95=100ms/);
  assert.match(text, /\[preview\/live\] agent\/agent_reply: requests=20 n=20 p50=10000ms p95=10000ms/);
  assert.ok(!/^ {2}\[live\]/m.test(text), "no row is labelled by mode alone");
});

test("overflow is partitioned by environment and mode: a demo record never joins a live overflow", () => {
  const lines = [];
  for (let i = 0; i < 51; i++) lines.push(attempt({ model: `openai/m${i}`, durationMs: 100 }));
  lines.push(attempt({ model: "openai/demo-only", durationMs: 7 }, { mode: "demo" }));
  lines.push(attempt({ model: "openai/preview-only", durationMs: 9 }, { environment: "preview" }));
  lines.push(attempt({ model: "openai/m52", durationMs: 100 }));
  const s = json(lines);
  const overflow = s.providerAttempts.filter((g) => g.model === "other");
  assert.deepEqual(overflow.map((g) => [g.environment, g.mode, g.attempts, g.latencyMs.max]).sort(), [
    ["preview", "live", 1, 9], ["production", "demo", 1, 7], ["production", "live", 2, 100],
  ]);
  assert.equal(s.providerAttempts.filter((g) => g.model !== "other").length, 50);
  assert.equal(s.providerAttempts.reduce((n, g) => n + g.attempts, 0), lines.length);
  // Bounded: however many scopes and keys arrive, overflow adds at most one group per environment/mode.
  const many = [];
  for (const environment of ["production", "preview", "development", "test", "unspecified"]) for (const mode of ["live", "demo"]) for (let i = 0; i < 60; i++) many.push(attempt({ model: `openai/x${i}` }, { environment, mode }));
  const m = json(many);
  assert.equal(m.providerAttempts.length, 50 + 10);
  assert.equal(m.providerAttempts.reduce((n, g) => n + g.attempts, 0), many.length);
});

test("empty input is a valid, empty summary", () => {
  const r = run([]);
  assert.equal(r.code, 0);
  assert.match(r.out, /accepted=0/); assert.match(r.out, /Provider attempts[^\n]*\n {2}none/);
});
