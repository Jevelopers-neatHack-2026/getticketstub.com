// The order authorization record (ticketstub.order-authorization/1), its signed token and its verifier. Pure
// (node:crypto only, no app imports) so the fixture generator, the unit tests and scripts/check-order-auth.mjs run
// this exact code under plain Node. Only server code imports it; the offline reference for consumers is
// fixtures/order-authorization/verify.mjs.
//
// An order authorization says: this signed-in owner confirmed THIS exact action (submit one order to one provider)
// for THIS exact SKU, options, quote amount, destination reference and design, once, until expiresAt. It is not
// an artwork approval (it REFERENCES one and never stands in for it), not a payment, and not a promise that a provider
// will accept anything. Revocation, staleness and claims are not in the token: they are the issuer's current answer,
// passed to the verifier as `state` (see verifyOrderAuthorization).
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const ORDER_AUTH_SCHEMA = "ticketstub.order-authorization/1";
/** The one action this version can authorize. Cancel, refund and reship are not supported (docs/architecture/order-authorization.md). */
export const ORDER_AUTH_ACTIONS = ["fulfillment.submit"] as const;
export type OrderAuthAction = (typeof ORDER_AUTH_ACTIONS)[number];
export const ORDER_AUTH_PROVIDERS = ["sandbox", "prodigi"] as const;
export type OrderAuthProvider = (typeof ORDER_AUTH_PROVIDERS)[number];
/** The consumer a record is addressed to. A record addressed to anyone else is wrong_scope. */
export const ORDER_AUTH_AUDIENCE = "fulfillment-connectors";
export const ORDER_AUTH_TTL_MS = 15 * 60_000;
/** What an authorization never grants. Part of the signed record. */
export const ORDER_AUTH_NOT_AUTHORIZED = ["payment", "refund", "other_orders", "destination_change", "asset_rights"] as const;

export type OrderAuthFailure =
  | "unknown"
  | "forged"
  | "unsupported_version"
  | "wrong_scope"
  | "changed_terms"
  | "revoked"
  | "expired"
  | "stale_approval"
  | "stale"
  | "not_orderable"
  | "already_claimed"
  | "not_claimed"
  | "idempotency_conflict"
  | "invalid_clock";
export const ORDER_AUTH_FAILURES: readonly OrderAuthFailure[] = [
  "unknown", "forged", "unsupported_version", "wrong_scope", "changed_terms", "revoked", "expired", "stale_approval", "stale", "not_orderable", "already_claimed", "not_claimed", "idempotency_conflict", "invalid_clock",
];

export interface OrderAuthDesign {
  versionId: string;
  designHash: string;
  artHash: string;
  factsHash: string;
  compositionHash: string;
}

/** Everything the consumer must name to prove it holds the same purchase the customer confirmed. Any difference is changed_terms. */
export interface OrderAuthTerms {
  orderRef: string;
  /** The confirmed supplier SKU. Null while the capability map holds none (every variant today). Never guessed. */
  sku: string | null;
  options: { variantId: string; material: string; finish: string; size: string; quantity: number };
  /** The quote the customer saw and confirmed: its id and the maximum exact amount. */
  quote: { id: string; amountMinor: number; currency: string };
  /** An opaque reference to the destination the connector holds, and its digest. Never an address. */
  destination: { ref: string; digest: string };
  design: OrderAuthDesign;
  /** The print.compose approval this authorization references. A reference, never an inference. */
  approvalId: string;
  capabilityVersion: string;
}

export interface OrderAuthRecord {
  schema: typeof ORDER_AUTH_SCHEMA;
  id: string;
  issuer: "ticketstub";
  audience: typeof ORDER_AUTH_AUDIENCE;
  tenant: { id: string };
  project: { kind: "stub"; id: string };
  actor: { kind: "account"; id: string };
  action: OrderAuthAction;
  provider: OrderAuthProvider;
  /** The logical action: stable across renewals of the same orderRef, so a renewal never opens a second dispatch. */
  actionId: string;
  command: { name: "submit_order"; hash: string };
  terms: OrderAuthTerms;
  approval: { id: string; purpose: "print.compose" };
  /** The customer's idempotency key for issuing, not the consumer's claim key. */
  idempotencyKey: string;
  membershipRevision: number;
  notAuthorizes: typeof ORDER_AUTH_NOT_AUTHORIZED;
  environment: "development" | "preview" | "live";
  mode: "fixture" | "sandbox" | "live";
  issuedAt: string;
  expiresAt: string;
}

