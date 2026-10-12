// Regenerates the JSON fixtures in this folder. Deterministic: same inputs, same bytes.
//   node fixtures/order-authorization/generate.mjs
// Signs with the FIXTURE key below. That key is public on purpose. It is fixture only, never production:
// a record signed with it carries mode "fixture", and the server refuses any secret that contains FIXTURE-ONLY.
// Everything here is synthetic and by reference: opaque ids, SHA-256 digests, no address, no name, no email, no payment detail.
// The approval it references (apr_FIXTURE_0001) and its bound hashes are the ones in fixtures/approval.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ORDER_AUTH_AUDIENCE,
  ORDER_AUTH_FAILURES,
  ORDER_AUTH_NOT_AUTHORIZED,
  ORDER_AUTH_SCHEMA,
  ORDER_AUTH_TTL_MS,
  actionIdOf,
  commandHash,
  consumerSignature,
  sha256Hex,
  signOrderAuthorization,
} from "../../src/server/order-auth-token.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_KEY = "FIXTURE-ONLY-NEVER-PRODUCTION--ticketstub-order-authorization-key-v1";
export const FIXTURE_CONSUMER_KEY = "FIXTURE-ONLY-NEVER-PRODUCTION--ticketstub-order-auth-consumer-key-v1";
const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;

const approvalContent = JSON.parse(readFileSync(join(here, "..", "approval", "content.json"), "utf8"));
const approvalFixture = JSON.parse(readFileSync(join(here, "..", "approval", "valid-print-compose.json"), "utf8"));
const TENANT = "acc_FIXTURE_owner1";
const PROJECT = { kind: "stub", id: "stub_fx_1" };
const ACTION = "fulfillment.submit";
const CAP = "2026-10-11.1";

export const terms = {
  orderRef: "ord_FIXTURE_0001",
  sku: null,
  options: { variantId: "print.classic.matte", material: "print", finish: "matte", size: "classic", quantity: 1 },
  quote: { id: `qt_${CAP}_print_matte_classic_x1`, amountMinor: 5500, currency: "USD" },
  destination: { ref: "dst_FIXTURE_ref_0001", digest: sha256Hex("FIXTURE destination reference digest v1: not a real address") },
  design: { versionId: "v_fx_2", ...approvalContent.bound },
  approvalId: "apr_FIXTURE_0001",
  capabilityVersion: CAP,
};

const record = (over = {}, t = terms, provider = "sandbox") => ({
  schema: ORDER_AUTH_SCHEMA,
  id: "oau_FIXTURE_0001",
  issuer: "ticketstub",
  audience: ORDER_AUTH_AUDIENCE,
  tenant: { id: TENANT },
  project: PROJECT,
  actor: { kind: "account", id: TENANT },
  action: ACTION,
  provider,
  actionId: actionIdOf(TENANT, PROJECT, ACTION, t.orderRef),
  command: { name: "submit_order", hash: commandHash(ACTION, provider, t) },
  terms: t,
  approval: { id: t.approvalId, purpose: "print.compose" },
  idempotencyKey: "issue_FIXTURE_key_0001",
  membershipRevision: 3,
  notAuthorizes: ORDER_AUTH_NOT_AUTHORIZED,
  environment: "development",
  mode: "fixture",
  issuedAt: iso(NOW),
  expiresAt: iso(NOW + ORDER_AUTH_TTL_MS),
  ...over,
});

const expectOf = (t = terms, over = {}) => ({ tenant: TENANT, project: PROJECT, action: ACTION, provider: "sandbox", terms: t, ...over });
/** What the issuer says when everything is as it was: approval active, nothing revoked or claimed, same membership and capability map. */
const live = { known: true, revoked: false, superseded: false, approval: "active", membershipRevision: 3, capabilityVersion: CAP, orderable: true, claim: null };
const ok = { ok: true };
const no = (reason, fields) => ({ ok: false, reason, ...(fields ? { fields } : {}) });
const set = (path, value, base = terms) => {
  const c = structuredClone(base);
  const keys = path.split(".");
  let o = c;
  for (const k of keys.slice(0, -1)) o = o[k];
  o[keys.at(-1)] = value;
  return c;
};

const out = {};
/**
 * expect: what the consumer names and holds. state: the issuer's current answer. intent: verify (read only), claim, or revalidate (dispatch time).
 * outcome: what a correct verifier answers. Terms in `expect` are the consumer's own copy; it never takes them from the token it is checking.
 */
