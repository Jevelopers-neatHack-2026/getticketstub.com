import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { contextAudience, issueContextToken, requireStaff, verifyContextTokenLive, type RequestContext } from "@/server/context";
import { ADMIN_BASE_PATH, type AdminContextSummary, type AdminNavInjection } from "../contract";
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
export default async function AdminPage({ params }: { params: Promise<{ path?: string[] }> }) {
  let ctx: RequestContext;
  try {
    ctx = await requireStaff(await headers());
  } catch {
    notFound(); // not signed in, not on ADMIN_EMAILS, or no admin.view: the same 404 as a path that isn't there
  }
  if (ctx.role !== "staff") notFound();

  const { path = [] } = await params;
  const segments = path.map((s) => decodeURIComponent(s));
  if (segments.length > MAX_DEPTH || !segments.every((s) => SEGMENT.test(s))) notFound();
  // Staff-only on purpose: lets verify:product see the error boundary on a real route.
  if (segments[0] === "fixture-error") throw new Error("admin fixture error (deliberate)");

  const token = issueContextToken(ctx);
  const verified = (await verifyContextTokenLive(token, undefined, { audience: contextAudience() })).ok;
  const summary: AdminContextSummary = {
    schema: ctx.schema,
    actorKind: ctx.actor.kind,
    role: ctx.role,
    tenantId: ctx.tenant.id,
    environment: ctx.environment,
    mode: ctx.mode,
    capabilities: ctx.capabilities,
    expiresAt: ctx.expiresAt,
    verified,
  };
  return <AdminMount context={{ token, summary }} nav={NAV} path={segments} />;
}
