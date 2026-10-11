#!/usr/bin/env node
// Summarize TicketStub operational telemetry (schema ticketstub.ops/1) read as JSON lines on stdin.
//
//   TICKETSTUB_OPS_TELEMETRY=log npm start 2>&1 | tee ops.log
//   node scripts/summarize-ops-telemetry.mjs [--environment=production] [--mode=live] [--format=text|json] [--strict] < ops.log
//
// Dependency-free. Input is untrusted log text: every record is re-checked against the same allow-list the server
// sanitizer uses (src/server/observability/schema.ts), and a record with any unknown field or ill-fitting value is
// rejected whole and only counted. Output is aggregates only: no raw line, operation/attempt id, URL, email, prompt
// or unknown string is ever printed. Unknown cost stays unknown (never summed as zero), and provider-reported cost
// is not billed spend. See docs/operations/analytics-ops-reporting.md.
import { createInterface } from "node:readline";

const SCHEMA = "ticketstub.ops/1";
const MARKER = `{"schema":"${SCHEMA}"`;
const MAX_LINE = 16_384;
const MAX_GROUPS = 50;

// ---------------------------------------------------------------------------------------------
// The allow-list (mirrors OPS_SPEC in src/server/observability/schema.ts)
// ---------------------------------------------------------------------------------------------

const OUTCOMES = ["success", "no_content", "invalid_input", "forbidden", "rejected", "rate_limited", "upstream_error", "server_error", "aborted"];
const SPEC = {
  api_request: {
    route: ["research", "art", "agent"],
    operation: ["research_link", "research_search", "art_generate", "agent_reply", "unknown"],
    status: "status", outcome: OUTCOMES, durationMs: "ms",
    dependency: ["none", "demo", "fixture", "page", "ticketmaster", "provider", "procedural"],
    fallback: ["none", "simulated", "procedural", "slug", "rules", "no_enrichment"],
    code: "code", aborted: "flag", attempts: "count", quota: ["ok", "limited", "storage_off"],
    results: "count", facts: "count", clientCorrelation: "flag",
  },
  provider_attempt: {
    attemptId: "id", attempt: "count", capability: ["research", "agent", "art"], provider: ["openrouter", "openai", "anthropic"],
    phase: ["model_check", "generate"], model: "model", returnedModel: "model", upstreamProvider: "model",
    outcome: ["ok", "error", "cancelled", "timeout"], code: "code", upstreamStatus: "status", durationMs: "ms",
    inputTokens: "count", outputTokens: "count", totalTokens: "count", costUsd: "usd",
    costSource: ["provider_reported", "unknown"], usageReported: "flag",
  },
  source_fetch: {
    source: ["event_page", "ticketmaster", "weather_geocode", "weather_forecast", "weather_archive"],
    outcome: ["ok", "http_error", "timeout", "network_error", "no_match", "no_data", "pending", "skipped", "rate_limited", "auth_failed", "not_found", "bad_response"],
    upstreamStatus: "status", durationMs: "ms",
  },
  source_parse: { parser: ["schema_org", "title", "none"], outcome: ["ok", "empty"], facts: "count", date: "flag" },
};
const ENVIRONMENTS = ["production", "preview", "development", "test", "unspecified"];
const MODES = ["demo", "live"];
const ENVELOPE = ["schema", "name", "at", "environment", "mode", "operationId", "fields"];

/** Codes the routes and transport actually return. Any other well-formed code is printed only as "other". */
const KNOWN_CODES = new Set([
  "bad_request", "bad_json", "too_large", "bad_origin", "unauthorized", "forbidden", "not_found", "rate_limited", "internal",
  "unreadable_link", "demo_only", "art_limit", "storage_unavailable", "server_only",
  "missing_provider_key", "invalid_provider_configuration", "invalid_model_configuration", "unsupported_image_model",
  "provider_authentication_failed", "provider_rate_limited", "provider_unavailable", "provider_request_cancelled",
  "unsupported_provider_request", "invalid_provider_response", "unsupported_provider_response", "invalid_image_response",
]);

