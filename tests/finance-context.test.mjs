import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITY_MATRIX, FINANCE_CAPS, financeCapsFor, signContext, toContextV2, verifyWithKey } from "../src/server/context-token.ts";
import { ECONOMIC_MODES, EVIDENCE_MODES, ENVIRONMENTS, ModeMappingError, PAID_PROVIDER_KEYS, modesConsistent, resolveModes } from "../src/server/context-modes.ts";
import { FINANCE_CAPS as OFFLINE_FINANCE_CAPS, authorizes, authorizesFinance, FINANCE_SCOPE_ADAPTER, toFinanceScope, verifyContext } from "../fixtures/context/verify.mjs";
import { AUDIENCE, BOUNDARY, FINANCE_ID_MAX, MALFORMED, MALFORMED_BASE, MALFORMED_WRONG_TYPE, NOW, malformedContexts, v1Base, v2Base, wrongTypeSchemaContexts } from "../fixtures/context/corpus.mjs";
import { checkVendored, loadConsumer } from "../fixtures/context/finance-scope-check.mjs";

// GT-FIN-001..003: explicit finance grants, injective ids, separate mode axes, verifier parity.
// Pure: the server code under test is context-token.ts and context-modes.ts, run directly.

const KEY = "unit-test-key-not-the-fixture-key-0123456789";
const DIR = join(fileURLToPath(new URL("../fixtures/context", import.meta.url)));
const sign = (c) => signContext(c, KEY, null);
// A /2 verifier must name its audience, so `both` names the published one unless a case passes `audience` itself (even undefined).
const both = (token, opts = {}) => {
  const o = "audience" in opts ? opts : { ...opts, audience: AUDIENCE };
  return [verifyWithKey(token, KEY, o.now ?? NOW, o.state, o.audience === undefined ? undefined : { audience: o.audience }), verifyContext(token, KEY, { now: NOW, ...o })];
};

// ---- GT-FIN-001: grants ----

test("finance grants are explicit strings from one matrix, and the offline verifier knows the same list", () => {
  assert.deepEqual([...FINANCE_CAPS], OFFLINE_FINANCE_CAPS);
  assert.ok(FINANCE_CAPS.includes("finance.read") && FINANCE_CAPS.includes("finance.export"));
  assert.ok(FINANCE_CAPS.filter((c) => c.startsWith("finance.command.")).length >= 5);
  assert.ok(CAPABILITY_MATRIX.finance);
});

test("grants per role and scope: captain reads and exports, member only reads, stub owner and guest hold none, staff hold the platform scope", () => {
  assert.deepEqual(financeCapsFor("account", "captain", { kind: "event" }, false), ["finance.read", "finance.export"]);
  assert.deepEqual(financeCapsFor("account", "member", { kind: "event" }, false), ["finance.read"]);
  assert.deepEqual(financeCapsFor("account", "viewer", { kind: "event" }, false), ["finance.read"]);
  assert.deepEqual(financeCapsFor("account", "owner", { kind: "stub" }, false), []);
  assert.deepEqual(financeCapsFor("guest", "owner", { kind: "stub" }, false), []);
  assert.deepEqual(financeCapsFor("anonymous", "none", undefined, true), []);
  assert.deepEqual(financeCapsFor("account", "owner", undefined, false), []); // an ordinary account has no platform scope
  assert.deepEqual(financeCapsFor("account", "staff", undefined, true), [...FINANCE_CAPS]);
  // staff get nothing extra on a project: scope is the context's project, never wider
  assert.deepEqual(financeCapsFor("account", "none", { kind: "event" }, true), []);
  // commands are held by staff in the platform scope only
  for (const [actor, role, project] of [["account", "captain", { kind: "event" }], ["account", "owner", { kind: "stub" }], ["account", "member", { kind: "event" }]]) {
    assert.ok(!financeCapsFor(actor, role, project, false).some((c) => c.startsWith("finance.command.")), `${role} must hold no command`);
  }
});

test("a /2 context carries the grants in capabilities; a /1 context has none, and the role name grants nothing", () => {
  const cap = v2Base();
  assert.ok(cap.capabilities.includes("finance.read") && cap.capabilities.includes("finance.export"));
  assert.ok(!v1Base().capabilities.some((c) => c.startsWith("finance.")));
  // A forged role: staff without the grant. A consumer reading capabilities denies; the role is informational.
  const fake = { ...v2Base({ role: "staff" }), capabilities: ["stub.draft"] };
  assert.equal(authorizesFinance(fake, { tenant: fake.tenant.id, project: fake.project, capability: "finance.read" }), false);
  // /1 can never authorize finance, even if someone adds the string
  const v1 = { ...v1Base(), capabilities: ["finance.read"] };
  assert.equal(authorizesFinance(v1, { tenant: v1.tenant.id, project: v1.project, capability: "finance.read" }), false);
});

