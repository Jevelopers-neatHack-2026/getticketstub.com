import "server-only";
import { randomBytes } from "node:crypto";
import { CAPABILITY_VERSION, authorizationGate, quoteIdFor, runtimeMode, variantFor, type PrintSize } from "@/customer/pages/capabilities";
import type { Finish, Material, Stub } from "@/customer/studio/types";
import { bindingNow } from "./approval";
import { canonicalJson as approvalJson, hashesOf, type ApprovalRecord } from "./approval-token";
import { contextEnvironment, type RequestContext } from "./context";
import { secretsCollide, type Keyring } from "./keyring";
import { orderAuthKeyring, requireOrderAuthKeyring } from "./signing-keys";
import { HttpError } from "./http";
import { getStorage } from "./index";
import {
  CONSUMER_HEADERS,
  HEX64,
  ORDER_AUTH_ACTIONS,
  ORDER_AUTH_AUDIENCE,
  ORDER_AUTH_NOT_AUTHORIZED,
  ORDER_AUTH_PROVIDERS,
  ORDER_AUTH_SCHEMA,
  ORDER_AUTH_TTL_MS,
  actionIdOf,
  canonicalJson,
  commandHash,
  hashJson,
  orderAuthIdOf,
  signOrderAuthorization,
  verifyConsumerSignature,
  verifyOrderAuthorization,
  type OrderAuthExpectation,
  type OrderAuthFailure,
  type OrderAuthIntent,
  type OrderAuthKeys,
  type OrderAuthProvider,
  type OrderAuthRecord,
  type OrderAuthState,
  type OrderAuthTerms,
  type OrderAuthVerifyResult,
} from "./order-auth-token";
import type { ApprovalRow, OrderAuthRow, OrderAuthSnapshot, OrderClaimRow } from "./storage";

// Order authorization, server side (GT-07, ticketstub.order-authorization/1). The issuer: it builds the record from the stub and the
// approval the server holds (never from a body), signs it, answers the consumer's verify, atomic claim, lookup and dispatch-time
// revalidate with its own current records. The record, token and verifier are in order-auth-token.ts; docs/architecture/order-authorization.md
// has the model and what is missing. An authorization REFERENCES a current print.compose approval; it is never inferred from one.

/** The one consumer this stopgap authenticates. The claim idempotency key space is per consumer. */
export const CONSUMER_ID = ORDER_AUTH_AUDIENCE;

export type OrderAuthStatus = "active" | "claimed" | "revoked" | "expired" | "stale";
/** An authorization as its owner sees it: the signed record plus where it stands right now. */
export interface OrderAuthView {
  authorization: OrderAuthRecord;
  status: OrderAuthStatus;
  revokedAt: string | null;
  claimedAt: string | null;
  token: string;
}

const conflict = (message: string) => new HttpError(409, "authorization_conflict", message);
const approvalInvalid = () => new HttpError(409, "approval_invalid", "That approval doesn't cover this order.");
const iso = (ms: number) => new Date(ms).toISOString();
const parseRecord = (row: OrderAuthRow) => JSON.parse(row.record) as OrderAuthRecord;
const newAuthId = () => `oau_${randomBytes(12).toString("base64url")}`;
const newClaimRef = () => `clm_${randomBytes(12).toString("base64url")}`;

// ---------------------------------------------------------------------------------------------
// Standing: what the issuer says right now
// ---------------------------------------------------------------------------------------------

/** The referenced approval as it reads now, from rows read in one transaction. Same rules as the approval module's own status. */
function approvalStanding(row: ApprovalRow | null, stub: Stub | null, membershipRevision: number | null, now: number): NonNullable<OrderAuthState["approval"]> {
  if (!row) return "missing";
  const rec = JSON.parse(row.record) as ApprovalRecord;
  if (row.revokedAt !== null) return "revoked";
  if (Date.parse(rec.expiresAt) <= now) return "expired";
  const bound = stub ? bindingNow(stub, rec.binding.composition.size) : null;
  if (membershipRevision === null || membershipRevision !== rec.membershipRevision || !bound || approvalJson(hashesOf(bound)) !== approvalJson(hashesOf(rec.binding))) return "stale";
  return "active";
}

const gateOf = (rec: OrderAuthRecord) => {
  const o = rec.terms.options;
  return authorizationGate(variantFor(o.material as Material, o.size as PrintSize, o.finish as Finish), rec.provider, runtimeMode({ TICKETSTUB_RUNTIME_MODE: process.env.TICKETSTUB_RUNTIME_MODE }));
};

