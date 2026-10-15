// Regenerates the JSON fixtures in this folder. Deterministic: same inputs, same bytes.
//   node fixtures/context/generate.mjs
// Signs with the FIXTURE key below. That key is public on purpose. It is fixture only, never production:
// a token signed with it carries mode "fixture", and no live deployment is configured with it.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTEXT_SCHEMA, capabilitiesFor, signContext, toContextV2 } from "../../src/server/context-token.ts";
import { AUDIENCE, BOUNDARY, malformedContexts } from "./corpus.mjs";
import { FINANCE_SCOPE_ADAPTER } from "./verify.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_KEY = "FIXTURE-ONLY-NEVER-PRODUCTION--ticketstub-context-key-v1";
const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

function ctx({ actor, tenant, project, role, staff = false, revision = 1, issued = NOW, ttl = 5 * 60_000, schema = CONTEXT_SCHEMA }) {
  return {
    schema,
    actor,
    tenant: { id: tenant },
    ...(project ? { project } : {}),
    role,
    capabilities: capabilitiesFor(actor.kind, role, project, staff),
    membershipRevision: revision,
    revoked: false,
    environment: "development",
    mode: "fixture",
    issuedAt: iso(issued),
    expiresAt: iso(issued + ttl),
  };
}

const account = (id) => ({ kind: "account", id });
const owner1 = account("acc_FIXTURE_owner1");
const SID = "fx0000000000000000000001";

const out = {};
function add(name, description, token, expect, state, verifyAt = NOW) {
  out[name] = { fixture: name, description, verifyAt: iso(verifyAt), token, ...(state ? { state } : {}), expect };
}
const live = { membershipRevision: 3, sessionLive: true };
const okExpect = (c) => ({ ok: true, role: c.role, tenant: c.tenant.id, ...(c.project ? { project: c.project } : {}) });

const owner = ctx({ actor: owner1, tenant: owner1.id, project: { kind: "stub", id: "stub_fx_1" }, role: "owner", revision: 3 });
add("owner", "An account owner on their own stub.", signContext(owner, FIXTURE_KEY, SID), okExpect(owner), live);

const captain = ctx({ actor: account("acc_FIXTURE_captain1"), tenant: "acc_FIXTURE_captain1", project: { kind: "event", id: "evt_fx_1" }, role: "captain", revision: 2 });
add("captain", "The captain (creator) of an organizer event.", signContext(captain, FIXTURE_KEY, "fx0000000000000000000002"), okExpect(captain), { membershipRevision: 2, sessionLive: true });

const staff = ctx({ actor: account("acc_FIXTURE_staff1"), tenant: "acc_FIXTURE_staff1", role: "staff", staff: true, revision: 1 });
add("staff", "A signed-in account on the ADMIN_EMAILS list. admin.view only, no project access.", signContext(staff, FIXTURE_KEY, "fx0000000000000000000003"), okExpect(staff), { membershipRevision: 1, sessionLive: true });

const guest = ctx({ actor: { kind: "guest", id: "fxguest0000000001" }, tenant: "guest:fxguest0000000001", role: "none", revision: 0 });
add("guest", "A server-bound guest device. Drafts only: no account capabilities.", signContext(guest, FIXTURE_KEY, null), okExpect(guest));

const unknown = ctx({ actor: { kind: "anonymous" }, tenant: "anonymous", role: "none", revision: 0 });
add("unknown", "No session and no device: role none, the public capabilities only. A valid token that grants nothing private.", signContext(unknown, FIXTURE_KEY, null), okExpect(unknown));

add("malformed", "Not a token at all.", "not-a-token", { ok: false, reason: "unknown" });

add("forged", "The owner payload signed with a different key.", signContext(owner, "some-other-key-the-issuer-never-saw-0000", SID), { ok: false, reason: "forged" }, live);

add(
  "stale",
  "Signed correctly, but the account's membershipRevision has moved on (4 now, the token says 3): email changed, signed out everywhere, or staff status flipped.",
  signContext(owner, FIXTURE_KEY, SID),
  { ok: false, reason: "stale" },
  { membershipRevision: 4, sessionLive: true },
);

add(
  "revoked",
  "Signed correctly, but the session behind it was signed out (or the account was deleted).",
  signContext(owner, FIXTURE_KEY, SID),
  { ok: false, reason: "revoked" },
  { membershipRevision: 3, sessionLive: false },
);

const old = ctx({ actor: owner1, tenant: owner1.id, project: { kind: "stub", id: "stub_fx_1" }, role: "owner", revision: 3, issued: NOW - 10 * 60_000 });
add("expired", "Issued ten minutes before verifyAt; the lifetime is five.", signContext(old, FIXTURE_KEY, SID), { ok: false, reason: "expired" }, live);

