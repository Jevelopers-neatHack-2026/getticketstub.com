// The one import product code needs: `track("event_name", { ...params })`. It never throws, never
// blocks, sends nothing without configuration and consent, and rejects anything outside the catalog.
// Safe to call during SSR (it does nothing there) and from any client handler.
import { trackEvent, trackEventOnce } from "./runtime";
import type { EventName, EventParams } from "./catalog";

export type { EventName, EventParams } from "./catalog";
export { EVENTS, SCHEMA_VERSION, VARIANT_IDS, isEventName } from "./catalog";

/** Send a catalogued product event, if analytics is configured and the visitor has agreed. */
export function track<E extends EventName>(name: E, params?: EventParams<E>): void {
  trackEvent(name, params);
}

/**
 * Like track, but at most once per page load for `key`, e.g. a creation boundary that a Strict Mode
 * double effect or a remount could reach twice. The key stays in memory and is never sent, but keep
 * it free of personal data anyway (an operation name plus a local counter, not a title).
 */
export function trackOnce<E extends EventName>(key: string, name: E, params?: EventParams<E>): void {
  trackEventOnce(key, name, params);
}

/** Convert integer minor units (cents) to the major units GA ecommerce `value`/`price` expect. */
export function toMajorUnits(minor: number): number {
  return Number.isFinite(minor) ? Math.round(minor) / 100 : 0;
}