function stateOf(snap: OrderAuthSnapshot, rec: OrderAuthRecord, who: { consumer: string; idemKey?: string } | null, now: number): OrderAuthState {
  const auth = snap.auth;
  const claim = snap.claim;
  return {
    known: !!auth,
    revoked: !!auth && auth.revokedAt !== null,
    superseded: !!auth && auth.superseded,
    approval: approvalStanding(snap.approval, snap.stub, snap.account ? snap.account.membershipRevision : null, now),
    membershipRevision: snap.account ? snap.account.membershipRevision : -1,
    capabilityVersion: CAPABILITY_VERSION,
    orderable: gateOf(rec).ok,
    claim: claim ? { reference: claim.claimRef, keyMatches: !!who && claim.consumer === who.consumer && claim.idemKey === who.idemKey } : null,
  };
}

/** The consumer's expectation if it held exactly what the record binds. For the issuer's own status and lookup answers. */
const selfExpect = (rec: OrderAuthRecord): OrderAuthExpectation => ({ tenant: rec.tenant.id, project: rec.project, action: rec.action, provider: rec.provider, terms: rec.terms });

async function viewOf(row: OrderAuthRow, keys: Keyring, now: number): Promise<OrderAuthView> {
  const rec = parseRecord(row);
  const token = signOrderAuthorization(rec, keys.signer()); // re-signed on demand with the active key
  const snap = await getStorage().getOrderAuthSnapshot(row.id);
  let status: OrderAuthStatus;
  if (row.revokedAt !== null) status = "revoked";
  else if (snap.claim) status = "claimed";
  else {
    const r = verifyOrderAuthorization(token, (kid, keyTime) => keys.lookup(kid, now, keyTime), selfExpect(rec), now, stateOf(snap, rec, null, now), "verify");
    status = r.ok ? "active" : r.reason === "expired" ? "expired" : r.reason === "revoked" ? "revoked" : "stale";
  }
  return { authorization: rec, status, revokedAt: row.revokedAt === null ? null : iso(row.revokedAt), claimedAt: snap.claim ? iso(snap.claim.claimedAt) : null, token };
}

// ---------------------------------------------------------------------------------------------
// Customer side: issue, list, revoke
// ---------------------------------------------------------------------------------------------

export interface IssueInput {
  stubId: string;
  approvalId: string;
  expectedVersionId: string;
  orderRef: string;
  quantity: number;
  provider: OrderAuthProvider;
  quote: { id: string; amountMinor: number; currency: string };
  destination: { ref: string; digest: string };
  idempotencyKey: string;
}

/**
 * Issues (or returns the stored identical) authorization. Atomic with the stub, approval and claim reads: nothing is issued unless the
 * referenced print.compose approval is active for the stub as it is right now, the variant passes the order gate, and the quote is the
 * one for this exact choice. The amount is the maximum the owner confirmed for that quote; the studio does not re-price it (see the doc).
 */
