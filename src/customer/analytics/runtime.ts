// The analytics runtime: one per page, shared by every caller. It decides whether an event may leave
// (configured, consented, tag loaded), attaches the sanitized page, and drops everything else. There
// is no backlog: an event tracked before consent is gone, not saved for later. The only buffer holds
// events tracked after consent while the tag is still loading, and it is discarded if consent is
// withdrawn or the tag never arrives. Framework-free so it runs under node:test.
import { SCHEMA_VERSION, type EventName, type EventParams, type InternalEventName, type InternalEventParams } from "./catalog";
import type { AnalyticsConfig } from "./config";
import type { ConsentState } from "./consent";
import { clearGaCookies, createGtagTransport, type PageContext, type Transport } from "./gtag";
import { sanitizeLocation, sanitizePath, sanitizeReferrer } from "./routes";
import { validateEvent, validateInternalEvent, type SafeParams, type Validation } from "./validate";

type Phase = "idle" | "loading" | "ready" | "failed";

interface Page {
  /** Raw pathname + search: identifies a navigation for de-duplication. Never leaves this module. */
  key: string;
  template: string;
  title: string;
  location: string;
  /** origin + template, without campaign tags: the next page's referrer. */
  base: string;
  referrer: string;
}

export interface ConfigureOptions {
  config: AnalyticsConfig | null;
  transport?: (config: AnalyticsConfig) => Transport;
  /** Defaults to window.location.origin and document.referrer. */
  origin?: string;
  referrer?: string;
}

export const MAX_PENDING = 25;
export const MAX_ONCE_KEYS = 1000;

let config: AnalyticsConfig | null = null;
let makeTransport: ((c: AnalyticsConfig) => Transport) | null = null;
let transport: Transport | null = null;
let consent: ConsentState = "unset";
let phase: Phase = "idle";
let pending: { name: string; params: SafeParams }[] = [];
let page: Page | null = null;
let pageSent = false;
let origin = "";
let landingReferrer = "";
let envRead = false;
const onceKeys = new Set<string>();
let onReject: ((name: string, reason: string) => void) | null = null;

/** The page's origin and the referrer it was opened from, read once (an SPA keeps both). */
function readEnv() {
  if (envRead || typeof window === "undefined") return;
  envRead = true;
  origin = window.location.origin;
  landingReferrer = document.referrer;
}

function pageContext(): PageContext {
  return { page_location: page?.location ?? "", page_referrer: page?.referrer ?? "", page_title: page?.title ?? "" };
}

function deliver(name: string, params: SafeParams) {
  if (!config || !transport || consent !== "granted") return;
  const full: SafeParams = {
    ...params,
    schema_version: SCHEMA_VERSION,
    deployment_env: config.environment,
    runtime_mode: config.runtimeMode,
    route_template: page?.template ?? "",
    ...pageContext(),
  };
  if (phase === "loading") {
    if (pending.length < MAX_PENDING) pending.push({ name, params: full });
    return;
  }
  if (phase !== "ready") return;
  try {
    transport.send(name, full);
  } catch {
    /* a provider failure never reaches the customer's action */
  }
}

function accept(name: string, v: Validation) {
  if (!v.ok) {
    onReject?.(name, v.reason);
    return;
  }
  deliver(name, v.params);
}

function sendPageView() {
  if (!page || pageSent || consent !== "granted" || !config) return;
  pageSent = true;
  accept("page_view", validateInternalEvent("page_view"));
}

function startLoad() {
  if (!config || !transport) return;
  const mine = transport;
  phase = "loading";
  let promise: Promise<void>;
  try {
    promise = mine.load(pageContext());
  } catch {
    phase = "failed";
    pending = [];
    return;
  }
  promise.then(
    () => {
      // A loader from a replaced deployment (or a reset) must not touch the current one.
      if (transport !== mine || phase !== "loading") return;
      phase = "ready";
      // Every consent change empties the buffer, so whatever is left was tracked under the current grant.
      const queued = consent === "granted" ? pending : [];
      pending = [];
      for (const e of queued) {
        try {
          mine.send(e.name, e.params);
        } catch {
          /* ignore */
        }
      }
    },
    () => {
      if (transport !== mine || phase !== "loading") return;
      // Blocked or too slow: nothing waits for it, and a late arrival gets nothing stale.
      phase = "failed";
      pending = [];
    },
  );
}