/** What the issuer says right now. Without it only signature, version, scope, terms and expiry are checked. */
export interface OrderAuthState {
  /** False when the issuer has no record of this id. */
  known?: boolean;
  revoked?: boolean;
  /** A newer authorization exists for the same action (the customer renewed it). */
  superseded?: boolean;
  /** The referenced approval as the approval issuer reads it right now. */
  approval?: "active" | "revoked" | "expired" | "stale" | "missing";
  membershipRevision?: number;
  capabilityVersion?: string;
  /** Whether the variant and provider still pass the order gate in the issuer's runtime mode. */
  orderable?: boolean;
  /** The committed claim on this authorization, if any. keyMatches: it was made under the idempotency key being asked about. */
  claim?: { reference: string; keyMatches: boolean } | null;
}

/** What the consumer says it is doing and holding. Every part is required; a consumer that holds less cannot say the authorization fits. */
export interface OrderAuthExpectation {
  tenant?: string;
  project?: { kind: string; id: string };
  action?: string;
  provider?: string;
  terms?: unknown;
  /** For revalidate: the claim reference the consumer was given. */
  claimReference?: string;
}

export type OrderAuthIntent = "verify" | "claim" | "revalidate";
export type OrderAuthVerifyResult = { ok: true; authorization: OrderAuthRecord } | { ok: false; reason: OrderAuthFailure; fields?: string[] };

// ---------------------------------------------------------------------------------------------
// Canonical JSON and hashing (the same canonicalization as approval-token.ts, kept separate so each record stands alone)
// ---------------------------------------------------------------------------------------------

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}
export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
export const hashJson = (v: unknown): string => sha256Hex(canonicalJson(v));
export const HEX64 = /^[a-f0-9]{64}$/;

/** The hash of the exact purchase: action, provider and every term. The consumer can recompute it from what it holds. */
export const commandHash = (action: string, provider: string, terms: OrderAuthTerms): string => hashJson({ action, provider, terms });

/** The logical fulfillment action: tenant, project, action and the customer's order reference. Provider, amount and destination are not in it, so a renewal keeps it. */
export const actionIdOf = (tenant: string, project: { kind: string; id: string }, action: string, orderRef: string): string =>
  `act_${hashJson({ tenant, project, action, orderRef }).slice(0, 32)}`;

/** The top-level and nested term names that differ between two term sets, as dotted paths. Names only, never values. */
export function termDiffs(held: unknown, bound: unknown, prefix = ""): string[] {
  const isO = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isO(held) || !isO(bound)) return canonicalJson(held) === canonicalJson(bound) ? [] : [prefix || "terms"];
  const out: string[] = [];
  for (const k of new Set([...Object.keys(held), ...Object.keys(bound)])) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (isO(held[k]) && isO(bound[k])) out.push(...termDiffs(held[k], bound[k], path));
    else if (canonicalJson(held[k]) !== canonicalJson(bound[k])) out.push(path);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Signing and verifying
// ---------------------------------------------------------------------------------------------

const MAX_TOKEN_CHARS = 8192;
const HEADER = { alg: "HS256", typ: "ticketstub.order-authorization" } as const;
const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isIso = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v));

/** The key that signs: its `kid` goes in the header. On the server it is the active key of ORDER_AUTH_SIGNING_KEYS. */
export interface OrderAuthSigningKey {
  kid: string;
  key: string | Buffer;
}
/** The keys a verifier accepts, by kid: a lookup function (the server's keyring) or a plain { kid: key } map. An unknown kid verifies nothing. */
export type OrderAuthKeys = ((kid: string, keyTimeMs: number) => string | Buffer | null | undefined) | Readonly<Record<string, string | Buffer>>;
const KID = /^[A-Za-z0-9._-]{1,64}$/;

/** Claimed signing time, authenticated before acceptance. Legacy tokens fall back to record issue time. */
function keyFor(keys: OrderAuthKeys, kid: string, keyTimeMs: number): string | Buffer | null {
  const k = typeof keys === "function" ? keys(kid, keyTimeMs) : Object.hasOwn(keys, kid) ? keys[kid] : null;
  return (typeof k === "string" && k.length > 0) || (Buffer.isBuffer(k) && k.length > 0) ? k : null;
}