function add(name, description, token, { intent = "verify", expect = expectOf(), state = live, verifyAt = NOW + 5 * MIN, consumer, outcome }) {
  out[name] = { fixture: name, description, intent, verifyAt: iso(verifyAt), token, expect, ...(state ? { state } : {}), ...(consumer ? { consumer } : {}), outcome };
}
const sign = (r, key = FIXTURE_KEY) => signOrderAuthorization(r, key);
const good = sign(record());
const claimRef = "clm_FIXTURE_ref_0001";
const claimed = (keyMatches) => ({ ...live, claim: { reference: claimRef, keyMatches } });

add("valid-submit", "A good authorization for one sandbox order. The consumer holds exactly the terms the owner confirmed. Control case: it must pass, and verify does not claim it.", good, { outcome: ok });
add("valid-claim", "The first claim, under key K1: nothing is committed yet, every check passes. The issuer commits the claim and answers claimed.", good, { intent: "claim", outcome: ok });
add("valid-claim-replay-same-key", "The claim under K1 already committed and the response was lost. The same key again passes and returns the committed claim; nothing is consumed twice.", good, { intent: "claim", state: claimed(true), outcome: ok });
add("valid-revalidate", "Dispatch time: the connector holds claim clm_FIXTURE_ref_0001 and everything still holds. It may send.", good, { intent: "revalidate", expect: expectOf(terms, { claimReference: claimRef }), state: claimed(true), outcome: ok });

add("unknown-malformed", "Not a token at all.", "not-a-token", { outcome: no("unknown") });
add("unknown-no-record", "Signed correctly, but the issuer has no record of this id (a different deployment, or a wiped database). The issuer answers known: false.", good, { state: { ...live, known: false }, outcome: no("unknown") });
add("unknown-approval-token", "A real, valid ticketstub.approval/1 token presented as an order authorization. An approval is not a purchase authorization: it is a different token type, signed with a different key, and is never accepted here.", approvalFixture.token, { outcome: no("unknown") });
add("forged", "The same record signed with a different key.", sign(record(), "some-other-key-the-issuer-never-saw-0000"), { outcome: no("forged") });
const edited = good.split(".");
const swapped = JSON.parse(Buffer.from(edited[1], "base64url").toString());
swapped.authorization.terms.quote.amountMinor = 9900;
edited[1] = Buffer.from(JSON.stringify(swapped)).toString("base64url");
add("forged-edited-terms", "A valid token whose payload was edited to raise the authorized amount. The signature no longer matches.", edited.join("."), { expect: expectOf(set("quote.amountMinor", 9900)), outcome: no("forged") });
add("unsupported-version", "A correctly signed record with a schema this verifier does not know.", sign(record({ schema: "ticketstub.order-authorization/2" })), { outcome: no("unsupported_version") });

add("wrong-scope-tenant", "A valid authorization for tenant acc_FIXTURE_owner1, presented by a consumer acting for another tenant.", good, { expect: expectOf(terms, { tenant: "acc_FIXTURE_owner2" }), outcome: no("wrong_scope") });
add("wrong-scope-project", "The same tenant's authorization for stub_fx_1, presented for stub_fx_2.", good, { expect: expectOf(terms, { project: { kind: "stub", id: "stub_fx_2" } }), outcome: no("wrong_scope") });
add("wrong-scope-provider", "An authorization for the sandbox provider presented to dispatch to prodigi.", good, { expect: expectOf(terms, { provider: "prodigi" }), outcome: no("wrong_scope") });
add("wrong-scope-action", "A submit authorization presented as permission to cancel. Only fulfillment.submit exists; cancel is unsupported.", good, { expect: expectOf(terms, { action: "fulfillment.cancel" }), outcome: no("wrong_scope") });
add("unknown-wrong-audience", "A record addressed to another audience is not a record this consumer can use: the verifier reads it as unknown, never as an authorization for itself.", sign(record({ audience: "someone-else" })), { outcome: no("unknown") });

