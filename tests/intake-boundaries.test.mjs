import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { registerHooks } from "node:module";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { execFileSync } from "node:child_process";
import { createServer as netServer } from "node:net";
import { gzipSync, brotliCompressSync } from "node:zlib";
import ts from "typescript";

// Offline negative tests for the URL-first intake boundary: nothing here may reach the network.
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
const scratch = mkdtempSync(join(tmpdir(), "ticketstub-intake-"));
process.env.TICKETSTUB_DB = join(scratch, "intake.sqlite");
process.env.TICKETSTUB_FILES = join(scratch, "files");
const intake = await import("../src/server/intake-url.ts");
const research = await import("../src/app/api/research/route.ts");

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let fetched = [];
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...originalEnv }; intake.setTransport(); intake.setHostResolver(); fetched = []; });
/** Offline: no sockets and no DNS. `handler` plays the remote site for every hop fetchPublic makes. */
function offline(handler) {
  fetched = [];
  process.env.TICKETSTUB_RUNTIME_MODE = "live";
  intake.setTransport(async (url) => { fetched.push(url.href); return handler ? handler(url.href) : assert.fail(`unexpected fetch ${url.href}`); });
}
const post = (body, raw) => research.POST(new Request("http://localhost/api/research", { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body) }));
const codeOf = async (res) => (await res.json()).error?.code;

test("parseIntakeUrl rejects schemes, credentials, ports, controls and length", () => {
  const reason = (s) => { const r = intake.parseIntakeUrl(s); return r.ok ? "ok" : r.reason; };
  for (const s of ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "ftp://example.com/x", "mailto:a@example.com", "blob:https://example.com/x", "//example.com/x"]) assert.equal(reason(s), "unsupported_scheme", s);
  for (const s of ["https://user:pw@example.com/", "https://user@example.com/", "http://:pw@example.com/"]) assert.equal(reason(s), "url_credentials", s);
  for (const s of ["https://example.com:8443/", "http://example.com:22/"]) assert.equal(reason(s), "unsupported_port", s);
  for (const s of ["https://exa mple.com/", "https://example.com/\u0000", "https://example.com\\@evil.com/", "https://"]) assert.equal(reason(s), "url_malformed", s);
  assert.equal(reason(`https://example.com/${"a".repeat(2048)}`), "url_too_long");
  assert.equal(reason("example.com/e/1"), "ok");
  assert.equal(reason("https://example.com:443/e"), "ok");
  assert.equal(reason(`https://example.com/${"a".repeat(2000)}`), "ok");
  // Boundary on the normalized URL: exactly 2048 passes, one more does not.
  const pad = (n) => `https://example.com/${"a".repeat(n - "https://example.com/".length)}`;
  assert.equal(reason(pad(2048)), "ok");
  assert.equal(reason(pad(2049)), "url_too_long");
});

test("private, loopback, link-local, reserved and local-name hosts are blocked without DNS", () => {
  const hosts = [
    "localhost", "LOCALHOST.", "foo.localhost", "printer.local", "db.internal", "intranet", "127.0.0.1", "127.1", "2130706433", "0x7f.0.0.1", "0177.0.0.1", "0.0.0.0",
    "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "198.18.0.1", "192.0.2.1", "224.0.0.1", "255.255.255.255",
    "[::1]", "[::]", "[fe80::1]", "[fc00::1]", "[fd12:3456::1]", "[ff02::1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::ffff:10.0.0.1]", "[64:ff9b::a00:1]", "[2001:db8::1]", "[2002:7f00:1::]",
  ];
  for (const h of hosts) {
    const r = intake.parseIntakeUrl(`http://${h}/x`);
    assert.equal(r.ok, false, h);
    assert.equal(r.reason, "blocked_destination", h);
  }
  for (const h of ["93.184.216.34", "172.32.0.1", "[2606:2800:220:1:248:1893:25c8:1946]", "example.com"]) assert.equal(intake.parseIntakeUrl(`https://${h}/x`).ok, true, h);
});

