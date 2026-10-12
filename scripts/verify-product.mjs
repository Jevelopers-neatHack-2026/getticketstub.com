// One entry point for the product checks, with evidence.
//   npm run verify:product -- --suite <foundation|access|approval|order-auth|research|creative|review|capabilities|messages|a11y|agent|download|production|degraded|mail-off|backup-drill> --mode fixture --evidence-dir <dir>
// (`accessibility` is an alias of `a11y`: GT-11 names the suite that way.)
// Every suite runs offline: in fixture mode a preload (scripts/lib/fixture-network-guard.mjs) refuses any host but
// loopback, and the server started here has no provider keys. A missing build or fixture, an unknown suite and
// any skipped check exit nonzero. Each run writes <evidence-dir>/<suite>-<timestamp>.json.
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guard = join(root, "scripts/lib/fixture-network-guard.mjs");
/** smoke-server checks that need `next dev`; production answers them differently on purpose. */
// smoke-server now checks the email preview against the server it talks to, so nothing is excused
const DEV_ONLY_CHECKS = [];
const STAFF_EMAIL = "verify-staff@example.com";
const MEMBER_EMAIL = "verify-member@example.com";

// ---- arguments ----
const SUITES = {
  foundation: { server: true, needs: [".next/BUILD_ID"], run: foundation },
  access: { server: true, needs: [".next/BUILD_ID", "scripts/smoke-server.mjs"], run: (ctx) => script("scripts/smoke-server.mjs", [ctx.base], { SMOKE_ADMIN_EMAIL: STAFF_EMAIL }) },
  // GT-06B: the artwork approval and its verifier (two accounts, stale, revoke, 404 parity, Origin, fixtures), against the production build.
  approval: { server: true, needs: [".next/BUILD_ID", "scripts/check-approval.mjs", "fixtures/approval/index.json", "fixtures/approval/verify.mjs"], run: (ctx) => script("scripts/check-approval.mjs", [ctx.base]) },
  // GT-07: the order authorization (issuer, verifier, atomic claim, lookup, dispatch-time revalidate), against the production build.
  // The server and the script share a random per-run CONTEXT_SECRET (to mint an expired row) and ORDER_AUTH_CONSUMER_KEY (to sign consumer requests); neither is the published fixture key.
  "order-auth": {
    server: true,
    env: () => ({ CONTEXT_SECRET: randomBytes(24).toString("hex"), ORDER_AUTH_CONSUMER_KEY: randomBytes(24).toString("hex") }),
    needs: [".next/BUILD_ID", "scripts/check-order-auth.mjs", "fixtures/order-authorization/index.json", "fixtures/order-authorization/verify.mjs"],
    run: (ctx) => script("scripts/check-order-auth.mjs", [ctx.base], ctx.env),
  },
  research: { server: false, needs: ["scripts/smoke-ticketmaster.mjs", "scripts/fixtures/ticketmaster-discovery-event.json"], run: () => script("scripts/smoke-ticketmaster.mjs") },
  creative: { server: false, needs: ["scripts/check-creative-adapter.mjs", "src/customer/studio/creative/fixtures"], run: () => script("scripts/check-creative-adapter.mjs") },
  review: { server: false, needs: ["scripts/check-review-versions.mjs", "src/customer/studio/facts/corrections.ts"], run: () => script("scripts/check-review-versions.mjs") },
  capabilities: { server: false, needs: ["scripts/check-capabilities.mjs", "src/customer/pages/capabilities.ts"], run: () => script("scripts/check-capabilities.mjs") },
  messages: { server: false, needs: ["scripts/check-messages.mjs", "src/customer/feedback-messages/messages.ts"], run: () => script("scripts/check-messages.mjs") },
  // GT-11: axe-core, overflow, keyboard, dialog focus and reduced motion in a real headless Chrome (needs Chrome or Edge, or CHROME_PATH).
  a11y: { server: true, needs: [".next/BUILD_ID", "scripts/check-a11y.mjs", "scripts/lib/cdp.mjs", "scripts/lib/contrast.mjs", "node_modules/axe-core/axe.min.js"], run: (ctx) => script("scripts/check-a11y.mjs", [ctx.base, evidenceDir]) },
  // GT-04: the agent proposes typed actions, the owner applies them, the result goes back; plus a forced failure and its recovery.
  agent: { server: true, needs: [".next/BUILD_ID", "scripts/check-agent.mjs", "scripts/lib/cdp.mjs", "src/customer/studio/agent/protocol.ts"], run: (ctx) => script("scripts/check-agent.mjs", [ctx.base, evidenceDir]) },
  // The exact stub download (#16): the real Download button in headless Chrome, the PNG against the on-screen stub (needs Chrome or Edge, or CHROME_PATH).
  download: { server: true, needs: [".next/BUILD_ID", "scripts/check-download.mjs", "scripts/lib/cdp.mjs"], run: (ctx) => script("scripts/check-download.mjs", [ctx.base, evidenceDir]) },
  production: { server: true, needs: [".next/BUILD_ID", "scripts/smoke-production.mjs"], run: (ctx) => script("scripts/smoke-production.mjs", [], { SMOKE_BASE_URL: ctx.base }) },
  // Storage that cannot be written: the server starts with TICKETSTUB_DB under a file, so every OS refuses it.
  degraded: { server: true, unwritableStorage: true, needs: [".next/BUILD_ID", "scripts/smoke-production.mjs"], run: degraded },
  // #27: a production server with no mail key and the sandbox flag off (or set to anything but "1") never shows or logs a link.
  "mail-off": { server: false, needs: [".next/BUILD_ID"], run: mailOff },
  // #27: seed through the app, back up as staff, survive a restart, restore into a new folder and serve the copy.
  "backup-drill": { server: false, needs: [".next/BUILD_ID", "scripts/restore-backup.mjs"], run: backupDrill },
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) fail(`unexpected argument "${a}"`);
    const [k, inline] = a.slice(2).split("=");
    out[k] = inline ?? argv[++i];
  }
  return out;
}