function applyConsent(next: ConsentState) {
  const prev = consent;
  consent = next;
  if (prev === next || !config || !transport) return;
  pending = [];
  if (next === "granted") {
    pageSent = false;
    if (phase === "idle") startLoad();
    else if (phase === "ready" || phase === "loading") {
      try {
        transport.resume(pageContext());
      } catch {
        /* ignore */
      }
    }
    // The page the visitor is on when they agree is measured; pages before it are not.
    sendPageView();
  } else if (prev === "granted") {
    pageSent = false;
    if (phase === "ready" || phase === "loading") {
      try {
        transport.pause();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Point the runtime at a deployment. Idempotent for the same settings (Strict Mode runs effects
 * twice), so page de-duplication survives remounts. A null config makes everything a no-op.
 */
export function configureAnalytics(opts: ConfigureOptions): void {
  try {
    const next = opts.config;
    const same =
      next && config &&
      next.measurementId === config.measurementId && next.environment === config.environment &&
      next.runtimeMode === config.runtimeMode && next.debug === config.debug;
    if (same) return;
    if (config && transport && consent === "granted" && phase !== "idle") transport.pause();
    config = next;
    makeTransport = opts.transport ?? makeTransport ?? ((c) => createGtagTransport(c));
    transport = next && makeTransport ? makeTransport(next) : null;
    phase = "idle";
      pending = [];
    pageSent = false;
    if (opts.origin !== undefined) origin = opts.origin;
    if (opts.referrer !== undefined) landingReferrer = opts.referrer;
    envRead = envRead || opts.origin !== undefined;
    const prevConsent = consent;
    consent = "unset";
    applyConsent(prevConsent);
  } catch {
    config = null;
    transport = null;
  }
}

/** Follow the visitor's choice. Withdrawal stops sending at once and drops anything buffered. */
export function updateConsent(next: ConsentState): void {
  try {
    if (next !== "granted" && typeof document !== "undefined" && typeof window !== "undefined") {
      clearGaCookies(document, window.location.hostname);
    }
    if (!config) {
      consent = next;
      return;
    }
    applyConsent(next);
  } catch {
    /* ignore */
  }
}

/**
 * Record an accepted navigation. The same pathname+search twice in a row is one view (Strict Mode,
 * remounts, re-renders); anything else is a new view, including back/forward and a different id on
 * the same template. Recorded even without consent so the page is known; sent only with it.
 * Returns whether this was a new navigation.
 */
export function recordPageView(pathname: string, search = ""): boolean {
  try {
    const key = `${pathname}?${search.replace(/^\?/, "")}`;
    if (page && page.key === key) return false;
    readEnv();
    const landing = page === null;
    const safe = sanitizePath(pathname);
    const base = sanitizeLocation(origin, pathname);
    page = {
      key,
      template: safe.template,
      title: safe.title,
      location: landing ? sanitizeLocation(origin, pathname, search, { landing: true }) : base,
      base,
      referrer: landing ? sanitizeReferrer(landingReferrer, origin) : (page?.base ?? ""),
    };
    pageSent = false;
    sendPageView();
    return true;
  } catch {
    return false;
  }
}

/** The public entry point (re-exported by ./track). Never throws. */
export function trackEvent<E extends EventName>(name: E, params?: EventParams<E>): void {
  try {
    if (!config) return;
    accept(name, validateEvent(name, params));
  } catch {
    /* ignore */
  }
}

/** Track once per page lifetime for a caller-chosen key (kept in memory, never sent). */
export function trackEventOnce<E extends EventName>(key: string, name: E, params?: EventParams<E>): void {
  try {
    if (onceKeys.has(key)) return;
    if (onceKeys.size >= MAX_ONCE_KEYS) onceKeys.delete(onceKeys.values().next().value as string);
    onceKeys.add(key);
    trackEvent(name, params);
  } catch {
    /* ignore */
  }
}

/** Runtime-owned events: page timing and Web Vitals. */
export function trackInternal<E extends Exclude<InternalEventName, "page_view">>(name: E, params: InternalEventParams<E>): void {
  try {
    if (!config) return;
    accept(name, validateInternalEvent(name, params));
  } catch {
    /* ignore */
  }
}

/** The current page's template (for callers' own logic; it is already attached to every event). */
export function currentRouteTemplate(): string | null {
  return page?.template ?? null;
}

/** Development aid: hear about rejected events (reasons name keys, never values). */
export function setRejectHandler(handler: ((name: string, reason: string) => void) | null): void {
  onReject = handler;
}

/** Test-only: forget everything, as a fresh page load would. */
export function resetAnalyticsForTests(): void {
  config = null;
  makeTransport = null;
  transport = null;
  consent = "unset";
  phase = "idle";
  pending = [];
  page = null;
  pageSent = false;
  origin = "";
  landingReferrer = "";
  envRead = false;
  onceKeys.clear();
  onReject = null;
}
