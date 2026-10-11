import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { registerHooks } from "node:module";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

// Operational measurement, exercised through the real route handlers and provider transport, fully offline:
// fetch is replaced in every test, and the in-memory collector stands in for the configured sink.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
    if (specifier.startsWith("@/")) {
      const file = fileURLToPath(new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url));
      if (existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true };
    }
    if (specifier.startsWith(".") && context.parentURL) {
      const url = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".ts")) return {
      format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    };
    return nextLoad(url, context);
  },
});

// A throwaway database, so art quotas and product events never touch ./data.
const scratch = mkdtempSync(join(tmpdir(), "ticketstub-ops-"));
process.env.TICKETSTUB_DB = join(scratch, "ops.sqlite");
process.env.TICKETSTUB_FILES = join(scratch, "files");
delete process.env.TICKETSTUB_OPS_TELEMETRY;

const { OPS_SCHEMA, sanitizeOpsEvent, sanitizeOpsFields, outcomeOf } = await import("../src/server/observability/schema.ts");
const { memoryCollector, setOpsSink, activeSink, logSink } = await import("../src/server/observability/sink.ts");
const { observeRoute, opsStats, resetOpsStats, annotate } = await import("../src/server/observability/measure.ts");
const { HttpError } = await import("../src/server/http.ts");
const agent = await import("../src/app/api/agent/route.ts");
const art = await import("../src/app/api/art/route.ts");
const research = await import("../src/app/api/research/route.ts");

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let sink;
beforeEach(() => { sink = memoryCollector(); setOpsSink(sink); resetOpsStats(); });
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...originalEnv }; setOpsSink(undefined); });

const SEED = "SEEDSECRET7f3a";
const response = (body, status = 200) => Response.json(body, { status });
const event = { type: "concert", title: `Private Title ${SEED}`, facts: [{ id: "x", label: `note ${SEED}`, value: SEED, source: "me", provenance: "live", confidence: 1 }] };
const req = (body, { signal, headers = {} } = {}) => new Request("http://localhost/api", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body), signal });
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1cAAAAASUVORK5CYII=";
const textResponse = (text = "Confirmed.", extra = {}) => ({ model: "anthropic/test-model", provider: "Anthropic", choices: [{ finish_reason: "stop", message: { content: text } }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, cost: 0.001 }, ...extra });
function configure(capability = "agent", model = "anthropic/test-model") {
  process.env.TICKETSTUB_RUNTIME_MODE = "live";
  const prefix = `TICKETSTUB_${capability.toUpperCase()}`;
  process.env[`${prefix}_PROVIDER`] = "openrouter";
  process.env[`${prefix}_MODEL`] = model;
  process.env[`${prefix}_OPENROUTER_API_KEY`] = "offline-test-placeholder";
  delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY;
}
const named = (name) => sink.events.filter((e) => e.name === name);
const only = (name) => { const list = named(name); assert.equal(list.length, 1, `${name} count`); return list[0]; };
const assertClean = (...extra) => {
  const all = JSON.stringify(sink.events);
  for (const bad of [SEED, "offline-test-placeholder", "example.com", "Bearer", "http:", "https:", ...extra]) assert.ok(!all.includes(bad), `telemetry leaked ${bad}`);
};

// ---------------------------------------------------------------------------------------------
// Schema and sanitizer
// ---------------------------------------------------------------------------------------------

test("schema refuses unknown names, unknown fields and values that do not fit", () => {
  assert.equal(sanitizeOpsEvent({ name: "prompt_logged", operationId: "op_AAAAAAAAAAAAAAAA", environment: "test", mode: "demo" }), null);
  assert.equal(sanitizeOpsEvent({ name: "api_request", operationId: "req_from_a_client_header", environment: "test", mode: "demo" }), null);
  const built = sanitizeOpsEvent({ name: "api_request", operationId: "op_AAAAAAAAAAAAAAAA", environment: "staging", mode: "live", fields: {
    route: "research", status: 200, durationMs: 12.6, outcome: "success",
    prompt: "tell me", url: "https://example.com", route2: "x", status2: 1, operation: "drop_tables", code: "Bad Code",
  } });
  assert.equal(built.event.schema, OPS_SCHEMA);
  assert.equal(built.event.environment, "unspecified");
  assert.deepEqual(built.event.fields, { route: "research", status: 200, durationMs: 13, outcome: "success" });
  assert.equal(built.dropped, 6);
});