function fail(msg) {
  console.error(`verify:product: ${msg}`);
  console.error(`usage: npm run verify:product -- --suite <${Object.keys(SUITES).join("|")}> --mode fixture --evidence-dir <dir>`);
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));
if (!args.suite) fail("--suite is required");
if (args.suite === "accessibility") args.suite = "a11y";
const suite = Object.hasOwn(SUITES, args.suite) ? SUITES[args.suite] : null;
if (!suite) fail(`unknown suite "${args.suite}"`);
if (args.mode !== "fixture") fail(`unsupported --mode "${args.mode ?? ""}": only "fixture" runs without live services`);
if (!args["evidence-dir"]) fail("--evidence-dir is required");
const evidenceDir = resolve(args["evidence-dir"]);

// ---- bookkeeping ----
const steps = [];
/** Extra, sanitized evidence a suite wants kept: counts and hashes only, never row contents or tokens. */
let drill = null;
const startedAt = new Date();
const tmp = mkdtempSync(join(tmpdir(), "ticketstub-verify-"));
const netLog = join(tmp, "blocked-network.log");
writeFileSync(netLog, "");
const guardUrl = pathToFileURL(guard).href;

function record(name, ok, detail = "") {
  steps.push({ name, ok, ...(ok ? {} : { detail }) });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  return ok;
}

