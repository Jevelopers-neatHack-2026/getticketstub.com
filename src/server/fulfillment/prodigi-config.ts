import "server-only";
import type { SecretReferenceBinding } from "../vendor/fulfillment-connectors/dist/prodigi-secrets.js";
import type { ProdigiSandboxDecision } from "../vendor/fulfillment-connectors/dist/prodigi-sandbox.js";

// Configuration for Prodigi sandbox callbacks. Names follow integration-evals decision 0003 (rows R4-R6):
//
//   TICKETSTUB_PRODIGI_CALLBACKS   off (default) | sandbox. Anything else is off; "live" is refused and logged.
//                                  Turns on the route POST /api/fulfillment/prodigi/callbacks/{token}, the durable
//                                  store and job worker, and the per-order callbackUrl on sandbox order creation.
//   PRODIGI_SANDBOX_CALLBACK_TOKEN           32 random bytes, base64url (43 characters). Server secret.
//   PRODIGI_SANDBOX_CALLBACK_TOKEN_PREVIOUS  the previous token during a rotation window. Optional.
//   PRODIGI_SANDBOX_API_KEY                  the sandbox API key the authenticated reads use (fulfillment-connectors'
//                                            predeclared binding). Optional until reads are approved.
//   APP_URL                                  existing: the public https origin the callbackUrl is built on.
//   TICKETSTUB_OPS_ENVIRONMENT               existing: production | preview | development | test. Required: it
//                                            partitions the shared database between Preview and Publish.
//
// The env names are fixed by 0003; the secret references are what the reconciler is configured with.

type Env = Readonly<Record<string, string | undefined>>;

export const CALLBACKS_SETTING = "TICKETSTUB_PRODIGI_CALLBACKS";
export const CALLBACK_ROUTE_PATH = "/api/fulfillment/prodigi/callbacks/";

export const CALLBACK_TOKEN_BINDING: SecretReferenceBinding = Object.freeze({
  reference: "prodigi/sandbox/callback-token",
  providerId: "prodigi",
  credentialClass: "sandbox",
  envVar: "PRODIGI_SANDBOX_CALLBACK_TOKEN",
});

export const CALLBACK_TOKEN_PREVIOUS_BINDING: SecretReferenceBinding = Object.freeze({
  reference: "prodigi/sandbox/callback-token-previous",
  providerId: "prodigi",
  credentialClass: "sandbox",
  envVar: "PRODIGI_SANDBOX_CALLBACK_TOKEN_PREVIOUS",
});

/**
 * The deployment environment, from the existing TICKETSTUB_OPS_ENVIRONMENT (production | preview | development | test).
 * Preview and Publish share one database on Plus Launch, so callbacks stay off unless it names one of these: every
 * store, job and alert row is tagged with it, and a worker only ever claims its own environment's jobs.
 */
export const PRODIGI_ENVIRONMENTS = ["production", "preview", "development", "test"] as const;
export type ProdigiEnvironment = (typeof PRODIGI_ENVIRONMENTS)[number];

export function prodigiEnvironment(env: Env = process.env): ProdigiEnvironment | null {
  const raw = env.TICKETSTUB_OPS_ENVIRONMENT?.trim().replace(/^["']|["']$/g, "").toLowerCase() ?? "";
  return (PRODIGI_ENVIRONMENTS as readonly string[]).includes(raw) ? (raw as ProdigiEnvironment) : null;
}

/** The scope every callback, order and job of one environment belongs to (identifiers exclude "_"). */
export function prodigiScope(environment: ProdigiEnvironment): { readonly tenantId: string; readonly projectId: string } {
  return Object.freeze({ tenantId: "getticketstub", projectId: `prodigi-sandbox-${environment}` });
}

/**
 * The owner-delegated sandbox validation decision (0003 R1/R3). It only names the decision: a real
 * SandboxDecisionVerifier must still resolve it before any read or order is permitted (0003 blocker 5).
 */
export const PRODIGI_SANDBOX_DECISION: ProdigiSandboxDecision = Object.freeze({
  decisionReference: "integration-evals/planning/decisions/0003-owner-delegated-decisions-2026-10-12#R1-R3",
  sku: "GLOBAL-PHO-4X6",
  destinationCountryCode: "US",
  shippingMethod: "Standard",
});

export type ProdigiCallbackMode = { state: "off" } | { state: "sandbox" } | { state: "refused"; value: "live" | "unrecognized" };

export function prodigiCallbackMode(env: Env = process.env): ProdigiCallbackMode {
  const raw = env[CALLBACKS_SETTING]?.trim().toLowerCase() ?? "";
  if (raw === "" || raw === "off" || raw === "0") return { state: "off" };
  if (raw === "sandbox") return { state: "sandbox" };
  return { state: "refused", value: raw === "live" ? "live" : "unrecognized" };
}

export const callbacksEnabled = (env: Env = process.env): boolean => prodigiCallbackMode(env).state === "sandbox";

/** A callback token as 0003 R6 defines it: base64url, at least 43 characters (256 bits), at most 512. URL-safe as is. */
export const CALLBACK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,512}$/;

export class ProdigiHostError extends Error {
  constructor(readonly code: "callback_url_unavailable" | "callbacks_disabled") {
    super(code === "callbacks_disabled" ? "Prodigi callbacks are off." : "The Prodigi callback URL cannot be built: APP_URL must be an https origin and PRODIGI_SANDBOX_CALLBACK_TOKEN a base64url token of 43+ characters.");
  }
}

/**
 * The per-order callbackUrl: `${APP_URL origin}/api/fulfillment/prodigi/callbacks/${PRODIGI_SANDBOX_CALLBACK_TOKEN}`.
 * Read at call time, so a rotation needs only the restart GoDaddy already requires. Throws, before anything is sent,
 * when callbacks are off, APP_URL is not https, or the token is missing or malformed.
 */
export function callbackUrl(env: Env = process.env): string {
  if (!callbacksEnabled(env)) throw new ProdigiHostError("callbacks_disabled");
  const token = env[CALLBACK_TOKEN_BINDING.envVar] ?? "";
  if (!CALLBACK_TOKEN_PATTERN.test(token)) throw new ProdigiHostError("callback_url_unavailable");
  let origin: URL;
  try {
    origin = new URL(env.APP_URL?.trim() ?? "");
  } catch {
    throw new ProdigiHostError("callback_url_unavailable");
  }
  if (origin.protocol !== "https:") throw new ProdigiHostError("callback_url_unavailable");
  return `${origin.origin}${CALLBACK_ROUTE_PATH}${token}`;
}