test("dangerous strings never pass as models, providers or codes", () => {
  const dangerous = [
    "sk-or-v1-0123456789abcdef", "Bearer abc", "anthropic/model?key=1", "https://evil.example/model", "//evil", "user@example.com",
    "openai/" + "a".repeat(40), "model token=abc", "api_key_model", "secret-model", "openai/gpt%2Fx", "a#b",
  ];
  for (const v of dangerous) {
    const { fields } = sanitizeOpsFields("provider_attempt", { model: v, returnedModel: v, upstreamProvider: v, code: v });
    assert.deepEqual(fields, {}, v);
  }
  for (const code of ["sk_live_abcdef", "secret_value", "a".repeat(30)]) assert.deepEqual(sanitizeOpsFields("api_request", { code }).fields, {}, code);
  const ok = sanitizeOpsFields("provider_attempt", { model: "anthropic/claude-3-5-sonnet-20241022", upstreamProvider: "Google AI Studio", code: "provider_rate_limited", costUsd: 0.0021, inputTokens: 12 });
  assert.equal(ok.dropped, 0);
  for (const [field, v] of [["costUsd", -1], ["costUsd", Infinity], ["inputTokens", 1.5], ["durationMs", -4], ["upstreamStatus", 99], ["upstreamStatus", 700]]) {
    assert.deepEqual(sanitizeOpsFields("provider_attempt", { [field]: v }).fields, {}, `${field}=${v}`);
  }
});

test("outcome words follow the final status, and an abort wins", () => {
  assert.deepEqual([200, 204, 400, 403, 422, 429, 502, 503, 504, 500].map((s) => outcomeOf(s, false)),
    ["success", "no_content", "invalid_input", "forbidden", "rejected", "rate_limited", "upstream_error", "upstream_error", "upstream_error", "server_error"]);
  assert.equal(outcomeOf(200, true), "aborted");
});

// ---------------------------------------------------------------------------------------------
// Configuration: off by default
// ---------------------------------------------------------------------------------------------

test("collection is off unless TICKETSTUB_OPS_TELEMETRY=log; off changes nothing about responses", async () => {
  setOpsSink(undefined);
  for (const v of [undefined, "", "off", "on", "true", "memory", "https://collector.example"]) {
    if (v === undefined) delete process.env.TICKETSTUB_OPS_TELEMETRY; else process.env.TICKETSTUB_OPS_TELEMETRY = v;
    assert.equal(activeSink(), undefined, String(v));
  }
  process.env.TICKETSTUB_OPS_TELEMETRY = " LOG ";
  assert.equal(activeSink(), logSink);
  delete process.env.TICKETSTUB_OPS_TELEMETRY;
  delete process.env.TICKETSTUB_RUNTIME_MODE;
  globalThis.fetch = () => assert.fail("demo attempted network");
  const res = await agent.POST(req({ event, message: "Hello?" }));
  assert.equal(res.status, 204); assert.equal(res.headers.get("x-ticketstub-operation"), null);
  assert.equal(opsStats().emitted, 0);
});

test("the log sink writes one sanitized JSON line per event and nothing private", async () => {
  setOpsSink(undefined);
  process.env.TICKETSTUB_OPS_TELEMETRY = "log";
  process.env.TICKETSTUB_OPS_ENVIRONMENT = "preview";
  configure();
  globalThis.fetch = async () => response(textResponse());
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => { if (String(chunk).includes(OPS_SCHEMA)) { lines.push(String(chunk)); return true; } return write.call(process.stdout, chunk, ...rest); };
  try { assert.equal((await agent.POST(req({ event, message: `Hi ${SEED}` }))).status, 200); }
  finally { process.stdout.write = write; }
  assert.equal(lines.length, 2);
  const parsed = lines.map((l) => { assert.ok(l.endsWith("\n")); return JSON.parse(l); });
  assert.deepEqual(parsed.map((e) => e.name), ["provider_attempt", "api_request"]);
  assert.ok(parsed.every((e) => e.environment === "preview" && e.mode === "live" && e.schema === OPS_SCHEMA));
  assert.ok(!lines.join("").includes(SEED));
});