const git = (...a) => {
  try {
    return execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};
const gitSha = git("rev-parse", "HEAD");
const gitDirty = git("status", "--porcelain") === null ? null : git("status", "--porcelain") !== "";

/** The child environment: no provider keys, no mail key, a throwaway database. */
function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "TICKETMASTER_API_KEY", "RESEND_API_KEY", "TICKETSTUB_RUNTIME_MODE", "APP_URL"]) delete env[k];
  return {
    ...env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${guardUrl}`.trim(),
    VERIFY_NET_LOG: netLog,
    TICKETSTUB_DB: join(tmp, "verify.sqlite"),
    TICKETSTUB_FILES: join(tmp, "files"),
    TICKETSTUB_SANDBOX_MAIL: "1",
    ADMIN_EMAILS: STAFF_EMAIL,
    ...extra,
  };
}

function runNode(nodeArgs, env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, nodeArgs, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => done({ code: code ?? 1, out }));
  });
}

/** Runs one of the repo's own check scripts and folds its ok/FAIL/SKIP lines into the evidence. */
async function script(file, fileArgs = [], envExtra = {}) {
  const { code, out } = await runNode([join(root, file), ...fileArgs], childEnv(envExtra));
  process.stdout.write(out);
  const lines = out.split(/\r?\n/);
  const passed = lines.filter((l) => /^(ok|PASS)\b/.test(l)).length;
  const skipped = lines.filter((l) => !/^(ok|PASS)\b/.test(l) && /\bskip(ped)?\b/i.test(l)).length;
  // Checks that only hold in `next dev`, named exactly; they fail by design against the production server used here.
  const failLines = lines.filter((l) => /^FAIL\b/.test(l));
  const expected = failLines.filter((l) => DEV_ONLY_CHECKS.some((name) => l.startsWith(`FAIL ${name}`)));
  const failed = failLines.length - expected.length;
  const ok = (code === 0 || (failLines.length > 0 && failed === 0)) && skipped === 0;
  steps.push({ name: file, command: `node ${file} ${fileArgs.join(" ")}`.trim(), exitCode: code, passed, failed, skipped, ...(expected.length ? { expectedFailures: expected } : {}), ok });
  if (skipped) console.error(`FAIL ${file}: ${skipped} required check(s) skipped`);
  if (!ok && code === 0) console.error(`FAIL ${file}: exit 0 but ${failed} failed line(s)`);
  if (expected.length) console.log(`note ${expected.length} dev-only check(s) failed by design against the production server: ${expected.join("; ")}`);
}

function freePort() {
  return new Promise((ok, no) => {
    const s = createServer();
    s.once("error", no);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

/** Starts `next start` on a free port, retrying with a new port if another process took the probed one first. */
async function startServer(extraEnv = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await startServerOnce(extraEnv);
    } catch (e) {
      if (attempt >= 3 || !(e instanceof Error) || !/EADDRINUSE/.test(e.message)) throw e;
    }
  }
}

async function startServerOnce(extraEnv = {}) {
  const port = await freePort();
  const env = childEnv({ PORT: String(port), NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", ...extraEnv });
  // An extra set to undefined means "not in the environment at all", not the string "undefined".
  for (const [k, v] of Object.entries(extraEnv)) if (v === undefined) delete env[k];
  const next = join(root, "node_modules/next/dist/bin/next");
  const child = spawn(process.execPath, [next, "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    try {
      if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) })).ok) return { base, child, log: () => log };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error(`server did not answer /api/health within 30s:\n${log}`);
}

// ---- foundation ----
/** Every page.tsx under src/app, as a URL with sample values for dynamic segments. */
function declaredPages() {
  const appDir = join(root, "src/app");
  const pages = [];
  const seg = (s) => (/^\[\[\.\.\..+\]\]$/.test(s) ? "" : /^\[\.\.\..+\]$/.test(s) ? "verify/sample" : /^\[.+\]$/.test(s) ? "verify-sample" : s);
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name === "page.tsx") {
        const segs = relative(appDir, dir).split(sep).filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("_"));
        pages.push("/" + segs.map(seg).filter(Boolean).join("/"));
      }
    }
  })(appDir);
  return pages.sort();
}

/** A fetch client with a cookie jar and its own client address; redirects are never followed. */
function client(base) {
  const jar = new Map();
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const send = async (method, path, body) => {
    const headers = { "x-real-ip": ip, origin: base };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(20000) });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [k, v] = pair.split("=");
      if (v === "" || /max-age=0/i.test(c)) jar.delete(k.trim());
      else jar.set(k.trim(), v);
    }
    return { status: res.status, headers: res.headers, text: await res.text() };
  };
  const signIn = async (email) => {
    const link = await send("POST", "/api/auth/link", { email, returnTo: "/wall", reason: "save" });
    const devLink = JSON.parse(link.text).devLink;
    if (!devLink) throw new Error(`no devLink for ${email} (${link.status})`);
    const token = new URL(devLink).searchParams.get("token");
    return send("POST", "/api/auth/confirm", { token });
  };
  return { get: (p) => send("GET", p), send, signIn };
}

async function foundation({ base }) {
  const anon = client(base);

  // every declared page answers (admin is reserved: a real 404 for anyone who is not staff)
  const pages = declaredPages();
  record("declared pages found", pages.length > 20, `only ${pages.length}`);
  for (const url of pages) {
    const res = await anon.get(url);
    const want = url.startsWith("/admin") ? 404 : url === "/map" ? 308 : 200;
    const ok = res.status === want && (url !== "/map" || (res.headers.get("location") ?? "").endsWith("/help"));
    record(`page ${url} -> ${want}`, ok, `got ${res.status}`);
  }

  // invalid routes
  const missing = await anon.get("/definitely-not-a-route");
  record("unknown page is a 404 with the desk copy", missing.status === 404 && /isn(&#x27;|')t on the desk/.test(missing.text), `got ${missing.status}`);
  const missingApi = await anon.get("/api/definitely-not-a-route");
  record("unknown API route is a 404", missingApi.status === 404, `got ${missingApi.status}`);

  // health
  const health = await anon.get("/api/health");
  let body = {};
  try {
    body = JSON.parse(health.text);
  } catch {
    /* asserted below */
  }
  record("health is 200 with ok, version, commit, mode and time", health.status === 200 && body.ok === true && typeof body.version === "string" && (body.commit === null || /^[0-9a-f]{7,40}$/.test(body.commit)) && body.mode === "demo" && !Number.isNaN(Date.parse(body.time)), health.text.slice(0, 120));
  record("health is uncached and carries nothing else", health.headers.get("cache-control") === "no-store" && Object.keys(body).sort().join() === "commit,mode,ok,persistence,storage,time,version" && body.storage === "ok" && body.persistence === "configured", Object.keys(body).join());

  // admin: anonymous and non-staff never learn it exists; staff get reload and deep links
  const member = client(base);
  const staff = client(base);
  await member.signIn(MEMBER_EMAIL);
  await staff.signIn(STAFF_EMAIL);
  for (const path of ["/admin", "/admin/x/y"]) {
    record(`anonymous ${path} is a real 404`, (await anon.get(path)).status === 404);
    const m = await member.get(path);
    record(`non-staff ${path} is a real 404 with no admin markup`, m.status === 404 && !m.text.includes("data-admin-fixture"), `got ${m.status}`);
  }
  for (const path of ["/admin", "/admin/x/y"]) {
    const want = path === "/admin" ? "" : "x/y";
    // the second GET is a hard reload: a full document request with no client navigation state
    for (const pass of ["entry", "reload"]) {
      const s = await staff.get(path);
      record(`staff ${path} ${pass} renders the fixture mount`, s.status === 200 && s.text.includes("data-admin-fixture") && s.text.includes(`data-admin-path="${want}"`) && s.text.includes("ts-admin"), `got ${s.status}`);
    }
  }
  const deep = await staff.get("/admin/x/y");
  record("the mount is handed the Admin root crumb and the capability list", deep.text.includes('data-admin-root="Admin"') && deep.text.includes("admin.view"));

  // error boundary: the fixture throws on purpose, for staff only
  const boom = await staff.get("/admin/fixture-error");
  record("a render error is a 500 that leaks neither the message nor a stack", boom.status === 500 && !boom.text.includes("deliberate") && !/at \w+ \(/.test(boom.text), `got ${boom.status}`);
  // Production paints the boundary in the browser, so the HTML only carries the chunks that hold it.
  const chunks = [...boom.text.matchAll(/\/_next\/static\/chunks\/[^"' ]+\.js/g)].map((m) => m[0]);
  let wired = false;
  for (const chunk of new Set(chunks)) {
    if ((await anon.get(chunk)).text.includes("press jammed")) wired = true;
  }
  record("the error boundary (desk copy) ships in the chunks that page loads", wired, `${chunks.length} chunk(s) checked`);
}

// ---- degraded ----
const UNAVAILABLE = { error: { code: "storage_unavailable", message: "Saving is off on this preview." } };

async function degraded(ctx) {
  const { base } = ctx;
  const anon = client(base);
  const json = (r) => {
    try {
      return JSON.parse(r.text);
    } catch {
      return null;
    }
  };

  // health says so, and says where the paths came from
  const health = await anon.get("/api/health");
  const h = json(health) ?? {};
  record("health is 200 and reports storage unavailable", health.status === 200 && h.ok === true && h.storage === "unavailable", health.text.slice(0, 160));
  record("health reports persistence configured (both paths set)", h.persistence === "configured", String(h.persistence));

  // every storage route answers the same calm 503
  const calls = [
    ["POST", "/api/auth/link", { email: "someone@example.com", reason: "save" }],
    ["POST", "/api/auth/confirm", { token: "x" }],
    ["GET", "/api/auth/confirm?token=x"],
    ["POST", "/api/wall/sync", { stubs: [], deleted: [] }],
    ["GET", "/api/wall/public"],
    ["PUT", "/api/wall/public", { isPublic: true }],
    ["GET", "/api/u/abcdefghijkl"],
    ["POST", "/api/share", { stub: {} }],
    ["GET", "/api/share/abcdefghijkl"],
    ["POST", "/api/share/revoke", { stubId: "s1" }],
    ["POST", "/api/approvals", { stubId: "s1", purpose: "print.compose", expectedVersionId: "v1" }],
    ["GET", "/api/approvals?project=stub:s1"],
    ["POST", "/api/approvals/revoke", { stubId: "s1", approvalId: "apr_x" }],
    ["POST", "/api/approvals/verify", { token: "x", expect: {} }],
    ["POST", "/api/order-authorizations", { stubId: "s1", approvalId: "apr_x", expectedVersionId: "v1", orderRef: "ord_00000001", quote: { id: "q", amountMinor: 1, currency: "USD" }, destination: { ref: "dst_00000001", digest: "0".repeat(64) }, idempotencyKey: "issue_00000001", confirm: true }],
    ["GET", "/api/order-authorizations?project=stub:s1"],
    ["POST", "/api/order-authorizations/revoke", { stubId: "s1", authorizationId: "oau_x" }],
    ["POST", "/api/order-authorizations/verify", { token: "x", expect: {} }],
    ["POST", "/api/order-authorizations/claim", { token: "x", expect: {}, idempotencyKey: "claim_00000001" }],
    ["POST", "/api/order-authorizations/revalidate", { token: "x", expect: {} }],
    ["POST", "/api/order-authorizations/claims/lookup", { tenant: "t", project: "stub:s1", idempotencyKey: "claim_00000001" }],
    ["POST", "/api/orders", { order: {} }],
    ["GET", "/api/orders"],
    ["POST", "/api/organizer/events", { title: "x" }],
    ["GET", "/api/claim/abcdefghijkl"],
    ["POST", "/api/claim/abcdefghijkl", {}],
    ["POST", "/api/gift", { stub: "s1", to: "A", message: "hi" }],
    ["GET", "/api/gift/abcdefghijkl"],
    ["DELETE", "/api/gift/abcdefghijkl", {}],
    ["POST", "/api/account/email", { email: "someone@example.com" }],
    ["DELETE", "/api/account", { confirm: "x" }],
  ];
  for (const [method, path, body] of calls) {
    const r = await anon.send(method, path, body);
    const j = json(r);
    record(`${method} ${path} -> 503 storage_unavailable`, r.status === 503 && j?.error?.code === UNAVAILABLE.error.code && j.error.message === UNAVAILABLE.error.message && r.headers.get("cache-control") === "no-store", `got ${r.status} ${r.text.slice(0, 120)}`);
  }

  // the things that must keep working
  const context = await anon.get("/api/context");
  const c = json(context);
  record("/api/context still answers an anonymous caller", context.status === 200 && c?.context?.actor?.kind === "anonymous" && c.context.revoked === false && typeof c.token === "string", `got ${context.status}`);
  const me = await anon.get("/api/auth/me");
  record("/api/auth/me answers 200, signed out, storage unavailable", me.status === 200 && json(me)?.account === null && json(me)?.storage === "unavailable", `got ${me.status}`);
  const stale = await anon.send("GET", "/api/context", undefined);
  record("a stale session cookie changes nothing", stale.status === 200);
  const art = await anon.send("POST", "/api/art", { event: { title: "Probe" }, vibe: "calm" });
  const a = json(art);
  record("/api/art fails open to procedural art with no quota", art.status === 200 && a?.kind === "procedural" && a.provenance === "simulated", `got ${art.status} ${art.text.slice(0, 100)}`);
  const stubImage = await anon.get("/api/stub-image/brand");
  record("/api/stub-image/brand needs no storage", stubImage.status === 200, `got ${stubImage.status}`);

  // pages render, never 500
  for (const url of ["/", "/make", "/wall", "/studio/x", "/checkout/x", "/account"]) {
    const r = await anon.get(url);
    record(`page ${url} -> 200`, r.status === 200, `got ${r.status}`);
  }
  for (const url of declaredPages()) {
    const want = url.startsWith("/admin") ? 404 : url === "/map" ? 308 : 200;
    const r = await anon.get(url);
    record(`declared page ${url} -> ${want}`, r.status === want, `got ${r.status}`);
  }
  const confirmPage = await anon.get("/signin/confirm?token=x");
  record("/signin/confirm renders the expired-link page", confirmPage.status === 200 && /expired/i.test(confirmPage.text), `got ${confirmPage.status}`);

  // the log: one storage line, no path
  const lines = server.log().split(/\r?\n/).filter((l) => l.includes("[storage]"));
  record("the server logged exactly one storage line, saying unavailable", lines.length === 1 && /unavailable/.test(lines[0]), lines.join(" | "));
  record("the log line leaks no path", lines.every((l) => !l.includes(tmp) && !/[\\/]/.test(l)), lines.join(" | "));

  // the production smoke still passes in this state
  await script("scripts/smoke-production.mjs", [], { SMOKE_BASE_URL: base });
}

// ---- mail-off ----
const LINK_IN_TEXT = /\/signin\/confirm\?token=|\/api\/auth\/callback\?token=|devLink|sandbox (sign-in|email-change) link/;
const sha256 = (t) => createHash("sha256").update(t).digest("hex");
/** Failure details go into the evidence file, so a leaked token never does. */
const redact = (t) => t.replace(/token=[A-Za-z0-9_%-]+/g, "token=<redacted>");

/** Signs an account in by writing a session straight into the database, as no link can reach us with mail off. */
function seedSession(email) {
  const db = new DatabaseSync(childEnv().TICKETSTUB_DB);
  try {
    const now = Date.now();
    const id = `acct_mailoff_${randomBytes(4).toString("hex")}`;
    const token = randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)").run(id, email, now);
    db.prepare("INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(sha256(token), id, now, now + 3600_000);
    return token;
  } finally {
    db.close();
  }
}

function newestLink(email) {
  const db = new DatabaseSync(childEnv().TICKETSTUB_DB, { readOnly: true });
  try {
    return db.prepare("SELECT token_hash, created_at, expires_at, used_at FROM login_links WHERE email = ? ORDER BY created_at DESC LIMIT 1").get(email);
  } finally {
    db.close();
  }
}

async function stopServer(s) {
  // A server that already died has fired "close" already; waiting for it again would hang the job.
  if (s.child.exitCode !== null || s.child.signalCode !== null) return;
  const exited = new Promise((done) => s.child.once("close", done));
  s.child.kill();
  await exited;
}

async function mailOff() {
  const parse = (r) => {
    try {
      return JSON.parse(r.text);
    } catch {
      return null;
    }
  };
  // Unset is the deployed case. The others prove only the exact value "1" turns the sandbox on.
  const variants = [["unset", undefined], ["0", "0"], ["true", "true"], ["empty", ""], ["' 1'", " 1"]];
  for (const [label, value] of variants) {
    const s = await startServer({ TICKETSTUB_SANDBOX_MAIL: value });
    try {
      const run = randomBytes(3).toString("hex");
      const email = `mailoff-${run}@example.com`;
      const anon = client(s.base);
      const tag = `[TICKETSTUB_SANDBOX_MAIL ${label}]`;

      const health = parse(await anon.get("/api/health")) ?? {};
      record(`${tag} health is ok with storage writable`, health.ok === true && health.storage === "ok", JSON.stringify(health));

      const link = await anon.send("POST", "/api/auth/link", { email, returnTo: "/wall", reason: "save" });
      const lj = parse(link);
      record(`${tag} sign-in link answers 503 mail_unavailable`, link.status === 503 && lj?.error?.code === "mail_unavailable" && link.headers.get("cache-control") === "no-store", `got ${link.status} ${redact(link.text).slice(0, 120)}`);
      record(`${tag} the response carries no devLink and no token URL`, !LINK_IN_TEXT.test(link.text) && !("devLink" in (lj ?? {})) && !/token=/.test(link.text), redact(link.text).slice(0, 160));

      const row = newestLink(email);
      record(`${tag} the link stored is a SHA-256 hash only, live for exactly 15 minutes`, !!row && /^[0-9a-f]{64}$/.test(row.token_hash) && row.expires_at - row.created_at === 15 * 60_000 && row.used_at === null, JSON.stringify(row && { ttl: row.expires_at - row.created_at, used: row.used_at }));

      // Email change, from a real session: same 503, same silence.
      const session = seedSession(`mailoff-owner-${run}@example.com`);
      const owner = { cookie: `ts_session=${session}` };
      const me = await fetch(`${s.base}/api/auth/me`, { headers: owner, signal: AbortSignal.timeout(20000) });
      const meJson = await me.json().catch(() => null);
      record(`${tag} a seeded session is signed in`, me.status === 200 && meJson?.account?.email === `mailoff-owner-${run}@example.com`, `got ${me.status}`);
      const change = await fetch(`${s.base}/api/account/email`, {
        method: "POST",
        headers: { ...owner, origin: s.base, "content-type": "application/json", "x-real-ip": "10.9.9.9" },
        body: JSON.stringify({ email: `mailoff-new-${run}@example.com` }),
        redirect: "manual",
        signal: AbortSignal.timeout(20000),
      });
      const changeText = await change.text();
      record(`${tag} email change answers 503 mail_unavailable`, change.status === 503 && /mail_unavailable/.test(changeText), `got ${change.status} ${redact(changeText).slice(0, 120)}`);
      record(`${tag} the email-change response carries no devLink and no token URL`, !LINK_IN_TEXT.test(changeText) && !/token=/.test(changeText), redact(changeText).slice(0, 160));

      const preview = await anon.get("/api/dev/email-preview");
      record(`${tag} the dev email preview is a 404`, preview.status === 404, `got ${preview.status}`);

      const log = s.log();
      record(`${tag} the server log holds no sign-in or email-change link`, !LINK_IN_TEXT.test(log) && !/token=/.test(log), "a link-shaped line was logged");
      record(`${tag} the server log names no full address`, !log.includes(email) && !log.includes(`mailoff-new-${run}@example.com`), "an unmasked address was logged");
      record(`${tag} the server log says mail was not sent, masked`, /\[mail\] no RESEND_API_KEY, not sent: sign-in link to m\*\*\*@example\.com/.test(log) && /not sent: email change link to m\*\*\*@example\.com/.test(log), redact(log.split("\n").filter((l) => l.includes("[mail]")).join(" | ")).replace(/[\w.+-]+@example\.com/g, "<address>"));
    } finally {
      await stopServer(s);
    }
  }

  // Control: the same build with the flag on does hand out a link, so the checks above can tell the difference.
  const s = await startServer({ TICKETSTUB_SANDBOX_MAIL: "1" });
  try {
    const email = `mailon-${randomBytes(3).toString("hex")}@example.com`;
    const c = client(s.base);
    const link = await c.send("POST", "/api/auth/link", { email, returnTo: "/wall", reason: "save" });
    const devLink = parse(link)?.devLink;
    record("[control TICKETSTUB_SANDBOX_MAIL=1] sign-in returns a devLink and logs it", link.status === 200 && typeof devLink === "string" && LINK_IN_TEXT.test(s.log()), `got ${link.status}`);
    const token = new URL(devLink).searchParams.get("token");
    const confirm = await c.send("POST", "/api/auth/confirm", { token });
    const cookie = confirm.headers.get("set-cookie") ?? "";
    record("[control] the session cookie is HttpOnly, SameSite=Lax, Secure, Path=/ and lasts 90 days", confirm.status === 303 && /^ts_session=[A-Za-z0-9_-]{40,}/.test(cookie) && /;\s*HttpOnly/i.test(cookie) && /;\s*SameSite=Lax/i.test(cookie) && /;\s*Secure/i.test(cookie) && /;\s*Path=\//.test(cookie) && /;\s*Max-Age=7776000\b/.test(cookie), cookie.replace(/ts_session=[^;]+/, "ts_session=<redacted>"));
    const again = await client(s.base).send("POST", "/api/auth/confirm", { token });
    record("[control] the link works once", again.status === 303 && again.headers.get("location") === "/wall?signin=expired" && !(again.headers.get("set-cookie") ?? "").includes("ts_session="), `got ${again.status} ${again.headers.get("location")}`);
  } finally {
    await stopServer(s);
  }
}

// ---- backup-drill ----
const DRILL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const drillPng = () => `data:image/png;base64,${Buffer.concat([DRILL_PNG, randomBytes(8)]).toString("base64")}`;
const drillStub = (id, title, art) => ({
  id,
  createdAt: new Date().toISOString(),
  event: { type: "concert", title, facts: [] },
  versions: [{ id: `${id}-v1`, edition: "classic", art: art ? { kind: "image", src: art, seed: 1, provenance: "live" } : { kind: "procedural", seed: 1, provenance: "simulated" }, createdAt: new Date().toISOString() }],
  currentVersionId: `${id}-v1`,
  personal: { titleFont: 0, titleColor: "#000", foilTitle: false, hiddenFields: [], friends: [] },
  material: "card",
  finish: "matte",
  torn: true,
  wallAngle: 0,
  photos: [],
  updatedAt: Date.now(),
});
const fileSha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");

function dbFacts(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all().map((r) => r.integrity_check).join("; ");
    const tables = {};
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      tables[name] = Number(db.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get().n);
    }
    return { integrity, tables };
  } finally {
    db.close();
  }
}

async function backupDrill() {
  const parse = (r) => {
    try {
      return JSON.parse(r.text);
    } catch {
      return null;
    }
  };
  const live = { db: childEnv().TICKETSTUB_DB, files: childEnv().TICKETSTUB_FILES };
  // The weekly schedule is covered by tests/backup.test.mjs; off here so its first check can't race the staff POST.
  const env = { TICKETSTUB_BACKUP_EVERY_DAYS: "off" };
  let s = await startServer(env);
  let wallToken, shareToken, artPath, manifest;
  try {
    // Seed through the app's own routes.
    const member = client(s.base);
    const staff = client(s.base);
    const signedIn = await member.signIn(MEMBER_EMAIL);
    record("member signs in through the confirm tap", signedIn.status === 303, `got ${signedIn.status}`);
    await staff.signIn(STAFF_EMAIL);
    const synced = await member.send("POST", "/api/wall/sync", { stubs: [drillStub("drill-1", "Drill night", drillPng()), drillStub("drill-2", "Drill matinee")], deleted: [] });
    const sj = parse(synced);
    artPath = sj?.stubs?.find((x) => x.id === "drill-1")?.versions?.[0]?.art?.src;
    record("wall sync stores two stubs and moves the art to a file", synced.status === 200 && sj.stubs.length === 2 && /^\/api\/files\/[a-f0-9]{64}\.png$/.test(artPath ?? ""), `got ${synced.status}`);
    wallToken = parse(await member.send("PUT", "/api/wall/public", { isPublic: true }))?.token;
    record("the wall is made public", typeof wallToken === "string");
    const share = await member.send("POST", "/api/share", { stub: drillStub("drill-share", "Drill share", drillPng()) });
    shareToken = parse(share)?.token;
    record("a share (with its own art file) is created", share.status === 200 && typeof shareToken === "string", `got ${share.status}`);
    const order = await member.send("POST", "/api/orders", { order: { stubIds: ["drill-1"], lines: [{ title: "Drill card", material: "card", finish: "matte", size: "classic", totalMinor: 3500 }], totalMinor: 3500, method: "card" } });
    record("a sandbox order is placed", order.status === 200, `got ${order.status}`);
    const org = await member.send("POST", "/api/organizer/events", { title: "Drill party", stub: drillStub("drill-evt", "Drill party"), guests: [{ name: "Ada", seat: "A1" }, { name: "Grace" }], expiresInDays: 7 });
    record("an organizer event with two claims is created", org.status === 200 && parse(org)?.claims?.length === 2, `got ${org.status}`);

    // Only staff may back up.
    const memberTry = await member.send("POST", "/api/admin/backup");
    record("a non-staff POST /api/admin/backup is a 404", memberTry.status === 404, `got ${memberTry.status}`);
    const anonTry = await client(s.base).send("POST", "/api/admin/backup");
    record("an anonymous POST /api/admin/backup is a 404", anonTry.status === 404, `got ${anonTry.status}`);
    const made = await staff.send("POST", "/api/admin/backup");
    manifest = parse(made)?.backup;
    record("staff POST /api/admin/backup is 201 with an ok manifest", made.status === 201 && manifest?.ok === true && manifest.database.integrity === "ok" && manifest.missing.length === 0, `got ${made.status}`);
    record("the manifest holds counts and hashes, never row contents", !made.text.includes("Drill") && !made.text.includes(MEMBER_EMAIL) && !made.text.includes("data:image"));
    record("the backup holds both art files and is downloadable", manifest?.files?.length === 2 && manifest.downloadable === true, `files ${manifest?.files?.length}`);
    const listed = parse(await staff.get("/api/admin/backup"));
    record("GET /api/admin/backup lists it", listed?.backups?.some((b) => b.id === manifest.id && b.ok), JSON.stringify(listed).slice(0, 120));

    // A write after the backup: the restore must show the snapshot, not the live database.
    const later = await member.send("POST", "/api/wall/sync", { stubs: [drillStub("drill-later", "After the backup")], deleted: [] });
    record("a stub written after the backup is accepted", later.status === 200 && parse(later)?.stubs?.length === 3);
  } finally {
    await stopServer(s);
  }

  // Restart on the same disk: what a redeploy does to /private.
  s = await startServer(env);
  try {
    const anon = client(s.base);
    const wall = parse(await anon.get(`/api/u/${wallToken}`));
    record("after a restart the public wall still has all three stubs", wall?.stubs?.length === 3, JSON.stringify(wall).slice(0, 80));
    const art = await fetch(s.base + artPath, { signal: AbortSignal.timeout(20000) });
    const artBytes = Buffer.from(await art.arrayBuffer());
    record("after a restart the art file serves and re-hashes to its name", art.status === 200 && createHash("sha256").update(artBytes).digest("hex") === artPath.slice(11, 75), `got ${art.status}`);
  } finally {
    await stopServer(s);
  }

  // Restore into a new folder with the restore script, as the README says.
  const backupDir = join(dirname(live.db), "backups", manifest.id);
  // A sibling of the live database would be refused (and rightly): restore into a folder of its own.
  const restoreRoot = mkdtempSync(join(tmpdir(), "ticketstub-restore-"));
  try {
    const target = join(restoreRoot, "restored");
    // childEnv keeps the fixture network guard on the restore script too.
    const restoreEnv = childEnv({ TICKETSTUB_DB: live.db, TICKETSTUB_FILES: live.files });
    const refusedOverlap = await runNode([join(root, "scripts/restore-backup.mjs"), backupDir, live.files], restoreEnv);
    record("restore refuses a target that overlaps the live storage", refusedOverlap.code !== 0 && /refusing a target/.test(refusedOverlap.out), refusedOverlap.out.slice(0, 120));
    const restored = await runNode([join(root, "scripts/restore-backup.mjs"), backupDir, target], restoreEnv);
    const restorePasses = restored.out.split(/\r?\n/).filter((l) => l.startsWith("PASS ")).length;
    record("restore-backup.mjs exits 0 with every check passing", restored.code === 0 && restorePasses > 0 && !/FAIL/.test(restored.out), restored.out.split("\n").find((l) => l.startsWith("FAIL")) ?? `exit ${restored.code}`);
    const refusedNonEmpty = await runNode([join(root, "scripts/restore-backup.mjs"), backupDir, target], restoreEnv);
    record("restore refuses a target that isn't empty", refusedNonEmpty.code !== 0 && /not empty/.test(refusedNonEmpty.out), refusedNonEmpty.out.slice(0, 120));

    // Re-check the copy independently of the script.
    const restoredDb = join(target, "ticketstub.sqlite");
    const facts = dbFacts(restoredDb);
    record("restored database integrity_check is ok", facts.integrity === "ok", facts.integrity);
    record("restored row counts equal the manifest, table by table", JSON.stringify(facts.tables) === JSON.stringify(Object.fromEntries(Object.keys(facts.tables).map((k) => [k, manifest.database.tables[k]]))) && Object.keys(facts.tables).length === Object.keys(manifest.database.tables).length, JSON.stringify({ restored: facts.tables, manifest: manifest.database.tables }));
    // Hashed before a server opens the copy: from then on the copy is a live database of its own.
    const restoredSha = fileSha(restoredDb);
    record("restored database bytes hash to the manifest", restoredSha === manifest.database.sha256);
    const restoredFiles = manifest.files.map((f) => ({ name: f.name, ok: fileSha(join(target, "files", f.name)) === f.sha256 && f.sha256 === f.name.slice(0, 64) }));
    record("every restored art file hashes to the manifest and its name", restoredFiles.length === 2 && restoredFiles.every((f) => f.ok));
    record("the snapshot is point in time: the later stub is not in it", manifest.database.tables.wall_stubs === dbFacts(live.db).tables.wall_stubs - 1, JSON.stringify({ backup: manifest.database.tables.wall_stubs, live: dbFacts(live.db).tables.wall_stubs }));

    // Serve the copy, isolated: mail off, schedule off, its own folder.
    s = await startServer({ ...env, TICKETSTUB_DB: restoredDb, TICKETSTUB_FILES: join(target, "files"), TICKETSTUB_SANDBOX_MAIL: undefined });
    try {
      const anon = client(s.base);
      const health = parse(await anon.get("/api/health"));
      record("a server on the restored copy is healthy with storage ok", health?.ok === true && health.storage === "ok", JSON.stringify(health));
      const wall = parse(await anon.get(`/api/u/${wallToken}`));
      record("the restored public wall has the two stubs from the backup", wall?.stubs?.length === 2 && wall.stubs.every((x) => x.id !== "drill-later"), `got ${wall?.stubs?.length}`);
      const share = await anon.get(`/api/share/${shareToken}`);
      const shareArt = parse(share)?.stub?.versions?.[0]?.art?.src;
      record("the restored share resolves", share.status === 200 && /^\/api\/files\//.test(shareArt ?? ""), `got ${share.status}`);
      let served = 0;
      for (const src of [artPath, shareArt]) {
        const r = await fetch(s.base + src, { signal: AbortSignal.timeout(20000) });
        if (r.status === 200 && createHash("sha256").update(Buffer.from(await r.arrayBuffer())).digest("hex") === src.slice(11, 75)) served++;
      }
      record("the restored art files serve byte for byte", served === 2, `${served}/2`);
    } finally {
      await stopServer(s);
    }

    drill = {
      backupId: manifest.id,
      manifest: { ok: manifest.ok, integrity: manifest.database.integrity, databaseBytes: manifest.database.bytes, databaseSha256: manifest.database.sha256, tables: manifest.database.tables, files: manifest.files.map((f) => ({ sha256: f.sha256, bytes: f.bytes })), downloadable: manifest.downloadable, missing: manifest.missing.length },
      restored: { integrity: facts.integrity, databaseSha256: restoredSha, tables: facts.tables, filesMatching: restoredFiles.filter((f) => f.ok).length, restoreScriptChecksPassed: restorePasses },
      liveAfterBackup: { wall_stubs: dbFacts(live.db).tables.wall_stubs },
    };
  } finally {
    // Remove the copy of the drill database even when a check above throws.
    rmSync(restoreRoot, { recursive: true, force: true });
  }
}

// ---- run ----
let exit = 1;
let server = null;
let blocked = [];
try {
  const missing = suite.needs.filter((rel) => !existsSync(join(root, rel)));
  if (missing.length) {
    record("required files and build present", false, `missing ${missing.join(", ")}${missing.some((m) => m.startsWith(".next")) ? " (run npm run build first)" : ""}`);
  } else {
    // the guard has to work before anything is trusted to it
    const probe = await runNode(["--import", guardUrl, "--input-type=module", "-e", "try { await fetch('https://example.com/'); console.log('REACHED'); } catch (e) { console.log(e.code); }"], { ...process.env, VERIFY_NET_LOG: join(tmp, "selftest.log") });
    record("fixture mode refuses outbound network", probe.out.trim() === "ETICKETSTUB_FIXTURE_NETWORK", probe.out.trim());
    const ctx = {};
    if (suite.server) {
      let extra = {};
      if (suite.env) extra = ctx.env = suite.env();
      if (suite.unwritableStorage) {
        // A path under a file is not creatable on any OS, whoever runs it.
        const blocker = join(tmp, "not-a-directory");
        writeFileSync(blocker, "x");
        extra = { ...extra, TICKETSTUB_DB: join(blocker, "ticketstub.sqlite"), TICKETSTUB_FILES: join(blocker, "files") };
      }
      server = await startServer(extra);
      ctx.base = server.base;
    }
    await suite.run(ctx);
    blocked = readFileSync(netLog, "utf8").split("\n").filter(Boolean);
    record("no outbound network attempted", blocked.length === 0, blocked.join("; "));
  }
} catch (e) {
  record("suite ran to completion", false, e instanceof Error ? e.message : String(e));
} finally {
  // The server holds the throwaway database open; Windows won't delete it until it is gone.
  if (server) await stopServer(server);
  exit = steps.length > 0 && steps.every((s) => s.ok) ? 0 : 1;
  const counts = steps.reduce(
    (c, s) => ({ passed: c.passed + (s.passed ?? (s.ok ? 1 : 0)), failed: c.failed + (s.failed ?? (s.ok ? 0 : 1)), skipped: c.skipped + (s.skipped ?? 0) }),
    { passed: 0, failed: 0, skipped: 0 },
  );
  mkdirSync(evidenceDir, { recursive: true });
  const file = join(evidenceDir, `${args.suite}-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        suite: args.suite,
        mode: args.mode,
        command: `npm run verify:product -- ${process.argv.slice(2).join(" ")}`,
        exitCode: exit,
        counts,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        gitSha,
        gitDirty,
        node: process.version,
        blockedNetwork: blocked,
        ...(drill ? { drill } : {}),
        steps,
      },
      null,
      2,
    ) + "\n",
  );
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* a leftover temp folder is not a failed run */
  }
  console.log(`\n${args.suite} (${args.mode}): ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped -> exit ${exit}\nevidence: ${file}`);
  process.exit(exit);
}