test("route refuses unsupported schemes and credentials before any fetch", async () => {
  offline();
  for (const [url, code] of [["javascript:alert(1)", "unsupported_url"], ["https://u:p@example.com/", "unsupported_url"], ["http://169.254.169.254/latest/meta-data", "unsupported_url"], ["http://localhost/admin", "unsupported_url"], ["http://example.com:6379/", "unsupported_url"], [`https://example.com/${"a".repeat(3000)}`, "too_large"]]) {
    const res = await post({ url });
    assert.equal(res.status, 422, url.slice(0, 40));
    const body = await res.json();
    assert.equal(body.error.code, code);
    assert.ok(!JSON.stringify(body).includes("169.254"), "the input is not echoed");
  }
  assert.deepEqual(fetched, []);
});

test("a demo keyword inside a malformed or control-character link never rescues it", async () => {
  offline();
  for (const url of ["neathack\u0000.example.com", "https://neathack\u0000.example.com/", "https://neat hack.example.com/", "https://neathack .example.com/x", "neathack.example.com/\u0001", "https://neathack.com\\@evil.example/", "neathack\u0000", "neathack\u0007"]) {
    const res = await post({ url });
    assert.equal(res.status, 422, JSON.stringify(url));
    assert.equal(await codeOf(res), "unreadable_link", JSON.stringify(url));
  }
  assert.deepEqual(fetched, []);
  assert.equal((await post({ url: "neathack%zz" })).status, 200); // a bad %-escape in a bare keyword must not crash the handler
});

test("unsupported inputs are refused explicitly, never accepted and ignored", async () => {
  offline();
  for (const field of ["file", "image", "screenshot", "upload", "urls", "sources", "email", "csv"]) {
    const res = await post({ url: "https://example.com/e", [field]: field === "urls" ? ["https://a.example.com"] : "x" });
    assert.equal(res.status, 422, field);
    assert.equal(await codeOf(res), "unsupported_input", field);
  }
  assert.deepEqual(fetched, []);
});

test("malformed and wrongly typed bodies are rejected before dispatch", async () => {
  offline();
  assert.equal((await post(null, "null")).status, 400);
  assert.equal((await post(null, "[1]")).status, 400);
  assert.equal((await post(null, "{not json")).status, 400);
  assert.equal((await post({ url: ["https://example.com"] })).status, 400);
  assert.equal((await post({ url: 42 })).status, 400);
  assert.equal((await post({ query: { $ne: 1 } })).status, 400);
  assert.equal((await post({ query: "q".repeat(201) })).status, 422);
  assert.equal((await post({ query: "q".repeat(200) })).status, 200);
  assert.deepEqual(fetched, []);
});

test("the body cap counts bytes, not characters, at exact boundaries", async () => {
  offline();
  const cap = intake.INTAKE_LIMITS.bodyBytes;
  // 8192 bytes exactly: accepted (a query that parses and is searched).
  const shell = JSON.stringify({ query: "", pad: "" });
  const exact = JSON.stringify({ query: "q", pad: "x".repeat(cap - Buffer.byteLength(JSON.stringify({ query: "q", pad: "" }))) });
  assert.equal(Buffer.byteLength(exact), cap);
  assert.equal((await post(null, exact)).status, 200);
  assert.ok(shell.length < cap);
  assert.equal((await post(null, exact.replace('"x', '"xx'))).status, 413); // one byte over
  // UTF-8: 4429 two-byte characters is 8858 bytes but only 4429 JS chars; it must be refused.
  const multi = JSON.stringify({ query: "q", pad: "é".repeat(4429) });
  assert.ok(multi.length < cap && Buffer.byteLength(multi) > cap);
  const res = await post(null, multi);
  assert.equal(res.status, 413);
  assert.equal(await codeOf(res), "too_large");
  // Just under in bytes with multi-byte characters is still accepted.
  const fits = JSON.stringify({ query: "q", pad: "é".repeat(Math.floor((cap - Buffer.byteLength(JSON.stringify({ query: "q", pad: "" }))) / 2)) });
  assert.ok(Buffer.byteLength(fits) <= cap);
  assert.equal((await post(null, fits)).status, 200);
});

