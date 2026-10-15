import "server-only";
import { randomBytes } from "node:crypto";
import { APPROVAL_TTL_MS } from "./approval-token";
import { ORDER_AUTH_TTL_MS } from "./order-auth-token";
import { isLiveRuntime } from "./context";
import { HttpError } from "./http";
import { loadKeyring, type Keyring, type KeysetProblem } from "./keyring";

// The environment bindings for the versioned token key sets (integration-evals decision 0003, row K4). Each token class
// has its own key set, so one leaked secret can mint only one class:
//   APPROVAL_SIGNING_KEYS    artwork approvals (ticketstub.approval/1, 7-day tokens)
//   ORDER_AUTH_SIGNING_KEYS  order authorizations (ticketstub.order-authorization/1, 15-minute tokens)
// ORDER_AUTH_CONSUMER_KEY is not a token key: it only signs consumer requests (order-authorization.ts).
// CONTEXT_SECRET stays a single key, for five-minute context tokens only (context.ts). The format and the rules are in
// keyring.ts and docs/architecture/identity.md "Signing keys".

export const APPROVAL_KEYS_ENV = "APPROVAL_SIGNING_KEYS";
export const ORDER_AUTH_KEYS_ENV = "ORDER_AUTH_SIGNING_KEYS";
const ORDER_AUTH_CONSUMER_ENV = "ORDER_AUTH_CONSUMER_KEY";

const g = globalThis as unknown as { __ticketstubKeyringFallback?: Map<string, Buffer>; __ticketstubKeyringWarned?: Set<string> };

/**
 * Outside live mode, an unset key set signs with a random key that lives as long as the process (tokens die on restart).
 * A production build (NODE_ENV=production) that is not in live runtime gets a warning once: a deployment that forgot or
 * mistyped TICKETSTUB_RUNTIME_MODE would otherwise run on throwaway keys with records marked mode "sandbox".
 */
function fallbackKey(name: string): Buffer {
  if (process.env.NODE_ENV === "production") warn(name, "fallback_in_production");
  const m = (g.__ticketstubKeyringFallback ??= new Map());
  let k = m.get(name);
  if (!k) m.set(name, (k = randomBytes(32)));
  return k;
}

/** Once per process and problem: the variable name and a fixed code, never a value. */
function warn(name: string, problem: KeysetProblem | "fallback_in_production") {
  const seen = (g.__ticketstubKeyringWarned ??= new Set());
  if (seen.has(`${name}:${problem}`)) return;
  seen.add(`${name}:${problem}`);
  console.error(
    problem === "fallback_in_production"
      ? `[signing-keys] ${name} is unset and TICKETSTUB_RUNTIME_MODE is not "live" in a production build: signing with a per-process random key (records say mode "sandbox")`
      : `[signing-keys] ${name} unavailable: ${problem}`,
  );
}

/** A single-key secret's raw string (keyring.ts compares it in both readings: text and base64url). */
function secret(name: string): string[] {
  const s = process.env[name]?.trim();
  return s ? [s] : [];
}

/** Every key string another key set's variable holds, without validating it, so no two token classes share a key. */
function setKeyStrings(name: string): string[] {
  try {
    const doc = JSON.parse(process.env[name] ?? "") as { keys?: { key?: unknown }[] };
    return (Array.isArray(doc.keys) ? doc.keys : []).flatMap((e) => (typeof e?.key === "string" && e.key ? [e.key] : []));
  } catch {
    return [];
  }
}

function keyringFor(name: string, retentionMs: number, forbidden: string[]): Keyring | null {
  const r = loadKeyring({ name, raw: process.env[name], live: isLiveRuntime(), retentionMs, forbidden, fallback: () => fallbackKey(name) });
  if (r.ok) return r.keyring;
  warn(name, r.problem);
  return null;
}

/** The approval keyring, or null when it is unset in live mode or invalid in any mode (then nothing verifies). */
export function approvalKeyring(): Keyring | null {
  return keyringFor(APPROVAL_KEYS_ENV, APPROVAL_TTL_MS, [...secret("CONTEXT_SECRET"), ...secret(ORDER_AUTH_CONSUMER_ENV), ...setKeyStrings(ORDER_AUTH_KEYS_ENV)]);
}

/** The approval keyring for issuing. Throws 503 signing_unavailable when there is none, before anything is written. */
export function requireApprovalKeyring(): Keyring {
  const k = approvalKeyring();
  if (!k) throw new HttpError(503, "signing_unavailable", "Approvals aren't set up on this server yet.");
  return k;
}

/** The order-authorization keyring, or null when it is unset in live mode or invalid in any mode (then nothing verifies). */
export function orderAuthKeyring(): Keyring | null {
  return keyringFor(ORDER_AUTH_KEYS_ENV, ORDER_AUTH_TTL_MS, [...secret("CONTEXT_SECRET"), ...secret(ORDER_AUTH_CONSUMER_ENV), ...setKeyStrings(APPROVAL_KEYS_ENV)]);
}

/** The order-authorization keyring for issuing. Throws 503 signing_unavailable when there is none, before anything is written. */
export function requireOrderAuthKeyring(): Keyring {
  const k = orderAuthKeyring();
  if (!k) throw new HttpError(503, "signing_unavailable", "Order authorization isn't set up on this server yet.");
  return k;
}