for (const [name, path, value, what] of [
  ["changed-terms-amount", "quote.amountMinor", 5501, "The connector's quote is one minor unit above the amount the owner confirmed."],
  ["changed-terms-currency", "quote.currency", "EUR", "The quote is in another currency."],
  ["changed-terms-quote-id", "quote.id", `qt_${CAP}_print_matte_classic_x2`, "The connector re-quoted: another quote id."],
  ["changed-terms-quantity", "options.quantity", 2, "Two pieces where the owner confirmed one."],
  ["changed-terms-sku", "sku", "SKU-SOMETHING-ELSE", "A SKU the owner never confirmed (the confirmed one is null: no SKU is confirmed yet)."],
  ["changed-terms-finish", "options.finish", "foil", "A different finish."],
  ["changed-terms-destination", "destination.ref", "dst_FIXTURE_ref_0002", "A different destination reference."],
  ["changed-terms-destination-digest", "destination.digest", sha256Hex("FIXTURE destination reference digest v2"), "The same destination reference, but its digest moved (the connector's copy changed)."],
  ["changed-terms-art", "design.artHash", sha256Hex("FIXTURE other art bytes"), "The art bytes in the production bundle are not the ones the owner approved and confirmed."],
  ["changed-terms-design-version", "design.versionId", "v_fx_9", "A different design version."],
  ["changed-terms-approval", "approvalId", "apr_FIXTURE_0099", "Bundled under another approval id."],
  ["changed-terms-order", "orderRef", "ord_FIXTURE_0002", "A different order."],
  ["changed-terms-capability-version", "capabilityVersion", "2026-01-01.1", "The consumer priced under another capability map."],
]) {
  add(name, `${what} Any difference in a bound term is changed_terms; a quote, budget hold or approval can never substitute. Renewed authorization is required.`, good, { expect: expectOf(set(path, value)), outcome: no("changed_terms", [path]) });
}

add("expired", "Verified sixteen minutes after issue; the lifetime is fifteen.", good, { verifyAt: NOW + 16 * MIN, outcome: no("expired") });
for (const [tag, label] of [["nan", "NaN"], ["infinity", "Infinity"], ["negative", "-1"], ["string", "a string"]]) add(`clock-${tag}`, `The valid-submit case, but the consumer's trusted clock is ${label}. A clock that is not a finite number above zero cannot judge expiry, so the answer is invalid_clock.`, good, { consumer: { clock: tag }, outcome: no("invalid_clock") });
add("revoked", "The owner revoked it before any claim. The issuer says revoked: true.", good, { state: { ...live, revoked: true }, outcome: no("revoked") });
add("stale-approval-revoked", "The owner revoked the print.compose approval this authorization references. The authorization itself is not revoked, and still fails: it never outlives its approval.", good, { state: { ...live, approval: "revoked" }, outcome: no("stale_approval") });
add("stale-approval-expired", "The referenced approval has expired (seven days).", good, { state: { ...live, approval: "expired" }, outcome: no("stale_approval") });
add("stale-approval-changed", "The owner changed a printed fact or the art after approving: the approval reads stale, and so the authorization does.", good, { state: { ...live, approval: "stale" }, outcome: no("stale_approval") });
add("stale-approval-missing", "The approval row is gone or is not this tenant's.", good, { state: { ...live, approval: "missing" }, outcome: no("stale_approval") });
add("stale-superseded", "The owner renewed the authorization for the same order (same orderRef, new idempotency key). The older one reads stale: only the newest can be claimed.", good, { state: { ...live, superseded: true }, outcome: no("stale") });
add("stale-membership", "The account's membershipRevision moved on (signed out everywhere, email change).", good, { state: { ...live, membershipRevision: 4 }, outcome: no("stale") });
add("stale-capability-version", "The capability map moved to a newer version since issue. Terms priced under the old map need renewed authorization.", good, { state: { ...live, capabilityVersion: "2026-10-12.1" }, outcome: no("stale") });
add("not-orderable", "The variant or provider no longer passes the order gate (for example the live runtime does not accept a preview variant).", good, { state: { ...live, orderable: false }, outcome: no("not_orderable") });