test("authorizesFinance binds tenant, project scope and (when pinned) the three modes", () => {
  const c = v2Base();
  const ask = (over = {}) => authorizesFinance(c, { tenant: c.tenant.id, project: { kind: "event", id: "evt_fx_1" }, capability: "finance.read", ...over });
  assert.equal(ask(), true);
  assert.equal(ask({ capability: "finance.command.budget_change" }), false);
  assert.equal(ask({ capability: "finance.nonsense" }), false);
  assert.equal(ask({ tenant: "account:acc_other" }), false);
  assert.equal(ask({ project: { kind: "event", id: "evt_other" } }), false);
  assert.equal(ask({ project: { kind: "stub", id: "evt_fx_1" } }), false); // same id, other kind
  assert.equal(ask({ project: undefined }), false); // a project token is not the platform scope
  assert.equal(ask({ expect: { economicMode: "sandbox", environment: "development", evidenceMode: "fixture" } }), true);
  assert.equal(ask({ expect: { economicMode: "paid_test" } }), false); // a sandbox token cannot authorize a paid test
  const staff = v2Base({}, { staff: true });
  assert.equal(staff.capabilities.includes("finance.command.recovery"), false); // staff flag alone, on a captain project context
});

// ---- GT-FIN-002: injective ids, three modes ----

test("ids are injective: an account and a guest with the same raw id are different actors and tenants", () => {
  const base = v1Base();
  const as = (kind, id, tenant) => toContextV2({ ...base, actor: { kind, id }, tenant: { id: tenant } }, { staff: false, environment: "development", economicMode: "none", evidenceMode: "synthetic", audience: AUDIENCE });
  const acct = as("account", "same", "same");
  const guest = as("guest", "same", "guest:same");
  assert.equal(acct.actor.id, "account:same");
  assert.equal(guest.actor.id, "guest:same");
  assert.notEqual(acct.actor.id, guest.actor.id);
  assert.notEqual(acct.tenant.id, guest.tenant.id);
  assert.equal(acct.tenant.id, acct.actor.id);
  const anon = toContextV2({ ...base, actor: { kind: "anonymous" }, tenant: { id: "anonymous" } }, { staff: false, environment: "development", economicMode: "none", evidenceMode: "synthetic", audience: AUDIENCE });
  assert.equal(anon.actor.id, "anonymous:0");
  // every id parses back to exactly one (kind, raw) at the first colon, and both verifiers accept them
  for (const c of [acct, guest, anon]) {
    const [kind, ...rest] = c.actor.id.split(":");
    assert.equal(kind, c.actor.kind);
    assert.ok(rest.join(":").length > 0);
    const [a, b] = both(sign(c));
    assert.equal(a.ok, true);
    assert.deepEqual(a, b);
  }
  // projects too: the same id as a stub and as an event is two refs
  assert.notEqual(toFinanceScope(v2Base({ project: { kind: "stub", id: "p1", ref: "stub:p1" } })).scope.projectId, toFinanceScope(v2Base({ project: { kind: "event", id: "p1", ref: "event:p1" } })).scope.projectId);
  assert.notEqual(toFinanceScope(acct).scope.actorId, toFinanceScope(guest).scope.actorId);
});