test("a chunked oversize body is cancelled at the cap, not read to the end", async () => {
  offline();
  let pulled = 0;
  let cancelled = false;
  const chunk = new TextEncoder().encode("x".repeat(1024));
  const stream = new ReadableStream({
    pull(c) { if (pulled >= 20) return c.close(); pulled++; c.enqueue(chunk); },
    cancel() { cancelled = true; },
  });
  const res = await research.POST(new Request("http://localhost/api/research", { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" }));
  assert.equal(res.status, 413);
  assert.equal(cancelled, true, "the request stream was cancelled");
  assert.ok(pulled < 20, `pulled ${pulled} of 20 chunks`);
  assert.deepEqual(fetched, []);
});

test("redirects to private or non-http destinations are refused and never requested", async () => {
  for (const target of ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:8080/", "http://10.0.0.1/", "ftp://example.com/x", "https://user:pw@example.com/x", "http://localhost/", "http://[::ffff:7f00:1]/"]) {
    offline((url) => url === "https://example.com/start" ? new Response(null, { status: 302, headers: { location: target } }) : assert.fail(`followed redirect to ${url}`));
    const res = await post({ url: "https://example.com/start" });
    assert.equal(res.status, 422, target);
    assert.equal(await codeOf(res), "unsupported_url", target);
    assert.deepEqual(fetched, ["https://example.com/start"], target);
  }
});

test("a redirect Location over the length cap is refused, including a long relative one", async () => {
  for (const location of [`https://example.com/${"a".repeat(2100)}`, `/${"b".repeat(2100)}`, `/${"b".repeat(2040)}`]) {
    offline((url) => url === "https://example.com/start" ? new Response(null, { status: 302, headers: { location } }) : new Response("<title>t</title>"));
    const res = await post({ url: "https://example.com/start" });
    assert.equal(res.status, 422, location.length);
    assert.deepEqual(fetched, ["https://example.com/start"], String(location.length));
  }
  // A 3020-character absolute target resolved from a short relative base is also refused.
  offline((url) => url === "https://example.com/start" ? new Response(null, { status: 302, headers: { location: `/${"c".repeat(3019)}` } }) : assert.fail("followed"));
  assert.equal((await post({ url: "https://example.com/start" })).status, 422);
});

test("redirect chains are capped, and a public redirect is still followed", async () => {
  offline((url) => new Response(null, { status: 302, headers: { location: `${url}x` } }));
  await assert.rejects(intake.fetchPublic("https://example.com/a"), (e) => e.reason === "too_many_redirects");
  assert.equal(fetched.length, intake.INTAKE_LIMITS.redirects + 1);

  offline((url) => url.endsWith("/a") ? new Response(null, { status: 302, headers: { location: "/b" } }) : new Response("<title>ok</title>"));
  const res = await intake.fetchPublic("https://example.com/a");
  assert.equal(await res.text(), "<title>ok</title>");
  assert.deepEqual(fetched, ["https://example.com/a", "https://example.com/b"]);
});

test("readCapped stops at the byte cap", async () => {
  const stream = new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode("a".repeat(1000))); } });
  assert.equal((await intake.readCapped(new Response(stream), 2500)).length, 2500);
});

test("demo keywords still work and make no outbound request", async () => {
  offline();
  assert.equal((await post({ url: "neathack" })).status, 200);
  assert.deepEqual(fetched, []);
});

// ---- Socket-bound pinning: real loopback sockets, no external network ----

const LOOPBACK = (a) => a === "127.0.0.1";
function listen(server) { return new Promise((res) => server.listen(0, "127.0.0.1", () => res(server.address().port))); }
const close = (server) => new Promise((res) => server.close(() => res()));

test("the pinned transport refuses a name with any private answer before a connection is made", async () => {
  let hits = 0;
  const server = httpServer((req, res) => { hits++; res.end("secret"); });
  const port = await listen(server);
  try {
    for (const answers of [["127.0.0.1"], ["93.184.216.34", "127.0.0.1"], ["::1"], ["::ffff:127.0.0.1"], ["10.0.0.1"], []]) {
      const t = intake.createPinnedTransport({ resolver: () => async () => answers });
      await assert.rejects(t(new URL(`http://rebind.example.com:${port}/`), {}), (e) => e instanceof intake.BlockedDestinationError, JSON.stringify(answers));
    }
    const failing = intake.createPinnedTransport({ resolver: () => async () => { throw new Error("nxdomain"); } });
    await assert.rejects(failing(new URL(`http://gone.example.com:${port}/`), {}), (e) => e.reason === "dns_failed");
    assert.equal(hits, 0, "no request reached the server");
  } finally { await close(server); }
});

