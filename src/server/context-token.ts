// The signed request context: types, the signer and the verifier. Pure (node:crypto only, no app imports)
// so the smoke test and the fixture generator run this exact code under plain Node. Only server code
// imports it; scripts/smoke-server.mjs checks that no client chunk does.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { EconomicMode, Environment, EvidenceMode } from "./context-modes";

// Two schema versions verify side by side. /1 is unchanged for existing consumers. /2 changes what fields
// mean (actor and tenant ids are kind-prefixed, `mode` is split into three axes) and adds finance grants,
// so it is a new version rather than an additive /1.x. See docs/architecture/identity.md, "Context /2".
export const CONTEXT_SCHEMA = "ticketstub.context/1";
export const CONTEXT_SCHEMA_V2 = "ticketstub.context/2";
export type Role = "owner" | "captain" | "member" | "viewer" | "staff" | "none";
export const ROLES: readonly Role[] = ["owner", "captain", "member", "viewer", "staff", "none"];

export interface RequestContext {
  schema: typeof CONTEXT_SCHEMA;
  actor: { kind: "account"; id: string } | { kind: "guest"; id: string } | { kind: "anonymous" };
  tenant: { id: string }; // account id, or guest:<id>
  project?: { id: string; kind: "stub" | "event" };
  role: Role;
  capabilities: string[]; // e.g. "stub.read", "stub.write", "event.publish", "admin.view"
  membershipRevision: number;
  revoked: boolean;
  environment: "development" | "preview" | "live";
  mode: "fixture" | "sandbox" | "live";
  issuedAt: string; // ISO
  expiresAt: string; // ISO
}

/**
 * ticketstub.context/2. Injective ids: `actor.id` is `<kind>:<raw id>` and `tenant.id` equals it, so an account
 * and a guest (or two future kinds) can never share an id. `project.ref` is `<kind>:<id>`. The three mode axes
 * are separate fields (see context-modes.ts). `audience` names the host the token was minted for.
 */
export interface ContextV2 {
  schema: typeof CONTEXT_SCHEMA_V2;
  issuer: string;
  audience: string;
  actor: { kind: "account" | "guest" | "anonymous"; id: string };
  tenant: { id: string };
  project?: { id: string; kind: "stub" | "event"; ref: string };
  role: Role;
  capabilities: string[];
  membershipRevision: number;
  revoked: boolean;
  environment: Environment;
  economicMode: EconomicMode;
  evidenceMode: EvidenceMode;
  issuedAt: string;
  expiresAt: string;
}

export type AnyContext = RequestContext | ContextV2;

export const ISSUER = "getticketstub.com";
export const DEFAULT_AUDIENCE = "ticketstub.finance";

export type VerifyFailure = "unknown" | "forged" | "stale" | "revoked" | "expired" | "unsupported_version" | "wrong_audience";
export type VerifyResult = { ok: true; ctx: AnyContext } | { ok: false; reason: VerifyFailure };

/** Options a verifier brings itself. `audience` is the host the verifier is: a /2 token for another audience, or checked with no audience named, is wrong_audience. */
export interface VerifyOptions {
  audience?: string;
}

/**
 * What the issuer currently says about the token's subject. Without it a verifier can only prove the
 * signature, the version and the expiry; stale and revoked need this (see verifyContextTokenLive).
 */
export interface TokenState {
  /** The account's current membershipRevision. */
  membershipRevision?: number;
  /** False when the session the token was issued for is gone (signed out, expired, account deleted). */
  sessionLive?: boolean;
  /** /2 only. False when the account no longer holds the token's project (the stub is gone, the event has another captain). */
  projectMember?: boolean;
}

export const TOKEN_TTL_MS = 5 * 60_000;
const MAX_TOKEN_CHARS = 8192;
const HEADER = { alg: "HS256", typ: "ticketstub.context" } as const;

const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");