test("mode mapping: environment, economic and evidence are separate, and each follows its own input", () => {
  const keys = (k) => ({ [k]: "sk-test" });
  const m = (env, secret = false) => resolveModes(env, secret);
  assert.deepEqual(m({}), { environment: "development", economicMode: "none", evidenceMode: "synthetic" });
  assert.deepEqual(m({ NODE_ENV: "production" }), { environment: "preview", economicMode: "none", evidenceMode: "synthetic" });
  assert.deepEqual(m({ TICKETSTUB_RUNTIME_MODE: "live" }, true), { environment: "live", economicMode: "live", evidenceMode: "live" });
  // live runtime without an issuer key: still live money, but the evidence is not live
  assert.deepEqual(m({ TICKETSTUB_RUNTIME_MODE: "live" }, false), { environment: "live", economicMode: "live", evidenceMode: "synthetic" });
  // a configured paid provider outside live mode is a paid test: real money, whatever the evidence says
  for (const k of PAID_PROVIDER_KEYS) assert.equal(m(keys(k)).economicMode, "paid_test", k);
  assert.equal(m({ ...keys("OPENAI_API_KEY"), NODE_ENV: "production" }).environment, "preview");
  assert.equal(m({ ...keys("OPENAI_API_KEY"), NODE_ENV: "production" }).evidenceMode, "synthetic");
  assert.equal(m({ OPENAI_API_KEY: "   " }).economicMode, "none"); // blank is not configured
  // an explicit statement is honoured only when consistent
  assert.equal(m({ TICKETSTUB_BILLING_MODE: "sandbox" }).economicMode, "sandbox");
  assert.equal(m({ TICKETSTUB_BILLING_MODE: " Paid_Test " }).economicMode, "paid_test");
  assert.equal(m({ TICKETSTUB_RUNTIME_MODE: "live", TICKETSTUB_BILLING_MODE: "sandbox" }, true).economicMode, "sandbox");
  // modes that cannot be mapped honestly refuse, rather than guess
  assert.throws(() => m({ TICKETSTUB_BILLING_MODE: "free" }), ModeMappingError);
  assert.throws(() => m({ TICKETSTUB_BILLING_MODE: "live" }), ModeMappingError); // live money from development
  assert.throws(() => m({ TICKETSTUB_RUNTIME_MODE: "live", TICKETSTUB_BILLING_MODE: "paid_test" }, true), ModeMappingError);
  assert.throws(() => m({ ...keys("ANTHROPIC_API_KEY"), TICKETSTUB_BILLING_MODE: "none" }), ModeMappingError); // cannot hide real spend
  assert.throws(() => m({ ...keys("ANTHROPIC_API_KEY"), TICKETSTUB_BILLING_MODE: "sandbox" }), ModeMappingError);
});

test("the issuer and both verifiers accept exactly the same (environment, economic, evidence) combinations", () => {
  for (const environment of ENVIRONMENTS) for (const economicMode of ECONOMIC_MODES) for (const evidenceMode of EVIDENCE_MODES) {
    const c = v2Base({ environment, economicMode, evidenceMode });
    const [a, b] = both(sign(c));
    assert.deepEqual(a, b, `${environment}/${economicMode}/${evidenceMode}`);
    assert.equal(a.ok, modesConsistent(environment, economicMode), `${environment}/${economicMode}/${evidenceMode}`);
  }
});

const FIVE = ["actorId", "billingMode", "environment", "projectId", "tenantId"];
const REFUSED = (reason, fields) => ({ ok: false, schema: FINANCE_SCOPE_ADAPTER, reason, ...(fields ? { fields } : {}) });

test("finance scope adapter: a versioned result whose scope is exactly the five TrustedScope fields, evidence beside it", () => {
  const r = toFinanceScope(v2Base({ environment: "preview", economicMode: "paid_test", evidenceMode: "fixture" }));
  assert.equal(r.ok, true);
  assert.equal(r.schema, "ticketstub.finance-scope-adapter/1");
  assert.deepEqual(Object.keys(r.scope).sort(), FIVE);
  assert.equal("evidenceMode" in r.scope, false);
  assert.equal(r.evidenceMode, "mocked");
  assert.ok(checkVendored(r.scope));
  // GT-V2-FIN-001 negative control: the old shape (evidenceMode inside the scope) is rejected by the consumer schema
  assert.equal(checkVendored({ ...r.scope, evidenceMode: r.evidenceMode }), false);
});

test("finance scope mapping: paid_test stays an actual expense whatever the environment or evidence; unsupported contexts are refused", () => {
  const s = (over) => toFinanceScope(v2Base(over));
  const paid = s({ environment: "preview", economicMode: "paid_test", evidenceMode: "fixture" });
  assert.equal(paid.scope.billingMode, "live");
  assert.equal(paid.scope.environment, "test");
  assert.equal(paid.evidenceMode, "mocked");
  assert.equal(s({ economicMode: "sandbox" }).scope.billingMode, "sandbox");
  assert.equal(s({ economicMode: "none" }).scope.billingMode, "simulated");
  assert.notEqual(s({ economicMode: "paid_test" }).scope.billingMode, s({ economicMode: "sandbox" }).scope.billingMode);
  assert.deepEqual(toFinanceScope(v1Base()), REFUSED("unsupported_context"));
  assert.deepEqual(s({ economicMode: "unheard-of" }), REFUSED("unsupported_context"));
  assert.deepEqual(toFinanceScope(null), REFUSED("unsupported_context"));
  assert.equal(s({}).scope.projectId, "event:evt_fx_1");
  assert.equal(toFinanceScope(v2Base({ project: undefined })).scope.projectId, "platform");
});

