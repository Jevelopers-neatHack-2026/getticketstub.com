import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { registerHooks } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

// The browser research client's api_call events, through the real analytics runtime with an offline transport.
registerHooks({
  resolve(specifier, context, nextResolve) {
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

const runtime = await import("../src/customer/analytics/runtime.ts");
const client = await import("../src/customer/studio/research/client.ts");

const SEED = "SEEDSECRET91bc";
const originalFetch = globalThis.fetch;
let sent; let rejected;
const stub = { id: "s1", event: { type: "concert", title: `Title ${SEED}`, facts: [] }, versions: [] };

async function grant() {
  runtime.updateConsent("granted");
  await new Promise((r) => setImmediate(r));
}
beforeEach(() => {
  sent = []; rejected = [];
  runtime.resetAnalyticsForTests();
  runtime.setRejectHandler((name, reason) => rejected.push(`${name}:${reason}`));
  runtime.configureAnalytics({
    config: { measurementId: "G-TEST000000", environment: "preview", runtimeMode: "demo", debug: false },
    transport: () => ({ load: async () => {}, send: (n, p) => sent.push([n, p]), pause() {}, resume() {} }),
    origin: "https://example.test", referrer: "",
  });
});
// What the layout's page observer does on a real navigation: the runtime sends nothing until a sanitized page
// is known. The private parts of these URLs (stub ids, pasted links, queries) are seeded so they can be checked.
const visit = (pathname, search = "") => runtime.recordPageView(pathname, search);
const visitStudio = () => visit(`/studio/stub_${SEED}`);
afterEach(() => { globalThis.fetch = originalFetch; runtime.resetAnalyticsForTests(); });

const calls = () => sent.filter(([n]) => n === "api_call").map(([, p]) => p);
const pick = (p) => ({ api: p.api, result: p.result, status_class: p.status_class, error_code: p.error_code, mode: p.mode });
/** api_call events carry the page's template, never its path or query, and follow that page's view. */
const onPage = (template) => {
  const firstCall = sent.findIndex(([n]) => n === "api_call");
  const view = sent.findIndex(([n]) => n === "page_view");
  assert.ok(view >= 0 && view < firstCall, "page_view precedes api_call");
  for (const p of calls()) assert.equal(p.route_template, template);
};
const clean = () => {
  const all = JSON.stringify(sent);
  for (const bad of [SEED, "unreadable_link", "provider_authentication_failed", "art_limit", "/api/"]) assert.ok(!all.includes(bad), bad);
  assert.deepEqual(rejected, []);
};

test("nothing is sent before consent, and nothing is replayed after it", async () => {
  visit("/search", `?q=${SEED}`);
  globalThis.fetch = async () => Response.json({ results: [] });
  await client.searchEvents(`query ${SEED}`);
  await grant();
  assert.equal(calls().length, 0);
});

test("research success, server rejection and network failure are bounded and timed", async () => {
  visit("/new", `?url=https%3A%2F%2Fexample.com%2F%3Fq%3D${SEED}`);
  await grant();
  globalThis.fetch = async () => Response.json({ results: [] });
  await client.searchEvents(`query ${SEED}`);
  globalThis.fetch = async () => Response.json({ error: { code: "unreadable_link", message: `raw ${SEED}` } }, { status: 422 });
  await assert.rejects(client.researchEvent({ url: `https://example.com/?q=${SEED}` }));
  globalThis.fetch = async () => { throw new TypeError(`offline ${SEED}`); };
  await assert.rejects(client.researchEvent({ url: "https://example.com/x" }));
  globalThis.fetch = async () => new Response("<html>", { status: 200 });
  await assert.rejects(client.searchEvents("q"));
  assert.deepEqual(calls().map(pick), [
    { api: "research", result: "empty", status_class: "2xx", error_code: undefined, mode: undefined },
    { api: "research", result: "failure", status_class: "4xx", error_code: "unsupported_url", mode: undefined },
    { api: "research", result: "failure", status_class: "network", error_code: "network", mode: undefined },
    { api: "research", result: "failure", status_class: "2xx", error_code: "parse", mode: undefined },
  ]);
  for (const p of calls()) assert.ok(Number.isInteger(p.duration_ms) && p.duration_ms >= 0 && p.attempt === 1);
  onPage("/new");
  clean();
});

test("agent 204 is a fallback, a live reply is live, a provider error maps to provider_config", async () => {
  visitStudio();
  await grant();
  globalThis.fetch = async () => new Response(null, { status: 204 });
  assert.equal(await client.askAgent(stub, `hi ${SEED}`), undefined);
  globalThis.fetch = async () => Response.json({ reply: `reply ${SEED}`, provenance: "live", providerMetadata: { requestedModel: "anthropic/x" } });
  assert.equal((await client.askAgent(stub, "hi")).provenance, "live");
  globalThis.fetch = async () => Response.json({ error: { code: "provider_authentication_failed", message: "x" } }, { status: 502 });
  await assert.rejects(client.askAgent(stub, "hi"));
  assert.deepEqual(calls().map(pick), [
    { api: "agent", result: "fallback", status_class: "204", error_code: undefined, mode: "fallback" },
    { api: "agent", result: "success", status_class: "2xx", error_code: undefined, mode: "live" },
    { api: "agent", result: "failure", status_class: "5xx", error_code: "provider_config", mode: undefined },
  ]);
  onPage("/studio/:id");
  clean();
});

test("art: live, simulated, daily-limit fallback and unknown server failure", async () => {
  visitStudio();
  await grant();
  globalThis.fetch = async () => Response.json({ kind: "image", src: "data:image/png;base64,AAAA", seed: 1, provenance: "live" });
  await client.remixArtNoted(stub, `vibe ${SEED}`);
  globalThis.fetch = async () => Response.json({ kind: "procedural", seed: 1, provenance: "simulated" });
  await client.remixArtNoted(stub);
  globalThis.fetch = async () => Response.json({ error: { code: "art_limit", message: "x" }, retryAt: 1, art: { kind: "procedural", seed: 2, provenance: "simulated" } }, { status: 429 });
  assert.ok((await client.remixArtNoted(stub)).limitNote);
  globalThis.fetch = async () => Response.json({ error: { code: `weird_${SEED}`, message: "x" } }, { status: 500 });
  await assert.rejects(client.remixArtNoted(stub));
  assert.deepEqual(calls().map(pick), [
    { api: "art", result: "success", status_class: "2xx", error_code: undefined, mode: "live" },
    { api: "art", result: "success", status_class: "2xx", error_code: undefined, mode: "simulated" },
    { api: "art", result: "fallback", status_class: "4xx", error_code: "rate_limited", mode: "fallback" },
    { api: "art", result: "failure", status_class: "5xx", error_code: "http_5xx", mode: undefined },
  ]);
  onPage("/studio/:id");
  clean();
});

test("duration is the real round trip, and each call is one event", async () => {
  visitStudio();
  await grant();
  globalThis.fetch = () => new Promise((r) => setTimeout(() => r(new Response(null, { status: 204 })), 40));
  await client.askAgent(stub, "hi");
  await client.askAgent(stub, "hi");
  const [a, b] = calls();
  assert.equal(calls().length, 2);
  assert.ok(a.duration_ms >= 35 && a.duration_ms < 5_000, `duration ${a.duration_ms}`);
  assert.ok(b.duration_ms >= 35);
  clean();
});

test("unconfigured analytics leaves every client result unchanged", async () => {
  runtime.resetAnalyticsForTests();
  globalThis.fetch = async () => new Response(null, { status: 204 });
  assert.equal(await client.askAgent(stub, "hi"), undefined);
  assert.equal(sent.length, 0);
});