test("the pinned transport connects only to the address it validated, resolving exactly once", async () => {
  const seen = [];
  const server = httpServer((req, res) => { seen.push({ host: req.headers.host, ua: req.headers["user-agent"], path: req.url }); res.end("<title>pinned</title>"); });
  const port = await listen(server);
  let resolutions = 0;
  try {
    const t = intake.createPinnedTransport({ resolver: () => async (h) => { resolutions++; return h === "pin.example.com" ? ["127.0.0.1"] : ["10.0.0.9"]; }, allowed: LOOPBACK });
    const res = await t(new URL(`http://pin.example.com:${port}/p?q=1`), { headers: { "user-agent": "t" } });
    assert.equal(await res.text(), "<title>pinned</title>");
    assert.equal(resolutions, 1, "a single lookup serves the connection; there is no second, separate resolution to rebind");
    assert.deepEqual(seen, [{ host: `pin.example.com:${port}`, ua: "t", path: "/p?q=1" }]);
    // A second name is judged on its own answer.
    await assert.rejects(t(new URL(`http://other.example.com:${port}/`), {}), (e) => e instanceof intake.BlockedDestinationError);
    assert.equal(seen.length, 1);
  } finally { await close(server); }
});

test("a rebinding resolver cannot redirect a validated connection: the answer used is the answer checked", async () => {
  const server = httpServer((req, res) => res.end("ok"));
  const port = await listen(server);
  const answers = [["127.0.0.1"], ["10.0.0.9"]];
  let call = 0;
  try {
    const t = intake.createPinnedTransport({ resolver: () => async () => answers[Math.min(call++, 1)], allowed: LOOPBACK });
    assert.equal(await (await t(new URL(`http://flip.example.com:${port}/`), {})).text(), "ok");
    await assert.rejects(t(new URL(`http://flip.example.com:${port}/`), {}), (e) => e instanceof intake.BlockedDestinationError);
  } finally { await close(server); }
});

test("HTTPS keeps hostname TLS semantics under pinning", { skip: (() => { try { execFileSync("openssl", ["version"]); return false; } catch { return "openssl is required to mint a throwaway test certificate"; } })() }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ticketstub-tls-"));
  const key = join(dir, "k.pem"), cert = join(dir, "c.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=tls.example.com", "-addext", "subjectAltName=DNS:tls.example.com"], { stdio: "ignore" });
  let sni;
  const server = httpsServer({ key: readFileSync(key), cert: readFileSync(cert), SNICallback: (name, cb) => { sni = name; cb(null, undefined); } }, (req, res) => res.end("secure"));
  const port = await listen(server);
  const resolver = () => async () => ["127.0.0.1"];
  const ca = readFileSync(cert, "utf8");
  try {
    const trusted = intake.createPinnedTransport({ resolver, allowed: LOOPBACK, ca });
    assert.equal(await (await trusted(new URL(`https://tls.example.com:${port}/`), {})).text(), "secure");
    assert.equal(sni, "tls.example.com", "SNI is the requested hostname, not the pinned IP");
    // Same pinned address, different requested name: the certificate does not cover it.
    await assert.rejects(trusted(new URL(`https://evil.example.com:${port}/`), {}), (e) => /altnames|hostname|does not match/i.test(`${e.code} ${e.message}`));
    // No trust anchor for the certificate: verification stays on.
    const untrusted = intake.createPinnedTransport({ resolver, allowed: LOOPBACK });
    await assert.rejects(untrusted(new URL(`https://tls.example.com:${port}/`), {}), (e) => /self.signed|unable to verify|CERT/i.test(`${e.code} ${e.message}`));
  } finally { await close(server); }
});