// ---- GT-V2-FIN-002: the 128-character policy ----

test("finance scope adapter length policy: 128 accepted, 129 and the 128-raw case refused, never truncated, for actor, tenant and project", () => {
  const long = (n) => "a".repeat(n);
  const acct = (n) => v2Base({ actor: { kind: "account", id: `account:${long(n)}` }, tenant: { id: `account:${long(n)}` } });
  const evt = (n) => v2Base({ project: { kind: "event", id: long(n), ref: `event:${long(n)}` } });
  const ok = toFinanceScope(acct(120));
  assert.equal(ok.ok, true);
  assert.equal(ok.scope.actorId.length, FINANCE_ID_MAX);
  assert.equal(ok.scope.tenantId, `account:${long(120)}`); // kind kept, nothing cut
  assert.deepEqual(toFinanceScope(acct(121)), REFUSED("identifier_too_long", ["tenantId", "actorId"]));
  assert.deepEqual(toFinanceScope(acct(128)), REFUSED("identifier_too_long", ["tenantId", "actorId"]));
  assert.equal(toFinanceScope(evt(122)).scope.projectId.length, FINANCE_ID_MAX);
  assert.deepEqual(toFinanceScope(evt(123)), REFUSED("identifier_too_long", ["projectId"]));
  assert.deepEqual(toFinanceScope(evt(128)), REFUSED("identifier_too_long", ["projectId"]));
  // guests (6-character prefix) and stubs (5) have their own boundaries
  const guest = (n) => v2Base({ actor: { kind: "guest", id: `guest:${long(n)}` }, tenant: { id: `guest:${long(n)}` }, capabilities: [] });
  assert.equal(toFinanceScope(guest(122)).ok, true);
  assert.equal(toFinanceScope(guest(123)).ok, false);
  const stub = (n) => v2Base({ project: { kind: "stub", id: long(n), ref: `stub:${long(n)}` } });
  assert.equal(toFinanceScope(stub(123)).ok, true);
  assert.equal(toFinanceScope(stub(124)).ok, false);
  // each field is checked on its own: a long tenant alone, a long actor alone
  const base = v2Base();
  assert.deepEqual(toFinanceScope({ ...base, tenant: { id: long(129) } }), REFUSED("identifier_too_long", ["tenantId"]));
  assert.deepEqual(toFinanceScope({ ...base, actor: { ...base.actor, id: long(129) } }), REFUSED("identifier_too_long", ["actorId"]));
  // the verifiers do not cap raw ids: they still accept all of these (the adapter is where Finance's bound lives)
  for (const c of [acct(120), acct(121), acct(128), evt(122), evt(123), evt(128)]) {
    const [a, b] = both(sign(c));
    assert.equal(a.ok, true);
    assert.deepEqual(a, b);
  }
  // negative control: the unguarded prefixed id the reviewer saw is rejected by the consumer schema
  assert.equal(checkVendored({ ...ok.scope, actorId: `account:${long(128)}` }), false);
});