const v2 = ctx({ actor: owner1, tenant: owner1.id, project: { kind: "stub", id: "stub_fx_1" }, role: "owner", revision: 3, schema: "ticketstub.context/3" });
add("unsupported-version", "A correctly signed token with a schema this verifier does not know (/3: /1 and /2 are both known).", signContext(v2, FIXTURE_KEY, SID), { ok: false, reason: "unsupported_version" }, live);

const projB = ctx({ actor: owner1, tenant: owner1.id, project: { kind: "stub", id: "stub_fx_2" }, role: "owner", revision: 3 });
add("cross-project-a", "The same user on project A (stub_fx_1). Authorizes project A only.", signContext(owner, FIXTURE_KEY, SID), okExpect(owner), live);
add("cross-project-b", "The same user on project B (stub_fx_2). A token for B must not authorize A, and the reverse.", signContext(projB, FIXTURE_KEY, SID), okExpect(projB), live);

const t1 = ctx({ actor: account("acc_FIXTURE_tenant1"), tenant: "acc_FIXTURE_tenant1", project: { kind: "stub", id: "stub_fx_shared" }, role: "owner", revision: 1 });
const t2 = ctx({ actor: account("acc_FIXTURE_tenant2"), tenant: "acc_FIXTURE_tenant2", project: { kind: "stub", id: "stub_fx_shared" }, role: "owner", revision: 1 });
add("tenant-a-owner", "Tenant A's owner of stub_fx_shared. Project ids are only unique inside a tenant.", signContext(t1, FIXTURE_KEY, "fx0000000000000000000004"), okExpect(t1), { membershipRevision: 1, sessionLive: true });
add("tenant-b-owner", "Tenant B's owner of a stub with the same id. Key every lookup by tenant AND project.", signContext(t2, FIXTURE_KEY, "fx0000000000000000000005"), okExpect(t2), { membershipRevision: 1, sessionLive: true });

// ---------------------------------------------------------------------------------------------
// ticketstub.context/2 (GT-FIN-001..003). Written to v2/ so the /1 inventory above is untouched.
// ---------------------------------------------------------------------------------------------
const out2 = {};
function add2(name, description, token, expect, state, { verifyAt = NOW, audience } = {}) {
  out2[name] = { fixture: name, description, verifyAt: iso(verifyAt), token, ...(audience ? { audience } : {}), ...(state ? { state } : {}), expect };
}

/** A /2 context. `raw` is the unprefixed account id or guest id; the /2 ids are derived exactly as the server derives them. */
function ctx2({ kind = "account", raw, project, role, staff = false, revision = 1, environment = "development", economicMode = "sandbox", evidenceMode = "fixture", audience = AUDIENCE }) {
  const actor = kind === "anonymous" ? { kind } : { kind, id: raw };
  const tenant = kind === "account" ? raw : kind === "guest" ? `guest:${raw}` : "anonymous";
  return toContextV2(ctx({ actor, tenant, project, role, staff, revision }), { staff, environment, economicMode, evidenceMode, audience });
}
const FIN = { read: "finance.read", export: "finance.export" };
const COMMANDS = ["budget_change", "expense_adjust", "reservation", "reconcile", "recovery"].map((n) => `finance.command.${n}`);
const grants = (allow, deny) => ({ allow, deny });
const ok2 = (c, extra = {}) => ({ ok: true, role: c.role, tenant: c.tenant.id, ...(c.project ? { project: c.project } : {}), modes: { environment: c.environment, economicMode: c.economicMode, evidenceMode: c.evidenceMode }, ...extra });
const live2 = (revision) => ({ membershipRevision: revision, sessionLive: true, projectMember: true });
const SID2 = "fx0000000000000000000010";
const evt = { kind: "event", id: "evt_fx_1" };

const cap = ctx2({ raw: "acc_FIXTURE_captain1", project: evt, role: "captain", revision: 2 });
add2("finance-read-allowed", "The captain of an event holds finance.read on that event: an explicit grant in capabilities, not the role name.", signContext(cap, FIXTURE_KEY, SID2), ok2(cap, { grants: grants([FIN.read], COMMANDS) }), live2(2));
add2("finance-export-allowed", "The captain of an event also holds finance.export on that event.", signContext(cap, FIXTURE_KEY, SID2), ok2(cap, { grants: grants([FIN.export], COMMANDS) }), live2(2));
add2("finance-command-denied", "The captain holds read and export, and no finance.command.*. A role that can read finance data cannot change it.", signContext(cap, FIXTURE_KEY, SID2), ok2(cap, { grants: grants([FIN.read, FIN.export], COMMANDS) }), live2(2));