/** Signs the unchanged record with the actual signing time. An explicit clock is for deterministic fixtures. */
export function signOrderAuthorization(record: OrderAuthRecord, signer: OrderAuthSigningKey, signedAtMs = Date.now()): string {
  if (!KID.test(signer.kid)) throw new Error("order authorization signing key has an invalid kid");
  if (!Number.isFinite(signedAtMs) || signedAtMs <= 0) throw new Error("order authorization signing clock is invalid");
  const head = b64(JSON.stringify({ ...HEADER, kid: signer.kid, signedAt: new Date(signedAtMs).toISOString() }));
  const body = b64(JSON.stringify({ authorization: record }));
  const sig = createHmac("sha256", signer.key).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

function shaped(v: unknown): v is OrderAuthRecord {
  if (!isObj(v) || !isObj(v.tenant) || !isObj(v.project) || !isObj(v.actor) || !isObj(v.command) || !isObj(v.terms) || !isObj(v.approval)) return false;
  const t = v.terms;
  if (typeof v.id !== "string" || typeof v.tenant.id !== "string" || v.project.kind !== "stub" || typeof v.project.id !== "string") return false;
  if (v.actor.kind !== "account" || typeof v.actor.id !== "string" || typeof v.action !== "string" || typeof v.provider !== "string" || typeof v.actionId !== "string") return false;
  if (typeof v.command.hash !== "string" || !HEX64.test(v.command.hash) || typeof v.approval.id !== "string" || v.audience !== ORDER_AUTH_AUDIENCE) return false;
  if (typeof t.orderRef !== "string" || !(t.sku === null || typeof t.sku === "string") || !isObj(t.options) || !isObj(t.quote) || !isObj(t.destination) || !isObj(t.design)) return false;
  if (!Number.isInteger(t.quote.amountMinor) || typeof t.quote.id !== "string" || typeof t.quote.currency !== "string") return false;
  if (typeof t.destination.ref !== "string" || typeof t.destination.digest !== "string" || !HEX64.test(t.destination.digest)) return false;
  if (![t.design.designHash, t.design.artHash, t.design.factsHash, t.design.compositionHash].every((h) => typeof h === "string" && HEX64.test(h))) return false;
  if (!Number.isInteger(v.membershipRevision) || !Array.isArray(v.notAuthorizes) || !isIso(v.issuedAt) || !isIso(v.expiresAt) || typeof v.idempotencyKey !== "string") return false;
  return ["development", "preview", "live"].includes(String(v.environment)) && ["fixture", "sandbox", "live"].includes(String(v.mode));
}

/** The id inside a token, without checking anything. For lookups; never for trusting. */
export function orderAuthIdOf(token: string): string | null {
  try {
    const id = (JSON.parse(unb64(token.split(".")[1] ?? "").toString("utf8")) as { authorization?: { id?: unknown } }).authorization?.id;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/**
 * Checks in this order, first failure wins:
 *   invalid_clock (`now` is not a finite number > 0: the verifier's own clock is bad, nothing can be judged; checked first of all)
 *   -> unknown (not a token, no or malformed kid, or the issuer has no such record) -> forged (unknown kid, or HMAC, constant time) -> unsupported_version
 *   -> wrong_scope (tenant, project, audience, action or provider differs from the consumer's)
 *   -> changed_terms (any term the consumer holds differs from the bound one: SKU, options, quote, amount, currency, destination, design, approval, capability version)
 *   -> revoked -> expired -> stale_approval (the referenced approval is not active now) -> stale (renewed, membership or capability version moved)
 *   -> not_orderable (the variant or provider no longer passes the order gate)
 *   -> claim rules by intent: verify refuses any claim (already_claimed); claim allows only a replay under the same key; revalidate needs the claim it was given (not_claimed).
 * revoked, stale and the rest need `state`; without it they are not checked.
 */
export function verifyOrderAuthorization(
  token: string,
  keys: OrderAuthKeys,
  expect: OrderAuthExpectation,
  now = Date.now(),
  state?: OrderAuthState,
  intent: OrderAuthIntent = "verify",
): OrderAuthVerifyResult {
  const no = (reason: OrderAuthFailure, fields?: string[]): OrderAuthVerifyResult => ({ ok: false, reason, ...(fields ? { fields } : {}) });
  if (typeof now !== "number" || !Number.isFinite(now) || now <= 0) return no("invalid_clock");
  if (typeof token !== "string" || token.length > MAX_TOKEN_CHARS) return no("unknown");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return no("unknown");
  let head: unknown;
  let body: unknown;
  try {
    head = JSON.parse(unb64(parts[0]).toString("utf8"));
    body = JSON.parse(unb64(parts[1]).toString("utf8"));
  } catch {
    return no("unknown");
  }
  if (!isObj(head) || head.alg !== HEADER.alg || head.typ !== HEADER.typ || typeof head.kid !== "string" || !KID.test(head.kid) || !isObj(body)) return no("unknown");
  const claimedSigned = typeof head.signedAt === "string" ? Date.parse(head.signedAt) : Number.NaN;
  const stamped = Object.hasOwn(head, "signedAt");
  if (stamped && (!Number.isFinite(claimedSigned) || claimedSigned <= 0 || new Date(claimedSigned).toISOString() !== head.signedAt)) return no("unknown");
  // Retain bounded rotation compatibility for old tokens. Their record time cannot identify an old-code late re-sign.
  const keyTime = stamped ? claimedSigned : isObj(body.authorization) && typeof body.authorization.issuedAt === "string" ? Date.parse(body.authorization.issuedAt) : Number.NaN;
  const key = keyFor(keys, head.kid, keyTime);
  if (!key) return no("forged"); // an unknown kid, or a retired key past retention: no key we hold signed it
  const want = createHmac("sha256", key).update(`${parts[0]}.${parts[1]}`).digest();
  const got = unb64(parts[2]);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return no("forged");
  const rec = body.authorization;
  if (!isObj(rec)) return no("unknown");
  if (rec.schema !== ORDER_AUTH_SCHEMA) return no("unsupported_version");
  if (!shaped(rec)) return no("unknown");
  if (state?.known === false) return no("unknown");
  const scopeOk =
    expect.tenant === rec.tenant.id && expect.project?.kind === rec.project.kind && expect.project?.id === rec.project.id &&
    expect.action === rec.action && (ORDER_AUTH_ACTIONS as readonly string[]).includes(rec.action) && expect.provider === rec.provider && (ORDER_AUTH_PROVIDERS as readonly string[]).includes(rec.provider);
  if (!scopeOk) return no("wrong_scope");
  const diffs = termDiffs(expect.terms, rec.terms);
  if (diffs.length || commandHash(rec.action, rec.provider, rec.terms) !== rec.command.hash) return no("changed_terms", diffs.length ? diffs.sort() : ["command"]);
  if (state?.revoked) return no("revoked");
  if (Date.parse(rec.expiresAt) <= now) return no("expired");
  if (state) {
    if (state.approval !== undefined && state.approval !== "active") return no("stale_approval");
    if (state.superseded) return no("stale");
    if (state.membershipRevision !== undefined && state.membershipRevision !== rec.membershipRevision) return no("stale");
    if (state.capabilityVersion !== undefined && state.capabilityVersion !== rec.terms.capabilityVersion) return no("stale");
    if (state.orderable === false) return no("not_orderable");
    const claim = state.claim ?? null;
    if (intent === "revalidate") {
      if (!claim || claim.reference !== expect.claimReference) return no("not_claimed");
    } else if (claim && (intent === "verify" || !claim.keyMatches)) return no("already_claimed");
  }
  return { ok: true, authorization: rec };
}

// ---------------------------------------------------------------------------------------------
// Consumer request signing (the stopgap consumer authentication; see docs/architecture/order-authorization.md)
// ---------------------------------------------------------------------------------------------

export const CONSUMER_SKEW_MS = 5 * 60_000;
export const CONSUMER_HEADERS = { timestamp: "x-ticketstub-consumer-timestamp", signature: "x-ticketstub-consumer-signature" } as const;

/** HMAC-SHA256 (hex) over `<timestamp ms>\n<METHOD>\n<path>\n<sha256 of the exact body text>`. */
export function consumerSignature(key: string | Buffer, timestamp: number, method: string, path: string, bodyText: string): string {
  return createHmac("sha256", key).update(`${timestamp}\n${method.toUpperCase()}\n${path}\n${sha256Hex(bodyText)}`).digest("hex");
}

/** True when the signature matches and the timestamp is within five minutes of `now`. Constant time on the signature. */
export function verifyConsumerSignature(key: string | Buffer, headers: { timestamp: string | null; signature: string | null }, method: string, path: string, bodyText: string, now = Date.now()): boolean {
  if (!headers.timestamp || !headers.signature || !/^\d{10,16}$/.test(headers.timestamp) || !/^[a-f0-9]{64}$/.test(headers.signature)) return false;
  const ts = Number(headers.timestamp);
  if (Math.abs(now - ts) > CONSUMER_SKEW_MS) return false;
  const want = Buffer.from(consumerSignature(key, ts, method, path, bodyText), "hex");
  const got = Buffer.from(headers.signature, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}