test("every adapter scope over the published and boundary fixtures passes the TrustedScope schema (vendored always; the consumer's TypeBox when FINANCE_CONSUMER_DIR is set)", async () => {
  const dir = process.env.FINANCE_CONSUMER_DIR;
  const consumer = dir ? await loadConsumer(dir) : null; // set but unloadable throws: skipping is failure
  if (consumer) assert.equal(consumer.drift, false, "vendored finance-trusted-scope.schema.json differs from the consumer's TrustedScopeSchema");
  const key = JSON.parse(readFileSync(join(DIR, "fixture-key.json"), "utf8")).key;
  const rows = [];
  for (const f of readdirSync(join(DIR, "v2")).filter((n) => n.endsWith(".json") && n !== "malformed-shapes.json")) rows.push(JSON.parse(readFileSync(join(DIR, "v2", f), "utf8")));
  for (const f of readdirSync(DIR).filter((n) => n.endsWith(".json") && !["fixture-key.json", "index.json", "finance-trusted-scope.schema.json"].includes(n))) rows.push(JSON.parse(readFileSync(join(DIR, f), "utf8")));
  let accepted = 0;
  let refused = 0;
  let v1 = 0;
  for (const fx of rows) {
    const v = verifyContext(fx.token, key, { now: Date.parse(fx.verifyAt), audience: AUDIENCE });
    if (!v.ok) continue; // expired, forged, revoked...: no context, nothing to map
    const r = toFinanceScope(v.ctx);
    if (fx.expect.financeAdapter) assert.deepEqual(r, fx.expect.financeAdapter, fx.fixture);
    if (r.ok) {
      accepted++;
      assert.deepEqual(Object.keys(r.scope).sort(), FIVE, fx.fixture);
      assert.ok(checkVendored(r.scope), `vendored schema: ${fx.fixture}`);
      if (consumer) assert.equal(consumer.check(r.scope), true, `consumer TypeBox: ${fx.fixture}`);
      assert.ok(["mocked", "sandbox", "live"].includes(r.evidenceMode), fx.fixture);
    } else if (v.ctx.schema === "ticketstub.context/2") {
      refused++;
      assert.equal(r.reason, "identifier_too_long", fx.fixture);
      assert.equal("scope" in r, false, `a refusal carries no scope: ${fx.fixture}`);
      // the naive mapping the reviewer ran (kind-prefixed ids, no length check) is what the consumer would have rejected
      const naive = { tenantId: v.ctx.tenant.id, projectId: v.ctx.project ? v.ctx.project.ref : "platform", environment: "development", billingMode: "sandbox", actorId: v.ctx.actor.id };
      assert.equal(checkVendored(naive), false, fx.fixture);
      if (consumer) assert.equal(consumer.check(naive), false, `consumer TypeBox rejects the naive scope: ${fx.fixture}`);
    } else {
      v1++;
      assert.equal(r.reason, "unsupported_context", fx.fixture);
    }
  }
  assert.equal(refused, BOUNDARY.filter((b) => b[3]).length);
  assert.ok(BOUNDARY.some((b) => !b[3]) && accepted >= 10, `${accepted} accepted`);
  assert.ok(v1 >= 1);
  console.log(`# trusted-scope: ${accepted} accepted, ${refused} refused, ${v1} /1 refused unsupported_context; consumer TypeBox ${consumer ? "ran" : "not configured (vendored schema only)"}`);
});

// ---- GT-FIN-003: parity ----

test("every malformed shape is refused as unknown, identically, by the server verifier and the offline verifier", () => {
  const cases = malformedContexts();
  assert.equal(cases.length, MALFORMED.length);
  assert.equal(MALFORMED_BASE.length, 40); // the original rows, retained and first, with their reasons
  assert.equal(MALFORMED_WRONG_TYPE.length, 55); // GT-V2-FIN-003: 11 enum fields x array, object, null, number, boolean
  assert.deepEqual(cases.slice(0, 40).map((c) => c.name), MALFORMED_BASE.map((r) => r[0]));
  for (const { name, ctx } of cases) {
    const [server, offline] = both(sign(ctx));
    assert.deepEqual(server, { ok: false, reason: "unknown" }, `server: ${name}`);
    assert.deepEqual(offline, server, `offline: ${name}`);
  }
  // the seven the Finance receipt named are in the corpus
  for (const needle of ["v1 missing account actor id", "v1 missing environment", "v1 unknown environment", "v1 missing mode", "v1 unknown mode", "v1 malformed project kind", "v1 malformed project id", "v1 missing issuedAt"]) {
    assert.ok(cases.some((c) => c.name === needle), needle);
  }
});