add("already-claimed-verify", "Read-only verify of an authorization somebody already claimed: not claimable any more.", good, { state: claimed(true), outcome: no("already_claimed") });
add("already-claimed-other-key", "A claim committed under K1. The same authorization presented under a different key K2 is rejected: one authorization, one dispatch, whatever the keys.", good, { intent: "claim", state: claimed(false), outcome: no("already_claimed") });
add("revalidate-not-claimed", "Dispatch-time revalidate when the issuer has no claim on this authorization: the connector must not send.", good, { intent: "revalidate", expect: expectOf(terms, { claimReference: claimRef }), outcome: no("not_claimed") });
add("revalidate-wrong-claim-reference", "Dispatch-time revalidate with a claim reference other than the committed one.", good, { intent: "revalidate", expect: expectOf(terms, { claimReference: "clm_FIXTURE_ref_9999" }), state: claimed(true), outcome: no("not_claimed") });
add("revalidate-revoked-after-claim", "The claim committed, then the owner revoked before the connector sent. Revalidate says revoked: authority ended, the claim stays on record.", good, { intent: "revalidate", expect: expectOf(terms, { claimReference: claimRef }), state: { ...claimed(true), revoked: true }, outcome: no("revoked") });
add("revalidate-expired-after-claim", "The claim committed, the job sat queued, and the fifteen minutes passed before dispatch.", good, { intent: "revalidate", expect: expectOf(terms, { claimReference: claimRef }), state: claimed(true), verifyAt: NOW + 16 * MIN, outcome: no("expired") });
add("revalidate-approval-revoked-after-claim", "The claim committed, then the owner revoked the approval the authorization references.", good, { intent: "revalidate", expect: expectOf(terms, { claimReference: claimRef }), state: { ...claimed(true), approval: "revoked" }, outcome: no("stale_approval") });
add("revalidate-changed-terms-after-claim", "The claim committed, then the connector's bundle changed (re-quote or new art). Revalidate says changed_terms: send nothing, ask for a renewed authorization.", good, { intent: "revalidate", expect: expectOf(set("quote.amountMinor", 6100), { claimReference: claimRef }), state: claimed(true), outcome: no("changed_terms", ["quote.amountMinor"]) });
add("revalidate-membership-moved-after-claim", "The claim committed, then the account signed out everywhere.", good, { intent: "revalidate", expect: expectOf(terms, { claimReference: claimRef }), state: { ...claimed(true), membershipRevision: 4 }, outcome: no("stale") });

// ---------------------------------------------------------------------------------------------
// Scenarios: stateful protocol traces. Run against the reference model in verify.mjs, and (drivers includes "live")
// against a real server by scripts/check-order-auth.mjs. Authorizations and keys are labels; the drivers make real ones.
// ---------------------------------------------------------------------------------------------
const scenarios = {};
const scn = (name, description, steps, drivers = ["reference", "live"]) => {
  scenarios[name] = { scenario: name, description, drivers, steps };
};
const claim = (auth, key, expect, extra = {}) => ({ op: "claim", auth, key, expect, ...extra });
const okc = (extra = {}) => ({ ok: true, ...extra });

