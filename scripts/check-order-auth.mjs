// GT-07: the order authorization (issuer, verifier, atomic claim, lookup, dispatch-time revalidate) end to end against a running
// production server, plus the offline fixtures.
//   node scripts/check-order-auth.mjs <baseUrl>
// Fixture mode only. It needs the env the harness gives the server and this script alike: TICKETSTUB_DB (the throwaway database, for the
// append-only and uniqueness checks), ORDER_AUTH_SIGNING_KEYS (to mint an expired row), CONTEXT_SECRET (to show it never verifies an
// authorization) and ORDER_AUTH_CONSUMER_KEY, all random per run, never the published fixture keys.
// Two accounts (A and B), a guest, and a consumer that holds no cookie and signs its requests with the consumer key.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { CAPABILITY_VERSION, quoteIdFor } from "../src/customer/pages/capabilities.ts";
import { ORDER_AUTH_FAILURES, ORDER_AUTH_NOT_AUTHORIZED, actionIdOf, canonicalJson, commandHash, consumerSignature, signOrderAuthorization, verifyOrderAuthorization } from "../src/server/order-auth-token.ts";
import { ReferenceIssuer, fixtureNow, matchesOutcome, runFixture, runScenario } from "../fixtures/order-authorization/verify.mjs";

const BASE = (process.argv[2] ?? process.env.SMOKE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const DB = process.env.TICKETSTUB_DB ?? "./data/ticketstub.sqlite";
const CONSUMER_KEY = process.env.ORDER_AUTH_CONSUMER_KEY ?? "";
const CONTEXT_KEY = process.env.CONTEXT_SECRET ?? "";
const SIGNING_SET_RAW = process.env.ORDER_AUTH_SIGNING_KEYS ?? "";
/** The active entry of ORDER_AUTH_SIGNING_KEYS, as the server signs with it: { kid, key bytes }. */
const SERVER_SIGNER = (() => {
  try {
    const e = JSON.parse(SIGNING_SET_RAW).keys.find((k) => k.state === "active");
    return { kid: e.kid, key: Buffer.from(e.key, "base64url"), text: e.key };
  } catch {
    return { kid: "", key: Buffer.alloc(0), text: "" };
  }
})();
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "fixtures", "order-authorization");
const run = randomBytes(4).toString("hex");
const responses = [];
const cookies = [];
let failed = 0;
let passed = 0;

function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
}

const randIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

function client(label) {
  const jar = new Map();
  const api = async (method, path, body, opts = {}) => {
    const headers = { "x-real-ip": randIp(), ...(opts.origin === null ? {} : { origin: opts.origin ?? BASE }) };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (jar.size && !opts.noCookie) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(20000) });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const [k, v] = pair.split("=");
      if (/max-age=0/i.test(attrs.join(";")) || v === "") jar.delete(k.trim());
      else {
        jar.set(k.trim(), v);
        cookies.push(v);
      }
    }
    const text = await res.text();
    responses.push(text);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text, headers: res.headers };
  };
  const signIn = async (email) => {
    const r = await api("POST", "/api/auth/link", { email, returnTo: "/wall", reason: "save" });
    if (!r.json?.devLink) throw new Error(`${label}: no devLink (${r.status} ${r.text.slice(0, 100)})`);
    return api("POST", "/api/auth/confirm", { token: new URL(r.json.devLink).searchParams.get("token") });
  };
  return { api, signIn, label };
}

