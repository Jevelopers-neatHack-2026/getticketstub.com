// Analytics configuration, read on the server per request (the root layout is dynamic) and handed to
// the client as props, so one build can run as production, preview or disabled. A GA4 measurement id
// is public by design; nothing secret belongs here. Missing or malformed settings mean no analytics.

export type DeploymentEnv = "production" | "preview";
export type RuntimeMode = "demo" | "live";

export interface AnalyticsConfig {
  measurementId: string;
  /** Which deployment this is; sent on every event so preview traffic can never pass for production. */
  environment: DeploymentEnv;
  /** The AI runtime setting. "live" never means live commerce. */
  runtimeMode: RuntimeMode;
  /** Send GA's debug_mode so events show in DebugView (designated test property only). */
  debug: boolean;
}

const MEASUREMENT_ID = /^G-[A-Z0-9]{4,16}$/;

type Env = Record<string, string | undefined>;

/**
 * TICKETSTUB_ANALYTICS_ENV (production|preview) and TICKETSTUB_GA_MEASUREMENT_ID must both be set.
 * TICKETSTUB_ANALYTICS_DISABLED=1 is the kill switch, and automated tests (NODE_ENV=test) never collect.
 */
export function analyticsConfigFromEnv(env: Env): AnalyticsConfig | null {
  if (env.NODE_ENV === "test" || env.TICKETSTUB_ANALYTICS_DISABLED === "1") return null;
  const environment = env.TICKETSTUB_ANALYTICS_ENV;
  if (environment !== "production" && environment !== "preview") return null;
  const measurementId = (env.TICKETSTUB_GA_MEASUREMENT_ID ?? "").trim();
  if (!MEASUREMENT_ID.test(measurementId)) return null;
  return {
    measurementId,
    environment,
    runtimeMode: env.TICKETSTUB_RUNTIME_MODE === "live" ? "live" : "demo",
    debug: env.TICKETSTUB_GA_DEBUG === "1",
  };
}

/** Accept only a well-formed config from props (the client never trusts its shape blindly). */
export function isAnalyticsConfig(v: unknown): v is AnalyticsConfig {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.measurementId === "string" && MEASUREMENT_ID.test(c.measurementId) &&
    (c.environment === "production" || c.environment === "preview") &&
    (c.runtimeMode === "demo" || c.runtimeMode === "live") &&
    typeof c.debug === "boolean"
  );
}