/** Signs a context. `sid` is a non-secret reference to the session it was derived from, for revocation. */
export function signContext(ctx: AnyContext, key: string | Buffer, sid: string | null = null): string {
  const head = b64(JSON.stringify(HEADER));
  const body = b64(JSON.stringify({ ctx, sid }));
  const sig = createHmac("sha256", key).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const PROJECT_ID_RE = /^[\w.:-]{1,128}$/;
const RAW_ID_RE = /^[\w.:-]{1,128}$/;
const ECONOMIC = ["none", "sandbox", "paid_test", "live"];
const EVIDENCE = ["fixture", "synthetic", "live"];
const ENVIRONMENTS = ["development", "preview", "live"];

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";
/** An enum member. A value must BE a string first: an array or object that would stringify to a member is not one. */
const oneOf = (list: readonly string[], v: unknown): v is string => typeof v === "string" && list.includes(v);

/** (environment, economicMode) pairs a verifier accepts. Mirrors modesConsistent in context-modes.ts and verify.mjs. */
function modesConsistent(environment: string, economicMode: string): boolean {
  return environment === "live" ? economicMode !== "paid_test" : economicMode !== "live";
}

/** Fields both versions share: tenant, role, capabilities, revision, revoked and the two times. */
function shapedCommon(v: Record<string, unknown>): boolean {
  if (!isObj(v.tenant) || !nonEmpty(v.tenant.id) || !oneOf(ROLES, v.role)) return false;
  if (!Array.isArray(v.capabilities) || !v.capabilities.every((c) => typeof c === "string")) return false;
  if (!Number.isInteger(v.membershipRevision) || typeof v.revoked !== "boolean") return false;
  return typeof v.issuedAt === "string" && typeof v.expiresAt === "string" && !Number.isNaN(Date.parse(v.issuedAt)) && !Number.isNaN(Date.parse(v.expiresAt));
}

function shapedV1(v: unknown): v is RequestContext {
  if (!isObj(v) || !isObj(v.actor) || !shapedCommon(v)) return false;
  if (!oneOf(["account", "guest", "anonymous"], v.actor.kind)) return false;
  if (v.actor.kind !== "anonymous" && !nonEmpty(v.actor.id)) return false;
  if (!oneOf(ENVIRONMENTS, v.environment) || !oneOf(["fixture", "sandbox", "live"], v.mode)) return false;
  return v.project === undefined || (isObj(v.project) && typeof v.project.id === "string" && PROJECT_ID_RE.test(v.project.id) && oneOf(["stub", "event"], v.project.kind));
}

/** Finance grants are explicit strings. An unknown `finance.*` string, or any at all for a non-account actor, is malformed. */
function financeCapsOk(caps: string[], actorKind: string): boolean {
  const fin = caps.filter((c) => c.startsWith("finance."));
  return fin.length === 0 || (actorKind === "account" && fin.every((c) => (FINANCE_CAPS as readonly string[]).includes(c)));
}

function shapedV2(v: unknown): v is ContextV2 {
  if (!isObj(v) || !isObj(v.actor) || !shapedCommon(v) || !nonEmpty(v.issuer) || !nonEmpty(v.audience) || v.audience.length > 128) return false;
  const kind = v.actor.kind;
  if (kind !== "account" && kind !== "guest" && kind !== "anonymous") return false;
  // Injective: the id carries its kind, and the tenant is the same string.
  const id = v.actor.id;
  const idOk = kind === "anonymous" ? id === "anonymous:0" : typeof id === "string" && id.startsWith(`${kind}:`) && RAW_ID_RE.test(id.slice(kind.length + 1));
  if (!idOk || (v.tenant as { id: unknown }).id !== id) return false;
  if (!oneOf(ENVIRONMENTS, v.environment) || !oneOf(ECONOMIC, v.economicMode) || !oneOf(EVIDENCE, v.evidenceMode)) return false;
  if (!modesConsistent(v.environment, v.economicMode)) return false;
  if (!financeCapsOk(v.capabilities as string[], kind)) return false;
  const p = v.project;
  return p === undefined || (isObj(p) && typeof p.id === "string" && PROJECT_ID_RE.test(p.id) && (p.kind === "stub" || p.kind === "event") && p.ref === `${p.kind}:${p.id}`);
}

/** The session reference a token was issued for, or null (guests and anonymous callers have none). */
export function tokenSessionRef(token: string): string | null {
  try {
    const sid = (JSON.parse(unb64(token.split(".")[1] ?? "").toString("utf8")) as { sid?: unknown }).sid;
    return typeof sid === "string" ? sid : null;
  } catch {
    return null;
  }
}

/**
 * Checks a token in this order: shape (unknown), HMAC in constant time (forged), schema version
 * (unsupported_version), that version's own shape (unknown), expiry (expired), audience (wrong_audience: /2
 * only, and a verifier that names no audience is refused the same way), session and project membership (revoked), membership
 * revision (stale). The last two run only when `state` is given.
 */
export function verifyWithKey(token: string, key: string | Buffer, now = Date.now(), state?: TokenState, opts?: VerifyOptions): VerifyResult {
  if (typeof token !== "string" || token.length > MAX_TOKEN_CHARS) return { ok: false, reason: "unknown" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: "unknown" };
  let head: unknown;
  let body: unknown;
  try {
    head = JSON.parse(unb64(parts[0]).toString("utf8"));
    body = JSON.parse(unb64(parts[1]).toString("utf8"));
  } catch {
    return { ok: false, reason: "unknown" };
  }
  if (!isObj(head) || head.alg !== HEADER.alg || head.typ !== HEADER.typ || !isObj(body)) return { ok: false, reason: "unknown" };
  const want = createHmac("sha256", key).update(`${parts[0]}.${parts[1]}`).digest();
  const got = unb64(parts[2]);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: "forged" };
  const raw = body.ctx;
  if (!isObj(raw)) return { ok: false, reason: "unknown" };
  if (raw.schema !== CONTEXT_SCHEMA && raw.schema !== CONTEXT_SCHEMA_V2) return { ok: false, reason: "unsupported_version" };
  if (raw.schema === CONTEXT_SCHEMA ? !shapedV1(raw) : !shapedV2(raw)) return { ok: false, reason: "unknown" };
  const ctx = raw as unknown as AnyContext;
  const v2 = ctx.schema === CONTEXT_SCHEMA_V2;
  if (Date.parse(ctx.expiresAt) <= now) return { ok: false, reason: "expired" };
  if (v2 && (typeof opts?.audience !== "string" || opts.audience === "" || ctx.audience !== opts.audience)) return { ok: false, reason: "wrong_audience" };
  if (ctx.revoked || state?.sessionLive === false || (v2 && state?.projectMember === false)) return { ok: false, reason: "revoked" };
  if (state?.membershipRevision !== undefined && state.membershipRevision !== ctx.membershipRevision) return { ok: false, reason: "stale" };
  return { ok: true, ctx };
}

