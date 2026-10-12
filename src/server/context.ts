import "server-only";
import { COOKIE } from "./auth";
import {
  CONTEXT_SCHEMA,
  CONTEXT_SCHEMA_V2,
  DEFAULT_AUDIENCE,
  CAPABILITY_MATRIX,
  capabilitiesFor,
  TOKEN_TTL_MS,
  signContext,
  toContextV2,
  tokenSessionRef,
  verifyWithKey,
  type ContextV2,
  type RequestContext,
  type Role,
  type TokenState,
  type VerifyOptions,
  type VerifyResult,
} from "./context-token";
import { ModeMappingError, resolveEnvironment, resolveModes } from "./context-modes";
import { hashToken, newToken } from "./crypto";
import { HttpError } from "./http";
import { getStorage, storageAvailable } from "./index";
import type { AccountState } from "./storage";

// Who is asking, and what they may do. The context is derived here, on the server, from the session
// cookie (or the guest device cookie) and the storage records. A body field, a query string, a URL token
// or a correlation id is never an input to who the caller is or what they own: a route may name a
// project, and this module answers whether this caller can see it.

export { CONTEXT_SCHEMA, CONTEXT_SCHEMA_V2 };
export { CAPABILITY_MATRIX, capabilitiesFor };
export type { ContextV2, RequestContext, Role, TokenState, VerifyResult };

const DEVICE_COOKIE = "ts_device";
const DEVICE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const PROJECT_ID = /^[\w.:-]{1,128}$/;
const SECRET_MIN = 32;

type Project = { id: string; kind: "stub" | "event" };

// ---------------------------------------------------------------------------------------------

export const isLiveRuntime = () => process.env.TICKETSTUB_RUNTIME_MODE === "live";

const environment = (): RequestContext["environment"] => resolveEnvironment(process.env);

/** ADMIN_EMAILS is comma-separated. Matched case-insensitively against a verified account email. */
function isStaffEmail(email: string): boolean {
  return (process.env.ADMIN_EMAILS ?? "").split(",").some((e) => e.trim() !== "" && e.trim().toLowerCase() === email.toLowerCase());
}

function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }
  return null;
}

/** The guest device id from its httpOnly cookie, if it is well formed. */
export function readDevice(req: Request): string | null {
  const v = readCookie(req.headers.get("cookie"), DEVICE_COOKIE);
  return v && DEVICE_RE.test(v) ? v : null;
}

/** The guest device for this request, minting one when there is none. The caller sets `cookie` on its response. */
export function ensureDevice(req: Request): { id: string; cookie?: string } {
  const have = readDevice(req);
  if (have) return { id: have };
  const id = newToken();
  return { id, cookie: `${DEVICE_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${365 * 24 * 3600}${process.env.NODE_ENV === "production" ? "; Secure" : ""}` };
}

/** The tenant a guest device owns drafts under: guest:<id>. The id is a hash, so the cookie value never leaves. */
export const guestTenant = (device: string) => `guest:${hashToken(device).slice(0, 16)}`;

const sessionRefs = new WeakMap<RequestContext, string>();
/** The issuer's own staff decision for a context, for the /2 finance grants. Never serialized. */
const staffFlags = new WeakMap<RequestContext, boolean>();

type SessionState = { account: AccountState; sessionRef: string } | null;
function identityFor(cookieHeader: string | null, sess: SessionState): { actor: RequestContext["actor"]; tenant: string; staff: boolean } {
  if (sess) return { actor: { kind: "account", id: sess.account.id }, tenant: sess.account.id, staff: isStaffEmail(sess.account.email) };
  const device = readCookie(cookieHeader, DEVICE_COOKIE);
  if (device && DEVICE_RE.test(device)) { const tenant = guestTenant(device); return { actor: { kind: "guest", id: tenant.slice("guest:".length) }, tenant, staff: false }; }
  return { actor: { kind: "anonymous" }, tenant: "anonymous", staff: false };
}