const stubOwner = ctx2({ raw: "acc_FIXTURE_owner1", project: { kind: "stub", id: "stub_fx_1" }, role: "owner", revision: 3 });
add2("finance-read-denied", "The owner of a stub has no finance grants at all: a stub is a personal product with no finance surface. role owner confers nothing.", signContext(stubOwner, FIXTURE_KEY, SID2), ok2(stubOwner, { grants: grants([], [FIN.read, FIN.export, ...COMMANDS]) }), live2(3));

const member = ctx2({ raw: "acc_FIXTURE_member1", project: evt, role: "member", revision: 1 });
add2("finance-export-denied", "A member of an event (modelled, never issued yet) may read finance summaries but not export them.", signContext(member, FIXTURE_KEY, "fx0000000000000000000011"), ok2(member, { grants: grants([FIN.read], [FIN.export, ...COMMANDS]) }), live2(1));

const staffPlatform = ctx2({ raw: "acc_FIXTURE_staff1", role: "staff", staff: true, revision: 1 });
add2("finance-command-allowed", "Staff, in the platform scope (no project), hold read, export and every finance.command.*. Staff get nothing on a project they do not own.", signContext(staffPlatform, FIXTURE_KEY, "fx0000000000000000000012"), ok2(staffPlatform, { grants: grants([FIN.read, FIN.export, ...COMMANDS], []) }), live2(1));

const guest2 = ctx2({ kind: "guest", raw: "fxguest0000000001", role: "none", revision: 0 });
add2("finance-guest-denied", "A guest device holds no finance grant, ever. A verifier also refuses a guest token that carries one.", signContext(guest2, FIXTURE_KEY, null), ok2(guest2, { grants: grants([], [FIN.read, FIN.export, ...COMMANDS]) }));

// Injective ids: the same raw string as an account and as a guest is two different actors and two different tenants.
const same = "fxsame000000000001";
const asAccount = ctx2({ raw: same, role: "owner", revision: 1 });
const asGuest = ctx2({ kind: "guest", raw: same, role: "none", revision: 0 });
add2("injective-account", `Raw id ${same} as an account: actor and tenant are account:${same}.`, signContext(asAccount, FIXTURE_KEY, "fx0000000000000000000013"), ok2(asAccount, { grants: grants([], [FIN.read]) }), live2(1));
add2("injective-guest", `The same raw id ${same} as a guest: actor and tenant are guest:${same}. Never equal to the account's.`, signContext(asGuest, FIXTURE_KEY, null), ok2(asGuest, { grants: grants([], [FIN.read]) }));

// Mode mapping: three independent axes. financeAdapter is the PROPOSED versioned cost-intelligence TrustedScope adapter result (verify.mjs toFinanceScope): the five-field scope, plus evidenceMode beside it.
const staffModes = (environment, economicMode, evidenceMode) => ctx2({ raw: "acc_FIXTURE_staff1", role: "staff", staff: true, revision: 1, environment, economicMode, evidenceMode });
const adapter = (c, environment, billingMode, evidenceMode) => ({ ok: true, schema: FINANCE_SCOPE_ADAPTER, scope: { tenantId: c.tenant.id, projectId: "platform", environment, billingMode, actorId: c.actor.id }, evidenceMode });
const sandbox = staffModes("development", "sandbox", "synthetic");
add2("economic-sandbox", "development / sandbox / synthetic: provider sandboxes, no real money. Finance billingMode sandbox.", signContext(sandbox, FIXTURE_KEY, "fx0000000000000000000012"), ok2(sandbox, { financeAdapter: adapter(sandbox, "development", "sandbox", "sandbox") }), live2(1));
const none = staffModes("development", "none", "synthetic");
add2("economic-none", "development / none / synthetic: nothing is billable. Finance has no none, so it maps to billingMode simulated.", signContext(none, FIXTURE_KEY, "fx0000000000000000000012"), ok2(none, { financeAdapter: adapter(none, "development", "simulated", "sandbox") }), live2(1));
const paidTest = staffModes("preview", "paid_test", "fixture");
add2("economic-paid-test", "preview / paid_test / fixture: a test deploy that spent real money, backed by fixture evidence. paid_test maps to billingMode live, so it stays an actual expense whatever the environment name or the evidence says.", signContext(paidTest, FIXTURE_KEY, "fx0000000000000000000012"), ok2(paidTest, { financeAdapter: adapter(paidTest, "test", "live", "mocked") }), live2(1));
const liveCtx = staffModes("live", "live", "live");
add2("economic-live", "live / live / live: production. Shows the mapping only: this token is signed with the fixture key, so no live deployment would accept it.", signContext(liveCtx, FIXTURE_KEY, "fx0000000000000000000012"), ok2(liveCtx, { financeAdapter: adapter(liveCtx, "production", "live", "live") }), live2(1));

