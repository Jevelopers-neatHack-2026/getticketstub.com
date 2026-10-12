import "server-only";
import {
  PRODIGI_SANDBOX_ORIGIN,
  ProdigiSandboxClient,
  ProdigiSandboxError,
  type ProdigiHttpPort,
  type ProdigiOrderCreateInput,
  type ProdigiOrderObservation,
} from "../vendor/fulfillment-connectors/dist/prodigi-sandbox.js";
import { PRODIGI_SANDBOX_OPERATION_ENDPOINTS, type SandboxDecisionVerifier } from "../vendor/fulfillment-connectors/dist/provider-matrix.js";
import type { ServerSecretSource } from "../vendor/fulfillment-connectors/dist/security.js";
import { callbackUrl, callbacksEnabled, PRODIGI_SANDBOX_DECISION } from "./prodigi-config";
import type { ProdigiHost } from "./prodigi-host";
import { UNVERIFIED_DECISION } from "./prodigi-host";
import { recordTrackFailedAlert } from "./prodigi-jobs";

// The one place this app creates a Prodigi sandbox order. Nothing calls it yet: it is what the owner-approved
// sandbox order (0003 checklist) and a later order flow go through, so the callback rules hold from the first order.
//
// - callbackUrl is sent only when the callback route is enabled (TICKETSTUB_PRODIGI_CALLBACKS=sandbox), and only
//   on POST /v4.0/Orders. The vendored adapter's create-order body has no callbackUrl field, so it is added at the
//   transport port, which is the adapter's documented injection point; nothing else in the request changes.
// - The URL is built (and the token checked) before anything is sent, so a misconfiguration sends nothing.
// - trackOrder runs as soon as POST /Orders returns, before this function returns. Prodigi assigns the order ID in
//   that response, so the order cannot be tracked before the request: this is the documented "immediately after
//   POST /Orders returns" path (docs/prodigi-callbacks.md, "Tracking"). A callback that races it is answered
//   not_tracked/503 and redelivered. If trackOrder fails, a durable "track" job tracks the order and reads it once.
//   If that job cannot be written either, a track_failed alert is attempted and ProdigiOrderTrackingError is thrown
//   with the order ID: the order exists at Prodigi and must not be retried as if nothing happened.
// - After every created order a delayed read-back poll is queued (POST_CREATE_POLL_DELAY_MS), so a callback lost
//   before tracking (Prodigi's redelivery on 5xx is undocumented) is still covered by an authenticated read.

const ORDERS_URL = `${PRODIGI_SANDBOX_ORIGIN}${PRODIGI_SANDBOX_OPERATION_ENDPOINTS.submit.path}`;
export const POST_CREATE_POLL_DELAY_MS = 60_000;

/** The order exists at Prodigi, but it is not tracked and no retry could be queued. Never retry it as a new order. */
export class ProdigiOrderTrackingError extends Error {
  readonly code = "tracking_pending";
  constructor(readonly orderId: string, readonly alerted: boolean) {
    super(`Order exists at Prodigi: ${orderId}, tracking pending (${alerted ? "track_failed alert stored" : "no alert could be stored"}). Track it with trackOrder, then reconcileOrder.`);
  }
}

/**
 * Adds `callbackUrl` to the create-order body, and to nothing else. Refuses a body that already carries one; the
 * refusal happens before the inner port is called, and `refused()` lets the caller report it as not dispatched
 * (the adapter has already marked the request dispatched by the time a port throws).
 */
export function withCallbackUrl(http: ProdigiHttpPort, url: string): ProdigiHttpPort & { refused(): boolean } {
  let refused = false;
  return Object.freeze({
    refused: () => refused,
    async send(request: Parameters<ProdigiHttpPort["send"]>[0]) {
      if (request.method !== "POST" || request.url !== ORDERS_URL || typeof request.body !== "string") return http.send(request);
      let body: unknown;
      try {
        body = JSON.parse(request.body);
      } catch {
        body = null;
      }
      if (body === null || typeof body !== "object" || Array.isArray(body) || Object.hasOwn(body, "callbackUrl")) {
        refused = true;
        throw new Error("unexpected create-order body");
      }
      return http.send({ ...request, body: JSON.stringify({ ...body, callbackUrl: url }) });
    },
  });
}