test("an enum field of the wrong type is refused by both verifiers, as the value itself and never as its string form", () => {
  for (const { name, ctx } of malformedContexts().slice(40)) {
    const [server, offline] = both(sign(ctx));
    assert.deepEqual(server, { ok: false, reason: "unknown" }, `server: ${name}`);
    assert.deepEqual(offline, server, `offline: ${name}`);
  }
  // the six the reviewer signed with the fixture key: one-element arrays that String() turned back into a member
  const six = [[1, ["environment"], ["development"]], [1, ["mode"], ["fixture"]], [1, ["project", "kind"], ["stub"]], [2, ["environment"], ["development"]], [2, ["economicMode"], ["sandbox"]], [2, ["evidenceMode"], ["fixture"]]];
  for (const [v, path, val] of six) {
    const c = structuredClone(v === 1 ? v1Base() : v2Base());
    const last = path.pop();
    path.reduce((x, k) => x[k], c)[last] = val;
    const [server, offline] = both(sign(c));
    assert.deepEqual(server, { ok: false, reason: "unknown" }, `/${v} ${last}`);
    assert.deepEqual(offline, server);
  }
  // `schema` of the wrong type is not a version we know
  for (const { name, ctx } of wrongTypeSchemaContexts()) {
    const [server, offline] = both(sign(ctx));
    assert.deepEqual(server, { ok: false, reason: "unsupported_version" }, `server: ${name}`);
    assert.deepEqual(offline, server, `offline: ${name}`);
  }
});

test("the valid bases verify (so the malformed cases fail for their one mutated field)", () => {
  for (const c of [v1Base(), v2Base()]) {
    const [a, b] = both(sign(c));
    assert.equal(a.ok, true);
    assert.deepEqual(a, b);
  }
});

test("every other verdict agrees too: forged, expired, unsupported_version, wrong_audience, revoked, project membership, stale", () => {
  const good = sign(v2Base());
  const cases = [
    ["forged", signContext(v2Base(), "another-key-0000000000000000000000000", null), {}, "forged"],
    ["expired", good, { now: NOW + 6 * 60_000 }, "expired"],
    ["unsupported_version", sign({ ...v2Base(), schema: "ticketstub.context/3" }), {}, "unsupported_version"],
    ["wrong_audience", good, { audience: "another-host" }, "wrong_audience"],
    ["right audience", good, { audience: AUDIENCE }, null],
    ["a /2 token with no expected audience is refused", good, { audience: undefined }, "wrong_audience"],
    ["a /2 token with an empty expected audience is refused", good, { audience: "" }, "wrong_audience"],
    ["no expected audience is refused before revocation is looked at", good, { audience: undefined, state: { sessionLive: false } }, "wrong_audience"],
    ["a /1 token needs no expected audience", sign(v1Base()), { audience: undefined }, null],
    ["a /1 token has no audience", sign(v1Base()), { audience: "another-host" }, null],
    ["revoked flag", sign(v2Base({ revoked: true })), {}, "revoked"],
    ["session gone", good, { state: { membershipRevision: 3, sessionLive: false } }, "revoked"],
    ["project membership lost", good, { state: { membershipRevision: 3, sessionLive: true, projectMember: false } }, "revoked"],
    ["project membership ignored for /1", sign(v1Base()), { state: { membershipRevision: 3, sessionLive: true, projectMember: false } }, null],
    ["stale revision", good, { state: { membershipRevision: 4, sessionLive: true, projectMember: true } }, "stale"],
    ["current", good, { state: { membershipRevision: 3, sessionLive: true, projectMember: true } }, null],
    ["audience is checked before revocation", good, { audience: "another-host", state: { sessionLive: false } }, "wrong_audience"],
  ];
  for (const [name, token, opts, reason] of cases) {
    const [server, offline] = both(token, opts);
    assert.deepEqual(offline, server, name);
    assert.equal(server.ok, reason === null, name);
    if (reason) assert.equal(server.reason, reason, name);
  }
});

test("garbage that is not a token gets the same answer from both verifiers", () => {
  const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "ticketstub.context" })).toString("base64url");
  const noCtx = signContext({ no: "ctx" }, KEY, null);
  const cases = ["", "nope", "a.b", "a.b.c.d", `${head}.${Buffer.from("[]").toString("base64url")}.x`, "x".repeat(9000), noCtx];
  for (const t of cases) {
    const [server, offline] = both(t);
    assert.deepEqual(offline, server, t.slice(0, 20));
    assert.equal(server.ok, false);
  }
});

// ---- the published fixtures ----

