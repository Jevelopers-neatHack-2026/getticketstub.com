// The GA4 adapter. Nothing here runs until the runtime has consent: no script, no dataLayer, no
// cookie. After consent it injects gtag.js once, configures it for manual, sanitized page views with
// Google signals and ad features off, and sends only what the runtime hands it. Every hit carries an
// explicit page_location/page_referrer/page_title so gtag never falls back to document.location,
// document.referrer or document.title (which can hold share tokens, typed input or stub titles).
import type { AnalyticsConfig } from "./config";
import type { SafeParams } from "./validate";

export interface PageContext {
  page_location: string;
  page_referrer: string;
  page_title: string;
}

export interface Transport {
  /** Inject and configure the tag. Resolves when it has loaded; rejects if blocked or too slow. */
  load(page: PageContext): Promise<void>;
  send(name: string, params: SafeParams): void;
  /** Withdrawal: stop collection now and remove GA's first-party cookies. */
  pause(): void;
  /** Consent given again in the same page after a withdrawal. */
  resume(page: PageContext): void;
}

/** Recommended ecommerce events whose single variant becomes GA's `items` array. */
const ITEM_EVENTS = new Set(["add_to_cart", "remove_from_cart", "begin_checkout", "view_item"]);

/**
 * Shape validated params the way GA ecommerce reads them: a variant id and quantity move into a
 * one-entry `items` array (GA ignores item fields at event level). Everything else passes through.
 */
export function toGaParams(name: string, params: SafeParams): Record<string, unknown> {
  if (!ITEM_EVENTS.has(name) || typeof params.item_id !== "string") return { ...params };
  const { item_id, quantity, ...rest } = params;
  const [material, finish, size] = item_id.split("_");
  const item: Record<string, string | number> = { item_id, item_category: material, item_variant: `${finish}_${size}` };
  if (typeof quantity === "number" && quantity > 0) item.quantity = quantity;
  return { ...rest, items: [item] };
}

export const GTAG_ORIGIN = "https://www.googletagmanager.com";
export const LOAD_TIMEOUT_MS = 10_000;

type GtagWindow = Window & { dataLayer?: unknown[]; [disable: `ga-disable-${string}`]: boolean | undefined };

/** Delete GA's cookies (_ga, _ga_<stream>) on this host and each parent domain GA may have used. */
export function clearGaCookies(doc: Document, hostname: string): void {
  let names: string[];
  try {
    names = doc.cookie
      .split(";")
      .map((c) => c.split("=")[0].trim())
      .filter((n) => n === "_ga" || n.startsWith("_ga_") || n === "_gid" || n === "_gat" || n.startsWith("_gat_"));
  } catch {
    return;
  }
  const parts = hostname.split(".");
  const domains = [""];
  for (let i = 0; i < parts.length - 1; i++) domains.push(`; domain=.${parts.slice(i).join(".")}`);
  for (const name of names) {
    for (const d of domains) {
      try {
        doc.cookie = `${name}=; Max-Age=0; path=/${d}`;
      } catch {
        /* a locked-down cookie jar is not our failure to surface */
      }
    }
  }
}

export function createGtagTransport(config: AnalyticsConfig, win: Window = window): Transport {
  const w = win as GtagWindow;
  const doc = win.document;
  const disableKey = `ga-disable-${config.measurementId}` as const;
  let loading: Promise<void> | null = null;

  // gtag.js reads the Arguments object, not an array, from the dataLayer.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function gtag(..._args: unknown[]) {
    // eslint-disable-next-line prefer-rest-params
    (w.dataLayer ??= []).push(arguments);
  }

  function setPage(page: PageContext) {
    gtag("set", { ...page });
  }

  return {
    load(page) {
      if (loading) return loading;
      w[disableKey] = false;
      w.dataLayer ??= [];
      // Basic consent mode: the tag loads only after the visitor agreed to analytics. Advertising
      // storage and signals stay denied; there is no ad product in this app.
      gtag("consent", "default", {
        analytics_storage: "granted",
        ad_storage: "denied",
        ad_user_data: "denied",
        ad_personalization: "denied",
        functionality_storage: "denied",
        personalization_storage: "denied",
        security_storage: "granted",
      });
      gtag("set", "ads_data_redaction", true);
      gtag("set", "url_passthrough", false);
      gtag("js", new Date());
      gtag("config", config.measurementId, {
        send_page_view: false,
        allow_google_signals: false,
        allow_ad_personalization_signals: false,
        cookie_flags: "SameSite=Lax;Secure",
        ...page,
        ...(config.debug ? { debug_mode: true } : {}),
      });
      loading = new Promise<void>((resolve, reject) => {
        const script = doc.createElement("script");
        let settled = false;
        const timer = setTimeout(() => finish(new Error("timeout")), LOAD_TIMEOUT_MS);
        function finish(err?: Error) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) reject(err);
          else resolve();
        }
        script.async = true;
        script.src = `${GTAG_ORIGIN}/gtag/js?id=${encodeURIComponent(config.measurementId)}`;
        script.dataset.analytics = "ga4";
        script.onload = () => finish();
        script.onerror = () => finish(new Error("blocked"));
        doc.head.appendChild(script);
      });
      return loading;
    },
    send(name, params) {
      // Keep the tag-wide page fields current too, so anything gtag sends on its own (an enhanced
      // measurement event left on by mistake) carries the sanitized page instead of the real one.
      if (name === "page_view") setPage({ page_location: String(params.page_location), page_referrer: String(params.page_referrer), page_title: String(params.page_title) });
      gtag("event", name, toGaParams(name, params));
    },
    pause() {
      w[disableKey] = true;
      if (w.dataLayer) gtag("consent", "update", { analytics_storage: "denied" });
      clearGaCookies(doc, win.location.hostname);
    },
    resume(page) {
      w[disableKey] = false;
      gtag("consent", "update", { analytics_storage: "granted" });
      setPage(page);
    },
  };
}