function contextFromState({ identity, sess, sessionCookie, project, validProject, projectOwned, revision, now }: {
  identity: ReturnType<typeof identityFor>; sess: SessionState; sessionCookie: string | null; project?: Project; validProject?: Project;
  projectOwned: boolean; revision: number; now: number;
}): RequestContext {
  const { actor, tenant, staff } = identity;
  const role: Role = validProject ? (projectOwned ? (validProject.kind === "stub" ? "owner" : "captain") : "none")
    : actor.kind === "account" ? (staff ? "staff" : "owner") : "none";
  const ctx: RequestContext = {
    schema: CONTEXT_SCHEMA, actor, tenant: { id: tenant },
    ...(project ? { project: validProject ?? { id: String(project.id).slice(0, 128), kind: project.kind } } : {}),
    role, capabilities: capabilitiesFor(actor.kind, role, validProject, staff), membershipRevision: revision,
    revoked: !!sessionCookie && !sess, environment: environment(), mode: isLiveRuntime() && contextSecret() ? "live" : "sandbox",
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + TOKEN_TTL_MS).toISOString(),
  };
  if (sess) sessionRefs.set(ctx, sess.sessionRef);
  staffFlags.set(ctx, staff);
  return ctx;
}

async function derive(cookieHeader: string | null, project?: Project): Promise<RequestContext> {
  const now = Date.now();
  // With storage off there are no sessions to look up: every caller is a guest or anonymous, and no project is theirs.
  const storage = storageAvailable() ? getStorage() : null;
  const sessionCookie = storage ? readCookie(cookieHeader, COOKIE) : null;
  const sess = storage && sessionCookie && sessionCookie.length <= 200 ? await storage.getSessionState(hashToken(sessionCookie), now) : null;
  const validProject = project && PROJECT_ID.test(project.id) && (project.kind === "stub" || project.kind === "event") ? project : undefined;
  const identity = identityFor(cookieHeader, sess);
  const { actor, tenant, staff } = identity;
  // Gaining or losing the staff list is a membership change: tokens issued before it go stale.
  const revision = sess ? (staff === sess.account.isStaff ? sess.account.membershipRevision : await storage!.syncStaff(sess.account.id, staff)) : 0;
  let projectOwned = false;
  if (validProject && storage) {
    // A project the caller can't prove is theirs is role "none", exactly as if it did not exist.
    projectOwned =
      validProject.kind === "stub"
        ? actor.kind !== "anonymous" && (await storage.ownsStub(tenant, validProject.id))
        : actor.kind === "account" && (await storage.getEventCaptain(validProject.id)) === tenant;
  }
  return contextFromState({ identity, sess, sessionCookie, project, validProject, projectOwned, revision, now });
}

export function getRequestContext(req: Request, project?: Project): Promise<RequestContext> {
  return derive(req.headers.get("cookie"), project);
}

/** For server components, which have request headers but no Request: `getServerContext(await headers())`. */
export function getServerContext(headers: Headers, project?: Project): Promise<RequestContext> {
  return derive(headers.get("cookie"), project);
}

/**
 * Throws unless the context holds `cap`. The status never says more than the caller may know:
 * admin.* gaps and projects the caller can't see are 404 (they do not exist for this caller);
 * an anonymous or guest caller is 401 (sign in); a role that is too weak is 403.
 */
export function requireCapability(ctx: RequestContext, cap: string): void {
  if (ctx.capabilities.includes(cap)) return;
  if (cap.startsWith("admin.") || (ctx.project && ctx.role === "none")) throw new HttpError(404, "not_found", "We couldn't find that.");
  if (ctx.actor.kind !== "account") throw new HttpError(401, "unauthorized", "Sign in with an emailed link to do that.");
  throw new HttpError(403, "forbidden", "You can't do that here.");
}

/** Commissioning uses the issuer's existing capability and economic-mode rules. */
export function requireCreativeCommissioningContext(platform: RequestContext, scoped: RequestContext): void {
  requireCapability(platform, "admin.view");
  requireCapability(scoped, "stub.write");
  if (platform.revoked || scoped.revoked || platform.actor.kind !== "account" || scoped.actor.kind !== "account" ||
      platform.actor.id !== scoped.actor.id || platform.tenant.id !== scoped.tenant.id) {
    throw new HttpError(403, "permission_denied", "This account cannot commission creative execution.");
  }
  const finance = issueContextV2(platform).context;
  if (!finance.capabilities.includes("finance.command.reservation") || !["live", "paid_test"].includes(finance.economicMode)) {
    throw new HttpError(403, "permission_denied", "This account cannot commission creative execution.");
  }
}

/** The last provider-send fence: a fresh storage-owned synchronous session,
 * membership and ownership snapshot, followed by the same issuer rules. */
