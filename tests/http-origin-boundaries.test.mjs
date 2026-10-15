import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Exercise the real HTTP helpers and Next responses without booting a server.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
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

const { NextRequest } = await import("next/server.js");
const { appOrigin, checkOrigin, configuredOrigin, foreignOrigin, HttpError, json, route } = await import("../src/server/http.ts");
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error("HTTP boundary tests must stay offline"); };
afterEach(() => { process.env = { ...originalEnv }; });
process.on("exit", () => { globalThis.fetch = originalFetch; });
const request = (origin, headers = {}, url = "https://ticketstub.example/api/auth/link") => new Request(url, {
  headers: { ...(origin === undefined ? {} : { origin }), ...headers },
});
const denied = (req) => assert.throws(() => checkOrigin(req), (e) => e instanceof HttpError && e.status === 403 && e.code === "bad_origin");

test("configured APP_URL exclusively governs origin despite Host and forwarded headers", () => {
  process.env.APP_URL = "https://ticketstub.example";
  for (const headers of [
    { host: "ticketstub.example", "x-forwarded-host": "attacker.example" },
    { host: "attacker.example" },
    { host: "ticketstub.example", "x-forwarded-host": "attacker.example, ticketstub.example", "x-forwarded-proto": "https" },
  ]) denied(request("https://attacker.example", headers));
  denied(request("https://internal.example", { host: "internal.example" }, "https://internal.example/api/auth/link"));
  const valid = request("https://ticketstub.example", { host: "internal.example", "x-forwarded-host": "attacker.example", "x-forwarded-proto": "http" }, "http://internal.example/api/auth/link");
  assert.doesNotThrow(() => checkOrigin(valid));
  assert.equal(appOrigin(valid), "https://ticketstub.example");
  assert.equal(foreignOrigin(valid), false);
});

test("origin equality includes scheme and effective port", () => {
  process.env.APP_URL = "https://ticketstub.example";
  denied(request("http://ticketstub.example", { host: "ticketstub.example", "x-forwarded-proto": "http" }));
  denied(request("https://ticketstub.example:8443", { host: "ticketstub.example:8443" }));
  assert.doesNotThrow(() => checkOrigin(request("https://TICKETSTUB.EXAMPLE:443")));
  process.env.APP_URL = "https://ticketstub.example:8443/path";
  denied(request("https://ticketstub.example"));
  assert.doesNotThrow(() => checkOrigin(request("https://ticketstub.example:8443")));
});

test("missing, opaque, malformed and non-origin values are refused", () => {
  process.env.APP_URL = "https://ticketstub.example";
  for (const value of [undefined, "null", "not a URL", "https://ticketstub.example/path", "https://ticketstub.example?query=fixture", "https://ticketstub.example#fragment", "https://user:fixture@ticketstub.example", "https://ticketstub.example https://attacker.example"]) denied(request(value));
  assert.equal(foreignOrigin(request(undefined)), false, "guest routes still allow an absent Origin");
  assert.equal(foreignOrigin(request("null")), true);
});