export async function issueOrderAuthorization(ctx: RequestContext, input: IssueInput): Promise<{ view: OrderAuthView; created: boolean }> {
  if (ctx.actor.kind !== "account") throw new HttpError(401, "unauthorized", "Sign in with an emailed link to do that.");
  const keys = requireOrderAuthKeyring(); // 503 in live mode without ORDER_AUTH_SIGNING_KEYS (or with an invalid set), before anything is written
  const actorId = ctx.actor.id;
  const now = Date.now();
  const reqHash = hashJson({ stubId: input.stubId, approvalId: input.approvalId, orderRef: input.orderRef, quantity: input.quantity, provider: input.provider, quote: input.quote, destination: input.destination });
  const res = await getStorage().issueOrderAuthorization(ctx.tenant.id, input.stubId, input.approvalId, input.idempotencyKey, reqHash, now, (stub, approvalRow, actionClaimed) => {
    if (stub.currentVersionId !== input.expectedVersionId) throw conflict("The stub changed while you were confirming.");
    if (!approvalRow || approvalStanding(approvalRow, stub, ctx.membershipRevision, now) !== "active") throw approvalInvalid();
    const approval = JSON.parse(approvalRow.record) as ApprovalRecord;
    if (approval.purpose !== "print.compose") throw approvalInvalid(); // an artifact.download approval is not even a print approval
    const size = approval.binding.composition.size as PrintSize;
    const variant = variantFor(stub.material, size, stub.finish);
    const gate = authorizationGate(variant, input.provider, runtimeMode({ TICKETSTUB_RUNTIME_MODE: process.env.TICKETSTUB_RUNTIME_MODE }));
    if (!gate.ok || !variant) throw new HttpError(422, "variant_not_orderable", gate.ok ? "That combination isn't on our list." : gate.message);
    if (input.quote.currency !== "USD") throw conflict("Only USD quotes can be authorized.");
    if (input.quote.id !== quoteIdFor(stub.material, stub.finish, size, input.quantity)) throw conflict("That quote isn't for this stub's current choice. Get a new quote.");
    const action = ORDER_AUTH_ACTIONS[0];
    const actionId = actionIdOf(ctx.tenant.id, { kind: "stub", id: input.stubId }, action, input.orderRef);
    if (actionClaimed(actionId)) throw conflict("That order was already submitted.");
    const b = approval.binding;
    const terms: OrderAuthTerms = {
      orderRef: input.orderRef,
      sku: gate.sku,
      options: { variantId: variant.id, material: stub.material, finish: stub.finish, size, quantity: input.quantity },
      quote: { id: input.quote.id, amountMinor: input.quote.amountMinor, currency: input.quote.currency },
      destination: { ref: input.destination.ref, digest: input.destination.digest },
      design: { versionId: b.versionId, designHash: b.designHash, artHash: b.artHash, factsHash: b.factsHash, compositionHash: b.compositionHash },
      approvalId: approvalRow.id,
      capabilityVersion: CAPABILITY_VERSION,
    };
    const record: OrderAuthRecord = {
      schema: ORDER_AUTH_SCHEMA,
      id: newAuthId(),
      issuer: "ticketstub",
      audience: ORDER_AUTH_AUDIENCE,
      tenant: { id: ctx.tenant.id },
      project: { kind: "stub", id: input.stubId },
      actor: { kind: "account", id: actorId },
      action,
      provider: input.provider,
      actionId,
      command: { name: "submit_order", hash: commandHash(action, input.provider, terms) },
      terms,
      approval: { id: approvalRow.id, purpose: "print.compose" },
      idempotencyKey: input.idempotencyKey,
      membershipRevision: ctx.membershipRevision,
      notAuthorizes: ORDER_AUTH_NOT_AUTHORIZED,
      environment: contextEnvironment(),
      mode: keys.mode,
      issuedAt: iso(now),
      expiresAt: iso(now + ORDER_AUTH_TTL_MS),
    };
    return { id: record.id, actionId, idemKey: input.idempotencyKey, reqHash, record: canonicalJson(record), issuedAt: now, expiresAt: now + ORDER_AUTH_TTL_MS };
  });
  if (res === null) throw new HttpError(404, "not_found", "We couldn't find that.");
  if (res === "conflict") throw conflict("That idempotency key was used for a different request.");
  return { view: await viewOf(res.row, keys, now), created: res.created };
}

/** Every authorization for the owner's stub, newest first, each with its current status. */
export async function listOrderAuthorizations(tenant: string, stubId: string): Promise<OrderAuthView[]> {
  const keys = requireOrderAuthKeyring();
  const now = Date.now();
  const rows = await getStorage().listOrderAuthorizations(tenant, stubId);
  return Promise.all(rows.map((r) => viewOf(r, keys, now)));
}

/** Adds the revocation row. The record and any claim stay: only its authority ends, and a dispatch-time revalidate sees it. */
export async function revokeOrderAuthorization(tenant: string, stubId: string, id: string): Promise<"revoked" | "already" | "missing"> {
  return getStorage().revokeOrderAuthorization(tenant, stubId, id, Date.now());
}

// ---------------------------------------------------------------------------------------------
// Consumer side. Authentication is a stopgap: one shared HMAC key, request signing, one consumer id.
// ---------------------------------------------------------------------------------------------

/** ORDER_AUTH_CONSUMER_KEY, at least 32 characters. Never the published fixture key, never CONTEXT_SECRET (raw or decoded). Null means the consumer port is off. */
function consumerKey(): string | null {
  const k = process.env.ORDER_AUTH_CONSUMER_KEY?.trim();
  if (!k || k.length < 32 || k.includes("FIXTURE-ONLY")) return null;
  const ctx = process.env.CONTEXT_SECRET?.trim();
  // Refused when it is CONTEXT_SECRET in either reading (the same string, or one is the other's base64url), so one pasted
  // value never covers both context tokens and consumer requests.
  return ctx && (k === ctx || secretsCollide(k, ctx)) ? null : k;
}

