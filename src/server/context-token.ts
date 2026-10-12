// The signed request context: types, the signer and the verifier. Pure (node:crypto only, no app imports)
// so the smoke test and the fixture generator run this exact code under plain Node. Only server code
// imports it; scripts/smoke-server.mjs checks that no client chunk does.
import { createHmac, timingSafeEqual } from "node:crypto";

export const CONTEXT_SCHEMA = "ticketstub.context/1";
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

export type VerifyFailure = "unknown" | "forged" | "stale" | "revoked" | "expired" | "unsupported_version";
export type VerifyResult = { ok: true; ctx: RequestContext } | { ok: false; reason: VerifyFailure };

/**
 * What the issuer currently says about the token's subject. Without it a verifier can only prove the
 * signature, the version and the expiry; stale and revoked need this (see verifyContextTokenLive).
 */
export interface TokenState {
  /** The account's current membershipRevision. */
  membershipRevision?: number;
  /** False when the session the token was issued for is gone (signed out, expired, account deleted). */
  sessionLive?: boolean;
}

export const TOKEN_TTL_MS = 5 * 60_000;
const MAX_TOKEN_CHARS = 8192;
const HEADER = { alg: "HS256", typ: "ticketstub.context" } as const;

const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");

/** Signs a context. `sid` is a non-secret reference to the session it was derived from, for revocation. */
export function signContext(ctx: RequestContext, key: string | Buffer, sid: string | null = null): string {
  const head = b64(JSON.stringify(HEADER));
  const body = b64(JSON.stringify({ ctx, sid }));
  const sig = createHmac("sha256", key).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function shaped(v: unknown): v is RequestContext {
  if (!isObj(v) || !isObj(v.actor) || !isObj(v.tenant)) return false;
  const kinds = ["account", "guest", "anonymous"];
  if (typeof v.actor.kind !== "string" || !kinds.includes(v.actor.kind)) return false;
  if (v.actor.kind !== "anonymous" && typeof v.actor.id !== "string") return false;
  if (typeof v.tenant.id !== "string" || typeof v.role !== "string" || !ROLES.includes(v.role as Role)) return false;
  if (!Array.isArray(v.capabilities) || !v.capabilities.every((c) => typeof c === "string")) return false;
  if (!Number.isInteger(v.membershipRevision) || typeof v.revoked !== "boolean") return false;
  if (!["development", "preview", "live"].includes(String(v.environment)) || !["fixture", "sandbox", "live"].includes(String(v.mode))) return false;
  if (v.project !== undefined && (!isObj(v.project) || typeof v.project.id !== "string" || !["stub", "event"].includes(String(v.project.kind)))) return false;
  return !Number.isNaN(Date.parse(String(v.issuedAt))) && !Number.isNaN(Date.parse(String(v.expiresAt)));
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
 * (unsupported_version), expiry (expired), session (revoked), membership revision (stale).
 * The last two run only when `state` is given.
 */
export function verifyWithKey(token: string, key: string | Buffer, now = Date.now(), state?: TokenState): VerifyResult {
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
  const ctx = body.ctx;
  if (!isObj(ctx)) return { ok: false, reason: "unknown" };
  if (ctx.schema !== CONTEXT_SCHEMA) return { ok: false, reason: "unsupported_version" };
  if (!shaped(ctx)) return { ok: false, reason: "unknown" };
  if (Date.parse(ctx.expiresAt) <= now) return { ok: false, reason: "expired" };
  if (ctx.revoked || state?.sessionLive === false) return { ok: false, reason: "revoked" };
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

export const CAPABILITY_MATRIX = { public: PUBLIC_CAPS, account: ACCOUNT_CAPS, project: PROJECT_CAPS, staff: STAFF_CAPS } as const;

/** Capabilities for an actor holding `role` on the optional project. */
export function capabilitiesFor(actor: RequestContext["actor"]["kind"], role: Role, project: { kind: "stub" | "event" } | undefined, staff: boolean): string[] {
  const caps = new Set<string>(PUBLIC_CAPS);
  if (actor === "account") for (const c of ACCOUNT_CAPS) caps.add(c);
  if (project) for (const c of PROJECT_CAPS[project.kind][role] ?? []) if (actor === "account" || !ACCOUNT_ONLY_PROJECT_CAPS.includes(c)) caps.add(c);
  if (staff && actor === "account") for (const c of STAFF_CAPS) caps.add(c);
  return [...caps].sort();
}