scn("first-claim-wins-and-replays", "The first claim commits. The same key again returns the same claim, not a second one. Lookup by key finds it.", [
  { op: "issue", auth: "A" },
  claim("A", "K1", okc({ replayed: false, as: "c1" })),
  claim("A", "K1", okc({ replayed: true, is: "c1" })),
  { op: "lookup", key: "K1", expect: { found: true, is: "c1", authority: "ok" } },
]);
scn("replay-under-distinct-key", "Same authorization, a second submission identity: rejected already_claimed. The committed claim is untouched.", [
  { op: "issue", auth: "A" },
  claim("A", "K1", okc({ replayed: false, as: "c1" })),
  claim("A", "K2", { ok: false, reason: "already_claimed" }),
  { op: "lookup", key: "K2", auth: "A", expect: { found: false, authorizationClaimed: true } },
  claim("A", "K1", okc({ replayed: true, is: "c1" })),
]);
scn("concurrent-claim-distinct-keys", "Eight submissions race one authorization under eight keys. Exactly one wins; seven are already_claimed.", [
  { op: "issue", auth: "A" },
  { op: "parallel", auth: "A", keys: ["K1", "K2", "K3", "K4", "K5", "K6", "K7", "K8"], expect: { ok: 1, created: 1, reasons: { already_claimed: 7 } } },
]);
scn("concurrent-claim-same-key", "Eight submissions of the same command (one key) race. One commits; the rest replay the same claim. Never a second consume.", [
  { op: "issue", auth: "A" },
  { op: "parallel", auth: "A", keys: ["K1", "K1", "K1", "K1", "K1", "K1", "K1", "K1"], expect: { ok: 8, created: 1, reasons: {}, sameClaim: true } },
]);
scn("claim-committed-response-lost", "The claim commits and the consumer never sees the response. A retry with the same key returns the committed claim; a different key is already_claimed.", [
  { op: "issue", auth: "A" },
  claim("A", "K1", okc({ replayed: false, as: "c1" }), { dropResponse: true }),
  { op: "lookup", key: "K1", expect: { found: true, is: "c1", authority: "ok" } },
  claim("A", "K1", okc({ replayed: true, is: "c1" })),
  claim("A", "K2", { ok: false, reason: "already_claimed" }),
]);
scn("unknown-claim-lookup-reconciliation", "A restart with no memory of the outcome. Lookup says not found for a key that never committed (definitive); after the claim it says found.", [
  { op: "issue", auth: "A" },
  { op: "lookup", key: "K9", expect: { found: false } },
  { op: "lookup", key: "K9", auth: "A", expect: { found: false } },
  claim("A", "K9", okc({ replayed: false, as: "c1" })),
  { op: "lookup", key: "K9", expect: { found: true, is: "c1", authority: "ok" } },
]);
scn("same-key-different-authorization", "A key is bound to the first authorization it claimed. The same key on another authorization is idempotency_conflict, not a second claim.", [
  { op: "issue", auth: "A" },
  { op: "issue", auth: "B" },
  claim("A", "K1", okc({ replayed: false, as: "c1" })),
  claim("B", "K1", { ok: false, reason: "idempotency_conflict" }),
  claim("B", "K2", okc({ replayed: false, as: "c2" })),
]);
scn("revoke-after-claim-before-dispatch", "Claimed, then revoked before transport. Revalidate at dispatch says revoked; a replay of the claim says revoked too; lookup still reports the claim fact with revoked authority.", [
  { op: "issue", auth: "A" },
  claim("A", "K1", okc({ replayed: false, as: "c1" })),
  { op: "revalidate", auth: "A", key: "K1", expect: { ok: true } },
  { op: "revoke", auth: "A" },
  { op: "revalidate", auth: "A", key: "K1", expect: { ok: false, reason: "revoked" } },
  claim("A", "K1", { ok: false, reason: "revoked" }),
  { op: "lookup", key: "K1", expect: { found: true, is: "c1", authority: "revoked" } },
]);
scn("approval-revoked-after-claim", "Claimed, then the owner revokes the artwork approval the authorization references. Revalidate says stale_approval.", [
  { op: "issue", auth: "A" },
  claim("A", "K1", okc({ replayed: false, as: "c1" })),
  { op: "revokeApproval", auth: "A" },
  { op: "revalidate", auth: "A", key: "K1", expect: { ok: false, reason: "stale_approval" } },
  { op: "lookup", key: "K1", expect: { found: true, is: "c1", authority: "stale_approval" } },
]);
scn("art-changed-after-claim", "Claimed, then the owner edits a printed fact. The approval goes stale, and so does the authorization at dispatch time.", [
  { op: "issue", auth: "A" },
  claim("A", "K1", okc({ replayed: false, as: "c1" })),
  { op: "changeDesign", auth: "A" },
  { op: "revalidate", auth: "A", key: "K1", expect: { ok: false, reason: "stale_approval" } },
]);
scn("changed-terms-after-claim", "Claimed, then the connector's bundle no longer matches what the owner confirmed (quote moved). Revalidate says changed_terms and names the field.", [
  { op: "issue", auth: "A" },
  claim("A", "K1", okc({ replayed: false, as: "c1" })),
  { op: "revalidate", auth: "A", key: "K1", mutate: { "quote.amountMinor": 1 }, expect: { ok: false, reason: "changed_terms", fields: ["quote.amountMinor"] } },
  { op: "revalidate", auth: "A", key: "K1", expect: { ok: true } },
]);
scn("revalidate-before-claim", "A revalidate with a claim the issuer never committed: not_claimed. A connector that skipped the claim cannot dispatch.", [
  { op: "issue", auth: "A" },
  { op: "revalidate", auth: "A", key: "K1", expect: { ok: false, reason: "not_claimed" } },
]);
scn("claim-after-revoke", "Revoked before any claim: the claim is refused and nothing is recorded, so lookup finds nothing.", [
  { op: "issue", auth: "A" },
  { op: "revoke", auth: "A" },
  claim("A", "K1", { ok: false, reason: "revoked" }),
  { op: "lookup", key: "K1", expect: { found: false } },
]);
scn("renewal-supersedes-older", "The owner renews the same order (same orderRef, new idempotency key). The older authorization reads stale; only the newest can be claimed.", [
  { op: "issue", auth: "A" },
  { op: "issue", auth: "A2", orderOf: "A" },
  claim("A", "K1", { ok: false, reason: "stale" }),
  claim("A2", "K2", okc({ replayed: false, as: "c1" })),
]);
scn("claimed-order-cannot-be-renewed", "Once an order's action is claimed, issuing another authorization for the same orderRef is refused (authorization_conflict): one order, one dispatch.", [
  { op: "issue", auth: "A" },
  claim("A", "K1", okc({ replayed: false, as: "c1" })),
  { op: "issue", auth: "A2", orderOf: "A", expect: { refused: "authorization_conflict" } },
]);
scn("expires-after-claim-before-dispatch", "Claimed, queued, and the fifteen minutes pass before transport. Revalidate says expired. (Reference model only: a live server cannot be moved forward in time.)", [
  { op: "issue", auth: "A" },
  claim("A", "K1", okc({ replayed: false, as: "c1" })),
  { op: "advance", minutes: 16 },
  { op: "revalidate", auth: "A", key: "K1", expect: { ok: false, reason: "expired" } },
], ["reference"]);
scn("expires-before-claim", "Never claimed and the fifteen minutes pass: claim says expired. (Reference model only.)", [
  { op: "issue", auth: "A" },
  { op: "advance", minutes: 16 },
  claim("A", "K1", { ok: false, reason: "expired" }),
], ["reference"]);

