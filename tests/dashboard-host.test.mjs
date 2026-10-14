import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadServerModule } from "./lib/load-server.mjs";
import { toFinanceScope } from "../src/server/finance-scope.ts";

// Actual app issuer/live verifier and SQLite storage. All identities and records
// are constructed local test data; no Dashboard package, Finance service or provider is called.
const savedEnv = { ...process.env };
const dir = mkdtempSync(join(tmpdir(), "ticketstub-dashboard-host-"));
for (const name of Object.keys(process.env)) if (/^(?:CONTEXT_|TICKETSTUB_|ADMIN_EMAILS|OPENAI_|ANTHROPIC_|OPENROUTER_|GEMINI_|GOOGLE_AI_|BRAVE_)/.test(name)) delete process.env[name];
Object.assign(process.env, { NODE_ENV: "test", TICKETSTUB_RUNTIME_MODE: "demo", TICKETSTUB_DB: join(dir, "app.sqlite"), TICKETSTUB_FILES: join(dir, "files"),
  CONTEXT_SECRET: "dashboard-test-only-key-at-least-thirty-two-characters", ADMIN_EMAILS: "" });
const host = await loadServerModule("src/server/dashboard-host.ts");
const { GET } = await loadServerModule("src/app/api/admin/dashboard/route.ts");
const { getStorage } = await loadServerModule("src/server/index.ts");
const { hashToken } = await loadServerModule("src/server/crypto.ts");
const { getServerContext, issueContextV2 } = await loadServerModule("src/server/context.ts");
const storage = getStorage();
const staffEmails = [];
const account = async ({ staff = true, expired = false } = {}) => {
  const email = `synthetic-${randomUUID()}@example.test`;
  const now = Date.now();
  const user = await storage.findOrCreateAccount(email, now);
  const cookie = `synthetic-cookie-${randomUUID()}`;
  await storage.createSession(hashToken(cookie), user.id, now, now + (expired ? -1 : 3_600_000));
  if (staff) staffEmails.push(email);
  process.env.ADMIN_EMAILS = staffEmails.join(",");
  return { ...user, cookie, headers: new Headers({ cookie: `ts_session=${cookie}` }) };
};
const event = async (user) => {
  const id = `event-${randomUUID()}`;
  await storage.createEvent(user.id, { id, title: "Synthetic private event", stub: {}, expiresAt: Date.now() + 3_600_000 }, [], Date.now());
  return id;
};
const session = async (user, selected) => {
  const result = await host.openAdminDashboard(user.headers, selected);
  assert.equal(result.state, "ready"); return result.session;
};
const api = (user, query = "", signal) => GET(new Request(`https://example.test/api/admin/dashboard${query}`, { headers: user?.headers, signal }));
after(() => {
  storage.db.close(); delete globalThis.__ticketstubStorageV9;
  rmSync(dir, { recursive: true, force: true });
  for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name];
  Object.assign(process.env, savedEnv);
});

test("project selection is a strict kind-prefixed question, with duplicates and empty values refused", () => {
  assert.deepEqual(host.parseDashboardProject(undefined), { ok: true });
  for (const kind of ["event", "stub"]) assert.deepEqual(host.parseDashboardProject(`${kind}:a:b-1`), { ok: true, project: { kind, id: "a:b-1" } });
  for (const bad of [null, "", "platform", "other:a", "event:", "event:a/b", "event:a?role=staff", "event:" + "a".repeat(129), ["event:a"], ["event:a", "event:b"], { project: "event:a" }]) assert.deepEqual(host.parseDashboardProject(bad), { ok: false });
});

test("pure scope mapping refuses malformed and prototype-like enum values without authenticating them", () => {
  const base = { schema: "ticketstub.context/2", tenant: { id: "account:a" }, actor: { id: "account:a" }, environment: "preview", economicMode: "paid_test", evidenceMode: "fixture" };
  assert.deepEqual(toFinanceScope(base), { ok: true, schema: "ticketstub.finance-scope-adapter/1", scope: { tenantId: "account:a", projectId: "platform", environment: "test", billingMode: "live", actorId: "account:a" }, evidenceMode: "mocked" });
  for (const key of ["environment", "economicMode", "evidenceMode"]) for (const value of ["__proto__", "toString", [base[key]], {}]) assert.equal(toFinanceScope({ ...base, [key]: value }).ok, false);
  for (const bad of [null, {}, { ...base, tenant: null }, { ...base, actor: [] }, { ...base, project: null }]) assert.equal(toFinanceScope(bad).ok, false);
});

