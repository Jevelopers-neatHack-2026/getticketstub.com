import "server-only";
import { COOKIE } from "./auth";
import {
  CONTEXT_SCHEMA,
  CAPABILITY_MATRIX,
  capabilitiesFor,
  TOKEN_TTL_MS,
  signContext,
  tokenSessionRef,
  verifyWithKey,
  type RequestContext,
  type Role,
  type TokenState,
  type VerifyResult,
} from "./context-token";
import { hashToken, newToken } from "./crypto";
import { HttpError } from "./http";
import { getStorage, storageAvailable } from "./index";

// Who is asking, and what they may do. The context is derived here, on the server, from the session
// cookie (or the guest device cookie) and the storage records. A body field, a query string, a URL token
// or a correlation id is never an input to who the caller is or what they own: a route may name a
// project, and this module answers whether this caller can see it.

export { CONTEXT_SCHEMA };
export { CAPABILITY_MATRIX, capabilitiesFor };
export type { RequestContext, Role, TokenState, VerifyResult };

const DEVICE_COOKIE = "ts_device";
const DEVICE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const PROJECT_ID = /^[\w.:-]{1,128}$/;
const SECRET_MIN = 32;

type Project = { id: string; kind: "stub" | "event" };

// ---------------------------------------------------------------------------------------------

export const isLiveRuntime = () => process.env.TICKETSTUB_RUNTIME_MODE === "live";

function environment(): RequestContext["environment"] {
  if (isLiveRuntime()) return "live";
  return process.env.NODE_ENV === "production" ? "preview" : "development";
}

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

async function derive(cookieHeader: string | null, project?: Project): Promise<RequestContext> {
  const now = Date.now();
  // With storage off there are no sessions to look up: every caller is a guest or anonymous, and no project is theirs.
  const storage = storageAvailable() ? getStorage() : null;
  const sessionCookie = storage ? readCookie(cookieHeader, COOKIE) : null;
  const sess = storage && sessionCookie && sessionCookie.length <= 200 ? await storage.getSessionState(hashToken(sessionCookie), now) : null;
  const device = readCookie(cookieHeader, DEVICE_COOKIE);
  const validProject = project && PROJECT_ID.test(project.id) && (project.kind === "stub" || project.kind === "event") ? project : undefined;

  let actor: RequestContext["actor"] = { kind: "anonymous" };
  let tenant = "anonymous";
  let revision = 0;
  let staff = false;
  if (sess) {
    actor = { kind: "account", id: sess.account.id };
    tenant = sess.account.id;
    staff = isStaffEmail(sess.account.email);
    // Gaining or losing the staff list is a membership change: tokens issued before it go stale.
    revision = staff === sess.account.isStaff ? sess.account.membershipRevision : await storage!.syncStaff(sess.account.id, staff);
  } else if (device && DEVICE_RE.test(device)) {
    tenant = guestTenant(device);
    actor = { kind: "guest", id: tenant.slice("guest:".length) };
  }

  let role: Role = "none";
  if (validProject && storage) {
    // A project the caller can't prove is theirs is role "none", exactly as if it did not exist.
    const found =
      validProject.kind === "stub"
        ? actor.kind !== "anonymous" && (await storage.ownsStub(tenant, validProject.id))
        : actor.kind === "account" && (await storage.getEventCaptain(validProject.id)) === tenant;
    if (found) role = validProject.kind === "stub" ? "owner" : "captain";
  } else if (!validProject && actor.kind === "account") {
    role = staff ? "staff" : "owner"; // owner of their own tenant
  }

  const ctx: RequestContext = {
    schema: CONTEXT_SCHEMA,
    actor,
    tenant: { id: tenant },
    ...(project ? { project: validProject ?? { id: String(project.id).slice(0, 128), kind: project.kind } } : {}),
    role,
    capabilities: capabilitiesFor(actor.kind, role, validProject, staff),
    membershipRevision: revision,
    // A session cookie that no longer resolves is a revoked session; the caller is handled as anonymous.
    revoked: !!sessionCookie && !sess,
    environment: environment(),
    mode: isLiveRuntime() && contextSecret() ? "live" : "sandbox",
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TOKEN_TTL_MS).toISOString(),
  };
  if (sess) sessionRefs.set(ctx, sess.sessionRef);
  return ctx;
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

/**
 * Signature, schema version and expiry only, unless the caller passes `state` (the account's current
 * membershipRevision and whether its session is still live), which adds revoked and stale.
 * verifyContextTokenLive reads that state from storage.
 */
export function verifyContextToken(token: string, now = Date.now(), state?: TokenState): VerifyResult {
  let key: string;
  try {
    key = signingKey();
  } catch {
    return { ok: false, reason: "forged" }; // no key, nothing can be valid
  }
  return verifyWithKey(token, key, now, state);
}

/** verifyContextToken plus the storage lookups, so stale (membership changed) and revoked (signed out, deleted) are caught. */
export async function verifyContextTokenLive(token: string, now = Date.now()): Promise<VerifyResult> {
  const first = verifyContextToken(token, now);
  if (!first.ok || first.ctx.actor.kind !== "account") return first;
  if (!storageAvailable()) return { ok: false, reason: "revoked" }; // no records to check against, so nothing account-bound can be honoured
  const storage = getStorage();
  const sid = tokenSessionRef(token);
  const acct = await storage.getAccountState(first.ctx.actor.id);
  const state: TokenState = {
    membershipRevision: acct ? (isStaffEmail(acct.email) === acct.isStaff ? acct.membershipRevision : await storage.syncStaff(acct.id, !acct.isStaff)) : -1,
    sessionLive: sid && acct ? await storage.isSessionLive(sid, now) : false,
  };
  return verifyContextToken(token, now, state);
}
