import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { registerHooks } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { generateText, generateImage, providerFailure } from "../src/server/ai/providers.ts";

// Exercise real route handlers offline, resolving the same TS/alias imports as Next.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
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
const agent = await import("../src/app/api/agent/route.ts");
const art = await import("../src/app/api/art/route.ts");
const research = await import("../src/app/api/research/route.ts");
const client = await import("../src/customer/studio/research/client.ts");
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...originalEnv }; });
const response = (body, status = 200) => Response.json(body, { status });
const event = { type: "concert", title: "Offline Test", facts: [] };
const req = (body, signal) => new Request("http://localhost/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1cAAAAASUVORK5CYII=";
function configure(capability = "agent", model = "anthropic/test-model") {
  process.env.TICKETSTUB_RUNTIME_MODE = "live";
  for (const c of ["RESEARCH", "AGENT", "ART"]) delete process.env[`TICKETSTUB_${c}_OPENROUTER_API_KEY`];
  process.env[`TICKETSTUB_${capability.toUpperCase()}_OPENROUTER_API_KEY`] = "offline-test-placeholder";
  delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY;
  process.env[`TICKETSTUB_${capability.toUpperCase()}_PROVIDER`] = "openrouter";
  process.env[`TICKETSTUB_${capability.toUpperCase()}_MODEL`] = model;
}
const textResponse = (text = "Confirmed.") => ({ model: "anthropic/test-model", provider: "Anthropic", choices: [{ finish_reason: "stop", message: { content: text } }], usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.001, secret: "discard" } });

test("demo routes never dispatch with all provider keys and selections present", async () => {
  for (const c of ["agent", "research", "art"]) configure(c);
  for (const c of ["RESEARCH", "AGENT", "ART"]) process.env[`TICKETSTUB_${c}_OPENROUTER_API_KEY`] = "offline-test-placeholder";
  delete process.env.TICKETSTUB_RUNTIME_MODE;
  globalThis.fetch = () => { assert.fail("demo attempted network"); };
  assert.equal(await generateText({ capability: "agent", prompt: "test", maxTokens: 10 }), undefined);
  assert.equal((await agent.POST(req({ event, message: "Hello?" }))).status, 204);
  assert.equal((await (await art.POST(req({ event }))).json()).provenance, "simulated");
  assert.equal((await research.POST(req({ url: "https://example.invalid/private" }))).status, 422);
});

for (const model of ["anthropic/test-model", "openai/test-model"]) test(`OpenRouter text route with ${model} and no direct keys`, async () => {
  configure("agent", model);
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(init.body);
    assert.equal(body.model, model); assert.equal(body.provider.allow_fallbacks, false);
    assert.equal(body.messages[0].role, "system"); assert.equal(body.max_tokens, 300);
    assert.equal(init.headers.authorization, "Bearer offline-test-placeholder");
    assert.equal(init.redirect, "error");
    return response({ ...textResponse(), model });
  };
  const result = await (await agent.POST(req({ event, message: "Hello?" }))).json();
  assert.equal(result.reply, "Confirmed."); assert.equal(result.provenance, "live");
  assert.equal(result.providerMetadata.requestedModel, model);
  assert.equal(result.providerMetadata.usage.costUsd, 0.001);
  assert.ok(!JSON.stringify(result).includes("discard"));
});

test("research keeps page citation and rejects ungrounded evidence as estimated", async () => {
  configure("research");
  globalThis.fetch = async (url, init) => {
    if (url === "https://example.com/test-event") return new Response('<script type="application/ld+json">{"@type":"MusicEvent","name":"Offline Test"}</script><p>Special guest Local Band.</p>');
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(init.body);
    assert.match(body.messages[0].content, /Local Band/);
    assert.equal(body.tools, undefined); // Extraction from supplied page, not web search.
    return response(textResponse(JSON.stringify([
      { id: "opener", label: "Local Band", value: "Local Band", evidence: "Special guest Local Band.", confidence: 0.9 },
      { id: "tour", label: "Unknown", value: "Unknown", evidence: "Absent quote", confidence: 0.9 },
    ])));
  };
  const res = await research.POST(req({ url: "https://example.com/test-event" }));
  assert.equal(res.status, 200);
  const result = await res.json();
  const fact = result.facts.find(f => f.id === "opener");
  assert.equal(fact.sourceUrl, "https://example.com/test-event"); assert.equal(fact.provenance, "live");
  assert.equal(result.facts.find(f => f.id === "tour").provenance, "estimated");
  assert.equal(result.providerMetadata.provider, "openrouter");
});

test("OpenRouter image discovery and generation preserve bytes, MIME and usage", async () => {
  configure("art", "openai/test-image");
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(url);
    if (url.endsWith("/images/models")) return response({ data: [{ id: "openai/test-image", architecture: { output_modalities: ["image"] } }] });
    assert.equal(url, "https://openrouter.ai/api/v1/images");
    const body = JSON.parse(init.body); assert.equal(body.provider.allow_fallbacks, false);
    assert.equal(body.n, 1); assert.equal(body.size, undefined);
    return response({ data: [{ b64_json: png, media_type: "image/png" }], usage: { cost: 0.01 } });
  };
  const result = await (await art.POST(req({ event }))).json();
  assert.equal(result.src, `data:image/png;base64,${png}`); assert.equal(result.provenance, "live");
  assert.equal(result.providerMetadata.usage.costUsd, 0.01); assert.equal(calls.length, 2);
});

