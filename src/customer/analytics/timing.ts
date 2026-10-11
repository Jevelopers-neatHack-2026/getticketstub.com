// Route timing and Web Vitals, reduced to catalog values. The router tells src/instrumentation-client.ts
// when a navigation starts; the page-view observer ends it after the new route has painted. Only the
// navigation type and a duration are kept: the URL the router passes is never stored.
import type { InternalEventParams } from "./catalog";

type NavType = "push" | "replace" | "traverse";

let started: { at: number; type: NavType } | null = null;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Called from onRouterTransitionStart. */
export function markRouteStart(navigationType: string): void {
  const type: NavType = navigationType === "replace" || navigationType === "traverse" ? navigationType : "push";
  started = { at: now(), type };
}

/**
 * The finished navigation's timing, once: null for the first load (Web Vitals cover it), for a start
 * that never led to a new page, or for a stale start (over the catalog's ten minutes).
 */
export function takeRouteTiming(): InternalEventParams<"route_timing"> | null {
  const s = started;
  started = null;
  if (!s) return null;
  const ms = Math.round(now() - s.at);
  if (!(ms >= 0 && ms <= 600_000)) return null;
  return { duration_ms: ms, navigation_type: s.type };
}

/** The fields useReportWebVitals hands us (next/dist/compiled/web-vitals Metric). */
export interface VitalMetric {
  name: string;
  value: number;
  rating?: string;
  navigationType?: string;
}

const VITALS = ["CLS", "FCP", "INP", "LCP", "TTFB"] as const;
const RATINGS = ["good", "needs-improvement", "poor"] as const;
const NAV_TYPES = ["navigate", "reload", "back-forward", "back-forward-cache", "prerender", "restore"] as const;

/**
 * A Web Vitals report as web_vital params: CLS as score x 1000, the rest in whole milliseconds. The
 * metric's id (unique per page load) is dropped; percentiles come from GA's own aggregation.
 */
export function vitalParams(m: VitalMetric): InternalEventParams<"web_vital"> | null {
  const name = VITALS.find((v) => v === m.name);
  if (!name || typeof m.value !== "number" || !Number.isFinite(m.value) || m.value < 0) return null;
  const value = Math.round(name === "CLS" ? m.value * 1000 : m.value);
  if (value > 600_000) return null;
  const rating = RATINGS.find((r) => r === m.rating);
  return {
    metric_name: name,
    metric_value: value,
    ...(rating ? { metric_rating: rating } : {}),
    navigation_type: NAV_TYPES.find((t) => t === m.navigationType) ?? "unknown",
  };
}

/** Test-only. */
export function resetTimingForTests(): void {
  started = null;
}