test("staff platform gets a fresh verified /2 display projection without any serialized credential", async () => {
  const user = await account(); const s = await session(user);
  assert.equal(s.summary.schema, "ticketstub.context/2"); assert.equal(s.summary.projectRef, null);
  assert.equal(s.summary.tenantId, `account:${user.id}`); assert.ok(s.summary.capabilities.includes("admin.view"));
  assert.ok(s.summary.capabilities.includes("finance.read")); assert.equal(s.summary.verified, true);
  assert.ok(Date.parse(s.summary.expiresAt) > Date.now()); assert.ok(Date.parse(s.summary.expiresAt) <= Date.now() + host.DASHBOARD_MAX_TTL_MS);
  assert.match(s.summary.revision, new RegExp(`^account:${user.id}@\\d+$`));
  assert.deepEqual(Object.keys(s), ["summary"]);
  for (const secret of [user.cookie, user.email, "eyJhbGci", "sessionRef", "token"]) assert.equal(JSON.stringify(s).includes(secret), false);
  assert.equal(Object.isFrozen(s), true); assert.equal(Object.isFrozen(s.summary.capabilities), true);
  const copy = JSON.parse(JSON.stringify(s)); let calls = 0;
  assert.deepEqual(await host.guardDashboardRead(copy, async () => { calls++; return "private"; }), { state: "denied" }); assert.equal(calls, 0);
});

test("internal no-project and project captain do not broaden public staff-only admission", async () => {
  const user = await account({ staff: false }); const id = await event(user);
  assert.deepEqual(await host.openDashboardSession(user.headers), { state: "no-project" });
  const opened = await host.openDashboardSession(user.headers, `event:${id}`);
  assert.equal(opened.state, "ready"); assert.equal(opened.session.summary.role, "captain");
  assert.deepEqual(await host.openAdminDashboard(user.headers, `event:${id}`), { state: "denied" });
  assert.equal((await api(user, `?project=event:${id}`)).status, 404);
  assert.equal((await api(null)).status, 404);
  assert.equal((await api({ headers: new Headers({ cookie: "ts_device=synthetic_device_12345" }) })).status, 404);
});

test("same actor projects A/B stay distinct; foreign and missing selections have identical denials", async () => {
  const a = await account(); const b = await account(); const a1 = await event(a); const a2 = await event(a); const b1 = await event(b);
  const one = await session(a, `event:${a1}`); const two = await session(a, `event:${a2}`);
  assert.equal(one.summary.projectRef, `event:${a1}`); assert.equal(two.summary.projectRef, `event:${a2}`);
  assert.notEqual(one.summary.projectRef, two.summary.projectRef);
  const foreign = await api(a, `?project=event:${b1}`); const missing = await api(a, "?project=event:missing");
  assert.equal(foreign.status, 404); assert.equal(missing.status, 404); assert.deepEqual(await foreign.json(), await missing.json());
  assert.equal((await api(a, `?project=event:${a1}&project=event:${a2}`)).status, 404);
  assert.equal((await api(a, "?project=")).status, 404);
});

test("stub ownership does not create a Finance read grant, even for admitted staff", async () => {
  const user = await account(); const id = `stub-${randomUUID()}`;
  await storage.syncWall(user.id, [{ id, title: "Synthetic stub", updatedAt: Date.now() }], [], Date.now());
  const s = await session(user, `stub:${id}`); let calls = 0;
  assert.equal(s.summary.capabilities.includes("finance.read"), false);
  assert.deepEqual(await host.guardDashboardRead(s, async () => { calls++; return "private"; }), { state: "denied" }); assert.equal(calls, 0);
  assert.equal((await host.dashboardHostView(s)).finance, "restricted");
});

test("an unchanged current session permits one explicitly synthetic read with exact immutable five-field scope", async () => {
  const user = await account(); const id = await event(user); const s = await session(user, `event:${id}`); let calls = 0;
  const read = await host.guardDashboardRead(s, async (scope) => {
    calls++; assert.deepEqual(Object.keys(scope).sort(), ["actorId", "billingMode", "environment", "projectId", "tenantId"]);
    assert.equal(scope.actorId, `account:${user.id}`); assert.equal(scope.projectId, `event:${id}`); assert.equal(Object.isFrozen(scope), true);
    await Promise.resolve(); return { syntheticControl: true };
  });
  assert.deepEqual(read, { state: "ready", value: { syntheticControl: true } }); assert.equal(calls, 1);
});

for (const change of ["session", "membership", "project", "staff", "account"]) test(`revocation during awaited read (${change}) withholds the returned value`, async () => {
  const user = await account(); const id = await event(user); const s = await session(user, `event:${id}`); let calls = 0;
  const result = await host.guardDashboardRead(s, async () => {
    calls++;
    if (change === "session") await storage.deleteSession(hashToken(user.cookie));
    if (change === "membership") storage.db.prepare("UPDATE accounts SET membership_revision = membership_revision + 1 WHERE id = ?").run(user.id);
    if (change === "project") storage.db.prepare("DELETE FROM organizer_events WHERE id = ?").run(id);
    if (change === "staff") process.env.ADMIN_EMAILS = staffEmails.filter((email) => email !== user.email).join(",");
    if (change === "account") await storage.deleteAccount(user.id, user.email);
    await Promise.resolve(); return { privateCanary: "must-not-be-disclosed" };
  });
  assert.deepEqual(result, { state: "denied" }); assert.equal(calls, 1);
});