// ---- Astra round 3 regressions ----

test("every provided field is validated before a branch: a long query is refused even beside a url", async () => {
  offline();
  for (const body of [{ url: "neathack", query: "q".repeat(201) }, { url: "https://example.com/e", query: "q".repeat(201) }, { url: "", query: "q".repeat(201) }]) {
    const res = await post(body);
    assert.equal(res.status, 422, JSON.stringify(body).slice(0, 40));
    assert.equal(await codeOf(res), "too_large");
  }
  assert.equal((await post({ url: "neathack", query: "q".repeat(200) })).status, 200);
  assert.deepEqual(fetched, []);
});

test("IPv6 is accepted only inside IANA-allocated prefixes; reserved, unlisted and special-purpose space fails closed", () => {
  // IANA lists 3ffe::/16 (former 6bone) and 3fff::/20 as RESERVED, and the rest of 2000::/3 outside its allocations as unassigned.
  for (const ip of [
    "3ffe::1", "3ffe:831f::1", "3fff::1", "3fff:fff::1", "3fff:1000::1", "3000::1", "3800::1", "3ffc::1", "2d00::1", "2e00::1", "2000::1", "2000:ffff::1", "2004::1",
    "2001::1", "2001:1ff:ffff::1", "2001:2::1", "2001:1::1", "2001:20::1", "2001:db8::1", "2001:db8:ffff::1", "2001:1000::1", "2001:1100::1", "2003:4000::1", "2420::1", "2810::1", "2a20::1", "2c10::1",
    "2610:200::1", "2620:4f:8000::1", "2620:4f:8000:ffff::1",
    "4000::1", "8000::1", "5f00::1", "64:ff9b:1::a00:1", "fc00::1", "fe80::1", "fec0::1", "ff02::1", "100::1", "::2",
    "2002:a00:1::1", "2002:7f00:1::", "2002:c0a8:1::1", // 6to4 judged by its embedded IPv4
  ]) assert.equal(intake.isBlockedIp(ip), true, ip);
  // Inside allocated rows, including both edges of each boundary the rows above probe.
  for (const ip of [
    "2001:200::1", "2001:3ff:ffff:ffff:ffff:ffff:ffff:ffff", "2001:400::1", "2001:4860:4860::8888", "2001:c00::1", "2001:dba::1", "2001:db9::1", "2001:fff::1", "2001:1200::1", "2001:1c00::1", "2001:1fff::1",
    "2001:2000::1", "2001:3fff::1", "2001:5000::1", "2001:5fff::1", "2001:8000::1", "2001:bfff::1",
    "2003::1", "2003:3fff::1", "2400::1", "240f:ffff::1", "2410::1", "241f::1", "2600::1", "2606:2800:220:1:248:1893:25c8:1946", "260f:ffff::1", "2610:1ff::1", "2620:0:1ff::1", "2620:4f:7fff::1", "2620:4f:8001::1", "2630::1", "263f::1",
    "2800::1", "280f::1", "2a00:1450:4009::200e", "2a1f::1", "2c00::1", "2c0f::1",
    "64:ff9b::5db8:d822", "::ffff:93.184.216.34", "2002:5db8:d822::1",
  ]) assert.equal(intake.isBlockedIp(ip), false, ip);
  // The hostname path agrees, through brackets and URL normalization.
  for (const h of ["[2001:2::1]", "[64:ff9b:1::a00:1]", "[4000::1]", "[3ffe::1]", "[2000::1]", "[3fff:1000::1]"]) assert.equal(intake.parseIntakeUrl(`http://${h}/`).reason, "blocked_destination", h);
  assert.equal(intake.parseIntakeUrl("https://[2606:2800:220:1:248:1893:25c8:1946]/").ok, true);
});

async function rawServer(respond) {
  const server = netServer((sock) => { sock.once("data", () => respond(sock)); sock.on("error", () => {}); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port, stop: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }) };
}
const loopbackTransport = (extra = {}) => intake.createPinnedTransport({ resolver: () => async () => ["127.0.0.1"], allowed: LOOPBACK, ...extra });