test("unsupported image model fails before generation, without simulated fallback", async () => {
  configure("art", "openai/text-only");
  let calls = 0;
  globalThis.fetch = async () => { calls++; return response({ data: [] }); };
  const result = await art.POST(req({ event, first: true, edition: "researched" }));
  assert.equal(result.status, 422); assert.equal((await result.json()).code, "unsupported_image_model"); assert.equal(calls, 1);
});

for (const [key, value, code] of [
  ["TICKETSTUB_AGENT_OPENROUTER_API_KEY", "", "missing_provider_key"],
  ["TICKETSTUB_AGENT_MODEL", "", "invalid_model_configuration"],
  ["TICKETSTUB_AGENT_MODEL", "openrouter/auto", "invalid_model_configuration"],
  ["TICKETSTUB_AGENT_MODEL", "openai/test:online", "invalid_model_configuration"],
  ["TICKETSTUB_AGENT_PROVIDER", "unknown", "invalid_provider_configuration"],
]) test(`configuration rejects ${key}=${value} before network`, async () => {
  configure(); process.env[key] = value;
  globalThis.fetch = () => { assert.fail("invalid configuration attempted network"); };
  await assert.rejects(generateText({ capability: "agent", prompt: "hi", maxTokens: 10 }), e => e.code === code);
});

for (const [status, code] of [[401, "provider_authentication_failed"], [403, "provider_authentication_failed"], [429, "provider_rate_limited"], [400, "unsupported_provider_request"], [503, "provider_unavailable"]]) test(`upstream ${status} returns safe error without retries/fallback`, async () => {
  configure(); let calls = 0;
  globalThis.fetch = async () => { calls++; return response({ error: "secret provider response" }, status); };
  const result = await agent.POST(req({ event, message: "Hello?" }));
  assert.equal(result.status, status === 429 ? 429 : 502);
  const data = await result.json(); assert.equal(data.code, code);
  assert.ok(!JSON.stringify(data).includes("secret")); assert.equal(calls, 1);
});

for (const data of [{}, { error: { message: "secret" } }, textResponse(""), { choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{}] } }] }]) test("malformed or non-final text fails safely", async () => {
  configure(); globalThis.fetch = async () => response(data);
  await assert.rejects(generateText({ capability: "agent", prompt: "hi", maxTokens: 10 }), e => !!providerFailure(e));
});

test("invalid JSON, network failures and cancellation are safe", async () => {
  configure();
  for (const failure of [async () => new Response("not JSON"), async () => { throw new Error("secret"); }]) {
    globalThis.fetch = failure;
    await assert.rejects(generateText({ capability: "agent", prompt: "hi", maxTokens: 10 }), e => e.code === "provider_unavailable" && !e.message.includes("secret"));
  }
  const controller = new AbortController(); controller.abort();
  globalThis.fetch = async (_url, init) => { assert.ok(init.signal.aborted); init.signal.throwIfAborted(); };
  await assert.rejects(generateText({ capability: "agent", prompt: "hi", maxTokens: 10, signal: controller.signal }), e => e.code === "provider_request_cancelled");
});

test("timeout signal is bounded without waiting for real timers", async () => {
  configure(); const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = ms => { assert.equal(ms, 15_000); return AbortSignal.abort(new DOMException("timeout", "TimeoutError")); };
  globalThis.fetch = async (_url, init) => { init.signal.throwIfAborted(); };
  try { await assert.rejects(generateText({ capability: "agent", prompt: "hi", maxTokens: 10 }), e => e.code === "provider_request_cancelled"); }
  finally { AbortSignal.timeout = originalTimeout; }
});

for (const image of [{ b64_json: png, media_type: "image/svg+xml" }, { b64_json: "not-base64", media_type: "image/png" }, { b64_json: "dGVzdA==", media_type: "image/png" }, { url: "https://untrusted.example/image.png", media_type: "image/png" }]) test("invalid or remote image output fails without fetching returned URLs", async () => {
  configure("art", "openai/test-image");
  globalThis.fetch = async url => url.endsWith("/models") ? response({ data: [{ id: "openai/test-image", architecture: { output_modalities: ["image"] } }] }) : response({ data: [image] });
  await assert.rejects(generateImage("test"), e => e.code === "invalid_image_response");
});

