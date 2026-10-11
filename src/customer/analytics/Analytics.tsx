"use client";
// Mounted once in the root layout. Points the runtime at this deployment (settings come from the server
// per request), follows the consent choice, records one page view per App Router navigation and
// reports Web Vitals and route timing. With no configuration it renders nothing and sends nothing.
import { usePathname, useSearchParams } from "next/navigation";
import { useReportWebVitals } from "next/web-vitals";
import { Suspense, useEffect } from "react";
import { isAnalyticsConfig, type AnalyticsConfig } from "./config";
import { readConsent, subscribeConsent } from "./consent";
import { ConsentControls } from "./ConsentControls";
import { configureAnalytics, recordPageView, setRejectHandler, trackInternal, updateConsent } from "./runtime";
import { takeRouteTiming, vitalParams } from "./timing";

function PageViews() {
  const pathname = usePathname();
  const search = useSearchParams();
  const query = search?.toString() ?? "";
  useEffect(() => {
    if (!pathname) return;
    const fresh = recordPageView(pathname, query);
    if (!fresh) return;
    // End the route timing after the new route has painted.
    const raf = requestAnimationFrame(() => {
      const timing = takeRouteTiming();
      if (timing) trackInternal("route_timing", timing);
    });
    return () => cancelAnimationFrame(raf);
  }, [pathname, query]);
  return null;
}

function Vitals() {
  useReportWebVitals((metric) => {
    const params = vitalParams(metric);
    if (params) trackInternal("web_vital", params);
  });
  return null;
}

function Runtime({ config }: { config: AnalyticsConfig }) {
  const { measurementId, environment, runtimeMode, debug } = config;
  useEffect(() => {
    configureAnalytics({ config: { measurementId, environment, runtimeMode, debug } });
    if (process.env.NODE_ENV !== "production") {
      setRejectHandler((name, reason) => console.warn(`[analytics] dropped ${name}: ${reason}`));
    }
    updateConsent(readConsent());
    return subscribeConsent(updateConsent);
  }, [measurementId, environment, runtimeMode, debug]);
  return null;
}

export function Analytics({ config }: { config: AnalyticsConfig | null }) {
  if (!isAnalyticsConfig(config)) return null;
  return (
    <>
      <Runtime config={config} />
      <Suspense fallback={null}>
        <PageViews />
      </Suspense>
      <Vitals />
      <ConsentControls />
    </>
  );
}