test("expired/revoked sessions, wrong audience and missing live key cannot open a usable host", async () => {
  const expired = await account({ expired: true }); assert.deepEqual(await host.openAdminDashboard(expired.headers), { state: "denied" });
  const user = await account(); const s = await session(user); const originalNow = Date.now;
  try { Date.now = () => Date.parse(s.summary.expiresAt) + 1; assert.deepEqual(await host.dashboardHostView(s), { state: "denied" }); } finally { Date.now = originalNow; }
  process.env.CONTEXT_AUDIENCE = "another.consumer";
  try { assert.deepEqual(await host.openAdminDashboard(user.headers), { state: "denied" }); } finally { delete process.env.CONTEXT_AUDIENCE; }
  const key = process.env.CONTEXT_SECRET; process.env.TICKETSTUB_RUNTIME_MODE = "live"; delete process.env.CONTEXT_SECRET;
  try { assert.notEqual((await host.openAdminDashboard(user.headers)).state, "ready"); } finally { process.env.TICKETSTUB_RUNTIME_MODE = "demo"; process.env.CONTEXT_SECRET = key; }
  await storage.deleteSession(hashToken(user.cookie)); assert.deepEqual(await host.dashboardHostView(s), { state: "denied" });
});

test("a backwards clock during live verification cannot admit an excessive remaining lifetime", async () => {
  const user = await account(); const originalNow = Date.now; const originalLive = storage.isSessionLive;
  const start = originalNow(); let now = start;
  Date.now = () => now;
  storage.isSessionLive = async (...args) => { const result = await originalLive.apply(storage, args); now = start - 120_000; return result; };
  try { assert.deepEqual(await host.openAdminDashboard(user.headers), { state: "denied" }); }
  finally { Date.now = originalNow; storage.isSessionLive = originalLive; }
});

test("a current read cannot use another actor's request or mutated projection to change its scope", async () => {
  const a = await account(); const b = await account(); const id = await event(a);
  const s = await session(a, `event:${id}`);
  assert.throws(() => { s.summary.tenantId = `account:${b.id}`; }, TypeError);
  assert.throws(() => { s.summary.capabilities.push("finance.command.new_grant"); }, TypeError);
  assert.equal((await api(b, `?project=event:${id}&actor=${a.id}&tenant=${a.id}`)).status, 404);
  const result = await host.guardDashboardRead(s, async (scope) => ({ syntheticActor: scope.actorId }));
  assert.deepEqual(result, { state: "ready", value: { syntheticActor: `account:${a.id}` } });
});

test("abort before or during the read is a denial, with no retry", async () => {
  const user = await account(); const s = await session(user); const before = new AbortController(); before.abort(); let calls = 0;
  assert.deepEqual(await host.guardDashboardRead(s, async () => { calls++; }, before.signal), { state: "denied" }); assert.equal(calls, 0);
  const during = new AbortController();
  assert.deepEqual(await host.guardDashboardRead(s, async () => { calls++; during.abort(); return "private"; }, during.signal), { state: "denied" }); assert.equal(calls, 1);
});

test("storage/read failures disclose no error text or partial value", async () => {
  const user = await account(); const s = await session(user); const canary = "synthetic-private-canary";
  assert.deepEqual(await host.guardDashboardRead(s, async () => { throw new Error(canary); }), { state: "unavailable" });
  const original = storage.getAccountState;
  storage.getAccountState = async () => { throw new Error(canary); };
  try { assert.deepEqual(await host.dashboardHostView(s), { state: "unavailable" }); } finally { storage.getAccountState = original; }
});

test("public host response is uncached and unavailable without actual Finance; browser authority is ignored", async () => {
  const user = await account(); const current = await getServerContext(user.headers); const { token } = issueContextV2(current);
  const response = await api(user, "?tenant=other&actor=other&capabilities=finance.command.recovery&token=private-input");
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.finance, "unavailable"); assert.equal(body.mount, "runtime-pending");
  assert.equal(body.summary.tenantId, `account:${user.id}`);
  assert.deepEqual(Object.keys(body).sort(), ["finance", "mount", "schema", "state", "summary"]);
  for (const secret of [token, user.cookie, user.email, "private-input", "sessionRef", "\"token\"", "amount", "balance"]) assert.equal(JSON.stringify(body).includes(secret), false);
  const unauthorized = await api({ headers: new Headers({ authorization: `Bearer ${token}`, "x-tenant": user.id, "x-role": "staff" }) });
  assert.equal(unauthorized.status, 404);
});

test("client contract and page cannot serialize the private credential or import a server issuer into a client", () => {
  const contract = readFileSync(new URL("../src/app/admin/contract.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/app/admin/[[...path]]/page.tsx", import.meta.url), "utf8");
  const mount = readFileSync(new URL("../src/app/admin/AdminMount.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(contract, /\btoken\s*:/); assert.doesNotMatch(page, /issueContextToken|context=\{\{\s*token/);
  assert.doesNotMatch(mount, /from ["'][^"']*server\//);
});