/**
 * Reads the body as UTF-8 text, counting bytes as they arrive and stopping (413 `too_large`) the moment more than `maxBytes` have been
 * seen, so an absent or understated Content-Length can't make the server buffer more than the cap. The text is decoded exactly as
 * `Request.text()` would (UTF-8, BOM stripped, malformed bytes replaced), so the signed raw text is unchanged.
 */
export async function readBoundedText(req: Request, maxBytes: number): Promise<string> {
  const tooLarge = () => new HttpError(413, "too_large", "That's too much to send in one go.");
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks, total));
}

/**
 * Reads a consumer request: 503 `consumer_unavailable` when no key is configured (in every mode, not only live), 401 `consumer_unauthorized`
 * unless the signature over method, path and the exact body text verifies within five minutes, then the parsed JSON.
 */
export async function readConsumerJson(req: Request, maxBytes: number): Promise<unknown> {
  const key = consumerKey();
  if (!key) throw new HttpError(503, "consumer_unavailable", "The order authorization port isn't set up on this server.");
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, "too_large", "That's too much to send in one go.");
  const text = await readBoundedText(req, maxBytes);
  const ok = verifyConsumerSignature(key, { timestamp: req.headers.get(CONSUMER_HEADERS.timestamp), signature: req.headers.get(CONSUMER_HEADERS.signature) }, req.method, new URL(req.url).pathname, text);
  if (!ok) throw new HttpError(401, "consumer_unauthorized", "That request isn't signed by a known consumer.");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "bad_json", "Send a JSON body.");
  }
}

const bad = (m: string) => new HttpError(400, "bad_request", m);
const REF = /^[\w.:-]{8,128}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number, what: string): string => {
  if (typeof v !== "string" || v.length === 0 || v.length > max) throw bad(`${what} is not valid.`);
  return v;
};
const hex = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !HEX64.test(v)) throw bad(`${what} must be a SHA-256 hex digest.`);
  return v;
};
const int = (v: unknown, min: number, max: number, what: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw bad(`${what} is not valid.`);
  return v;
};

/** Validates a terms object from a body into the exact OrderAuthTerms shape (unknown keys dropped), 400 when anything is missing or the wrong type. */
export function parseTerms(v: unknown): OrderAuthTerms {
  if (!isObj(v) || !isObj(v.options) || !isObj(v.quote) || !isObj(v.destination) || !isObj(v.design)) throw bad("Send the full terms: orderRef, sku, options, quote, destination, design, approvalId, capabilityVersion.");
  if (!(v.sku === null || typeof v.sku === "string")) throw bad("sku must be a string or null.");
  const orderRef = str(v.orderRef, 64, "orderRef");
  if (!REF.test(orderRef)) throw bad("orderRef is not valid.");
  const destRef = str(v.destination.ref, 128, "destination.ref");
  if (!REF.test(destRef)) throw bad("destination.ref must be an opaque reference.");
  return {
    orderRef,
    sku: v.sku === null ? null : str(v.sku, 128, "sku"),
    options: { variantId: str(v.options.variantId, 64, "options.variantId"), material: str(v.options.material, 32, "options.material"), finish: str(v.options.finish, 32, "options.finish"), size: str(v.options.size, 32, "options.size"), quantity: int(v.options.quantity, 1, 1000, "options.quantity") },
    quote: { id: str(v.quote.id, 200, "quote.id"), amountMinor: int(v.quote.amountMinor, 0, 1_000_000_000, "quote.amountMinor"), currency: str(v.quote.currency, 8, "quote.currency") },
    destination: { ref: destRef, digest: hex(v.destination.digest, "destination.digest") },
    design: { versionId: str(v.design.versionId, 128, "design.versionId"), designHash: hex(v.design.designHash, "design.designHash"), artHash: hex(v.design.artHash, "design.artHash"), factsHash: hex(v.design.factsHash, "design.factsHash"), compositionHash: hex(v.design.compositionHash, "design.compositionHash") },
    approvalId: str(v.approvalId, 64, "approvalId"),
    capabilityVersion: str(v.capabilityVersion, 64, "capabilityVersion"),
  };
}

