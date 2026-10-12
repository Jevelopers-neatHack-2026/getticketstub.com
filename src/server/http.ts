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
        const path = req ? new URL(req.url).pathname.replace(/^\/api\//, "").replace(/[^a-z0-9]+/gi, "_").toLowerCase().slice(0, 40) : "unknown";
        const ev = sanitizeEvent({ type: "storage_unavailable", requestId, fields: { code: "storage_unavailable", route: /^[a-z]/.test(path) ? path : "unknown" } });
        if (ev) pushRing(ev);
      }
      return tagged(errorResponse(e), requestId);
    }
  };
}

export const notFound = () => new HttpError(404, "not_found", "We couldn't find that.");

/** APP_URL's origin, when it is an absolute https URL (or http on localhost). Anything else counts as unset. */
export function configuredOrigin(): string | null {
  try {
    const u = new URL(process.env.APP_URL?.trim() ?? "");
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    return u.protocol === "https:" || (u.protocol === "http:" && local) ? u.origin : null;
  } catch {
    return null;
  }
}

/** The public origin, for links in emails. APP_URL wins; otherwise the request's own origin. */
export function appOrigin(req: Request): string {
  const configured = configuredOrigin();
  if (configured) return configured;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim() ?? new URL(req.url).protocol.replace(":", "");
  return `${proto}://${host}`;
}

/** Mutating routes only accept a browser Origin that is APP_URL or this request's own host. */
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
  const own = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").toLowerCase();
  let allowed = parsed.host.toLowerCase() === own;
  const configured = configuredOrigin();
  if (!allowed && configured) allowed = parsed.origin === configured;
  if (!allowed) throw deny();
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