export function assertCreativeCommissioningCurrent(req: Request, admitted: { platform: RequestContext; scoped: RequestContext }): void {
  const now = Date.now(); const project = admitted.scoped.project;
  const sessionCookie = readCookie(req.headers.get("cookie"), COOKIE);
  if (req.signal.aborted || !storageAvailable() || !sessionCookie || sessionCookie.length > 200 ||
      !project || project.kind !== "stub" || !PROJECT_ID.test(project.id) ||
      Date.parse(admitted.platform.expiresAt) <= now || Date.parse(admitted.scoped.expiresAt) <= now) {
    throw new HttpError(403, "permission_denied", "Current creative authority could not be confirmed.");
  }
  const storage = getStorage();
  if (typeof storage.readCreativeDispatchState !== "function") throw new HttpError(503, "context_unavailable", "Current creative authority could not be confirmed.");
  const state = storage.readCreativeDispatchState(hashToken(sessionCookie), project.id, now);
  if (!state || state.account.isStaff !== isStaffEmail(state.account.email)) {
    throw new HttpError(403, "permission_denied", "Current creative authority could not be confirmed.");
  }
  const identity = identityFor(req.headers.get("cookie"), state);
  const common = { identity, sess: state, sessionCookie, revision: state.account.membershipRevision, now };
  const platform = contextFromState({ ...common, projectOwned: false });
  const scoped = contextFromState({ ...common, project, validProject: project, projectOwned: state.ownsStub });
  requireCreativeCommissioningContext(platform, scoped);
  for (const [current, expected] of [[platform, admitted.platform], [scoped, admitted.scoped]]) {
    if (current.actor.kind !== "account" || expected.actor.kind !== "account" || current.actor.id !== expected.actor.id ||
        current.tenant.id !== expected.tenant.id || current.membershipRevision !== expected.membershipRevision ||
        current.environment !== expected.environment || current.mode !== expected.mode) {
      throw new HttpError(403, "permission_denied", "Current creative authority could not be confirmed.");
    }
  }
}

/** The signed-in account behind a context that already passed an account capability. 401 when there is none. */
export async function accountOf(ctx: RequestContext): Promise<{ id: string; email: string }> {
  const acct = ctx.actor.kind === "account" ? await getStorage().getAccountState(ctx.actor.id) : null;
  if (!acct) throw new HttpError(401, "unauthorized", "Sign in with an emailed link to do that.");
  return { id: acct.id, email: acct.email };
}

/** For /admin: staff only. Everyone else gets the same 404 as a route that does not exist. */
export async function requireStaff(headers: Headers): Promise<RequestContext> {
  const ctx = await getServerContext(headers);
  requireCapability(ctx, "admin.view");
  return ctx;
}

// ---------------------------------------------------------------------------------------------
// Signing. CONTEXT_SECRET keys the HMAC. Outside live mode a missing secret falls back to a random
// per-process key and the context says mode "sandbox", so nobody mistakes it for a live issuer.
// ---------------------------------------------------------------------------------------------

function contextSecret(): string | null {
  const s = process.env.CONTEXT_SECRET?.trim();
  if (s?.includes("FIXTURE-ONLY")) return null; // the published fixture keys (fixtures/context, fixtures/approval) are never a server secret
  return s && s.length >= SECRET_MIN ? s : null;
}

const g = globalThis as unknown as { __ticketstubContextKey?: string };

function signingKey(): string {
  const secret = contextSecret();
  if (secret) return secret;
  if (isLiveRuntime()) throw new HttpError(503, "context_unavailable", "Context tokens aren't set up on this server yet.");
  return (g.__ticketstubContextKey ??= newToken(32));
}

/** The HMAC key for every token this server signs (context and approval). Throws 503 in live mode without CONTEXT_SECRET. */
export function tokenSigningKey(): string {
  return signingKey();
}

/** "live" only when CONTEXT_SECRET is set and the runtime is live; otherwise "sandbox". */
export function signingMode(): "sandbox" | "live" {
  return contextSecret() && isLiveRuntime() ? "live" : "sandbox";
}

/** The deployment environment, as the context reports it. */
export const contextEnvironment = environment;

/** A signed, versioned, five-minute copy of a context for a downstream consumer. Throws 503 in live mode without CONTEXT_SECRET. */
export function issueContextToken(ctx: RequestContext): string {
  if (ctx.revoked) throw new HttpError(401, "unauthorized", "Sign in with an emailed link to do that.");
  const key = signingKey();
  const mode = contextSecret() && isLiveRuntime() ? "live" : "sandbox";
  return signContext({ ...ctx, mode }, key, sessionRefs.get(ctx) ?? null);
}

