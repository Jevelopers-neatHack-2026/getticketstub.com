// Runs before hydration. Analytics only notes when an App Router navigation starts (for route timing);
// it sends nothing here and keeps nothing about the destination URL.
import { markRouteStart } from "@/customer/analytics/timing";

export function onRouterTransitionStart(_url: string, navigationType: "push" | "replace" | "traverse") {
  try {
    markRouteStart(navigationType);
  } catch {
    /* timing is optional */
  }
}