test("every published /2 fixture and malformed shape gets its expected outcome from both verifiers", () => {
  const key = JSON.parse(readFileSync(join(DIR, "fixture-key.json"), "utf8")).key;
  const files = readdirSync(join(DIR, "v2")).filter((n) => n.endsWith(".json") && n !== "malformed-shapes.json");
  assert.ok(files.length >= 24, `${files.length} /2 fixtures`);
  const seen = new Set();
  for (const f of files) {
    const fx = JSON.parse(readFileSync(join(DIR, "v2", f), "utf8"));
    const now = Date.parse(fx.verifyAt);
    const server = verifyWithKey(fx.token, key, now, fx.state, { audience: fx.audience ?? AUDIENCE });
    const offline = verifyContext(fx.token, key, { now, state: fx.state, audience: fx.audience ?? AUDIENCE });
    assert.deepEqual(offline, server, fx.fixture);
    assert.equal(server.ok, fx.expect.ok, fx.fixture);
    if (server.ok) {
      assert.equal(server.ctx.role, fx.expect.role, fx.fixture);
      assert.equal(server.ctx.tenant.id, fx.expect.tenant, fx.fixture);
      for (const c of fx.expect.grants?.allow ?? []) assert.ok(server.ctx.capabilities.includes(c), `${fx.fixture} allows ${c}`);
      for (const c of fx.expect.grants?.deny ?? []) assert.ok(!server.ctx.capabilities.includes(c), `${fx.fixture} denies ${c}`);
      if (fx.expect.modes) assert.deepEqual({ environment: server.ctx.environment, economicMode: server.ctx.economicMode, evidenceMode: server.ctx.evidenceMode }, fx.expect.modes, fx.fixture);
      if (fx.expect.financeAdapter) assert.deepEqual(toFinanceScope(server.ctx), fx.expect.financeAdapter, fx.fixture);
    } else {
      assert.equal(server.reason, fx.expect.reason, fx.fixture);
    }
    seen.add(server.ok ? "ok" : server.reason);
  }
  for (const r of ["ok", "revoked", "stale", "wrong_audience"]) assert.ok(seen.has(r), r);
  const shapes = JSON.parse(readFileSync(join(DIR, "v2", "malformed-shapes.json"), "utf8")).cases;
  assert.equal(shapes.length, MALFORMED.length);
  assert.deepEqual(shapes.map((c) => c.name), MALFORMED.map((r) => r[0]));
  for (const c of shapes) {
    const now = Date.parse(c.verifyAt);
    assert.deepEqual(verifyWithKey(c.token, key, now), { ok: false, reason: "unknown" }, c.name);
    assert.deepEqual(verifyContext(c.token, key, { now }), { ok: false, reason: "unknown" }, c.name);
  }
});

test("the finance fixtures cover read, export and command, each allowed and denied, and paid_test against sandbox", () => {
  const load = (n) => JSON.parse(readFileSync(join(DIR, "v2", `${n}.json`), "utf8"));
  const key = JSON.parse(readFileSync(join(DIR, "fixture-key.json"), "utf8")).key;
  const ctx = (n) => verifyContext(load(n).token, key, { now: Date.parse(load(n).verifyAt), audience: AUDIENCE }).ctx;
  const can = (n, cap) => ctx(n).capabilities.includes(cap);
  assert.ok(can("finance-read-allowed", "finance.read") && !can("finance-read-denied", "finance.read"));
  assert.ok(can("finance-export-allowed", "finance.export") && !can("finance-export-denied", "finance.export"));
  assert.ok(can("finance-command-allowed", "finance.command.budget_change") && !can("finance-command-denied", "finance.command.budget_change"));
  assert.equal(toFinanceScope(ctx("economic-paid-test")).scope.billingMode, "live");
  assert.equal(toFinanceScope(ctx("economic-sandbox")).scope.billingMode, "sandbox");
  assert.equal(ctx("economic-paid-test").evidenceMode, "fixture"); // fixture evidence, real expense
  assert.notEqual(ctx("injective-account").tenant.id, ctx("injective-guest").tenant.id);
});

test("/1 is unchanged: its fixtures still verify, and /1 and /2 verify side by side", () => {
  const key = JSON.parse(readFileSync(join(DIR, "fixture-key.json"), "utf8")).key;
  const owner = JSON.parse(readFileSync(join(DIR, "owner.json"), "utf8"));
  const r = verifyContext(owner.token, key, { now: Date.parse(owner.verifyAt), state: owner.state });
  assert.equal(r.ok, true);
  assert.equal(r.ctx.schema, "ticketstub.context/1");
  assert.equal(r.ctx.mode, "fixture");
  assert.equal(authorizes(r.ctx, { tenant: r.ctx.tenant.id, project: r.ctx.project, capability: "stub.read" }), true);
  assert.equal(JSON.parse(readFileSync(join(DIR, "index.json"), "utf8")).schema, "ticketstub.context/1");
});