/** The host this issuer mints /2 tokens for. Server configuration only: CONTEXT_AUDIENCE, else the finance default. */
export function contextAudience(): string {
  const a = process.env.CONTEXT_AUDIENCE?.trim();
  return a && /^[\w.:-]{1,128}$/.test(a) ? a : DEFAULT_AUDIENCE;
}

/** The three mode axes as this server is configured right now, or throws ModeMappingError (see context-modes.ts). */
function currentModes() {
  return resolveModes(process.env, !!contextSecret());
}

/**
 * The /2 context and a signed five-minute token for it: injective ids, separate environment / economic /
 * evidence modes, finance grants. Derived from the same server-side context as /1. A configuration whose modes
 * cannot be mapped honestly (a paid provider key with economic mode none, live money from a preview deploy)
 * refuses with 503 instead of guessing.
 */
export function issueContextV2(ctx: RequestContext): { context: ContextV2; token: string } {
  if (ctx.revoked) throw new HttpError(401, "unauthorized", "Sign in with an emailed link to do that.");
  const key = signingKey();
  let modes: ReturnType<typeof currentModes>;
  try {
    modes = currentModes();
  } catch (e) {
    if (e instanceof ModeMappingError) throw new HttpError(503, "context_unavailable", "Context tokens aren't set up on this server yet.");
    throw e;
  }
  const context = toContextV2(ctx, { staff: staffFlags.get(ctx) ?? false, audience: contextAudience(), ...modes });
  return { context, token: signContext(context, key, sessionRefs.get(ctx) ?? null) };
}

/**
 * Signature, schema version and expiry only, unless the caller passes `state` (the account's current
 * membershipRevision and whether its session is still live), which adds revoked and stale.
 * verifyContextTokenLive reads that state from storage.
 */
export function verifyContextToken(token: string, now = Date.now(), state?: TokenState, opts?: VerifyOptions): VerifyResult {
  let key: string;
  try {
    key = signingKey();
  } catch {
    return { ok: false, reason: "forged" }; // no key, nothing can be valid
  }
  return verifyWithKey(token, key, now, state, opts);
}

/**
 * verifyContextToken plus the storage lookups, so stale (membership changed) and revoked (signed out, deleted) are caught.
 * For /2 it also re-checks, now: that the token is for this issuer's audience (and the verifier's, when it names one),
 * that the account still holds the token's project, and that the modes it carries are still what this server is
 * configured to say. Each failure is a denial: wrong_audience, revoked, stale.
 */
export async function verifyContextTokenLive(token: string, now = Date.now(), opts?: VerifyOptions): Promise<VerifyResult> {
  const first = verifyContextToken(token, now, undefined, opts);
  if (!first.ok) return first;
  const v2 = first.ctx.schema === CONTEXT_SCHEMA_V2 ? first.ctx : null;
  if (v2) {
    if (v2.audience !== contextAudience()) return { ok: false, reason: "wrong_audience" };
    let modes: ReturnType<typeof currentModes>;
    try {
      modes = currentModes();
    } catch {
      return { ok: false, reason: "stale" }; // this server can no longer vouch for any mapping
    }
    if (modes.environment !== v2.environment || modes.economicMode !== v2.economicMode || modes.evidenceMode !== v2.evidenceMode) return { ok: false, reason: "stale" };
  }
  if (first.ctx.actor.kind !== "account") return first;
  if (!storageAvailable()) return { ok: false, reason: "revoked" }; // no records to check against, so nothing account-bound can be honoured
  const storage = getStorage();
  const sid = tokenSessionRef(token);
  const accountId = v2 ? first.ctx.actor.id.slice("account:".length) : first.ctx.actor.id;
  const acct = await storage.getAccountState(accountId);
  const state: TokenState = {
    membershipRevision: acct ? (isStaffEmail(acct.email) === acct.isStaff ? acct.membershipRevision : await storage.syncStaff(acct.id, !acct.isStaff)) : -1,
    sessionLive: sid && acct ? await storage.isSessionLive(sid, now) : false,
  };
  // Current membership of the selected project: a stub that is gone, an event with another captain, is a lost membership.
  if (v2?.project && acct) {
    state.projectMember = v2.project.kind === "stub" ? await storage.ownsStub(acct.id, v2.project.id) : (await storage.getEventCaptain(v2.project.id)) === acct.id;
  }
  return verifyContextToken(token, now, state, opts);
}