export interface SandboxOrderDeps {
  readonly http: ProdigiHttpPort;
  readonly secrets: ServerSecretSource;
  /** Required for anything to be sent; defaults to the fail-closed verifier. */
  readonly decisionVerifier?: SandboxDecisionVerifier;
  /** Must be exactly true, set by the owner-approved caller. Defaults off, so nothing is sent. */
  readonly sandboxCallsEnabled?: boolean;
  /** The callback host, when the route is enabled. */
  readonly callbacks: ProdigiHost | null;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface SandboxOrderResult {
  readonly observation: ProdigiOrderObservation;
  readonly callbackUrlSent: boolean;
  /** "now": tracked before returning. "queued": trackOrder failed and a durable track job owns it. "off": callbacks off. */
  readonly tracking: "now" | "queued" | "off";
  /** Whether the delayed read-back poll was queued. */
  readonly readBackQueued: boolean;
}

export async function createSandboxOrder(deps: SandboxOrderDeps, input: ProdigiOrderCreateInput, signal?: AbortSignal): Promise<SandboxOrderResult> {
  const env = deps.env ?? process.env;
  const enabled = callbacksEnabled(env) && deps.callbacks !== null;
  const url = enabled ? callbackUrl(env) : null; // throws before anything is sent
  const port = url ? withCallbackUrl(deps.http, url) : null;
  const client = new ProdigiSandboxClient({
    http: port ?? deps.http,
    secrets: deps.secrets,
    decision: PRODIGI_SANDBOX_DECISION,
    decisionVerifier: deps.decisionVerifier ?? UNVERIFIED_DECISION,
    sandboxCallsEnabled: deps.sandboxCallsEnabled === true,
  });
  let observation: ProdigiOrderObservation;
  try {
    observation = await client.createOrder(input, signal);
  } catch (e) {
    // The wrapper refused before calling the real port: nothing reached Prodigi.
    if (port?.refused()) throw new ProdigiSandboxError("invalid_input", "not_dispatched");
    throw e;
  }
  const callbacks = deps.callbacks;
  if (!enabled || !callbacks) return { observation, callbackUrlSent: false, tracking: "off", readBackQueued: false };
  const orderId = observation.orderId;
  let tracking: "now" | "queued";
  try {
    await callbacks.reconciler.trackOrder(orderId);
    tracking = "now";
  } catch {
    try {
      callbacks.queue.enqueue("track", orderId, {});
      tracking = "queued";
      console.warn(`[prodigi] trackOrder failed for ${orderId}; queued a track job`);
    } catch {
      let alerted = false;
      try {
        alerted = recordTrackFailedAlert(callbacks.db, callbacks.environment, orderId, Date.now());
      } catch {
        /* the database is down; the error below is what is left */
      }
      console.error(`[prodigi] order ${orderId} exists at Prodigi but is not tracked and no track job could be queued (alert ${alerted ? "stored" : "not stored"})`);
      throw new ProdigiOrderTrackingError(orderId, alerted);
    }
  }
  // The "track" job reads once itself; a tracked order gets the delayed read-back.
  let readBackQueued = tracking === "queued";
  if (tracking === "now") {
    try {
      callbacks.queue.enqueue("poll", orderId, { reason: "post_create" }, POST_CREATE_POLL_DELAY_MS);
      readBackQueued = true;
    } catch {
      console.warn(`[prodigi] order ${orderId} is tracked, but its read-back poll could not be queued`);
    }
  }
  return { observation, callbackUrlSent: true, tracking, readBackQueued };
}