// ---------------------------------------------------------------------------------------------
// The one role -> capability matrix. docs/architecture/identity.md and fixtures/context/README.md
// repeat it; scripts/smoke-server.mjs checks the fixtures and the endpoint against this table.
// ---------------------------------------------------------------------------------------------

/** Anyone, signed in or not: drafts, art, link-holder reads, guest orders (with an email). */
const PUBLIC_CAPS = ["stub.draft", "art.generate", "agent.use", "share.create", "share.view", "wall.public.view", "claim.view", "file.read", "order.create"];
/** A verified account (a session minted from an emailed link). */
const ACCOUNT_CAPS = [
  "account.read", "account.email.change", "account.delete", "session.revoke",
  "wall.sync", "wall.publish", "order.read", "event.create", "claim.redeem",
];
/** Per project role. The same user holds different roles on different projects. */
const PROJECT_CAPS: Record<"stub" | "event", Partial<Record<Role, string[]>>> = {
  stub: { owner: ["stub.read", "stub.write", "stub.approve", "order.authorize", "share.revoke", "gift.create"], member: ["stub.read"], viewer: ["stub.read"] },
  event: { captain: ["event.read", "event.publish", "claims.read"], member: ["event.read"], viewer: ["event.read"] },
};
/** Project capabilities only a signed-in account can hold: a guest device that owns a stub still can't approve it. */
const ACCOUNT_ONLY_PROJECT_CAPS: readonly string[] = ["stub.approve", "order.authorize"];
/** Staff: the admin mount only. Staff get no read access to anyone's projects. */
const STAFF_CAPS = ["admin.view"];