mkdirSync(join(here, "scenarios"), { recursive: true });
for (const [name, f] of Object.entries(out)) writeFileSync(join(here, `${name}.json`), `${JSON.stringify(f, null, 2)}\n`);
for (const [name, f] of Object.entries(scenarios)) writeFileSync(join(here, "scenarios", `${name}.json`), `${JSON.stringify(f, null, 2)}\n`);

// A worked example of the consumer request signature, so a consumer can test its signing against the fixture key.
const exampleBody = JSON.stringify({ tenant: TENANT, project: "stub:stub_fx_1", idempotencyKey: "claim_FIXTURE_key_K1" });
const exampleTs = NOW;
writeFileSync(
  join(here, "fixture-key.json"),
  `${JSON.stringify(
    {
      warning: "FIXTURE ONLY. NEVER PRODUCTION. Public on purpose: it signs test authorizations that carry mode fixture, and test consumer requests. Never set either key on a server; the server refuses any secret containing FIXTURE-ONLY.",
      kid: "fixture",
      alg: "HS256",
      key: FIXTURE_KEY,
      consumerKey: FIXTURE_CONSUMER_KEY,
      consumerRequestExample: {
        method: "POST",
        path: "/api/order-authorizations/claims/lookup",
        body: exampleBody,
        timestamp: exampleTs,
        signature: consumerSignature(FIXTURE_CONSUMER_KEY, exampleTs, "POST", "/api/order-authorizations/claims/lookup", exampleBody),
        headers: "x-ticketstub-consumer-timestamp, x-ticketstub-consumer-signature",
        signs: "HMAC-SHA256 hex over `${timestamp}\\n${METHOD}\\n${path}\\n${sha256 hex of the exact body text}`",
      },
    },
    null,
    2,
  )}\n`,
);
writeFileSync(
  join(here, "content.json"),
  `${JSON.stringify({ description: "The synthetic terms every token fixture binds, so a consumer can build its own copy. Reference ids and digests only: no address, name, email or payment detail. The approval id and design hashes are the ones in fixtures/approval.", tenant: TENANT, project: PROJECT, action: ACTION, provider: "sandbox", terms, commandHash: commandHash(ACTION, "sandbox", terms), actionId: actionIdOf(TENANT, PROJECT, ACTION, terms.orderRef) }, null, 2)}\n`,
);
const index = {
  schema: ORDER_AUTH_SCHEMA,
  reasons: ORDER_AUTH_FAILURES,
  key: "fixture-key.json",
  content: "content.json",
  verifier: "verify.mjs",
  fixtures: Object.keys(out).map((n) => `${n}.json`),
  scenarios: Object.keys(scenarios).map((n) => `scenarios/${n}.json`),
};
writeFileSync(join(here, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
console.log(`wrote ${Object.keys(out).length} token fixtures and ${Object.keys(scenarios).length} scenarios to ${here}`);