/** The consumer's expectation from a request body: tenant, project, action, provider and the full terms. */
export function parseExpect(v: unknown, withClaim = false): OrderAuthExpectation {
  if (!isObj(v)) throw bad("Send { expect: { tenant, project, action, provider, terms } }.");
  const project = typeof v.project === "string" ? /^(stub):([\w.:-]{1,128})$/.exec(v.project) : null;
  if (!project) throw bad("expect.project must be stub:<id>.");
  const out: OrderAuthExpectation = {
    tenant: str(v.tenant, 160, "expect.tenant"),
    project: { kind: project[1], id: project[2] },
    action: str(v.action, 64, "expect.action"),
    provider: str(v.provider, 32, "expect.provider"),
    terms: parseTerms(v.terms),
  };
  if (withClaim) out.claimReference = str(v.claimReference, 64, "expect.claimReference");
  return out;
}

export function parseIdempotencyKey(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9_.:-]{8,128}$/.test(v)) throw bad("idempotencyKey must be 8 to 128 characters of letters, digits and _ . : -.");
  return v;
}

/** Refusals worth an event: the token was genuine and the scope was the consumer's own, so the tenant it is attributed to is the token's. */
export const LOGGED_REFUSALS: ReadonlySet<string> = new Set(["changed_terms", "revoked", "expired", "stale_approval", "stale", "not_orderable", "already_claimed", "not_claimed", "idempotency_conflict"]);

export const ORDER_AUTH_REASON_STATUS: Record<string, number> = { already_claimed: 409, idempotency_conflict: 409 };

/** Signature, shape, scope and terms from the token alone, then the issuer's record of the id. A failure here needs no storage state to be final. */
async function preflight(token: string, expect: OrderAuthExpectation, now: number, intent: OrderAuthIntent): Promise<{ key: OrderAuthKeys; id: string } | { fail: OrderAuthVerifyResult & { ok: false } }> {
  const keyring = orderAuthKeyring();
  if (!keyring) return { fail: { ok: false, reason: "forged" } }; // no usable key set, nothing can be valid
  const key: OrderAuthKeys = (kid, keyTime) => keyring.lookup(kid, now, keyTime);
  const first = verifyOrderAuthorization(token, key, expect, now, undefined, intent);
  if (!first.ok && (first.reason === "invalid_clock" || first.reason === "unknown" || first.reason === "forged" || first.reason === "unsupported_version")) return { fail: first };
  const id = orderAuthIdOf(token);
  return id ? { key, id } : { fail: { ok: false, reason: "unknown" } };
}

function tokenRecord(token: string): unknown {
  try {
    return (JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { authorization?: unknown }).authorization;
  } catch {
    return null;
  }
}

/** A signed record that differs from what we stored under that id is not something we issued. */
const storedMatches = (snap: OrderAuthSnapshot, token: string) => !!snap.auth && canonicalJson(JSON.parse(snap.auth.record)) === canonicalJson(tokenRecord(token));

/** Read-only verify: what the issuer says about a token right now, for the exact scope and terms the consumer holds. Never claims. */
export async function verifyOrderAuthorizationLive(token: string, expect: OrderAuthExpectation, now = Date.now()): Promise<OrderAuthVerifyResult> {
  const pre = await preflight(token, expect, now, "verify");
  if ("fail" in pre) return pre.fail;
  const snap = await getStorage().getOrderAuthSnapshot(pre.id);
  if (!snap.auth) return { ok: false, reason: "unknown" };
  if (!storedMatches(snap, token)) return { ok: false, reason: "forged" };
  return verifyOrderAuthorization(token, pre.key, expect, now, stateOf(snap, parseRecord(snap.auth), null, now), "verify");
}

export interface ClaimResult {
  authorizationId: string;
  actionId: string;
  claimReference: string;
  claimedAt: string;
}
const claimResult = (c: OrderClaimRow): ClaimResult => ({ authorizationId: c.authorizationId, actionId: c.actionId, claimReference: c.claimRef, claimedAt: iso(c.claimedAt) });

/**
 * The atomic single-use claim. First claim wins; the same key replays the same claim while the authority still stands; a different key
 * after a claim is already_claimed; the same key on another authorization is idempotency_conflict. Checked and committed in one write lock.
 */
