import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { openAdminDashboard, dashboardHostView } from "@/server/dashboard-host";
import { ADMIN_BASE_PATH, type AdminNavInjection } from "../contract";
import { AdminMount } from "../AdminMount";

const SEGMENT = /^[A-Za-z0-9._~-]{1,64}$/;
const MAX_DEPTH = 8;

const NAV: AdminNavInjection = {
  base: ADMIN_BASE_PATH,
  root: { label: "Admin", href: ADMIN_BASE_PATH },
  items: [
    { label: "Overview", href: ADMIN_BASE_PATH },
    { label: "Deep link sample", href: `${ADMIN_BASE_PATH}/x/y` },
  ],
};

/**
 * /admin and everything below it. The gate is here, on the server, from the signed session: anyone who is not
 * staff gets the same 404 as a path that doesn't exist. The sidebar entry is cosmetic; this is the check.
 */
export default async function AdminPage({ params, searchParams }: {
  params: Promise<{ path?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const opened = await openAdminDashboard(await headers(), query.project);
  if (opened.state === "denied" || opened.state === "no-project") notFound();
  if (opened.state !== "ready") throw new Error("Admin context unavailable");

  const { path = [] } = await params;
  let segments: string[];
  try { segments = path.map((s) => decodeURIComponent(s)); } catch { notFound(); }
  if (segments.length > MAX_DEPTH || !segments.every((s) => SEGMENT.test(s))) notFound();
  // Staff-only on purpose: lets verify:product see the error boundary on a real route.
  if (segments[0] === "fixture-error") throw new Error("admin fixture error (deliberate)");

  const view = await dashboardHostView(opened.session);
  if (view.state === "denied") notFound();
  if (view.state !== "ready") throw new Error("Admin context unavailable");
  return <AdminMount context={{ summary: view.summary, finance: view.finance, mount: view.mount }} nav={NAV} path={segments} />;
}
