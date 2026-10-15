import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { ProdigiCallbackError } from "../vendor/fulfillment-connectors/dist/prodigi-callbacks.js";
import { errorJson, json } from "../http";
import { CALLBACK_TOKEN_BINDING, CALLBACK_TOKEN_PREVIOUS_BINDING } from "./prodigi-config";
import { prodigiCallbackHost, type ProdigiHost } from "./prodigi-host";

// POST /api/fulfillment/prodigi/callbacks/{token} (0003 R5). The token is the last path segment and goes to the
// reconciler as presentedToken; the reconciler compares it in constant time with PRODIGI_SANDBOX_CALLBACK_TOKEN (and
// _PREVIOUS) before it touches the body or the store. A callback is only an untrusted "go look" hint: the body is
// never applied, and only an authenticated read changes state.
//
// Status mapping (fulfillment-connectors docs/prodigi-callbacks.md, "Host HTTP status mapping"):
//   off, live refused, wrong or missing token          404 (the endpoint is not revealed)
//   reconciled, already_*, replayed, ignored_type ...  200
//   deferred (the job queue is durable)                202
//   not_tracked, reconcile_failed                      503 + Retry-After (Prodigi redelivers)
//   callback_invalid 400 · callback_oversized 413 · callback_source_mismatch 503 (logged) · server-side 503
//
// The token is checked before the body is read: a wrong token is a 404 whatever else fails (body stream, host,
// database). With a host, the check is the reconciler's own (an empty-body probe it rejects before touching the
// store); without one (the host failed to start), a constant-time comparison with the same two settings decides
// between 404 and 503. The body is then read with a hard cap before it is buffered.

const RETRY_AFTER_SECONDS = "30";

const RETRY = { "retry-after": RETRY_AFTER_SECONDS };
const notFound = () => errorJson(404, "not_found", "We couldn't find that.");
/** Every server-side 503 (token secret missing, store, deadline, anything unexpected) has one public code; the log says which. */
const unavailable = () => errorJson(503, "callbacks_unavailable", "Callbacks can't be taken right now. Try again shortly.", undefined, RETRY);

async function readCapped(req: Request, max: number): Promise<Uint8Array> {
  const over = () => new Uint8Array(max + 1);
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return over();
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return over();
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** Only content-type is passed on; proxy headers would trip the reconciler's header bounds and carry nothing it uses. */
function callbackHeaders(req: Request): Record<string, string> {
  const type = req.headers.get("content-type");
  return type && type.length <= 256 && !/[\r\n\0]/.test(type) ? { "content-type": type } : {};
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** Host-failure path only: whether `token` is one of the configured tokens, compared in constant time. */
function matchesConfiguredToken(token: string, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const presented = digest(token);
  let match = false;
  for (const name of [CALLBACK_TOKEN_BINDING.envVar, CALLBACK_TOKEN_PREVIOUS_BINDING.envVar]) {
    const value = env[name];
    if (typeof value === "string" && value.length >= 43 && timingSafeEqual(presented, digest(value))) match = true;
  }
  return match;
}

/** The reconciler's token gate with an empty body: forged → false; anything past the gate → true. */
async function tokenAccepted(host: ProdigiHost, token: string, signal: AbortSignal): Promise<boolean> {
  try {
    await host.reconciler.handleCallback({ presentedToken: token, headers: {}, rawBody: new Uint8Array(0), signal });
    return true; // unreachable: an empty body never parses
  } catch (e) {
    const code = e instanceof ProdigiCallbackError ? e.code : "unexpected";
    if (code === "callback_forged" || code === "callbacks_disabled") return false;
    if (code === "callback_invalid") return true;
    throw e; // callback_token_unavailable, deadline_exceeded: mapped below
  }
}

export async function handleProdigiCallback(req: Request, token: string, resolveHost: () => ProdigiHost | null = prodigiCallbackHost): Promise<Response> {
  let host: ProdigiHost | null;
  try {
    host = resolveHost();
  } catch (e) {
    if (!matchesConfiguredToken(token)) return notFound();
    console.error("[prodigi] callback host unavailable:", e instanceof Error ? e.message : "unknown");
    return unavailable();
  }
  // Off (the default), or refused (live, unrecognized, no environment): nothing is read, not even the body.
  if (!host) return notFound();

  try {
    if (!(await tokenAccepted(host, token, req.signal))) return notFound();
  } catch (e) {
    return mapError(e);
  }

  let rawBody: Uint8Array;
  try {
    rawBody = await readCapped(req, host.maxBodyBytes);
  } catch {
    return errorJson(400, "callback_invalid", "The callback could not be read.");
  }

  try {
    const result = await host.reconciler.handleCallback({ presentedToken: token, headers: callbackHeaders(req), rawBody, signal: req.signal });
    if (result.tokenGeneration === "previous") console.warn("[prodigi] callback used the previous token; rotation still in progress");
    if (result.recommendedHttpStatus === 503) {
      return json(
        { outcome: result.outcome, ...(result.errorCode ? { errorCode: result.errorCode } : {}) },
        { status: 503, headers: { "retry-after": String(result.retryAfterSeconds ?? RETRY_AFTER_SECONDS) } },
      );
    }
    return json({ outcome: result.outcome }, { status: result.recommendedHttpStatus });
  } catch (e) {
    return mapError(e);
  }
}

function mapError(e: unknown): Response {
  const code = e instanceof ProdigiCallbackError ? e.code : "unexpected";
  switch (code) {
    case "callbacks_disabled":
    case "callback_forged":
    case "live_refused":
      return notFound();
    case "callback_invalid":
    case "invalid_input":
      return errorJson(400, "callback_invalid", "The callback did not pass validation.");
    case "callback_oversized":
      return errorJson(413, "callback_oversized", "The callback is too large.");
    case "callback_source_mismatch":
      // The wire format is unconfirmed (0003 / docs "Not done" item 4): log it and let Prodigi redeliver.
      console.warn("[prodigi] callback source is not the sandbox Orders endpoint; answered 503");
      return errorJson(503, "callback_source_mismatch", "The callback source wasn't the one we expect. Try again shortly.", undefined, RETRY);
    case "callback_token_unavailable":
      console.error("[prodigi] PRODIGI_SANDBOX_CALLBACK_TOKEN is missing or malformed; callbacks answer 503");
      return unavailable();
    case "store_unavailable":
    case "deadline_exceeded":
      console.warn(`[prodigi] callback answered 503: ${code}`);
      return unavailable();
    default:
      console.error("[prodigi] callback failed:", e instanceof Error ? e.message : "unknown");
      return unavailable();
  }
}