/** A consumer request: no cookie, no Origin, signed over method, path and the exact body text. */
async function cons(path, body, { key = CONSUMER_KEY, ts = Date.now(), signPath = path, text = JSON.stringify(body), signText = text, unsigned = false } = {}) {
  const headers = { "content-type": "application/json", "x-real-ip": randIp() };
  if (!unsigned) {
    headers["x-ticketstub-consumer-timestamp"] = String(ts);
    headers["x-ticketstub-consumer-signature"] = consumerSignature(key, ts, "POST", signPath, signText);
  }
  const res = await fetch(BASE + path, { method: "POST", headers, body: text, signal: AbortSignal.timeout(20000) });
  const t = await res.text();
  responses.push(t);
  let json;
  try {
    json = JSON.parse(t);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text: t };
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const uniquePng = () => `data:image/png;base64,${Buffer.concat([PNG, randomBytes(8)]).toString("base64")}`;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const now = () => new Date().toISOString();

const stub = (id, title, updatedAt, extra = {}) => ({
  id,
  createdAt: now(),
  event: { type: "concert", title, venue: "Harbour Hall", dateISO: "2026-11-02", facts: [{ id: "f1", label: "Opening song", value: "Lantern", source: "fixture", provenance: "simulated", confidence: 0.9, kept: true }] },
  versions: [
    { id: `${id}-v1`, edition: "classic", art: { kind: "image", src: uniquePng(), seed: 1, provenance: "simulated" }, createdAt: now() },
    { id: `${id}-v2`, parentId: `${id}-v1`, edition: "letterpress", art: { kind: "procedural", seed: 2, provenance: "simulated" }, createdAt: now() },
  ],
  currentVersionId: `${id}-v1`,
  personal: { titleFont: 0, titleColor: "#111111", foilTitle: false, hiddenFields: [], friends: [] },
  material: "print",
  finish: "matte",
  torn: true,
  wallAngle: 0,
  photos: [],
  updatedAt,
  ...extra,
});

const sync = (c, stubs) => c.api("POST", "/api/wall/sync", { stubs, deleted: [] });
const wallStub = (r, id) => r.json.stubs.find((s) => s.id === id);
const sameDenial = (a, b) => a.status === b.status && JSON.stringify(a.json) === JSON.stringify(b.json);
const approve = (c, stubId, extra = {}) => c.api("POST", "/api/approvals", { stubId, purpose: "print.compose", expectedVersionId: `${stubId}-v1`, ...extra });
const set = (terms, path, value) => {
  const c = structuredClone(terms);
  const ks = path.split(".");
  let o = c;
  for (const k of ks.slice(0, -1)) o = o[k];
  o[ks.at(-1)] = value;
  return c;
};
const expectOf = (rec, over = {}) => ({ tenant: rec.tenant.id, project: `stub:${rec.project.id}`, action: rec.action, provider: rec.provider, terms: rec.terms, ...over });

async function main() {
  // ---------------------------------------------------------------- fixtures, offline
  const keyFile = JSON.parse(readFileSync(join(FIXTURES, "fixture-key.json"), "utf8"));
  const fixtureKeys = { [keyFile.kid]: keyFile.key }; // fixture tokens carry kid "fixture"; a server refuses that kid
  const index = JSON.parse(readFileSync(join(FIXTURES, "index.json"), "utf8"));
  const content = JSON.parse(readFileSync(join(FIXTURES, "content.json"), "utf8"));
  const readme = existsSync(join(FIXTURES, "README.md")) ? readFileSync(join(FIXTURES, "README.md"), "utf8") : "";
  const onDisk = readdirSync(FIXTURES).filter((n) => n.endsWith(".json") && !["fixture-key.json", "index.json", "content.json"].includes(n));
  const scnDisk = readdirSync(join(FIXTURES, "scenarios")).filter((n) => n.endsWith(".json"));
  check("fixtures: the index lists every token fixture and every scenario file", index.fixtures.length === onDisk.length && index.fixtures.every((f) => onDisk.includes(f)) && index.scenarios.length === scnDisk.length && index.scenarios.every((f) => scnDisk.includes(f.replace("scenarios/", ""))));
  check("fixtures: the keys are marked fixture only and contain FIXTURE-ONLY", /fixture only|never production/i.test(keyFile.warning) && keyFile.key.includes("FIXTURE-ONLY") && keyFile.consumerKey.includes("FIXTURE-ONLY"));
  const fx = {};
  const bad = [];
  for (const f of onDisk) {
    const x = JSON.parse(readFileSync(join(FIXTURES, f), "utf8"));
    fx[x.fixture] = x;
    const a = verifyOrderAuthorization(x.token, fixtureKeys, x.expect, fixtureNow(x), x.state, x.intent); // the code the server runs
    const b = runFixture(x, fixtureKeys); // the reference verifier a consumer copies
    if (!matchesOutcome(a, x.outcome) || !matchesOutcome(b, x.outcome)) bad.push(x.fixture);
  }
  check("fixtures: the server verifier and the reference verifier give each token fixture its expected outcome", bad.length === 0, bad.join());
  const seen = new Set(Object.values(fx).map((x) => (x.outcome.ok ? "ok" : x.outcome.reason)));
  const fromScenarios = new Set(["idempotency_conflict"]);
  check("fixtures: the token outcomes cover ok and every reason (idempotency_conflict is a scenario)", seen.has("ok") && ORDER_AUTH_FAILURES.every((r) => seen.has(r) || fromScenarios.has(r)), ORDER_AUTH_FAILURES.filter((r) => !seen.has(r)).join());
  const required = ["valid-submit", "valid-claim", "valid-claim-replay-same-key", "valid-revalidate", "unknown-approval-token", "wrong-scope-tenant", "wrong-scope-project", "changed-terms-amount", "changed-terms-destination", "changed-terms-art", "expired", "revoked", "stale-approval-revoked", "already-claimed-other-key", "revalidate-revoked-after-claim", "revalidate-approval-revoked-after-claim"];
  check("fixtures: every required case is published", required.every((n) => fx[n]));
  const refIssues = [];
  let refCount = 0;
  const scenarios = {};
  for (const f of index.scenarios) {
    const scn = JSON.parse(readFileSync(join(FIXTURES, f), "utf8"));
    scenarios[scn.scenario] = scn;
    if (!scn.drivers.includes("reference")) continue;
    refCount++;
    const issuer = new ReferenceIssuer({ key: keyFile.key, baseTerms: content.terms, tenant: content.tenant, project: content.project, scenario: scn.scenario });
    refIssues.push(...(await runScenario(issuer, scn)));
  }
  check(`fixtures: all ${refCount} reference scenarios pass on the reference issuer`, refIssues.length === 0, refIssues.join(" | "));
  const wantScenarios = ["first-claim-wins-and-replays", "replay-under-distinct-key", "concurrent-claim-distinct-keys", "concurrent-claim-same-key", "claim-committed-response-lost", "unknown-claim-lookup-reconciliation", "same-key-different-authorization", "revoke-after-claim-before-dispatch", "approval-revoked-after-claim", "art-changed-after-claim", "changed-terms-after-claim", "expires-after-claim-before-dispatch"];
  check("fixtures: the protocol scenarios the request names are published", wantScenarios.every((n) => scenarios[n]));
  check("fixtures: the signed approval fixture token is rejected here, so an approval is never an authorization", fx["unknown-approval-token"].outcome.reason === "unknown" && JSON.parse(readFileSync(join(ROOT, "fixtures", "approval", "valid-print-compose.json"), "utf8")).token === fx["unknown-approval-token"].token);
  check("fixtures: the README names every reason and every scenario and says fixture only", ORDER_AUTH_FAILURES.every((r) => readme.includes(r)) && Object.keys(scenarios).every((s) => readme.includes(s)) && /FIXTURE ONLY/.test(readme) && /Unsupported/i.test(readme));
  const allText = [...onDisk.map((f) => join(FIXTURES, f)), ...index.scenarios.map((f) => join(FIXTURES, f)), join(FIXTURES, "content.json")].map((p) => readFileSync(p, "utf8")).join("\n");
  check("fixtures: reference ids and digests only (no email, street, phone, name or art data)", !/@|street|avenue|postcode|zip code|\+\d{6,}|data:image|"(email|phone|name|street|line1|city|postcode)"/i.test(allText));
  const rec0 = JSON.parse(Buffer.from(fx["valid-submit"].token.split(".")[1], "base64url").toString()).authorization;
  check("fixtures: the record is mode fixture, bound to a destination reference and digest, and says what it never authorizes", rec0.mode === "fixture" && /^dst_/.test(rec0.terms.destination.ref) && /^[a-f0-9]{64}$/.test(rec0.terms.destination.digest) && ["payment", "refund", "other_orders", "destination_change", "asset_rights"].every((x) => rec0.notAuthorizes.includes(x)));
  check("fixtures: the command hash in content.json is the one the record carries", content.commandHash === rec0.command.hash && commandHash("fulfillment.submit", "sandbox", content.terms) === rec0.command.hash);

  // static guarantees that cannot be exercised against a server that has the key set
  const srcOf = (f) => (existsSync(join(ROOT, f)) ? readFileSync(join(ROOT, f), "utf8") : "");
  const oa = srcOf("src/server/order-authorization.ts");
  check("static: the consumer port is off (503 consumer_unavailable) whenever no usable key is set, in every mode", /consumer_unavailable/.test(oa) && /FIXTURE-ONLY/.test(oa) && /!k \|\| k\.length < 32/.test(oa) && !/isLiveRuntime/.test(oa));
  check("static: the consumer key is never CONTEXT_SECRET and never the published fixture key", /k === ctx/.test(oa) && !oa.includes(keyFile.consumerKey));
  check("separate: no order, checkout, commerce or approval code reads an order authorization", !/order-auth|OrderAuth|order_auth/.test(srcOf("src/app/api/orders/route.ts") + srcOf("src/customer/pages/commerce.ts") + srcOf("src/server/approval.ts") + srcOf("src/server/approval-token.ts")));
  check("separate: the order authorization never infers anything from an approval's purposes (it names print.compose and checks the approval's current state)", /purpose !== "print\.compose"/.test(oa));

  // ---------------------------------------------------------------- the live server
  check("setup: this script holds a consumer key, an order-authorization key set and a context secret, none of them a published fixture key and no two alike", CONSUMER_KEY.length >= 32 && !CONSUMER_KEY.includes("FIXTURE-ONLY") && SERVER_SIGNER.key.length >= 32 && /^order-auth-/.test(SERVER_SIGNER.kid) && CONTEXT_KEY.length >= 32 && new Set([CONSUMER_KEY, CONTEXT_KEY, SERVER_SIGNER.key.toString("latin1")]).size === 3);
  check("static: order authorizations sign with ORDER_AUTH_SIGNING_KEYS, never CONTEXT_SECRET", /requireOrderAuthKeyring\(\)/.test(oa) && /orderAuthKeyring\(\)/.test(oa) && !/tokenSigningKey|CONTEXT_SECRET\b.*sign/.test(oa) && !/export function (tokenSigningKey|signingMode)/.test(srcOf("src/server/context.ts")));
  const A = client("A");
  const B = client("B");
  const emailA = `orderauth-a-${run}@example.com`;
  const emailB = `orderauth-b-${run}@example.com`;
  await A.signIn(emailA);
  await B.signIn(emailB);
  const ctxA = (await A.api("GET", "/api/context")).json.context;
  const ctxB = (await B.api("GET", "/api/context")).json.context;
  const t = Date.now();
  let n = 0;
  /** A fresh stub on A's wall with a stored image, approved for print.compose. */
  const fresh = async (owner = A, extra = {}) => {
    const id = `oa-${run}-${++n}`;
    const wall = await sync(owner, [stub(id, "Order auth smoke", t + n, extra)]);
    const s = wallStub(wall, id);
    const ap = await approve(owner, id);
    return { id, stub: s, approval: ap.json?.approval, approvalToken: ap.json?.token, ap };
  };
  const S = await fresh();
  const SB = await fresh(B);
  check("setup: A's stub is on the wall and approved for print.compose", S.ap.status === 200 && S.approval?.purpose === "print.compose");
  const artName = /^\/api\/files\/([a-f0-9]{64}\.png)$/.exec(S.stub.versions[0].art.src)?.[1];
  const bytes = Buffer.from(await (await fetch(`${BASE}/api/files/${artName}`)).arrayBuffer());
  const artHash = sha(bytes);
  const body = (s, over = {}) => ({
    stubId: s.id,
    approvalId: s.approval.id,
    expectedVersionId: `${s.id}-v1`,
    orderRef: `ord_${run}_${s.id}`,
    quantity: 1,
    provider: "sandbox",
    quote: { id: quoteIdFor("print", "matte", "classic", 1), amountMinor: 5500, currency: "USD" },
    destination: { ref: `dst_${run}_a`, digest: sha(`destination-${run}`) },
    idempotencyKey: `issue_${run}_${s.id}`,
    confirm: true,
    ...over,
  });
  const issue = (c, b, opts) => c.api("POST", "/api/order-authorizations", b, opts);
  const list = (c, id) => c.api("GET", `/api/order-authorizations?project=stub:${id}`);

  // --- guards
  const anon = client("anon");
  check("guard: anonymous issue is 404 (a project it can't see)", (await issue(anon, body(S))).status === 404);
  check("guard: a guest who owns a stub is 401 (sign in), never an authorization", await (async () => {
    const g = client("g2");
    const gid = `oa-g-${run}`;
    const sh = await g.api("POST", "/api/share", { stub: stub(gid, "Guest stub", t) });
    const r = await issue(g, body({ id: gid, approval: { id: "apr_x" } }));
    return sh.status === 200 && r.status === 401 && r.json.error.code === "unauthorized";
  })());
  check("guard: issue without an Origin is 403 bad_origin", (await issue(A, body(S), { origin: null })).json?.error?.code === "bad_origin");
  check("guard: issue from a foreign Origin is 403 bad_origin", (await issue(A, body(S), { origin: "https://evil.example" })).json?.error?.code === "bad_origin");
  check("guard: revoke without an Origin is 403", (await A.api("POST", "/api/order-authorizations/revoke", { stubId: S.id, authorizationId: "x" }, { origin: null })).status === 403);
  check("guard: no explicit confirmation is 400 (confirm must be the literal true)", (await issue(A, { ...body(S), confirm: undefined })).status === 400 && (await issue(A, body(S, { confirm: "yes" }))).status === 400 && (await issue(A, body(S, { confirm: false }))).status === 400);
  check("guard: a destination that is an address, an email or not a reference is 400", (await issue(A, body(S, { destination: { ref: "12 Main Street", digest: sha("x") } }))).status === 400 && (await issue(A, body(S, { destination: { ref: "someone@example.com", digest: sha("x") } }))).status === 400 && (await issue(A, body(S, { destination: { ref: `dst_${run}_a`, digest: "nothex" } }))).status === 400 && (await issue(A, body(S, { destination: { ref: `dst_${run}_a` } }))).status === 400);
  check("guard: a bad provider, quantity, amount, key or order reference is 400", (await issue(A, body(S, { provider: "dhl" }))).status === 400 && (await issue(A, body(S, { quantity: 0 }))).status === 400 && (await issue(A, body(S, { quote: { id: "q", amountMinor: 0, currency: "USD" } }))).status === 400 && (await issue(A, body(S, { idempotencyKey: "short" }))).status === 400 && (await issue(A, body(S, { orderRef: "no spaces allowed here" }))).status === 400);
  check("guard: prodigi is 422 variant_not_orderable (no confirmed SKU, and not a live server)", await (async () => {
    const r = await issue(A, body(S, { provider: "prodigi", idempotencyKey: `issue_${run}_prodigi` }));
    return r.status === 422 && r.json.error.code === "variant_not_orderable";
  })());
  const holo = await fresh(A, { finish: "holo" });
  check("guard: a physical holo stub (unavailable, never printed) is 422 variant_not_orderable", await (async () => {
    const r = await issue(A, body(holo));
    return holo.ap.status === 200 && r.status === 422 && r.json.error.code === "variant_not_orderable";
  })());
  check("guard: a quote for another choice is 409 authorization_conflict", (await issue(A, body(S, { quote: { id: quoteIdFor("print", "matte", "classic", 2), amountMinor: 5500, currency: "USD" }, idempotencyKey: `issue_${run}_q` }))).json?.error?.code === "authorization_conflict");
  check("guard: a currency other than USD is 409 authorization_conflict", (await issue(A, body(S, { quote: { id: quoteIdFor("print", "matte", "classic", 1), amountMinor: 5500, currency: "EUR" }, idempotencyKey: `issue_${run}_c` }))).json?.error?.code === "authorization_conflict");
  check("guard: a version the owner was not looking at is 409 authorization_conflict", (await issue(A, body(S, { expectedVersionId: `${S.id}-v2`, idempotencyKey: `issue_${run}_v` }))).json?.error?.code === "authorization_conflict");
  const dl = await approve(A, S.id, { purpose: "artifact.download" });
  const noApproval = await issue(A, body(S, { approvalId: `apr_nope${run}`, idempotencyKey: `issue_${run}_n1` }));
  const foreignApproval = await issue(A, body(S, { approvalId: SB.approval.id, idempotencyKey: `issue_${run}_n2` }));
  check("guard: an artifact.download approval is not a print approval (409 approval_invalid)", (await issue(A, body(S, { approvalId: dl.json.approval.id, idempotencyKey: `issue_${run}_dl` }))).json?.error?.code === "approval_invalid");
  check("guard: a missing approval and B's approval id are the same 409 approval_invalid", noApproval.status === 409 && noApproval.json.error.code === "approval_invalid" && sameDenial(noApproval, foreignApproval));
  const none = await list(A, S.id);
  check("guard: none of the refused attempts left a record", none.status === 200 && none.json.authorizations.length === 0, none.text.slice(0, 120));

  // --- issue
  const i1 = await issue(A, body(S));
  const au1 = i1.json?.authorization;
  check("issue: the owner gets a ticketstub.order-authorization/1 record, status active, created, with a token", i1.status === 200 && au1?.schema === "ticketstub.order-authorization/1" && i1.json.status === "active" && i1.json.created === true && typeof i1.json.token === "string", i1.text.slice(0, 240));
  check("issue: it binds tenant, project, actor, action, provider and audience", au1.tenant.id === ctxA.tenant.id && au1.project.id === S.id && au1.actor.id === ctxA.tenant.id && au1.action === "fulfillment.submit" && au1.provider === "sandbox" && au1.audience === "fulfillment-connectors" && au1.issuer === "ticketstub");
  check("issue: it binds SKU (null: none confirmed), options, quote, amount, currency, destination reference and orderRef", au1.terms.sku === null && au1.terms.options.variantId === "print.classic.matte" && au1.terms.options.quantity === 1 && au1.terms.quote.id === quoteIdFor("print", "matte", "classic", 1) && au1.terms.quote.amountMinor === 5500 && au1.terms.quote.currency === "USD" && au1.terms.destination.ref === `dst_${run}_a` && au1.terms.orderRef === `ord_${run}_${S.id}`);
  check("issue: it references the approval id and copies its binding hashes (art is the SHA-256 of the stored bytes)", au1.approval.id === S.approval.id && au1.approval.purpose === "print.compose" && au1.terms.approvalId === S.approval.id && au1.terms.design.versionId === `${S.id}-v1` && au1.terms.design.artHash === artHash && ["designHash", "artHash", "factsHash", "compositionHash"].every((k) => au1.terms.design[k] === S.approval.binding[k]));
  check("issue: capability version, membership revision, idempotency key and the command hash are in the record", au1.terms.capabilityVersion === CAPABILITY_VERSION && au1.membershipRevision === ctxA.membershipRevision && au1.idempotencyKey === `issue_${run}_${S.id}` && au1.command.hash === commandHash(au1.action, au1.provider, au1.terms) && /^act_[a-f0-9]{32}$/.test(au1.actionId));
  check("issue: fifteen minutes, mode sandbox, and what it never authorizes", Date.parse(au1.expiresAt) - Date.parse(au1.issuedAt) === 15 * 60_000 && au1.mode === "sandbox" && ORDER_AUTH_NOT_AUTHORIZED.every((x) => au1.notAuthorizes.includes(x)));
  check("issue: the token header names the active ORDER_AUTH_SIGNING_KEYS kid and canonical signing time", (() => {
    const h = JSON.parse(Buffer.from(i1.json.token.split(".")[0], "base64url").toString());
    const signedAt = typeof h.signedAt === "string" ? Date.parse(h.signedAt) : NaN;
    return Object.keys(h).sort().join() === "alg,kid,signedAt,typ" && h.alg === "HS256" && h.typ === "ticketstub.order-authorization" && h.kid === SERVER_SIGNER.kid
      && Number.isFinite(signedAt) && signedAt > 0 && new Date(signedAt).toISOString() === h.signedAt;
  })());
  check("issue: no address, phone or email anywhere in the record", !/@|street/i.test(JSON.stringify(au1)) && !/"(address|email|phone|street|line1|postcode|guestName)"/i.test(JSON.stringify(au1)));
  const again = await issue(A, body(S));
  check("issue: the same request and key preserves the whole authorization and token payload, created false", again.status === 200 && isDeepStrictEqual(again.json.authorization, au1) && again.json.created === false && again.json.token.split(".")[1] === i1.json.token.split(".")[1]);
  const reuse = await issue(A, body(S, { quote: { id: quoteIdFor("print", "matte", "classic", 1), amountMinor: 9900, currency: "USD" } }));
  check("issue: the same key with a different amount is 409 authorization_conflict, nothing issued", reuse.status === 409 && reuse.json.error.code === "authorization_conflict" && (await list(A, S.id)).json.authorizations.length === 1);
  const forgedBody = await issue(A, { ...body(S), tenant: "acc_other", terms: { quote: { amountMinor: 1 } }, status: "claimed", expiresAt: "2099-01-01T00:00:00Z", sku: "FAKE", provider: "sandbox" });
  check("issue: tenant, terms, status, expiry and SKU in the body change nothing (the server builds the record)", forgedBody.status === 200 && forgedBody.json.authorization.id === au1.id && forgedBody.json.authorization.terms.sku === null);
  const ls = await list(A, S.id);
  check("issue/list: the owner sees the unchanged whole record and token payload with status active", ls.status === 200 && ls.json.authorizations.length === 1 && ls.json.authorizations[0].status === "active" && isDeepStrictEqual(ls.json.authorizations[0].authorization, au1) && ls.json.authorizations[0].token.split(".")[1] === i1.json.token.split(".")[1]);
  check("list: ?project must name a stub, anything else is 404", (await list(A, "")).status === 404 && (await A.api("GET", "/api/order-authorizations")).status === 404 && (await A.api("GET", `/api/order-authorizations?project=event:${S.id}`)).status === 404);

  // --- A versus B
  const bIssue = await issue(B, body(S, { idempotencyKey: `issue_${run}_b1` }));
  const bMissing = await issue(B, body({ id: `oa-nothing-${run}`, approval: S.approval }, { idempotencyKey: `issue_${run}_b2` }));
  check("A vs B: B issuing on A's stub is 404, identical to a stub that does not exist", bIssue.status === 404 && sameDenial(bIssue, bMissing), bIssue.text);
  check("A vs B: B listing A's authorizations is 404, identical to a missing project", (await list(B, S.id)).status === 404 && sameDenial(await list(B, S.id), await list(B, `oa-nothing-${run}`)));
  const bRevoke = await B.api("POST", "/api/order-authorizations/revoke", { stubId: S.id, authorizationId: au1.id });
  check("A vs B: B revoking A's authorization is 404, identical to a missing id, and changes nothing", bRevoke.status === 404 && sameDenial(bRevoke, await B.api("POST", "/api/order-authorizations/revoke", { stubId: S.id, authorizationId: `oau_nope${run}` })) && (await list(A, S.id)).json.authorizations[0].status === "active");
  check("A vs B: B naming its own stub with A's authorization id is 404 too", (await B.api("POST", "/api/order-authorizations/revoke", { stubId: SB.id, authorizationId: au1.id })).status === 404);
  const bOwn = await issue(B, body(SB, { idempotencyKey: `issue_${run}_bown` }));
  check("A vs B: B authorizes B's own stub, and the record is B's tenant", bOwn.status === 200 && bOwn.json.authorization.tenant.id === ctxB.tenant.id && bOwn.json.authorization.tenant.id !== au1.tenant.id);
  check("A vs B: the same idempotency key on two tenants does not collide", (await issue(B, body(SB, { idempotencyKey: `issue_${run}_${S.id}`, orderRef: `ord_${run}_other` }))).status === 200);

  // --- consumer authentication
  const V = "/api/order-authorizations/verify";
  const verify = (token, expect, opts) => cons(V, { token, expect }, opts);
  const want = expectOf(au1);
  check("consumer: no signature is 401 consumer_unauthorized", (await verify(i1.json.token, want, { unsigned: true })).json?.error?.code === "consumer_unauthorized");
  check("consumer: the published fixture consumer key is 401, never accepted", (await verify(i1.json.token, want, { key: keyFile.consumerKey })).status === 401);
  check("consumer: a wrong key, a stale timestamp, a future timestamp are 401", (await verify(i1.json.token, want, { key: `${CONSUMER_KEY}x` })).status === 401 && (await verify(i1.json.token, want, { ts: Date.now() - 10 * 60_000 })).status === 401 && (await verify(i1.json.token, want, { ts: Date.now() + 10 * 60_000 })).status === 401);
  const goodText = JSON.stringify({ token: i1.json.token, expect: want });
  check("consumer: a body altered after signing, and a signature made for another path, are 401", (await cons(V, null, { text: goodText.replace("5500", "1"), signText: goodText })).status === 401 && (await verify(i1.json.token, want, { signPath: "/api/order-authorizations/claim" })).status === 401);
  check("consumer: a customer cookie and Origin are not credentials (A, signed in, gets 401 on the consumer port)", (await A.api("POST", V, { token: i1.json.token, expect: want })).status === 401);
  check("consumer: the same signed request is accepted (control)", (await verify(i1.json.token, want)).status === 200);

  // --- verify (read only)
  const ok1 = await verify(i1.json.token, want);
  check("verify: the exact scope and terms verify, with the record back", ok1.status === 200 && ok1.json.ok === true && ok1.json.authorization.id === au1.id && Date.parse(ok1.json.checkedAt) > 0, ok1.text.slice(0, 160));
  const renewed = await Promise.all([again.json.token, ls.json.authorizations[0].token].map((token) => verify(token, want)));
  check("verify: original, retried and listed tokens authenticate the unchanged whole authorization", ok1.json.ok === true && isDeepStrictEqual(ok1.json.authorization, au1) && renewed.every((r) => r.status === 200 && r.json.ok === true && isDeepStrictEqual(r.json.authorization, au1)));
  const [timeHead, timePayload, timeSignature] = i1.json.token.split(".");
  const changedTime = { ...JSON.parse(Buffer.from(timeHead, "base64url").toString()), signedAt: new Date(Date.parse(au1.issuedAt) - 1).toISOString() };
  check("verify: changing only signedAt without signing is forged", (await verify(`${Buffer.from(JSON.stringify(changedTime)).toString("base64url")}.${timePayload}.${timeSignature}`, want)).json?.reason === "forged");
  const reasonOf = (r) => r.json?.reason;
  const changed = async (path, value) => {
    const r = await verify(i1.json.token, expectOf(au1, { terms: set(au1.terms, path, value) }));
    return reasonOf(r) === "changed_terms" && r.status === 403 && r.json.fields.includes(path);
  };
  check("verify: wrong tenant, project, provider and action are wrong_scope", reasonOf(await verify(i1.json.token, expectOf(au1, { tenant: ctxB.tenant.id }))) === "wrong_scope" && reasonOf(await verify(i1.json.token, expectOf(au1, { project: `stub:${SB.id}` }))) === "wrong_scope" && reasonOf(await verify(i1.json.token, expectOf(au1, { provider: "prodigi" }))) === "wrong_scope" && reasonOf(await verify(i1.json.token, expectOf(au1, { action: "fulfillment.cancel" }))) === "wrong_scope");
  check("verify: B's authorization presented for A's stub is wrong_scope", reasonOf(await verify(bOwn.json.token, want)) === "wrong_scope");
  const changes = [["quote.amountMinor", 5501], ["quote.currency", "EUR"], ["quote.id", "qt_other"], ["options.quantity", 2], ["options.finish", "foil"], ["sku", "SKU-OTHER-0001"], ["destination.ref", `dst_${run}_b`], ["destination.digest", sha("another")], ["design.artHash", sha("another art")], ["design.versionId", "v_other"], ["approvalId", "apr_other"], ["orderRef", `ord_${run}_other`], ["capabilityVersion", "2026-01-01.1"]];
  const results = [];
  for (const [p, v] of changes) results.push([p, await changed(p, v)]);
  check("verify: every bound term (amount, currency, quote, quantity, finish, SKU, destination, digest, art, version, approval, order, capability version) changed is changed_terms naming the field", results.every(([, ok]) => ok), results.filter(([, ok]) => !ok).map(([p]) => p).join());
  const [h, p, s] = i1.json.token.split(".");
  const flip = (x) => x.slice(0, -2) + (x.slice(-2) === "AA" ? "BB" : "AA");
  check("verify: a flipped signature is forged", reasonOf(await verify(`${h}.${p}.${flip(s)}`, want)) === "forged");
  const edited = JSON.parse(Buffer.from(p, "base64url").toString());
  edited.authorization.terms.quote.amountMinor = 99999;
  check("verify: an edited payload (a raised amount) is forged", reasonOf(await verify(`${h}.${Buffer.from(JSON.stringify(edited)).toString("base64url")}.${s}`, want)) === "forged");
  check("verify: the published fixture token is forged on this server (the fixture key is never accepted)", reasonOf(await verify(fx["valid-submit"].token, { tenant: "acc_FIXTURE_owner1", project: "stub:stub_fx_1", action: "fulfillment.submit", provider: "sandbox", terms: content.terms })) === "forged");
  check("verify: garbage, an approval token and a context token are unknown", reasonOf(await verify("nope", want)) === "unknown" && reasonOf(await verify(S.approvalToken, want)) === "unknown" && reasonOf(await verify((await A.api("GET", "/api/context")).json.token, want)) === "unknown");
  check("verify: a context token cannot pass as an authorization, and an authorization is not a context token", (await consumer_context(i1.json.token)).json?.ok !== true);
  check("verify: it refuses a request that names no tenant, project, action, provider or full terms (400)", (await verify(i1.json.token, { ...want, tenant: undefined })).status === 400 && (await verify(i1.json.token, { ...want, project: undefined })).status === 400 && (await verify(i1.json.token, { ...want, terms: undefined })).status === 400 && (await verify(i1.json.token, { ...want, terms: { orderRef: au1.terms.orderRef } })).status === 400 && (await verify(i1.json.token, { ...want, terms: { ...au1.terms, design: { ...au1.terms.design, artHash: "nothex" } } })).status === 400 && (await cons(V, {})).status === 400);
  check("verify: a rejection is 403 with ok false, a reason from the list and the one error envelope", await (async () => {
    const r = await verify(i1.json.token, expectOf(au1, { tenant: ctxB.tenant.id }));
    return r.status === 403 && r.json.ok === false && ORDER_AUTH_FAILURES.includes(r.json.reason) && r.json.error.code === "authorization_invalid" && typeof r.json.error.message === "string";
  })());
  check("verify: it is read only (two verifies, still claimable)", (await verify(i1.json.token, want)).json?.ok === true && (await verify(i1.json.token, want)).json?.ok === true && (await list(A, S.id)).json.authorizations[0].status === "active");

  // --- claim, replay, lookup, revalidate (direct), then the same protocol from the shared scenario files
  const C = "/api/order-authorizations/claim";
  const claim = (token, expect, key, opts) => cons(C, { token, expect, idempotencyKey: key }, opts);
  const k1 = `claim_${run}_k1`;
  check("claim: unsigned, and a request with a bad key (idempotencyKey too short), are refused before anything is claimed", (await claim(i1.json.token, want, k1, { unsigned: true })).status === 401 && (await claim(i1.json.token, want, "short")).status === 400);
  check("claim: terms that differ are changed_terms and nothing is committed", await (async () => {
    const r = await claim(i1.json.token, expectOf(au1, { terms: set(au1.terms, "quote.amountMinor", 6000) }), `claim_${run}_ct`);
    return r.status === 403 && r.json.reason === "changed_terms" && (await list(A, S.id)).json.authorizations[0].status === "active";
  })());
  const c1 = await claim(i1.json.token, want, k1);
  check("claim: the first claim wins and answers the connector's shape (claimed, authorizationId, actionId, claimReference)", c1.status === 200 && c1.json.ok === true && c1.json.status === "claimed" && c1.json.replayed === false && c1.json.authorizationId === au1.id && c1.json.actionId === au1.actionId && /^clm_/.test(c1.json.claimReference) && Date.parse(c1.json.claimedAt) > 0, c1.text.slice(0, 200));
  const c1b = await claim(i1.json.token, want, k1);
  check("claim: the same key again returns the same claim (replayed true), not a second one", c1b.status === 200 && c1b.json.replayed === true && c1b.json.claimReference === c1.json.claimReference && c1b.json.claimedAt === c1.json.claimedAt);
  const c1c = await claim(i1.json.token, want, `claim_${run}_k2`);
  check("claim: a different key after the claim is 409 already_claimed", c1c.status === 409 && c1c.json.reason === "already_claimed" && c1c.json.status === "rejected" && c1c.json.error.code === "authorization_invalid");
  check("claim: verify now says already_claimed (409), and the list says claimed", (await verify(i1.json.token, want)).status === 409 && reasonOf(await verify(i1.json.token, want)) === "already_claimed" && (await list(A, S.id)).json.authorizations[0].status === "claimed");
  check("claim: an authorization that is B's cannot be claimed with A's scope (wrong_scope), and B's own is still claimable", reasonOf(await claim(bOwn.json.token, want, `claim_${run}_kb`)) === "wrong_scope" && (await verify(bOwn.json.token, expectOf(bOwn.json.authorization))).json?.ok === true);
  const L = "/api/order-authorizations/claims/lookup";
  const lookup = (key, over = {}, opts) => cons(L, { tenant: ctxA.tenant.id, project: `stub:${S.id}`, idempotencyKey: key, ...over }, opts);
  const lk = await lookup(k1);
  check("lookup: the committed claim is found with its reference and authority ok", lk.status === 200 && lk.json.found === true && lk.json.claim.claimReference === c1.json.claimReference && lk.json.authority.ok === true, lk.text.slice(0, 200));
  const lu = await lookup(`claim_${run}_never`);
  check("lookup: a key that never committed is found false", lu.status === 200 && lu.json.found === false);
  check("lookup: another tenant's, another project's and an unsigned lookup of a real key are indistinguishable from a key never used", sameBody(await lookup(k1, { tenant: ctxB.tenant.id }), lu) && sameBody(await lookup(k1, { project: `stub:${SB.id}` }), lu) && (await lookup(k1, {}, { unsigned: true })).status === 401);
  const lo = await lookup(`claim_${run}_k2`, { authorizationId: au1.id });
  check("lookup: a claim under another key shows as authorizationClaimed true, with found false", lo.json.found === false && lo.json.authorizationClaimed === true);
  const R = "/api/order-authorizations/revalidate";
  const reval = (token, expect, opts) => cons(R, { token, expect }, opts);
  check("revalidate: with the committed claim reference it is dispatchable", await (async () => {
    const r = await reval(i1.json.token, expectOf(au1, { claimReference: c1.json.claimReference }));
    return r.status === 200 && r.json.ok === true && r.json.status === "dispatchable";
  })());
  check("revalidate: a claim reference that is not the committed one is not_claimed", reasonOf(await reval(i1.json.token, expectOf(au1, { claimReference: "clm_madeup0000" }))) === "not_claimed");
  check("revalidate: a missing claimReference is 400", (await reval(i1.json.token, want)).status === 400);
  check("revalidate: changed terms at dispatch are changed_terms naming the field", await (async () => {
    const r = await reval(i1.json.token, expectOf(au1, { claimReference: c1.json.claimReference, terms: set(au1.terms, "options.quantity", 3) }));
    return r.status === 403 && r.json.reason === "changed_terms" && r.json.fields.includes("options.quantity");
  })());

  // --- concurrency, against the database
  const db = new DatabaseSync(DB);
  const claimsFor = (id) => Number(db.prepare("SELECT COUNT(*) AS n FROM order_authorization_claims WHERE authorization_id = ?").get(id).n);
  const issueFresh = async (label) => {
    const s = await fresh();
    const r = await issue(A, body(s, { idempotencyKey: `issue_${run}_${label}`, orderRef: `ord_${run}_${label}` }));
    return { s, r, rec: r.json.authorization, token: r.json.token };
  };
  const raceA = await issueFresh("race-a");
  const keys = Array.from({ length: 12 }, (_, i) => `claim_${run}_ra${i}`);
  const raced = await Promise.all(keys.map((k) => claim(raceA.token, expectOf(raceA.rec), k)));
  const winners = raced.filter((r) => r.status === 200);
  check("concurrent: twelve parallel claims under twelve keys, exactly one wins", winners.length === 1 && raced.filter((r) => r.status === 409 && r.json.reason === "already_claimed").length === 11, raced.map((r) => r.status).join());
  check("concurrent: the database holds exactly one claim for it, and the winner's key is the one it records", claimsFor(raceA.rec.id) === 1 && db.prepare("SELECT idem_key FROM order_authorization_claims WHERE authorization_id = ?").get(raceA.rec.id).idem_key === keys[raced.indexOf(winners[0])]);
  const raceB = await issueFresh("race-b");
  const sameKey = `claim_${run}_same`;
  const racedSame = await Promise.all(Array.from({ length: 12 }, () => claim(raceB.token, expectOf(raceB.rec), sameKey)));
  check("concurrent: twelve parallel claims under one key all answer ok with the same claim, and exactly one committed it", racedSame.every((r) => r.status === 200) && new Set(racedSame.map((r) => r.json.claimReference)).size === 1 && racedSame.filter((r) => r.json.replayed === false).length === 1 && claimsFor(raceB.rec.id) === 1);
  const raceC = await issueFresh("race-c");
  const raceD = await issueFresh("race-d");
  const mixed = await Promise.all([claim(raceC.token, expectOf(raceC.rec), `claim_${run}_mx`), claim(raceD.token, expectOf(raceD.rec), `claim_${run}_mx`)]);
  check("concurrent: one key racing two authorizations commits one and refuses the other as idempotency_conflict", mixed.filter((r) => r.status === 200).length === 1 && mixed.filter((r) => r.json.reason === "idempotency_conflict").length === 1, mixed.map((r) => `${r.status}:${r.json?.reason}`).join());
  const raceRenew = await issueFresh("race-e");
  const renew = await issue(A, body(raceRenew.s, { idempotencyKey: `issue_${run}_race-e2`, orderRef: `ord_${run}_race-e` }));
  const stalePair = await Promise.all([claim(raceRenew.token, expectOf(raceRenew.rec), `claim_${run}_re1`), claim(renew.json.token, expectOf(renew.json.authorization), `claim_${run}_re2`)]);
  check("concurrent: an order renewed while its first authorization is raced commits only the newest (the older reads stale)", renew.status === 200 && stalePair[0].json.reason === "stale" && stalePair[1].status === 200, stalePair.map((r) => `${r.status}:${r.json?.reason}`).join());
  const dupe = (() => {
    try {
      db.prepare("INSERT INTO order_authorization_claims (authorization_id, action_id, tenant, consumer, idem_key, claim_ref, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(raceA.rec.id, raceA.rec.actionId, raceA.rec.tenant.id, "fulfillment-connectors", `claim_${run}_dupe`, `clm_dupe_${run}`, 1);
      return "inserted";
    } catch (e) {
      return String(e.message);
    }
  })();
  const dupeAction = (() => {
    try {
      db.prepare("INSERT INTO order_authorization_claims (authorization_id, action_id, tenant, consumer, idem_key, claim_ref, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(raceD.rec.id, raceA.rec.actionId, raceA.rec.tenant.id, "fulfillment-connectors", `claim_${run}_dupe2`, `clm_dupe2_${run}`, 1);
      return "inserted";
    } catch (e) {
      return String(e.message);
    }
  })();
  check("concurrent: the database refuses a second claim for one authorization, and for one action, even if the code did not", /UNIQUE/.test(dupe) && /UNIQUE/.test(dupeAction), `${dupe} | ${dupeAction}`);

  // --- the shared scenarios, driven against this server
  const liveDriver = (scn) => {
    let ctx;
    const auths = {};
    const setup = async () => (ctx ??= await fresh());
    const rec = (label) => auths[label].rec;
    const driver = {
      async issue(label, { orderOf } = {}) {
        const c = await setup();
        const orderRef = orderOf ? auths[orderOf].rec.terms.orderRef : `ord_${run}_${scn.scenario}_${label}`.slice(0, 64);
        const r = await issue(A, body(c, { orderRef, destination: { ref: `dst_${run}_${label}`, digest: sha(`dest-${scn.scenario}-${label}`) }, idempotencyKey: `issue_${run}_${scn.scenario}_${label}`.slice(0, 128) }));
        if (r.status !== 200) return { ok: false, code: r.json?.error?.code };
        auths[label] = { rec: r.json.authorization, token: r.json.token };
        return { ok: true };
      },
      async claim(label, keyLabel) {
        const r = await claim(auths[label].token, expectOf(rec(label)), `claim_${run}_${scn.scenario}_${keyLabel}`);
        return r.status === 200 ? { ok: true, replayed: r.json.replayed, ref: r.json.claimReference } : { ok: false, reason: r.json?.reason ?? `http_${r.status}` };
      },
      async parallelClaim(label, keyLabels) {
        return Promise.all(keyLabels.map((k) => driver.claim(label, k)));
      },
      async lookup(keyLabel, label) {
        const r = await lookup(`claim_${run}_${scn.scenario}_${keyLabel}`, { tenant: ctxA.tenant.id, project: `stub:${ctx.id}`, ...(label ? { authorizationId: rec(label).id } : {}) });
        if (!r.json?.found) return { found: false, authorizationClaimed: !!r.json?.authorizationClaimed };
        return { found: true, ref: r.json.claim.claimReference, authority: r.json.authority.ok ? "ok" : r.json.authority.reason };
      },
      async revoke(label) {
        const r = await A.api("POST", "/api/order-authorizations/revoke", { stubId: ctx.id, authorizationId: rec(label).id });
        if (r.status !== 200) throw new Error(`revoke ${r.status}`);
      },
      async revokeApproval() {
        const r = await A.api("POST", "/api/approvals/revoke", { stubId: ctx.id, approvalId: ctx.approval.id });
        if (r.status !== 200) throw new Error(`revoke approval ${r.status}`);
      },
      async changeDesign() {
        const cur = ctx.stub;
        const r = await sync(A, [{ ...cur, event: { ...cur.event, venue: "Somewhere else entirely" }, updatedAt: Date.now() + 5000 }]);
        if (r.status !== 200) throw new Error(`sync ${r.status}`);
      },
      async revalidate(label, claimRef, mutate) {
        let terms = rec(label).terms;
        for (const [pth, v] of Object.entries(mutate ?? {})) terms = set(terms, pth, v);
        const r = await reval(auths[label].token, expectOf(rec(label), { claimReference: claimRef, terms }));
        return r.json?.ok ? { ok: true } : { ok: false, reason: r.json?.reason, fields: r.json?.fields };
      },
      async advance() {
        throw new Error("a live server cannot be moved forward in time");
      },
    };
    return driver;
  };
  const liveScenarios = Object.values(scenarios).filter((x) => x.drivers.includes("live"));
  for (const scn of liveScenarios) {
    const failures = await runScenario(liveDriver(scn), scn);
    check(`scenario (live): ${scn.scenario}`, failures.length === 0, failures.join(" | "));
  }
  check("scenario: every scenario that names the live driver ran, and the ones that did not say why", liveScenarios.length >= 13 && Object.values(scenarios).filter((x) => !x.drivers.includes("live")).every((x) => /reference model only/i.test(x.description)));

  // --- revoke (owner), after a claim and before one
  const rv = await issueFresh("rv");
  const rvClaim = await claim(rv.token, expectOf(rv.rec), `claim_${run}_rv`);
  const rvOwn = await A.api("POST", "/api/order-authorizations/revoke", { stubId: rv.s.id, authorizationId: rv.rec.id });
  check("revoke: the owner revokes a claimed authorization before dispatch", rvClaim.status === 200 && rvOwn.status === 200 && rvOwn.json.revoked === true && rvOwn.json.already === false, rvOwn.text);
  check("revoke: revoking twice is idempotent (already true)", (await A.api("POST", "/api/order-authorizations/revoke", { stubId: rv.s.id, authorizationId: rv.rec.id })).json?.already === true);
  check("revoke: the list keeps the record, status revoked with a revokedAt and the claim", await (async () => {
    const e = (await list(A, rv.s.id)).json.authorizations.find((x) => x.authorization.id === rv.rec.id);
    return e.status === "revoked" && typeof e.revokedAt === "string" && typeof e.claimedAt === "string";
  })());
  check("revoke: revalidate says revoked, a replay of the claim says revoked, and no new claim exists", reasonOf(await reval(rv.token, expectOf(rv.rec, { claimReference: rvClaim.json.claimReference }))) === "revoked" && reasonOf(await claim(rv.token, expectOf(rv.rec), `claim_${run}_rv`)) === "revoked" && claimsFor(rv.rec.id) === 1);

  // --- expiry: a row inserted directly, signed with the server key (a live server cannot be moved forward in time)
  const exp = await issueFresh("exp");
  const expTerms = { ...exp.rec.terms, orderRef: `ord_${run}_expired` };
  const expRec = { ...exp.rec, id: `oau_EXPIRED_${run}`, idempotencyKey: `issue_${run}_expired`, terms: expTerms, actionId: undefined, issuedAt: new Date(Date.now() - 20 * 60_000).toISOString(), expiresAt: new Date(Date.now() - 5 * 60_000).toISOString() };
  expRec.actionId = actionIdOf(expRec.tenant.id, expRec.project, expRec.action, expTerms.orderRef);
  expRec.command = { name: "submit_order", hash: commandHash(expRec.action, expRec.provider, expTerms) };
  db.prepare("INSERT INTO order_authorizations (id, tenant, project, action_id, idem_key, req_hash, record, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(expRec.id, expRec.tenant.id, expRec.project.id, expRec.actionId, expRec.idempotencyKey, "x", canonicalJson(expRec), Date.now() - 20 * 60_000, Date.now() - 5 * 60_000);
  const expToken = signOrderAuthorization(expRec, SERVER_SIGNER);
  check("keys: a token signed with CONTEXT_SECRET under the active kid is forged on the server (no key confusion)", reasonOf(await verify(signOrderAuthorization(expRec, { kid: SERVER_SIGNER.kid, key: CONTEXT_KEY }), expectOf(expRec))) === "forged");
  check("keys: a token under a kid the server does not hold is forged", reasonOf(await verify(signOrderAuthorization(expRec, { kid: "order-auth-g999", key: SERVER_SIGNER.key }), expectOf(expRec))) === "forged");
  check("expired: verify says expired (403)", reasonOf(await verify(expToken, expectOf(expRec))) === "expired");
  check("expired: claim says expired and commits nothing", reasonOf(await claim(expToken, expectOf(expRec), `claim_${run}_exp`)) === "expired" && claimsFor(expRec.id) === 0);
  check("expired: the owner's list reads it as expired", (await list(A, exp.s.id)).json.authorizations.some((x) => x.authorization.id === expRec.id && x.status === "expired"));
  // the same, after a claim: insert the claim row directly, as if it had committed fifteen minutes ago
  const expClaimRef = `clm_EXPIRED_${run}`;
  db.prepare("INSERT INTO order_authorization_claims (authorization_id, action_id, tenant, consumer, idem_key, claim_ref, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(expRec.id, expRec.actionId, expRec.tenant.id, "fulfillment-connectors", `claim_${run}_exp2`, expClaimRef, Date.now() - 19 * 60_000);
  check("expired: a claim that committed before expiry is not dispatchable after it (revalidate says expired), and lookup still shows the claim with that authority", reasonOf(await reval(expToken, expectOf(expRec, { claimReference: expClaimRef }))) === "expired" && (await lookup(`claim_${run}_exp2`, { project: `stub:${exp.s.id}` })).json.authority?.reason === "expired");

  // --- membership: signing out everywhere moves the revision
  const M = client("M");
  await M.signIn(`orderauth-m-${run}@example.com`);
  const sm = await fresh(M);
  const im = await issue(M, body(sm, { idempotencyKey: `issue_${run}_m` }));
  const cm = await claim(im.json.token, expectOf(im.json.authorization), `claim_${run}_m`);
  const outEverywhere = await M.api("POST", "/api/auth/signout", { everywhere: true });
  check("membership: after the account signs out everywhere, revalidate says stale (the approval it references is stale too, so stale_approval or stale)", cm.status === 200 && outEverywhere.status === 200 && ["stale", "stale_approval"].includes(reasonOf(await reval(im.json.token, expectOf(im.json.authorization, { claimReference: cm.json.claimReference })))));
  check("membership: and verify of that token is refused the same way", ["stale", "stale_approval"].includes(reasonOf(await verify(im.json.token, expectOf(im.json.authorization)))) || reasonOf(await verify(im.json.token, expectOf(im.json.authorization))) === "already_claimed");

  // --- the order route is untouched by an authorization
  const order = { stubIds: [S.id], lines: [{ title: "Print", material: "print", finish: "matte", size: "classic", totalMinor: 5500 }], totalMinor: 5500, method: "card", email: emailA };
  const plain = await A.api("POST", "/api/orders", { order });
  const withAuth = await A.api("POST", "/api/orders", { order, authorizationToken: i1.json.token, authorizationId: au1.id });
  check("separate: an authorization attached to an order changes nothing about it (same answer without it)", plain.status === withAuth.status && plain.json?.error?.code === withAuth.json?.error?.code, `${plain.status} vs ${withAuth.status}`);

  // --- approval remains separate: revoking the approval stales the authorization, and an approval alone buys nothing
  const ap = await fresh();
  const iap = await issue(A, body(ap));
  check("approval: with a live approval the authorization is active", iap.json?.status === "active");
  await A.api("POST", "/api/approvals/revoke", { stubId: ap.id, approvalId: ap.approval.id });
  check("approval: revoking the approval makes the authorization read stale in the owner's list, and verify and claim say stale_approval", (await list(A, ap.id)).json.authorizations[0].status === "stale" && reasonOf(await verify(iap.json.token, expectOf(iap.json.authorization))) === "stale_approval" && reasonOf(await claim(iap.json.token, expectOf(iap.json.authorization), `claim_${run}_ap`)) === "stale_approval");
  check("approval: a new authorization against the revoked approval is 409 approval_invalid", (await issue(A, body(ap, { idempotencyKey: `issue_${run}_ap2`, orderRef: `ord_${run}_ap2` }))).json?.error?.code === "approval_invalid");

  // --- events and secrets
  const ev = await A.api("GET", `/api/events?project=stub:${S.id}`);
  const types = (ev.json?.events ?? []).map((e) => e.type);
  check("events: order_authorized and authorization_claimed are in the owner's history for the stub", ["order_authorized", "authorization_claimed"].every((x) => types.includes(x)), types.join());
  const evRv = await A.api("GET", `/api/events?project=stub:${rv.s.id}`);
  check("events: authorization_revoked and authorization_refused are recorded for the revoked one", (evRv.json?.events ?? []).some((e) => e.type === "authorization_revoked") && (evRv.json?.events ?? []).some((e) => e.type === "authorization_refused"));
  const evAll = [...ev.json.events, ...evRv.json.events].filter((e) => /authoriz/.test(e.type));
  check("events: they carry a provider, a 16-hex ref, a reason code, an op and flags only", evAll.every((e) => Object.entries(e.fields).every(([k, v]) => (k === "provider" && ["sandbox", "prodigi"].includes(v)) || (k === "authorization" && /^[a-f0-9]{16}$/.test(v)) || (k === "reason" && /^[a-z_]+$/.test(v)) || (k === "op" && ["claim", "revalidate"].includes(v)) || typeof v === "boolean")));
  check("events: no authorization id, token, hash, destination reference or email in the history", ![au1.id, i1.json.token, au1.terms.destination.ref, au1.terms.destination.digest, artHash, emailA].some((v) => ev.text.includes(v) || evRv.text.includes(v)));
  const joined = responses.join("\n");
  const secrets = ["FIXTURE-ONLY", "CONTEXT_SECRET", "ORDER_AUTH_CONSUMER_KEY", "ORDER_AUTH_SIGNING_KEYS", "__ticketstubKeyringFallback", CONSUMER_KEY, CONTEXT_KEY, SERVER_SIGNER.text, "membership_revision", "__ticketstubContextKey", "RESEND_API_KEY", "OPENAI_API_KEY", ...cookies.filter((c) => c.length > 20)];
  check("secrets: no response carries a key, a session or device cookie, or an internal name", !secrets.some((v) => joined.includes(v)), secrets.filter((v) => joined.includes(v)).join().slice(0, 100));
  const tokens = [...joined.matchAll(/"token":"([^"]+)"/g)].map((m) => m[1]).filter((tk) => tk.split(".").length === 3 && JSON.parse(Buffer.from(tk.split(".")[0], "base64url").toString()).typ === "ticketstub.order-authorization");
  const bodies = tokens.map((tk) => JSON.parse(Buffer.from(tk.split(".")[1], "base64url").toString()));
  check("secrets: an authorization token body holds only the record (no session reference, no email, no art url)", tokens.length > 0 && bodies.every((b) => Object.keys(b).join() === "authorization" && !/"sid"|@|\/api\/files|data:/.test(JSON.stringify(b))));
  check("secrets: no authorization response carries an account email or a street-like value", ![emailA, emailB].some((e) => [i1.text, ls.text, ok1.text, c1.text, lk.text].some((x) => x.includes(e))));

  // --- append-only, and deletion
  let upd = "";
  let del = "";
  let updClaim = "";
  let delClaim = "";
  const rowsBefore = Number(db.prepare("SELECT COUNT(*) AS n FROM order_authorizations").get().n);
  try {
    db.prepare("UPDATE order_authorizations SET expires_at = 9999999999999 WHERE id = ?").run(au1.id);
  } catch (e) {
    upd = String(e.message);
  }
  try {
    db.prepare("DELETE FROM order_authorizations WHERE id = ?").run(au1.id);
  } catch (e) {
    del = String(e.message);
  }
  try {
    db.prepare("UPDATE order_authorization_claims SET idem_key = 'x' WHERE authorization_id = ?").run(au1.id);
  } catch (e) {
    updClaim = String(e.message);
  }
  try {
    db.prepare("DELETE FROM order_authorization_claims WHERE authorization_id = ?").run(au1.id);
  } catch (e) {
    delClaim = String(e.message);
  }
  let updRev = "";
  try {
    db.prepare("UPDATE order_authorization_revocations SET revoked_at = 1 WHERE authorization_id = ?").run(rv.rec.id);
  } catch (e) {
    updRev = String(e.message);
  }
  check("append-only: UPDATE on authorizations, claims and revocations is refused by the database, and DELETE while the account exists", /append-only/.test(upd) && /kept while/.test(del) && /append-only/.test(updClaim) && /kept while/.test(delClaim) && /append-only/.test(updRev), `${upd} | ${del} | ${updClaim} | ${delClaim} | ${updRev}`);
  check("append-only: the rows are still there (a revocation and a claim are new rows)", Number(db.prepare("SELECT COUNT(*) AS n FROM order_authorizations").get().n) === rowsBefore && claimsFor(au1.id) === 1);

  const D = client("D");
  const emailD = `orderauth-d-${run}@example.com`;
  await D.signIn(emailD);
  const ctxD = (await D.api("GET", "/api/context")).json.context;
  const sd = await fresh(D);
  const idd = await issue(D, body(sd, { idempotencyKey: `issue_${run}_d` }));
  const kd = `claim_${run}_d`;
  const cd = await claim(idd.json.token, expectOf(idd.json.authorization), kd);
  const del2 = await D.api("DELETE", "/api/account", { confirm: emailD });
  check("delete: deleting the account succeeds", del2.status === 200 && cd.status === 200, del2.text.slice(0, 120));
  check("delete: its authorizations, claims and revocations leave with it, and the verifier and lookup no longer know them", Number(db.prepare("SELECT COUNT(*) AS n FROM order_authorizations WHERE tenant = ?").get(ctxD.tenant.id).n) === 0 && Number(db.prepare("SELECT COUNT(*) AS n FROM order_authorization_claims WHERE tenant = ?").get(ctxD.tenant.id).n) === 0 && reasonOf(await verify(idd.json.token, expectOf(idd.json.authorization))) === "unknown" && (await lookup(kd, { tenant: ctxD.tenant.id, project: `stub:${sd.id}` })).json.found === false);
  check("delete: other accounts' authorizations are untouched", Number(db.prepare("SELECT COUNT(*) AS n FROM order_authorizations WHERE tenant = ?").get(au1.tenant.id).n) >= 5);
  db.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const sameBody = (a, b) => a.status === b.status && JSON.stringify({ ...a.json, checkedAt: 0 }) === JSON.stringify({ ...b.json, checkedAt: 0 });

/** The context verify port as a hostile consumer would use it, to show one token type never passes as the other. */
async function consumer_context(token) {
  const res = await fetch(`${BASE}/api/context/verify`, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": randIp() }, body: JSON.stringify({ token }) });
  const text = await res.text();
  responses.push(text);
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: undefined };
  }
}

main().catch((e) => {
  console.error(`FAIL order authorization check crashed: ${e instanceof Error ? e.stack : e}`);
  process.exit(1);
});