// Finance identifier bounds: kind-prefixed ids at, over and far over 128 characters. Valid /2 tokens either way; the adapter decides.
for (const [name, description, c, tooLong] of BOUNDARY) {
  const expect = tooLong
    ? { ok: true, role: c.role, tenant: c.tenant.id, project: c.project, financeAdapter: { ok: false, schema: FINANCE_SCOPE_ADAPTER, reason: "identifier_too_long", fields: tooLong } }
    : { ok: true, role: c.role, tenant: c.tenant.id, project: c.project, financeAdapter: { ok: true, schema: FINANCE_SCOPE_ADAPTER, scope: { tenantId: c.tenant.id, projectId: c.project.ref, environment: "development", billingMode: "sandbox", actorId: c.actor.id }, evidenceMode: "mocked" } };
  add2(name, description, signContext(c, FIXTURE_KEY, SID2), expect, live2(c.membershipRevision));
}

// Audience, current membership, revocation, version.
add2("wrong-audience", "A valid token minted for ticketstub.finance, checked by a verifier that is another host.", signContext(cap, FIXTURE_KEY, SID2), { ok: false, reason: "wrong_audience" }, live2(2), { audience: "some-other-host" });
add2("right-audience", "The same token checked by the host it names.", signContext(cap, FIXTURE_KEY, SID2), ok2(cap, { grants: grants([FIN.read], COMMANDS) }), live2(2), { audience: AUDIENCE });
add2("revoked-membership", "Signed correctly, but the session behind it was signed out or the account was deleted.", signContext(cap, FIXTURE_KEY, SID2), { ok: false, reason: "revoked" }, { membershipRevision: 2, sessionLive: false, projectMember: true });
add2("project-membership-removed", "The session is live, but the account no longer holds the selected project (the event has another captain, the stub is gone).", signContext(cap, FIXTURE_KEY, SID2), { ok: false, reason: "revoked" }, { membershipRevision: 2, sessionLive: true, projectMember: false });
add2("stale-revision", "Signed correctly, but membershipRevision has moved on (3 now, the token says 2): email changed, signed out everywhere, or staff status flipped.", signContext(cap, FIXTURE_KEY, SID2), { ok: false, reason: "stale" }, live2(3));

// Malformed shapes, signed with the fixture key: every one is `unknown` offline and from the server.
const malformed = malformedContexts().map(({ name, ctx: c }) => ({ name, verifyAt: iso(NOW), token: signContext(c, FIXTURE_KEY, null), expect: { ok: false, reason: "unknown" } }));

mkdirSync(join(here, "v2"), { recursive: true });
for (const [name, f] of Object.entries(out2)) writeFileSync(join(here, "v2", `${name}.json`), `${JSON.stringify(f, null, 2)}\n`);
writeFileSync(join(here, "v2", "malformed-shapes.json"), `${JSON.stringify({ description: "Validly signed contexts with one malformed field each. Every case must be refused as unknown, by verify.mjs and by POST /api/context/verify alike.", cases: malformed }, null, 2)}\n`);

mkdirSync(here, { recursive: true });
for (const [name, f] of Object.entries(out)) writeFileSync(join(here, `${name}.json`), `${JSON.stringify(f, null, 2)}\n`);
const keyFile = {
  warning: "FIXTURE ONLY. NEVER PRODUCTION. Public on purpose: it signs test tokens that carry mode fixture. Never set it as CONTEXT_SECRET.",
  kid: "fixture",
  alg: "HS256",
  key: FIXTURE_KEY,
};
writeFileSync(join(here, "fixture-key.json"), `${JSON.stringify(keyFile, null, 2)}\n`);
const index = {
  schema: CONTEXT_SCHEMA,
  key: "fixture-key.json",
  verifier: "verify.mjs",
  fixtures: Object.keys(out).map((n) => `${n}.json`),
  v2: { schema: "ticketstub.context/2", dir: "v2", fixtures: Object.keys(out2).map((n) => `v2/${n}.json`), malformed: "v2/malformed-shapes.json" },
};
writeFileSync(join(here, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
console.log(`wrote ${Object.keys(out).length} /1 fixtures and ${Object.keys(out2).length} /2 fixtures (+ ${malformed.length} malformed shapes) to ${here}`);