test("an upstream status outside the Response range is rejected safely, without an uncaught exception", async () => {
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);
  process.on("uncaughtException", onUncaught);
  const sent = [];
  try {
    for (const status of ["600", "999", "100", "199"]) {
      const { port, stop } = await rawServer((sock) => { sent.push(status); sock.end(`HTTP/1.1 ${status} Odd\r\ncontent-length: 2\r\nconnection: close\r\n\r\nhi`); });
      try {
        await assert.rejects(loopbackTransport()(new URL(`http://odd.example.com:${port}/`), {}), (e) => e instanceof Error, status);
      } finally { await stop(); }
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(uncaught, []);
    assert.ok(sent.length >= 2);
    // The route reports it as an unreadable link, not a 500.
    process.env.TICKETSTUB_RUNTIME_MODE = "live";
    const { port, stop } = await rawServer((sock) => sock.end("HTTP/1.1 600 Odd\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"));
    try {
      const t = loopbackTransport();
      intake.setTransport((url, init) => t(new URL(`http://odd.example.com:${port}${url.pathname}`), init));
      const res = await post({ url: "https://example.com/e" });
      assert.equal(res.status, 422);
      assert.equal(await codeOf(res), "unreadable_link");
    } finally { await stop(); }
  } finally { process.off("uncaughtException", onUncaught); }
});

test("Content-Encoding gzip, deflate and br are decoded like native fetch, with decoded headers", async () => {
  const html = "<title>Compressed event</title>";
  const { deflateSync } = await import("node:zlib");
  for (const [enc, pack] of [["gzip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync], ["identity", (x) => Buffer.from(x)], ["gzip, identity", gzipSync]]) {
    const server = httpServer((_req, res) => { res.writeHead(200, { "content-type": "text/html", "content-encoding": enc }); res.end(pack(html)); });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const res = await loopbackTransport()(new URL(`http://enc.example.com:${server.address().port}/`), {});
      assert.equal(await intake.readCapped(res), html, enc);
      if (enc !== "identity") assert.equal(res.headers.get("content-encoding"), null, "decoded responses do not claim to still be encoded");
    } finally { server.closeAllConnections(); await close(server); }
  }
});

test("an unsupported Content-Encoding is refused rather than passed through as bytes", async () => {
  const server = httpServer((_req, res) => { res.writeHead(200, { "content-encoding": "zstd" }); res.end("x"); });
  const port = await listen(server);
  try {
    await assert.rejects(loopbackTransport()(new URL(`http://enc.example.com:${port}/`), {}), /unsupported content-encoding/);
  } finally { server.closeAllConnections(); await close(server); }
});

test("a compression bomb is aborted at the decoded-byte cap and the upstream is torn down", async () => {
  const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024, 0x61)); // 64 MiB of "a" in ~64 KB
  assert.ok(bomb.length < 200 * 1024);
  let closed = false;
  const server = httpServer((req, res) => { res.on("close", () => { closed = true; }); res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" }); res.end(bomb); });
  const port = await listen(server);
  try {
    // 1) The transport's own decoded cap errors the stream.
    const res = await loopbackTransport({ maxDecodedBytes: 100_000 })(new URL(`http://bomb.example.com:${port}/`), {});
    await assert.rejects(res.text());
    // 2) The page reader stops at its cap well before the cap, and cancels the pipeline.
    const res2 = await loopbackTransport()(new URL(`http://bomb.example.com:${port}/`), {});
    const text = await intake.readCapped(res2, 50_000);
    assert.equal(text.length, 50_000);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(closed, true, "the upstream connection was closed");
  } finally { server.closeAllConnections(); await close(server); }
});

test("aborting the caller's signal stops a pending DNS lookup", async () => {
  let finish;
  const t = intake.createPinnedTransport({ resolver: () => () => new Promise((r) => { finish = r; }) });
  const controller = new AbortController();
  const pending = t(new URL("http://dns.example.com/"), { signal: controller.signal }).then(() => "resolved", (e) => e.name);
  controller.abort();
  assert.equal(await Promise.race([pending, new Promise((r) => setTimeout(() => r("still-pending"), 200))]), "AbortError");
  finish?.(["93.184.216.34"]);
});
