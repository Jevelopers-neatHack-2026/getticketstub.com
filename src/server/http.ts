import "server-only";
import { NextResponse } from "next/server";
import { pushRing, requestIdOf, sanitizeEvent } from "./events";
import { hit } from "./ratelimit";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

const NO_STORE = { "cache-control": "no-store" };

// Labels are fixed codes, shorter than the event sanitizer's token-like string limit.
// Static routes precede dynamic ones (notably share/revoke). New routes default to unknown.
const API_ROUTE_LABELS = [
  ["account", "account"],
  ["account/email", "account_email"],
  ["account/email/confirm", "account_email_confirm"],
  ["admin/backup", "admin_backup"],
  ["admin/harness", "admin_harness"],
  ["agent", "agent"],
  ["approvals", "approvals"],
  ["approvals/revoke", "approvals_revoke"],
  ["approvals/verify", "approvals_verify"],
  ["art", "art"],
  ["auth/callback", "auth_callback"],
  ["auth/confirm", "auth_confirm"],
  ["auth/link", "auth_link"],
  ["auth/me", "auth_me"],
  ["auth/signout", "auth_signout"],
  ["context", "context"],
  ["context/verify", "context_verify"],
  ["creative", "creative"],
  ["dev/email-preview", "dev_email_preview"],
  ["events", "events"],
  ["gift", "gift"],
  ["health", "health"],
  ["order-authorizations", "order_authorizations"],
  ["order-authorizations/claim", "order_auth_claim"],
  ["order-authorizations/claims/lookup", "order_auth_claim_lookup"],
  ["order-authorizations/revalidate", "order_auth_revalidate"],
  ["order-authorizations/revoke", "order_auth_revoke"],
  ["order-authorizations/verify", "order_auth_verify"],
  ["orders", "orders"],
  ["organizer/events", "organizer_events"],
  ["payments/dodo/webhook", "payments_dodo_webhook"],
  ["payments/stripe/webhook", "payments_stripe_webhook"],
  ["research", "research"],
  ["share", "share"],
  ["share/revoke", "share_revoke"],
  ["wall/public", "wall_public"],
  ["wall/sync", "wall_sync"],
  ["fulfillment/prodigi/callbacks/:token", "prodigi_callbacks"],
  ["claim/:token", "claim_token"],
  ["files/:name", "files_name"],
  ["gift/:token", "gift_token"],
  ["share/:token", "share_token"],
  ["stub-image/:token", "stub_image_token"],
  ["u/:token", "u_token"],
] as const;

/** Never derive a telemetry value from a request's dynamic segments or an unknown path. */
function safeRouteLabel(pathname: string): string {
  if (!pathname.startsWith("/api/")) return "unknown";
  const segments = pathname.slice(5).replace(/\/$/, "").split("/");
  for (const [template, label] of API_ROUTE_LABELS) {
    const parts = template.split("/");
    if (parts.length === segments.length && parts.every((part, i) => part.startsWith(":") ? segments[i].length > 0 : part === segments[i])) return label;
  }
  return "unknown";
}

export function json(data: unknown, init?: { status?: number; headers?: Record<string, string> }): NextResponse {
  return NextResponse.json(data, { status: init?.status ?? 200, headers: { ...NO_STORE, ...init?.headers } });
}

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof HttpError) {
    return json({ error: { code: e.code, message: e.message } }, { status: e.status, headers: e.headers });
  }
  // Log the message only: bodies, tokens and cookies never reach the log.
  console.error("[api] unexpected error:", e instanceof Error ? e.message : "unknown");
  return json({ error: { code: "internal", message: "Something broke on our side. Try again in a moment." } }, { status: 500 });
}

/** The one error body: `{ error: { code, message } }`, plus any extra top-level fields (retryAt, art). */
export function errorJson(status: number, code: string, message: string, extra?: Record<string, unknown>, headers?: Record<string, string>): NextResponse {
  return json({ error: { code, message }, ...extra }, { status, headers });
}

/** Tags a response with the request's correlation id. Redirects and other frozen headers are left alone. */
function tagged<R extends Response>(res: R, requestId: string): R {
  try {
    res.headers.set("x-request-id", requestId);
  } catch {
    /* immutable headers */
  }
  return res;
}

