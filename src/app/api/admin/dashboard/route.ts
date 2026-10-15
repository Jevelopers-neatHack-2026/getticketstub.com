import { dashboardHostView, openAdminDashboard } from "@/server/dashboard-host";
import { json } from "@/server/http";

export const runtime = "nodejs";

/** Staff-only display/read availability. No body, token, capability or scope is
 * accepted from the browser; session authority is derived afresh for every GET. */
export async function GET(req: Request): Promise<Response> {
  const query = new URL(req.url).searchParams;
  const selectors = query.getAll("project");
  const selector = selectors.length === 0 ? undefined : selectors.length === 1 ? selectors[0] : selectors;
  const opened = await openAdminDashboard(req.headers, selector);
  const missing = () => json({ error: { code: "not_found", message: "We couldn't find that." } }, { status: 404 });
  if (opened.state === "denied" || opened.state === "no-project") return missing();
  if (opened.state !== "ready") return json({ error: { code: "context_unavailable", message: "Dashboard context is unavailable. Try again later." } }, { status: 503 });
  const view = await dashboardHostView(opened.session, req.signal);
  if (view.state === "denied") return missing();
  if (view.state !== "ready") return json({ error: { code: "context_unavailable", message: "Dashboard context is unavailable. Try again later." } }, { status: 503 });
  // An authenticated projection is available; actual Finance reporting is not.
  return json({ schema: "ticketstub.admin-host-view/1", ...view });
}