export async function claimOrderAuthorization(token: string, expect: OrderAuthExpectation, idemKey: string, now = Date.now()): Promise<{ ok: true; claim: ClaimResult; replayed: boolean } | (OrderAuthVerifyResult & { ok: false })> {
  const pre = await preflight(token, expect, now, "claim");
  if ("fail" in pre) return pre.fail;
  const out = await getStorage().claimOrderAuthorization(pre.id, CONSUMER_ID, idemKey, newClaimRef(), now, (snap) => {
    if (!snap.auth) return { ok: false, reason: "unknown" };
    if (!storedMatches(snap, token)) return { ok: false, reason: "forged" };
    const rec = parseRecord(snap.auth);
    const r = verifyOrderAuthorization(token, pre.key, expect, now, stateOf(snap, rec, { consumer: CONSUMER_ID, idemKey }, now), "claim");
    if (!r.ok) return r;
    if (snap.claimByKey && snap.claimByKey.authorizationId !== snap.auth.id) return { ok: false, reason: "idempotency_conflict" };
    return { ok: true };
  });
  if (!out.ok) return { ok: false, reason: out.reason as OrderAuthFailure, ...(out.fields ? { fields: out.fields } : {}) };
  return { ok: true, claim: claimResult(out.claim), replayed: out.replayed };
}

/**
 * Dispatch-time revalidation: the connector holds a committed claim and is about to send. Re-checks everything now: scope and terms,
 * revoked, expired, the approval still current, membership, capability version, the order gate, and that this claim is the committed one.
 */
export async function revalidateOrderAuthorization(token: string, expect: OrderAuthExpectation, now = Date.now()): Promise<OrderAuthVerifyResult> {
  const pre = await preflight(token, expect, now, "revalidate");
  if ("fail" in pre) return pre.fail;
  const snap = await getStorage().getOrderAuthSnapshot(pre.id, CONSUMER_ID);
  if (!snap.auth) return { ok: false, reason: "unknown" };
  if (!storedMatches(snap, token)) return { ok: false, reason: "forged" };
  const st = stateOf(snap, parseRecord(snap.auth), { consumer: CONSUMER_ID, idemKey: snap.claim?.idemKey }, now);
  return verifyOrderAuthorization(token, pre.key, expect, now, st, "revalidate");
}

export type LookupResult =
  | { found: true; claim: ClaimResult; authority: { ok: true } | { ok: false; reason: string } }
  | { found: false; authorizationClaimed?: boolean };

/**
 * Unknown-claim reconciliation: "did my claim under this key commit?". Scoped by tenant and project, so a key that belongs to someone else
 * answers found:false, the same as a key never used. found:false is definitive: a claim commits in one write lock, so there is no in-flight
 * state; the consumer may retry the claim with the same key. `authority` is what a dispatch-time revalidate would say now.
 */
export async function lookupOrderClaim(tenant: string, stubId: string, idemKey: string, authorizationId: string | null, now = Date.now()): Promise<LookupResult> {
  const storage = getStorage();
  const hit = await storage.findOrderClaim(CONSUMER_ID, idemKey);
  if (hit && hit.claim.tenant === tenant && hit.project === stubId) {
    const snap = await storage.getOrderAuthSnapshot(hit.claim.authorizationId, CONSUMER_ID, idemKey);
    const rec = parseRecord(snap.auth as OrderAuthRow);
    const keyring = orderAuthKeyring();
    if (!keyring) return { found: true, claim: claimResult(hit.claim), authority: { ok: false, reason: "forged" } };
    const r = verifyOrderAuthorization(signOrderAuthorization(rec, keyring.signer()), (kid, keyTime) => keyring.lookup(kid, now, keyTime), { ...selfExpect(rec), claimReference: hit.claim.claimRef }, now, stateOf(snap, rec, { consumer: CONSUMER_ID, idemKey }, now), "revalidate");
    return { found: true, claim: claimResult(hit.claim), authority: r.ok ? { ok: true } : { ok: false, reason: r.reason } };
  }
  if (authorizationId) {
    const snap = await storage.getOrderAuthSnapshot(authorizationId);
    if (snap.auth && snap.auth.tenant === tenant && snap.auth.project === stubId && snap.claim) return { found: false, authorizationClaimed: true };
  }
  return { found: false };
}

/** The set of providers a consumer may name. */
export const isProvider = (v: unknown): v is OrderAuthProvider => typeof v === "string" && (ORDER_AUTH_PROVIDERS as readonly string[]).includes(v);