const ID = /^(?:op|att)_[A-Za-z0-9_-]{16,24}$/;
const CODE = /^[a-z][a-z0-9_]{0,47}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9 _.:/-]{0,99}$/;
const CREDENTIALISH = /(?:sk[-_]|bearer|secret|token|api[-_]?key|apikey|passw|authoriz|private[-_]?key)/i;
const LONG_RUN = /[A-Za-z0-9]{32,}/;
const EMAIL = /[^\s@]+@[^\s@]+/;
const URLISH = /(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|www\.|[?&#=]|%[0-9a-f]{2})/i;
/** Model names are printed only in a provider model shape; anything else that passed validation is "other_model". */
const PRINTABLE_MODEL = /^(?:(?:openai|anthropic)\/[a-z0-9][a-z0-9_.:-]{0,79}|(?:claude|gpt)-[a-z0-9_.-]{1,60})$/;
const safeString = (v) => !CREDENTIALISH.test(v) && !LONG_RUN.test(v) && !EMAIL.test(v) && !URLISH.test(v);

function fits(kind, v) {
  if (Array.isArray(kind)) return typeof v === "string" && kind.includes(v);
  switch (kind) {
    case "id": return typeof v === "string" && ID.test(v);
    case "code": return typeof v === "string" && CODE.test(v) && safeString(v) && !/[a-z0-9]{24,}/.test(v);
    case "model": return typeof v === "string" && MODEL.test(v) && safeString(v);
    case "status": return Number.isInteger(v) && v >= 100 && v <= 599;
    case "ms": return Number.isInteger(v) && v >= 0 && v <= 3_600_000;
    case "count": return Number.isSafeInteger(v) && v >= 0 && v <= 1_000_000_000;
    case "usd": return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 10_000;
    case "flag": return typeof v === "boolean";
  }
  return false;
}

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** The record if it is a valid ticketstub.ops/1 event, otherwise the reason bucket it is counted under. */
function validate(rec) {
  if (!isPlain(rec) || rec.schema !== SCHEMA) return "not_ops";
  if (Object.keys(rec).some((k) => !ENVELOPE.includes(k))) return "unknown_envelope_field";
  if (!Object.hasOwn(SPEC, rec.name)) return "unknown_name";
  if (!ENVIRONMENTS.includes(rec.environment) || !MODES.includes(rec.mode)) return "bad_envelope";
  if (!Number.isInteger(rec.at) || rec.at <= 0 || rec.at >= 8.64e15) return "bad_envelope";
  if (typeof rec.operationId !== "string" || !/^op_/.test(rec.operationId) || !ID.test(rec.operationId)) return "bad_envelope";
  if (!isPlain(rec.fields)) return "bad_fields";
  const spec = SPEC[rec.name];
  for (const [k, v] of Object.entries(rec.fields)) {
    if (!Object.hasOwn(spec, k)) return "unknown_field";
    if (!fits(spec[k], v)) return "bad_value";
  }
  return rec;
}

/**
 * Finds the ops JSON in one log line. Accepts the bare line the log sink writes, the same line behind an ordinary
 * hosting prefix (timestamps, stream names, container ids: everything before the marker is ignored and never
 * printed), and Docker json-file style wrappers whose "log"/"message"/"msg" string holds the line.
 */
function extract(line) {
  const at = line.indexOf(MARKER);
  if (at >= 0) return line.slice(at).trimEnd();
  if (!line.trimStart().startsWith("{") || !line.includes(SCHEMA)) return undefined;
  try {
    const outer = JSON.parse(line);
    for (const key of ["log", "message", "msg"]) {
      const inner = isPlain(outer) && typeof outer[key] === "string" ? outer[key] : undefined;
      const i = inner?.indexOf(MARKER) ?? -1;
      if (i >= 0) return inner.slice(i).trimEnd();
    }
  } catch {
    /* not a wrapper */
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------------------------

const inc = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n; };

/** Nearest-rank percentile of integer milliseconds. */
function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}
const latency = (ms) => {
  const s = [...ms].sort((a, b) => a - b);
  return { n: s.length, p50: percentile(s, 0.5), p95: percentile(s, 0.95), max: s.length ? s[s.length - 1] : null };
};

/**
 * Groups are always partitioned by environment and mode, so production is never mixed with preview or demo. At most
 * MAX_GROUPS named groups are kept per table; later new keys fold into one "other" group per environment/mode (at
 * most 10 more), which carries that scope and no record's labels.
 */
function grouper() {
  const groups = new Map();
  let named = 0;
  return {
    groups,
    get(v, key, make) {
      const scope = `${v.environment}/${v.mode}`;
      let k = `${scope} ${key}`;
      if (!groups.has(k)) {
        const overflow = named >= MAX_GROUPS;
        if (overflow) k = `${scope} other`;
        if (!groups.has(k)) {
          const g = { environment: v.environment, mode: v.mode, ...make() };
          if (overflow) {
            for (const label of ["route", "operation", "capability", "provider", "model", "phase", "source", "parser"]) if (label in g) g[label] = "other";
          } else {
            named++;
          }
          groups.set(k, g);
        }
      }
      return groups.get(k);
    },
  };
}

async function summarize(lines, opts) {
  const input = { lines: 0, opsLines: 0, accepted: 0, filteredOut: 0, ignoredNonOps: 0, rejected: {} };
  const scope = {};
  let first = null; let last = null;
  const api = grouper(); const prov = grouper(); const src = grouper(); const parse = grouper();
  const code = (c) => (c === undefined ? undefined : KNOWN_CODES.has(c) ? c : "other");
  const model = (m) => (m === undefined ? "?" : PRINTABLE_MODEL.test(m) ? m : "other_model");

  for await (const line of lines) {
    input.lines++;
    if (line.length > MAX_LINE) {
      if (line.includes(SCHEMA)) inc(input.rejected, "oversize_line"); else input.ignoredNonOps++;
      continue;
    }
    const json = extract(line);
    if (json === undefined) { input.ignoredNonOps++; continue; }
    input.opsLines++;
    let rec;
    try { rec = JSON.parse(json); } catch { inc(input.rejected, "invalid_json"); continue; }
    const v = validate(rec);
    if (typeof v === "string") { inc(input.rejected, v); continue; }
    if ((opts.environment && v.environment !== opts.environment) || (opts.mode && v.mode !== opts.mode)) { input.filteredOut++; continue; }
    input.accepted++;
    inc(scope, `${v.environment}/${v.mode}`);
    first = first === null ? v.at : Math.min(first, v.at);
    last = last === null ? v.at : Math.max(last, v.at);
    const f = v.fields;

    if (v.name === "api_request") {
      const g = api.get(v, `${f.route ?? "?"} ${f.operation ?? "?"}`, () => ({ route: f.route ?? null, operation: f.operation ?? null, requests: 0, outcome: {}, status: {}, dependency: {}, fallback: {}, code: {}, aborted: 0, attempts: 0, ms: [] }));
      g.requests++;
      if (f.outcome) inc(g.outcome, f.outcome);
      if (f.status !== undefined) inc(g.status, String(f.status));
      if (f.dependency) inc(g.dependency, f.dependency);
      if (f.fallback) inc(g.fallback, f.fallback);
      if (f.code) inc(g.code, code(f.code));
      if (f.aborted) g.aborted++;
      g.attempts += f.attempts ?? 0;
      if (f.durationMs !== undefined) g.ms.push(f.durationMs);
    } else if (v.name === "provider_attempt") {
      const m = model(f.model);
      const g = prov.get(v, `${f.capability ?? "?"} ${f.provider ?? "?"} ${m} ${f.phase ?? "?"}`, () => ({
        capability: f.capability ?? null, provider: f.provider ?? null, model: m, phase: f.phase ?? null,
        attempts: 0, outcome: {}, code: {}, upstreamStatus: {}, returnedModelDiffers: 0, ms: [],
        tokens: { input: { sum: 0, reported: 0 }, output: { sum: 0, reported: 0 }, total: { sum: 0, reported: 0 } },
        cost: { reportedUsd: 0, reportedAttempts: 0, reportedButDropped: 0, unknownAttempts: 0 },
      }));
      g.attempts++;
      if (f.outcome) inc(g.outcome, f.outcome);
      if (f.code) inc(g.code, code(f.code));
      if (f.upstreamStatus !== undefined) inc(g.upstreamStatus, String(f.upstreamStatus));
      if (f.returnedModel !== undefined && f.model !== undefined && f.returnedModel !== f.model) g.returnedModelDiffers++;
      if (f.durationMs !== undefined) g.ms.push(f.durationMs);
      for (const [key, field] of [["input", "inputTokens"], ["output", "outputTokens"], ["total", "totalTokens"]]) {
        if (f[field] !== undefined) { g.tokens[key].sum += f[field]; g.tokens[key].reported++; }
      }
      // Cost: only what the provider reported. A missing figure is unknown, never zero.
      if (f.costUsd !== undefined && f.costSource === "provider_reported") { g.cost.reportedUsd += f.costUsd; g.cost.reportedAttempts++; }
      else if (f.costSource === "provider_reported") g.cost.reportedButDropped++;
      else g.cost.unknownAttempts++;
    } else if (v.name === "source_fetch") {
      const g = src.get(v, `${f.source ?? "?"}`, () => ({ source: f.source ?? null, fetches: 0, outcome: {}, upstreamStatus: {}, ms: [] }));
      g.fetches++;
      if (f.outcome) inc(g.outcome, f.outcome);
      if (f.upstreamStatus !== undefined) inc(g.upstreamStatus, String(f.upstreamStatus));
      if (f.durationMs !== undefined) g.ms.push(f.durationMs);
    } else {
      const g = parse.get(v, `${f.parser ?? "?"}`, () => ({ parser: f.parser ?? null, parses: 0, facts: 0, withDate: 0 }));
      g.parses++;
      g.facts += f.facts ?? 0;
      if (f.date) g.withDate++;
    }
  }

  const finish = (g) => { const { ms, ...rest } = g; return { ...rest, latencyMs: latency(ms) }; };
  return {
    schema: SCHEMA,
    filters: { environment: opts.environment ?? null, mode: opts.mode ?? null },
    input,
    window: first === null ? null : { from: new Date(first).toISOString(), to: new Date(last).toISOString() },
    scope,
    apiRequests: [...api.groups.values()].map(finish),
    providerAttempts: [...prov.groups.values()].map((g) => {
      const out = finish(g);
      const t = g.tokens;
      out.tokens = Object.fromEntries(Object.entries(t).map(([k, x]) => [k, x.reported ? { sum: x.sum, reportedAttempts: x.reported } : { sum: null, reportedAttempts: 0 }]));
      out.cost = {
        // null, not 0, when no attempt reported a cost: unknown is not free.
        providerReportedUsd: g.cost.reportedAttempts ? Number(g.cost.reportedUsd.toFixed(6)) : null,
        reportedAttempts: g.cost.reportedAttempts,
        unknownAttempts: g.cost.unknownAttempts + g.cost.reportedButDropped,
        coverage: g.attempts ? Number((g.cost.reportedAttempts / g.attempts).toFixed(4)) : 0,
        note: "provider-reported, not billed spend",
      };
      return out;
    }),
    sourceFetches: [...src.groups.values()].map(finish),
    sourceParses: [...parse.groups.values()],
  };
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

const counts = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(" ") || "-";
const lat = (l) => (l.n ? `n=${l.n} p50=${l.p50}ms p95=${l.p95}ms max=${l.max}ms` : "no durations");

function text(s) {
  const out = [];
  const i = s.input;
  out.push(`TicketStub operational summary (${s.schema})`);
  out.push(`filters: environment=${s.filters.environment ?? "all"} mode=${s.filters.mode ?? "all"}`);
  out.push(`input: lines=${i.lines} ops_lines=${i.opsLines} accepted=${i.accepted} filtered_out=${i.filteredOut} ignored_non_ops=${i.ignoredNonOps} rejected=${Object.values(i.rejected).reduce((a, b) => a + b, 0)}${Object.keys(i.rejected).length ? ` (${counts(i.rejected)})` : ""}`);
  out.push(`window: ${s.window ? `${s.window.from} .. ${s.window.to}` : "-"}`);
  out.push(`scope (environment/mode): ${counts(s.scope)}`);
  out.push("", "API requests");
  if (!s.apiRequests.length) out.push("  none");
  for (const g of s.apiRequests) {
    out.push(`  [${g.environment}/${g.mode}] ${g.route}/${g.operation}: requests=${g.requests} ${lat(g.latencyMs)}`);
    out.push(`    outcome: ${counts(g.outcome)}`);
    out.push(`    status: ${counts(g.status)}  aborted=${g.aborted}  provider_attempts=${g.attempts}`);
    out.push(`    dependency: ${counts(g.dependency)}  fallback: ${counts(g.fallback)}`);
    if (Object.keys(g.code).length) out.push(`    codes: ${counts(g.code)}`);
  }
  out.push("", "Provider attempts (AI provider usage only; source APIs are listed separately)");
  if (!s.providerAttempts.length) out.push("  none");
  for (const g of s.providerAttempts) {
    out.push(`  [${g.environment}/${g.mode}] ${g.capability} ${g.provider} ${g.model} ${g.phase}: attempts=${g.attempts} ${lat(g.latencyMs)}`);
    out.push(`    outcome: ${counts(g.outcome)}${Object.keys(g.code).length ? `  codes: ${counts(g.code)}` : ""}${Object.keys(g.upstreamStatus).length ? `  upstream_status: ${counts(g.upstreamStatus)}` : ""}`);
    const tok = (t) => (t.reportedAttempts ? `${t.sum} (${t.reportedAttempts} reporting)` : "unknown");
    out.push(`    tokens: input=${tok(g.tokens.input)} output=${tok(g.tokens.output)} total=${tok(g.tokens.total)}${g.returnedModelDiffers ? `  returned_model_differs=${g.returnedModelDiffers}` : ""}`);
    const c = g.cost;
    out.push(`    cost (provider-reported, not billed spend): ${c.providerReportedUsd === null ? "unknown" : `$${c.providerReportedUsd}`} from ${c.reportedAttempts}/${g.attempts} attempts; unknown for ${c.unknownAttempts}`);
  }
  out.push("", "Source fetches (data sources, not AI usage)");
  if (!s.sourceFetches.length) out.push("  none");
  for (const g of s.sourceFetches) out.push(`  [${g.environment}/${g.mode}] ${g.source}: fetches=${g.fetches} ${lat(g.latencyMs)}  outcome: ${counts(g.outcome)}${Object.keys(g.upstreamStatus).length ? `  upstream_status: ${counts(g.upstreamStatus)}` : ""}`);
  out.push("", "Page parses");
  if (!s.sourceParses.length) out.push("  none");
  for (const g of s.sourceParses) out.push(`  [${g.environment}/${g.mode}] ${g.parser}: parses=${g.parses} facts=${g.facts} with_date=${g.withDate}`);
  return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function usage(message) {
  process.stderr.write(`${message ? `${message}\n` : ""}usage: node scripts/summarize-ops-telemetry.mjs [--environment=${ENVIRONMENTS.join("|")}] [--mode=demo|live] [--format=text|json] [--strict] < ops.log\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { format: "text", strict: false };
  for (const arg of argv) {
    const [k, v] = arg.split(/=(.*)/s, 2);
    if (k === "--help" || k === "-h") usage();
    else if (k === "--strict" && v === undefined) opts.strict = true;
    else if (k === "--environment" && ENVIRONMENTS.includes(v)) opts.environment = v;
    else if (k === "--mode" && MODES.includes(v)) opts.mode = v;
    else if (k === "--format" && (v === "text" || v === "json")) opts.format = v;
    else usage("unrecognised argument"); // the argument itself is not echoed
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const s = await summarize(createInterface({ input: process.stdin, crlfDelay: Infinity }), opts);
  process.stdout.write(opts.format === "json" ? `${JSON.stringify(s, null, 2)}\n` : text(s));
  const rejected = Object.values(s.input.rejected).reduce((a, b) => a + b, 0);
  if (opts.strict && rejected > 0) process.exitCode = 1;
}

main().catch(() => {
  process.stderr.write("summarize-ops-telemetry: could not read input\n");
  process.exit(1);
});