// ---------------------------------------------------------------------------------------------
// Finance grants (ticketstub.context/2 only). Explicit capability strings, issued per role and per scope.
// Nothing is inferred from a role name: a consumer asks "does ctx.capabilities hold finance.read", never
// "is the role captain". A context with a project carries that project's grants and nothing wider. A context
// with no project is the platform scope, and only staff hold grants there. Guests and anonymous callers never
// hold any. These are the host's proposal; the finance owner (CompleteDotTech) has not approved the matrix.
// ---------------------------------------------------------------------------------------------

export const FINANCE_CAPS = [
  "finance.read", // summaries, transaction detail, source references
  "finance.export", // export manifests and downloads
  "finance.command.budget_change",
  "finance.command.expense_adjust",
  "finance.command.reservation", // authorize, dispatch, settle, release
  "finance.command.reconcile",
  "finance.command.recovery",
] as const;

const FINANCE_COMMANDS = FINANCE_CAPS.filter((c) => c.startsWith("finance.command."));

const FINANCE_PROJECT_CAPS: Record<"stub" | "event", Partial<Record<Role, string[]>>> = {
  stub: {}, // a personal stub has no finance surface
  event: { captain: ["finance.read", "finance.export"], member: ["finance.read"], viewer: ["finance.read"] },
};
/** Platform scope (no project): staff read, export and command. The only holders of finance.command.* today. */
const FINANCE_STAFF_CAPS: string[] = ["finance.read", "finance.export", ...FINANCE_COMMANDS];

export const CAPABILITY_MATRIX = { public: PUBLIC_CAPS, account: ACCOUNT_CAPS, project: PROJECT_CAPS, staff: STAFF_CAPS, finance: { project: FINANCE_PROJECT_CAPS, staff: FINANCE_STAFF_CAPS } } as const;

/** Finance grants for an actor holding `role` on the optional project, or `staff` on the platform scope. */
export function financeCapsFor(actor: RequestContext["actor"]["kind"], role: Role, project: { kind: "stub" | "event" } | undefined, staff: boolean): string[] {
  if (actor !== "account") return [];
  if (project) return [...(FINANCE_PROJECT_CAPS[project.kind][role] ?? [])];
  return staff ? [...FINANCE_STAFF_CAPS] : [];
}

/** The /2 form of a /1 context: injective ids, three mode axes, finance grants. `staff` is the issuer's own staff decision. */
export function toContextV2(ctx: RequestContext, extra: { staff: boolean; environment: Environment; economicMode: EconomicMode; evidenceMode: EvidenceMode; audience: string }): ContextV2 {
  const id = ctx.actor.kind === "anonymous" ? "anonymous:0" : `${ctx.actor.kind}:${ctx.actor.id}`;
  return {
    schema: CONTEXT_SCHEMA_V2,
    issuer: ISSUER,
    audience: extra.audience,
    actor: { kind: ctx.actor.kind, id },
    tenant: { id },
    ...(ctx.project ? { project: { id: ctx.project.id, kind: ctx.project.kind, ref: `${ctx.project.kind}:${ctx.project.id}` } } : {}),
    role: ctx.role,
    capabilities: [...new Set([...ctx.capabilities, ...financeCapsFor(ctx.actor.kind, ctx.role, ctx.project, extra.staff)])].sort(),
    membershipRevision: ctx.membershipRevision,
    revoked: ctx.revoked,
    environment: extra.environment,
    economicMode: extra.economicMode,
    evidenceMode: extra.evidenceMode,
    issuedAt: ctx.issuedAt,
    expiresAt: ctx.expiresAt,
  };
}

/** Capabilities for an actor holding `role` on the optional project. */
export function capabilitiesFor(actor: RequestContext["actor"]["kind"], role: Role, project: { kind: "stub" | "event" } | undefined, staff: boolean): string[] {
  const caps = new Set<string>(PUBLIC_CAPS);
  if (actor === "account") for (const c of ACCOUNT_CAPS) caps.add(c);
  if (project) for (const c of PROJECT_CAPS[project.kind][role] ?? []) if (actor === "account" || !ACCOUNT_ONLY_PROJECT_CAPS.includes(c)) caps.add(c);
  if (staff && actor === "account") for (const c of STAFF_CAPS) caps.add(c);
  return [...caps].sort();
}