test("unset APP_URL permits only the request URL's exact loopback origin", () => {
  delete process.env.APP_URL;
  for (const base of ["http://localhost:3000", "http://127.0.0.1:3999", "http://[::1]:3000", "https://localhost:3000"]) {
    const req = request(base, { host: "attacker.example", "x-forwarded-host": "attacker.example", "x-forwarded-proto": "javascript" }, `${base}/api/auth/link`);
    assert.doesNotThrow(() => checkOrigin(req));
    assert.equal(appOrigin(req), base);
    denied(request("https://attacker.example", { "x-forwarded-host": "attacker.example" }, `${base}/api/auth/link`));
    denied(request(base.replace(/:\d+$/, ":4444"), { host: base.replace(/^https?:\/\//, "").replace(/:\d+$/, ":4444") }, `${base}/api/auth/link`));
  }
  process.env.TICKETSTUB_RUNTIME_MODE = "live";
  assert.doesNotThrow(() => checkOrigin(request("http://localhost", {}, "http://localhost/api/agent")), "local AI mode does not change origin authority");
});

test("unset or invalid APP_URL cannot authorize a public request or link", () => {
  for (const value of [undefined, "bad-url", "http://ticketstub.example", "https://user:fixture@ticketstub.example", "javascript:fixture"]) {
    if (value === undefined) delete process.env.APP_URL; else process.env.APP_URL = value;
    assert.equal(configuredOrigin(), null);
    const req = request("https://ticketstub.example", { host: "ticketstub.example", "x-forwarded-host": "ticketstub.example" });
    denied(req);
    assert.throws(() => appOrigin(req), (e) => e instanceof HttpError && e.status === 503 && e.code === "origin_unavailable");
    if (value !== undefined) denied(request("http://localhost", { host: "localhost" }, "http://localhost/api/auth/link"));
  }
});

test("configuredOrigin preserves HTTPS and explicit localhost HTTP configuration", () => {
  for (const [value, expected] of [[" https://ticketstub.example/path ", "https://ticketstub.example"], ["http://localhost:3000", "http://localhost:3000"], ["http://127.0.0.1:3999", "http://127.0.0.1:3999"]]) {
    process.env.APP_URL = value;
    assert.equal(configuredOrigin(), expected);
    assert.doesNotThrow(() => checkOrigin(request(expected)));
  }
});

test("route keeps the bad-origin envelope and request ID and gates work before link issuance", async () => {
  process.env.APP_URL = "https://ticketstub.example";
  let issued = 0;
  const handler = route(async (req) => { checkOrigin(req); issued++; return json({ origin: appOrigin(req) }); });
  const rejected = await handler(request("https://attacker.example", { "x-forwarded-host": "attacker.example", "x-request-id": "req_fixture_origin" }));
  assert.equal(rejected.status, 403);
  assert.deepEqual(await rejected.json(), { error: { code: "bad_origin", message: "This request didn't come from TicketStub." } });
  assert.equal(rejected.headers.get("x-request-id"), "req_fixture_origin");
  assert.equal(rejected.headers.get("cache-control"), "no-store");
  assert.equal(issued, 0);
  const accepted = await handler(request("https://ticketstub.example"));
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { origin: "https://ticketstub.example" });
  assert.equal(issued, 1);
});

test("real NextRequest and native Request preserve each exact loopback authority", () => {
  delete process.env.APP_URL;
  delete process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE;
  const observations = [];
  for (const hostname of ["127.0.0.1", "[::1]", "localhost"]) {
    const origin = `http://${hostname}:36703`;
    for (const Constructor of [Request, NextRequest]) {
      const req = new Constructor(`${origin}/api/auth/link`, { headers: {
        origin, host: "attacker.example", "x-forwarded-host": "attacker.example", "x-forwarded-proto": "https",
      } });
      let accepted = true;
      try { checkOrigin(req); } catch (e) { assert.equal(e.code, "bad_origin"); accepted = false; }
      observations.push({ kind: Constructor.name, origin, exposedUrl: req.url, accepted, linkOrigin: appOrigin(req), foreign: foreignOrigin(req) });
    }
  }
  console.log("NEXTREQUEST_AUTHORITY_OBSERVATIONS " + JSON.stringify(observations));
  for (const observation of observations) {
    assert.equal(observation.accepted, true, `${observation.kind}: ${observation.origin}`);
    assert.equal(observation.linkOrigin, observation.origin);
    assert.equal(observation.foreign, false);
    if (observation.kind === "NextRequest") assert.equal(new URL(observation.exposedUrl).hostname, "localhost", "exercise actual framework normalization");
  }
});

test("loopback aliases remain separate authorities for native and real NextRequest", () => {
  delete process.env.APP_URL;
  for (const hostname of ["127.0.0.1", "[::1]", "localhost"]) {
    for (const other of ["127.0.0.1", "[::1]", "localhost"].filter((value) => value !== hostname)) {
      for (const Constructor of [Request, NextRequest]) {
        const origin = `http://${other}:36703`;
        denied(new Constructor(`http://${hostname}:36703/api/auth/link`, { headers: {
          origin, host: `${other}:36703`, "x-forwarded-host": `${other}:36703`, "x-forwarded-proto": "http",
        } }));
      }
    }
  }
});

test("real NextRequest fallback checks complete scheme and effective port", () => {
  delete process.env.APP_URL;
  for (const hostname of ["127.0.0.1", "[::1]", "localhost"]) {
    for (const scheme of ["http", "https"]) {
      const origin = `${scheme}://${hostname}:36703`;
      const make = (given) => new NextRequest(`${origin}/api/auth/link`, { headers: {
        origin: given, host: `${hostname}:4444`, "x-forwarded-proto": scheme === "http" ? "https" : "http",
      } });
      assert.doesNotThrow(() => checkOrigin(make(origin)));
      assert.equal(appOrigin(make(origin)), origin);
      denied(make(origin.replace(":36703", ":4444")));
      denied(make(origin.replace(`${scheme}:`, scheme === "http" ? "https:" : "http:")));
    }
    const defaultPort = new NextRequest(`https://${hostname}:443/api/auth/link`, { headers: { origin: `https://${hostname}` } });
    assert.doesNotThrow(() => checkOrigin(defaultPort));
    assert.equal(appOrigin(defaultPort), `https://${hostname}`);
  }
});

test("NextRequest normalization cannot authorize unlisted loopback or public endpoints", () => {
  delete process.env.APP_URL;
  delete process.env.__NEXT_NO_MIDDLEWARE_URL_NORMALIZE;
  for (const hostname of ["127.0.0.2", "127.10.20.30", "foo.localhost", "public.example"]) {
    for (const Constructor of [Request, NextRequest]) {
      for (const origin of ["http://localhost:36703", `http://${hostname}:36703`]) {
        const req = new Constructor(`http://${hostname}:36703/api/auth/link`, { headers: {
          origin, host: "localhost:36703", "x-forwarded-host": "localhost:36703", "x-forwarded-proto": "http",
        } });
        if (Constructor === NextRequest && hostname.startsWith("127.")) assert.equal(new URL(req.url).hostname, "localhost");
        denied(req);
        assert.throws(() => appOrigin(req), (e) => e.status === 503 && e.code === "origin_unavailable");
      }
    }
  }
});

test("APP_URL remains exclusive for real NextRequest regardless of normalized or supplied authority", () => {
  process.env.APP_URL = "https://public.example:8443/configured-path";
  for (const hostname of ["127.0.0.1", "[::1]", "localhost", "127.0.0.2", "internal.example"]) {
    const make = (origin) => new NextRequest(`http://${hostname}:36703/api/auth/link`, { headers: {
      origin, host: "attacker.example", "x-forwarded-host": "attacker.example", "x-forwarded-proto": "https",
    } });
    const valid = make("https://public.example:8443");
    assert.doesNotThrow(() => checkOrigin(valid));
    assert.equal(appOrigin(valid), "https://public.example:8443");
    for (const origin of [`http://${hostname}:36703`, "http://localhost:36703", "https://attacker.example", "http://public.example:8443", "https://public.example"]) denied(make(origin));
  }
  process.env.APP_URL = "not-a-url";
  const local = new NextRequest("http://127.0.0.1:36703/api/auth/link", { headers: { origin: "http://127.0.0.1:36703" } });
  denied(local);
  assert.throws(() => appOrigin(local), (e) => e.code === "origin_unavailable");
});

test("framework wrappers and clones keep their constructor-held authority", () => {
  delete process.env.APP_URL;
  for (const hostname of ["127.0.0.1", "[::1]"]) {
    const origin = `http://${hostname}:36703`;
    const native = new Request(`${origin}/api/auth/link`, { headers: { origin } });
    const framework = new NextRequest(native);
    for (const req of [framework, new NextRequest(framework), framework.clone()]) {
      assert.doesNotThrow(() => checkOrigin(req));
      assert.equal(appOrigin(req), origin);
    }
  }
});

test("overridden URL properties cannot create a local authority for a public native request", () => {
  delete process.env.APP_URL;
  const req = new Request("https://public.example/api/auth/link", { headers: { origin: "http://localhost:36703", host: "localhost:36703" } });
  Object.defineProperty(req, "url", { value: "http://localhost:36703/api/auth/link" });
  denied(req);
  assert.throws(() => appOrigin(req), (e) => e.status === 503 && e.code === "origin_unavailable");
});