/**
 * Wraps a handler so thrown HttpErrors become `{ error: { code, message } }`, and every answer carries
 * `x-request-id` (the caller's, when well formed, or a new one). A 503 storage_unavailable is noted in the
 * in-memory event ring, because there is no storage to write it to.
 */
export function route<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    const req = args[0] instanceof Request ? args[0] : undefined;
    const requestId = req ? requestIdOf(req.headers) : requestIdOf(new Headers());
    try {
      return tagged(await fn(...args), requestId);
    } catch (e) {
      if (e instanceof HttpError && e.code === "storage_unavailable") {
        const label = req ? safeRouteLabel(new URL(req.url).pathname) : "unknown";
        const ev = sanitizeEvent({ type: "storage_unavailable", requestId, fields: { code: "storage_unavailable", route: label } });
        if (ev) pushRing(ev);
      }
      return tagged(errorResponse(e), requestId);
    }
  };
}

export const notFound = () => new HttpError(404, "not_found", "We couldn't find that.");

/** APP_URL's origin, when it is credential-free HTTPS (or HTTP on localhost/127.0.0.1). Invalid values return null. */
export function configuredOrigin(): string | null {
  try {
    const u = new URL(process.env.APP_URL?.trim() ?? "");
    if (u.username || u.password) return null;
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    return u.protocol === "https:" || (u.protocol === "http:" && local) ? u.origin : null;
  } catch {
    return null;
  }
}

/** Configured authority, or a loopback request URL for local operation. Headers never supply authority. */
function trustedOrigin(req: Request): string | null {
  if (process.env.APP_URL?.trim()) return configuredOrigin();
  try {
    // NextRequest.url normalizes loopback hosts. Recover the native constructor-held URL,
    // bypassing framework/instance overrides without consulting authority headers.
    const u = new URL(Reflect.get(Request.prototype, "url", req));
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    return local && !u.username && !u.password && (u.protocol === "http:" || u.protocol === "https:") ? u.origin : null;
  } catch {
    return null;
  }
}

/** The origin for security links; public requests require a valid APP_URL. */
export function appOrigin(req: Request): string {
  const origin = trustedOrigin(req);
  if (!origin) throw new HttpError(503, "origin_unavailable", "The public URL isn't configured on this server.");
  return origin;
}

/** Mutating routes require the complete configured origin, or the exact loopback request URL origin. */
export function checkOrigin(req: Request): void {
  const deny = () => new HttpError(403, "bad_origin", "This request didn't come from TicketStub.");
  const origin = req.headers.get("origin");
  if (!origin) throw deny();
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw deny();
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.origin !== trustedOrigin(req)) throw deny();
}

/** True when the request carries an Origin that isn't ours. A missing Origin is not foreign: for the routes that guests may call without one. */
export function foreignOrigin(req: Request): boolean {
  if (!req.headers.get("origin")) return false;
  try {
    checkOrigin(req);
    return false;
  } catch {
    return true;
  }
}

/** Reads a raw body, refusing anything over `maxBytes` while it streams. */
export async function readBody(req: Request, maxBytes: number): Promise<Buffer> {
  const tooBig = () => new HttpError(413, "too_large", "That's too much to send in one go.");
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooBig();
  if (!req.body) throw new HttpError(400, "bad_json", "Send a JSON body.");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw tooBig();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Reads a JSON body, refusing anything over `maxBytes` before it is parsed. */
export async function readJson(req: Request, maxBytes: number): Promise<unknown> {
  const body = await readBody(req, maxBytes);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "bad_json", "Send a JSON body.");
  }
}

export function clientIp(req: Request): string {
  return req.headers.get("x-real-ip")?.trim() || req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
}

/** Throws 429 when `key` has used up `max` hits in the window. */
export function limit(key: string, max: number, windowMs: number): void {
  const wait = hit(key, max, windowMs);
  if (wait) {
    throw new HttpError(429, "rate_limited", `Too many tries. Wait ${Math.ceil(wait / 60)} min and try again.`, { "retry-after": String(wait) });
  }
}

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