test("direct Anthropic and OpenAI paths keep their original wire contracts", async () => {
  process.env.TICKETSTUB_RUNTIME_MODE = "live";
  delete process.env.TICKETSTUB_AGENT_PROVIDER; delete process.env.TICKETSTUB_ART_PROVIDER;
  process.env.ANTHROPIC_API_KEY = "offline-direct-key"; process.env.OPENAI_API_KEY = "offline-direct-key";
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url === "https://api.anthropic.com/v1/messages") {
      assert.equal(init.headers["x-api-key"], "offline-direct-key"); assert.equal(body.model, "claude-sonnet-5-5");
      return response({ content: [{ type: "text", text: "Direct reply" }] });
    }
    assert.equal(url, "https://api.openai.com/v1/images/generations"); assert.equal(body.model, "gpt-image-1"); assert.equal(body.size, "1024x1536");
    return response({ data: [{ b64_json: "/9j/AA==" }] });
  };
  assert.equal((await generateText({ capability: "agent", prompt: "hi", maxTokens: 10 })).value, "Direct reply");
  assert.match((await generateImage("test")).value, /^data:image\/jpeg/);
});


test("browser agent displays configured-provider errors rather than simulated replies", async () => {
  globalThis.fetch = async () => response({ error: "The selected AI service could not complete this request.", code: "provider_authentication_failed" }, 502);
  await assert.rejects(client.askAgent({ event }, "Hello?"), /selected AI service/);
  globalThis.fetch = async () => new Response(null, { status: 204 });
  assert.equal(await client.askAgent({ event }, "Hello?"), undefined);
});

test("invalid provider configuration surfaces an error at the route boundary", async () => {
  configure(); process.env.TICKETSTUB_AGENT_PROVIDER = "typo";
  globalThis.fetch = () => { assert.fail("invalid provider attempted network"); };
  const result = await agent.POST(req({ event, message: "Hello?" }));
  assert.equal(result.status, 503); assert.equal((await result.json()).code, "invalid_provider_configuration");
});

test("research rejects malformed enrichment with a safe provider error", async () => {
  configure("research");
  globalThis.fetch = async url => url === "https://example.com/test-event"
    ? new Response('<script type="application/ld+json">{"@type":"MusicEvent","name":"Offline Test"}</script>')
    : response(textResponse("[null]"));
  const result = await research.POST(req({ url: "https://example.com/test-event" }));
  assert.equal(result.status, 502); assert.equal((await result.json()).code, "invalid_provider_response");
});

test("optional direct-provider paths still simulate without credentials", async () => {
  process.env.TICKETSTUB_RUNTIME_MODE = "live";
  delete process.env.TICKETSTUB_AGENT_PROVIDER; delete process.env.TICKETSTUB_ART_PROVIDER;
  delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  globalThis.fetch = () => { assert.fail("missing direct keys attempted network"); };
  assert.equal((await agent.POST(req({ event, message: "Hello?" }))).status, 204);
  assert.equal((await (await art.POST(req({ event }))).json()).provenance, "simulated");
});


test("each OpenRouter model uses only its paired capability key", async () => {
  process.env.TICKETSTUB_RUNTIME_MODE = "live";
  process.env.OPENROUTER_API_KEY = "offline-shared-key-must-not-be-used";
  for (const c of ["research", "agent", "art"]) {
    const prefix = `TICKETSTUB_${c.toUpperCase()}`;
    process.env[`${prefix}_PROVIDER`] = "openrouter";
    process.env[`${prefix}_MODEL`] = c === "art" ? "openai/test-image" : `anthropic/test-${c}`;
    process.env[`${prefix}_OPENROUTER_API_KEY`] = `offline-${c}-key`;
  }
  const authorizations = [];
  globalThis.fetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    const capability = url.includes("/images") ? "art" : body.model.endsWith("research") ? "research" : "agent";
    assert.equal(init.headers.authorization, `Bearer offline-${capability}-key`);
    authorizations.push(capability);
    if (url.endsWith("/images/models")) return response({ data: [{ id: "openai/test-image", architecture: { output_modalities: ["image"] } }] });
    if (url.endsWith("/images")) return response({ data: [{ b64_json: png, media_type: "image/png" }] });
    return response(textResponse());
  };
  await generateText({ capability: "research", prompt: "test", maxTokens: 10 });
  await generateText({ capability: "agent", prompt: "test", maxTokens: 10 });
  await generateImage("test");
  assert.deepEqual(authorizations, ["research", "agent", "art", "art"]);
});

for (const capability of ["research", "agent", "art"]) test(`${capability} never falls back to another model or shared key`, async () => {
  configure(capability, capability === "art" ? "openai/test-image" : "anthropic/test-model");
  process.env.OPENROUTER_API_KEY = "offline-shared-key";
  for (const c of ["RESEARCH", "AGENT", "ART"]) process.env[`TICKETSTUB_${c}_OPENROUTER_API_KEY`] = "offline-other-key";
  process.env[`TICKETSTUB_${capability.toUpperCase()}_OPENROUTER_API_KEY`] = " ";
  globalThis.fetch = () => { assert.fail("missing paired key attempted network"); };
  const operation = capability === "art" ? generateImage("test") : generateText({ capability, prompt: "test", maxTokens: 10 });
  await assert.rejects(operation, e => e.code === "missing_provider_key");
});