// ---------------------------------------------------------------------------------------------
// Agent route
// ---------------------------------------------------------------------------------------------

test("agent demo keeps its 204 and is measured as a rules fallback in demo mode", async () => {
  delete process.env.TICKETSTUB_RUNTIME_MODE;
  globalThis.fetch = () => assert.fail("demo attempted network");
  const res = await agent.POST(req({ event, message: "Hello?" }));
  assert.equal(res.status, 204); assert.equal(await res.text(), "");
  const e = only("api_request");
  assert.equal(e.mode, "demo");
  assert.deepEqual({ ...e.fields, durationMs: 0 }, { operation: "agent_reply", dependency: "demo", fallback: "rules", route: "agent", status: 204, outcome: "no_content", durationMs: 0, aborted: false, attempts: 0, clientCorrelation: false });
  assert.equal(res.headers.get("x-ticketstub-operation"), e.operationId);
});

test("agent live success: one provider attempt with reported usage and cost, tied to one server-made operation", async () => {
  configure();
  globalThis.fetch = async () => response(textResponse());
  const res = await agent.POST(req({ event, message: `Hello ${SEED}` }, { headers: { "x-request-id": "req_clientChosenId123" } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.reply, "Confirmed."); assert.equal(body.providerMetadata.usage.costUsd, 0.001); // existing contract kept
  assert.ok(!JSON.stringify(body).includes("op_") && !JSON.stringify(body).includes("att_"), "no telemetry in the body");
  const a = only("provider_attempt"); const r = only("api_request");
  assert.equal(a.operationId, r.operationId);
  assert.match(r.operationId, /^op_[A-Za-z0-9_-]{16}$/); assert.match(a.fields.attemptId, /^att_/);
  assert.notEqual(r.operationId, "req_clientChosenId123");
  assert.ok(!JSON.stringify(sink.events).includes("clientChosenId"), "client correlation value is never kept");
  assert.equal(r.fields.clientCorrelation, true);
  assert.equal(res.headers.get("x-ticketstub-operation"), r.operationId);
  assert.deepEqual({ ...a.fields, attemptId: "", durationMs: 0 }, {
    attemptId: "", attempt: 1, capability: "agent", provider: "openrouter", phase: "generate", model: "anthropic/test-model",
    returnedModel: "anthropic/test-model", upstreamProvider: "Anthropic", outcome: "ok", durationMs: 0,
    inputTokens: 12, outputTokens: 3, totalTokens: 15, costUsd: 0.001, costSource: "provider_reported", usageReported: true,
  });
  assert.equal(r.fields.outcome, "success"); assert.equal(r.fields.dependency, "provider"); assert.equal(r.fields.attempts, 1);
  assertClean();
});

test("missing usage and cost stay unknown, never estimated", async () => {
  process.env.TICKETSTUB_RUNTIME_MODE = "live";
  delete process.env.TICKETSTUB_AGENT_PROVIDER;
  process.env.ANTHROPIC_API_KEY = "offline-direct-key";
  globalThis.fetch = async () => response({ content: [{ type: "text", text: "Direct reply" }] });
  assert.equal((await agent.POST(req({ event, message: "Hi" }))).status, 200);
  const a = only("provider_attempt");
  assert.equal(a.fields.provider, "anthropic"); assert.equal(a.fields.model, "claude-sonnet-5-5");
  assert.equal(a.fields.costSource, "unknown"); assert.equal(a.fields.usageReported, false);
  for (const k of ["costUsd", "inputTokens", "outputTokens", "totalTokens", "returnedModel"]) assert.ok(!(k in a.fields), k);
  assertClean("offline-direct-key");
});

test("missing OpenRouter key is a configuration failure with no upstream attempt", async () => {
  configure(); process.env.TICKETSTUB_AGENT_OPENROUTER_API_KEY = "";
  globalThis.fetch = () => assert.fail("missing key attempted network");
  const res = await agent.POST(req({ event, message: "Hi" }));
  assert.equal(res.status, 503);
  assert.equal(named("provider_attempt").length, 0);
  const r = only("api_request");
  assert.equal(r.fields.code, "missing_provider_key"); assert.equal(r.fields.attempts, 0); assert.equal(r.fields.outcome, "upstream_error");
});

test("invalid input is measured without reading the body into telemetry", async () => {
  configure();
  globalThis.fetch = () => assert.fail("invalid input attempted network");
  assert.equal((await agent.POST(req(`{"message":"${SEED}`))).status, 400);
  assert.equal((await agent.POST(req({ message: SEED }))).status, 400);
  assert.deepEqual(named("api_request").map((e) => [e.fields.outcome, e.fields.code]), [["invalid_input", "bad_request"], ["invalid_input", "bad_request"]]);
  assertClean();
});

for (const [status, code, outcome] of [[429, "provider_rate_limited", "rate_limited"], [401, "provider_authentication_failed", "upstream_error"], [503, "provider_unavailable", "upstream_error"]]) {
  test(`upstream ${status} is one failed attempt with the upstream status and a safe code`, async () => {
    configure();
    globalThis.fetch = async () => response({ error: { message: `upstream body ${SEED}` } }, status);
    const res = await agent.POST(req({ event, message: "Hi" }));
    assert.equal(res.status, status === 429 ? 429 : 502);
    const a = only("provider_attempt");
    assert.equal(a.fields.outcome, "error"); assert.equal(a.fields.code, code); assert.equal(a.fields.upstreamStatus, status);
    assert.equal(a.fields.costSource, "unknown");
    const r = only("api_request");
    assert.equal(r.fields.outcome, outcome); assert.equal(r.fields.code, code);
    assertClean();
  });
}

test("direct-provider failure keeps the 204 fallback and records why", async () => {
  process.env.TICKETSTUB_RUNTIME_MODE = "live";
  delete process.env.TICKETSTUB_AGENT_PROVIDER;
  process.env.ANTHROPIC_API_KEY = "offline-direct-key";
  globalThis.fetch = async () => response({}, 500);
  const res = await agent.POST(req({ event, message: "Hi" }));
  assert.equal(res.status, 204);
  const r = only("api_request");
  assert.equal(r.fields.fallback, "rules"); assert.equal(r.fields.code, "provider_unavailable"); assert.equal(r.fields.outcome, "no_content");
  assert.equal(only("provider_attempt").fields.upstreamStatus, 500);
});

test("a caller abort is a cancelled attempt and an aborted operation; the 504 envelope is unchanged", async () => {
  configure();
  const controller = new AbortController();
  globalThis.fetch = async (_url, init) => { controller.abort(); init.signal.throwIfAborted(); };
  const res = await agent.POST(req({ event, message: "Hi" }, { signal: controller.signal }));
  assert.equal(res.status, 504); assert.equal((await res.json()).error.code, "provider_request_cancelled");
  assert.equal(only("provider_attempt").fields.outcome, "cancelled");
  const r = only("api_request");
  assert.equal(r.fields.aborted, true); assert.equal(r.fields.outcome, "aborted");
});

test("a transport timeout is told apart from a caller abort", async () => {
  configure();
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => AbortSignal.abort(new DOMException("timeout", "TimeoutError"));
  globalThis.fetch = async (_url, init) => { init.signal.throwIfAborted(); };
  try { assert.equal((await agent.POST(req({ event, message: "Hi" }))).status, 504); }
  finally { AbortSignal.timeout = originalTimeout; }
  assert.equal(only("provider_attempt").fields.outcome, "timeout");
  assert.equal(only("api_request").fields.aborted, false);
});

// ---------------------------------------------------------------------------------------------
// Art route
// ---------------------------------------------------------------------------------------------

test("art OpenRouter: model check and generation are separate attempts of one operation", async () => {
  configure("art", "openai/test-image");
  globalThis.fetch = async (url) => url.endsWith("/images/models")
    ? response({ data: [{ id: "openai/test-image", architecture: { output_modalities: ["image"] } }] })
    : response({ data: [{ b64_json: png, media_type: "image/png" }], usage: { cost: 0.04 } });
  const res = await art.POST(req({ event, vibe: `vibe ${SEED}` }));
  assert.equal(res.status, 200); assert.equal((await res.json()).provenance, "live");
  const attempts = named("provider_attempt");
  assert.deepEqual(attempts.map((a) => [a.fields.attempt, a.fields.phase, a.fields.outcome]), [[1, "model_check", "ok"], [2, "generate", "ok"]]);
  assert.equal(attempts[1].fields.costUsd, 0.04); assert.equal(attempts[0].fields.costSource, "unknown");
  const r = only("api_request");
  assert.equal(r.fields.attempts, 2); assert.equal(r.fields.dependency, "provider"); assert.equal(r.fields.quota, "ok");
  assert.ok(attempts.every((a) => a.operationId === r.operationId));
  assertClean(png.slice(0, 20));
});

test("art in demo is a procedural fallback with no attempts", async () => {
  delete process.env.TICKETSTUB_RUNTIME_MODE;
  globalThis.fetch = () => assert.fail("demo attempted network");
  assert.equal((await (await art.POST(req({ event }))).json()).provenance, "simulated");
  const r = only("api_request");
  assert.deepEqual([r.fields.dependency, r.fields.fallback, r.fields.attempts, r.fields.outcome], ["procedural", "procedural", 0, "success"]);
});

test("unsupported image model: one failed model check, 422 kept", async () => {
  configure("art", "openai/text-only");
  globalThis.fetch = async () => response({ data: [] });
  assert.equal((await art.POST(req({ event, first: true, edition: "researched" }))).status, 422);
  const a = only("provider_attempt");
  assert.deepEqual([a.fields.phase, a.fields.outcome, a.fields.code], ["model_check", "error", "unsupported_image_model"]);
  assert.equal(only("api_request").fields.code, "unsupported_image_model");
});

// ---------------------------------------------------------------------------------------------
// Research route: sources, parses and enrichment
// ---------------------------------------------------------------------------------------------

test("research invalid JSON, search and demo-only rejection", async () => {
  delete process.env.TICKETSTUB_RUNTIME_MODE;
  globalThis.fetch = () => assert.fail("demo attempted network");
  assert.equal((await research.POST(req("{"))).status, 400);
  const search = await research.POST(req({ query: `pale hours ${SEED}` }));
  assert.equal(search.status, 200); assert.ok(search.headers.get("x-request-id"), "route() still tags responses");
  assert.equal((await research.POST(req({ url: `https://example.com/private?token=${SEED}` }))).status, 422);
  assert.deepEqual(named("api_request").map((e) => [e.fields.operation, e.fields.outcome, e.fields.code ?? "-", e.fields.results ?? "-"]), [
    ["unknown", "invalid_input", "bad_request", "-"],
    ["research_search", "success", "-", 1],
    ["research_link", "rejected", "demo_only", "-"],
  ]);
  assertClean();
});

test("research live page: fetch, schema.org parse, archive weather and enrichment are all measured", async () => {
  configure("research");
  const page = `<script type="application/ld+json">{"@type":"MusicEvent","name":"Offline ${SEED}","startDate":"2020-01-01","location":{"name":"Hall","address":{"addressLocality":"Glasgow"}}}</script><p>Special guest Local Band.</p>`;
  globalThis.fetch = async (url) => {
    if (url.startsWith("https://example.com/")) return new Response(page);
    if (url.startsWith("https://geocoding-api")) return response({ results: [{ latitude: 1, longitude: 2, name: "Glasgow" }] });
    if (url.startsWith("https://archive-api")) return response({ daily: { temperature_2m_max: [5], precipitation_sum: [0] } });
    return response(textResponse(JSON.stringify([{ id: "opener", label: "Local Band", value: "Local Band", evidence: "Special guest Local Band.", confidence: 0.9 }])));
  };
  const res = await research.POST(req({ url: `https://example.com/event?ref=${SEED}` }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.facts.some((f) => f.id === "weather" && f.provenance === "live"));
  assert.deepEqual(named("source_fetch").map((e) => [e.fields.source, e.fields.outcome, e.fields.upstreamStatus]).sort(), [
    ["event_page", "ok", 200], ["weather_archive", "ok", 200], ["weather_geocode", "ok", 200],
  ]);
  assert.deepEqual(only("source_parse").fields, { parser: "schema_org", outcome: "ok", facts: 2, date: true });
  assert.equal(only("provider_attempt").fields.capability, "research");
  const r = only("api_request");
  assert.deepEqual([r.fields.operation, r.fields.dependency, r.fields.fallback, r.fields.outcome, r.fields.facts], ["research_link", "page", "none", "success", body.facts.length]);
  assertClean("Glasgow", "Local Band");
});

test("research page 404 and weather network failure stay graceful and are told apart", async () => {
  configure("research");
  globalThis.fetch = async () => new Response("gone", { status: 404 });
  assert.equal((await research.POST(req({ url: "https://example.com/missing" }))).status, 422);
  let fe = only("source_fetch");
  assert.deepEqual([fe.fields.source, fe.fields.outcome, fe.fields.upstreamStatus], ["event_page", "http_error", 404]);
  assert.equal(only("api_request").fields.code, "unreadable_link");

  sink.clear(); process.env.TICKETSTUB_RESEARCH_PROVIDER = "anthropic"; delete process.env.ANTHROPIC_API_KEY; // no enrichment
  globalThis.fetch = async (url) => {
    if (url.startsWith("https://example.com/")) return new Response('<script type="application/ld+json">{"@type":"Event","name":"X","startDate":"2020-01-01","location":{"name":"Hall","address":{"addressLocality":"Oslo"}}}</script>');
    throw new TypeError(`fetch failed ${SEED}`);
  };
  const res = await research.POST(req({ url: "https://example.com/weatherless" }));
  assert.equal(res.status, 200);
  assert.ok((await res.json()).facts.some((f) => f.id === "weather" && f.provenance === "pending"));
  fe = named("source_fetch").find((e) => e.fields.source === "weather_geocode");
  assert.equal(fe.fields.outcome, "network_error");
  assert.equal(named("provider_attempt").length, 0);
  assertClean();
});

test("research page timeout is a timeout, and a parse with nothing usable is empty", async () => {
  configure("research");
  globalThis.fetch = async () => { throw new DOMException("t", "TimeoutError"); };
  assert.equal((await research.POST(req({ url: "https://example.com/slow" }))).status, 422);
  assert.equal(only("source_fetch").fields.outcome, "timeout");
  sink.clear();
  globalThis.fetch = async () => new Response("<p>no title</p>");
  assert.equal((await research.POST(req({ url: "https://example.com/blank" }))).status, 422);
  assert.deepEqual(only("source_parse").fields, { parser: "none", outcome: "empty", facts: 0, date: false });
});

test("Ticketmaster without a key is a skipped source and the slug fallback is labelled", async () => {
  configure("research");
  delete process.env.TICKETMASTER_API_KEY;
  globalThis.fetch = async (url) => url.includes("ticketmaster") ? new Response("blocked", { status: 403 }) : assert.fail(`unexpected ${url}`);
  const res = await research.POST(req({ url: "https://www.ticketmaster.com/the-pale-hours-glasgow/event/1A2B3C4D5E" }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ticketmaster.status, "skipped");
  assert.deepEqual(named("source_fetch").map((e) => [e.fields.source, e.fields.outcome]), [["ticketmaster", "skipped"], ["event_page", "http_error"]]);
  const r = only("api_request");
  assert.deepEqual([r.fields.dependency, r.fields.fallback], ["ticketmaster", "slug"]);
  assertClean("ticketmaster.com", "1A2B3C4D5E", "pale");
});

test("research enrichment failure on a direct provider is a measured no_enrichment fallback", async () => {
  process.env.TICKETSTUB_RUNTIME_MODE = "live";
  delete process.env.TICKETSTUB_RESEARCH_PROVIDER;
  process.env.ANTHROPIC_API_KEY = "offline-direct-key";
  globalThis.fetch = async (url) => url.startsWith("https://example.com/")
    ? new Response('<script type="application/ld+json">{"@type":"MusicEvent","name":"Offline"}</script>')
    : response({}, 529);
  assert.equal((await research.POST(req({ url: "https://example.com/event" }))).status, 200);
  const r = only("api_request");
  assert.deepEqual([r.fields.fallback, r.fields.code, r.fields.outcome], ["no_enrichment", "provider_unavailable", "success"]);
  assert.equal(only("provider_attempt").fields.upstreamStatus, 529);
});

test("research OpenRouter malformed enrichment keeps its 502 envelope", async () => {
  configure("research");
  globalThis.fetch = async (url) => url.startsWith("https://example.com/")
    ? new Response('<script type="application/ld+json">{"@type":"MusicEvent","name":"Offline"}</script>')
    : response(textResponse("[null]"));
  const res = await research.POST(req({ url: "https://example.com/event" }));
  assert.equal(res.status, 502);
  // The transport call itself succeeded; it is the route that refused the output.
  assert.equal(only("provider_attempt").fields.outcome, "ok");
  assert.equal(only("api_request").fields.code, "invalid_provider_response");
});

// ---------------------------------------------------------------------------------------------
// Isolation: sink failures, hostile provider output, thrown handlers
// ---------------------------------------------------------------------------------------------

test("a throwing or rejecting sink never changes a response", async () => {
  configure();
  globalThis.fetch = async () => response(textResponse());
  const warn = console.warn; const warnings = []; console.warn = (...a) => warnings.push(a.join(" "));
  try {
    setOpsSink({ name: "broken", write() { throw new Error(`sink down ${SEED}`); } });
    const a = await agent.POST(req({ event, message: "Hi" }));
    assert.equal(a.status, 200); assert.equal((await a.json()).reply, "Confirmed.");
    setOpsSink({ name: "async-broken", write: async () => { throw new Error("later"); } });
    const b = await agent.POST(req({ event, message: "Hi" }));
    assert.equal(b.status, 200);
    await new Promise((r) => setImmediate(r));
    assert.equal(opsStats().sinkErrors, 4);
  } finally { console.warn = warn; }
  assert.ok(warnings.every((w) => !w.includes(SEED)));
});

test("hostile provider metadata is dropped from telemetry field by field", async () => {
  configure();
  globalThis.fetch = async () => response(textResponse("ok", {
    model: "sk-or-v1-abcdefabcdefabcdefabcdefabcdef", provider: `https://evil.example/${SEED}`,
    usage: { prompt_tokens: -5, completion_tokens: 2.5, total_tokens: "15", cost: Number.MAX_VALUE },
  }));
  assert.equal((await agent.POST(req({ event, message: "Hi" }))).status, 200);
  const a = only("provider_attempt");
  for (const k of ["returnedModel", "upstreamProvider", "inputTokens", "outputTokens", "totalTokens", "costUsd"]) assert.ok(!(k in a.fields), k);
  assert.equal(a.fields.costSource, "provider_reported"); // the provider did send a cost; it was out of range, so it is not kept
  assertClean("evil", "sk-or");
});

test("a handler that throws is measured with its HTTP status and rethrown untouched", async () => {
  const boom = new HttpError(503, "storage_unavailable", "x");
  const wrapped = observeRoute("research", async () => { annotate({ operation: "research_link", prompt: SEED }); throw boom; });
  await assert.rejects(wrapped(req({})), (e) => e === boom);
  const r = only("api_request");
  assert.deepEqual([r.fields.status, r.fields.code, r.fields.outcome], [503, "storage_unavailable", "upstream_error"]);
  assert.ok(opsStats().droppedFields >= 1);
  assertClean();
  sink.clear();
  await assert.rejects(observeRoute("art", async () => { throw new Error(`raw ${SEED}`); })(req({})));
  assert.deepEqual([only("api_request").fields.status, only("api_request").fields.code], [500, "internal"]);
  assertClean();
});
