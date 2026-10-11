// Product-flow helpers (issue #39). Screens name what happened with flow(), typed by the one event catalog
// (src/customer/analytics/catalog.ts), so a call can only carry that event's bounded enums, numbers and booleans:
// never a title, a name, a token, a URL, an error message or anything a person typed. The helpers here turn the
// app's own values (thrown errors, storage failures, minor-unit prices) into those bounded values.
// Nothing here throws, renders or changes a flow: with analytics off (no consent, no config, tests) it does nothing.
import { track } from "@/customer/analytics/track";
import type { EventName, EventParams } from "@/customer/analytics/catalog";
import { MESSAGE_CODES, type MessageCode } from "@/customer/feedback-messages/messages";

export type { EventName, EventParams };

/** Record one product-flow event. Never throws; a blocked or missing analytics layer changes nothing. */
export function flow<E extends EventName>(name: E, params?: EventParams<E>): void {
  try {
    track(name, params);
  } catch {
    /* analytics is optional */
  }
}

/** A caught error as its bounded catalog code (src/customer/feedback-messages/messages.ts): never its message. */
export function errorCode(err: unknown): MessageCode {
  let code: unknown = err;
  if (typeof err === "object" && err !== null) {
    const o = err as { code?: unknown; name?: unknown; error?: { code?: unknown } };
    code = typeof o.code === "string" ? o.code : typeof o.error?.code === "string" ? o.error.code : o.name === "AbortError" || o.name === "TimeoutError" ? "timeout" : undefined;
  }
  return typeof code === "string" && (MESSAGE_CODES as readonly string[]).includes(code) ? (code as MessageCode) : "unknown";
}

/** A monotonic clock reading for since(). */
export function clock(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Whole milliseconds since a clock() reading, never negative, capped at the catalog's ten minutes. */
export function since(start: number): number {
  return Math.min(600_000, Math.max(0, Math.round(clock() - start)));
}

/** Minor units (cents) as the major-unit number GA expects for `value`. */
export const major = (minor: number): number => (Number.isFinite(minor) ? Math.min(100_000, Math.max(0, Math.round(minor)) / 100) : 0);

/** A whole count for a bounded parameter (the catalog caps counts at 1000). */
export const count = (n: number): number => Math.min(1000, Math.max(0, Math.round(n)));

/** The closed variant id for a material, finish and size: never a stub, cart, quote or order id. */
export const variantId = <M extends string, F extends string, S extends string>(material: M, finish: F, size: S) => `${material}_${finish}_${size}` as const;

type Store = NonNullable<EventParams<"storage_failure">["store"]>;
type Reason = NonNullable<EventParams<"storage_failure">["reason"]>;

/** Storage failures are reported once per store, operation and reason per page load: a full quota must not flood. */
const reported = new Set<string>();
export function storageFailure(store: Store, op: "read" | "write", err: unknown): void {
  const reason = storageReason(err);
  const key = `${store}|${op}|${reason}`;
  if (reported.has(key)) return;
  reported.add(key);
  flow("storage_failure", { store, op, reason });
}

/** Why a storage call threw, as one of four words (never the record, never the error's message). */
export function storageReason(err: unknown): Reason {
  const name = typeof err === "object" && err !== null ? String((err as { name?: unknown }).name ?? "") : "";
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") return "quota";
  if (name === "SecurityError" || name === "ReferenceError" || name === "InvalidStateError") return "unavailable";
  if (name === "SyntaxError") return "parse";
  return "unknown";
}

/** For tests: forget which storage failures were already reported. */
export function resetStorageReports(): void {
  reported.clear();
}

/** What a remix produced, in the catalog's words: generated or procedural art, and where it truly came from. */
export function artOutcome(art: { kind: string; provenance: string }): { art: "generated" | "procedural"; capability: "live" | "sandbox" | "simulated" } {
  return {
    art: art.kind === "image" ? "generated" : "procedural",
    // only a real image model is live; estimated or pending art is reported as simulated, never as live
    capability: art.provenance === "live" ? "live" : art.provenance === "sandbox" ? "sandbox" : "simulated",
  };
}

/** A remix vibe chip as a bounded value; anything typed is "custom" and is never sent. */
export function vibeOf(vibe: string | null | undefined): "neon" | "risograph" | "70s" | "minimal" | "custom" | "none" {
  if (!vibe) return "none";
  const v = vibe.toLowerCase();
  return v === "neon" || v === "risograph" || v === "70s" || v === "minimal" ? v : "custom";
}
