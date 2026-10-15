import "server-only";
import { getServerContext, issueContextV2, requireStaff, verifyContextTokenLive, type ContextV2 } from "./context";
import { toFinanceScope, type FinanceScope } from "./finance-scope";
import type { AdminContextSummary } from "@/app/admin/contract";

export const DASHBOARD_AUDIENCE = "ticketstub.finance";
export const DASHBOARD_MAX_TTL_MS = 360_000;
type Project = { kind: "stub" | "event"; id: string };
type Denied = { state: "denied" };
type Unavailable = { state: "unavailable" };
type NoProject = { state: "no-project" };

/** App-owned handle. Only this module can issue an authentic instance. Neither
 * serialization nor a structurally identical object carries its authority. */
export interface DashboardSession { readonly summary: AdminContextSummary }
type OpenResult = Denied | Unavailable | NoProject | { state: "ready"; session: DashboardSession };
const credentials = new WeakMap<DashboardSession, { token: string; scope: FinanceScope; expiresAt: number; admin: boolean }>();

/** A URL selects a project, never an actor, tenant, capability or authority token.
 * An array (duplicate query keys), empty value and malformed selector all deny. */
export function parseDashboardProject(value: unknown): { ok: true; project?: Project } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string") return { ok: false };
  const match = /^(stub|event):([\w.:-]{1,128})$/.exec(value);
  return match ? { ok: true, project: { kind: match[1] as Project["kind"], id: match[2] } } : { ok: false };
}

function projected(ctx: ContextV2): AdminContextSummary {
  return Object.freeze({
    schema: ctx.schema, actorKind: "account", role: ctx.role, tenantId: ctx.tenant.id,
    environment: ctx.environment, economicMode: ctx.economicMode, evidenceMode: ctx.evidenceMode,
    projectRef: ctx.project?.ref ?? null, revision: `${ctx.actor.id}@${ctx.membershipRevision}`,
    capabilities: Object.freeze([...ctx.capabilities]), expiresAt: ctx.expiresAt, verified: true,
  });
}

/** Fresh server-issued /2 only, checked in process against current storage. The
 * credential remains exclusively in a private WeakMap, never in client props.
 * Nonstaff no-project is modeled here without admitting it to /admin. */
export async function openDashboardSession(headers: Headers, selector?: unknown, admin = false): Promise<OpenResult> {
  // Public admin admission keeps the old concealed 404 behavior even when storage is down.
  if (admin) { try { await requireStaff(headers); } catch { return { state: "denied" }; } }
  try {
    const selected = parseDashboardProject(selector);
    if (!selected.ok) return { state: "denied" };
    const ctx = await getServerContext(headers, selected.project);
    if (ctx.actor.kind !== "account" || ctx.revoked || (selected.project && ctx.role === "none")) return { state: "denied" };
    const { token } = issueContextV2(ctx);
    const now = Date.now();
    const verified = await verifyContextTokenLive(token, now, { audience: DASHBOARD_AUDIENCE });
    if (!verified.ok || verified.ctx.schema !== "ticketstub.context/2") return { state: "denied" };
    const current = verified.ctx;
    const remaining = Date.parse(current.expiresAt) - Date.now();
    if (remaining <= 0 || remaining > DASHBOARD_MAX_TTL_MS) return { state: "denied" };
    if (!selected.project && !current.capabilities.includes("admin.view")) return { state: "no-project" };
    if (admin && !current.capabilities.includes("admin.view")) return { state: "denied" };
    const mapping = toFinanceScope(current);
    if (!mapping.ok) return { state: "unavailable" };
    const session = Object.freeze({ summary: projected(current) });
    credentials.set(session, { token, scope: Object.freeze(mapping.scope), expiresAt: Date.parse(current.expiresAt), admin });
    return { state: "ready", session };
  } catch {
    // No raw provider, storage, configuration or credential errors cross the host boundary.
    return { state: "unavailable" };
  }
}

/** Keep /admin's existing staff-only concealment, including on every recheck. */
export async function openAdminDashboard(headers: Headers, selector?: unknown): Promise<OpenResult> {
  return openDashboardSession(headers, selector, true);
}

async function current(session: DashboardSession, signal?: AbortSignal): Promise<boolean> {
  const saved = credentials.get(session);
  if (!saved || signal?.aborted || saved.expiresAt <= Date.now()) return false;
  const result = await verifyContextTokenLive(saved.token, Date.now(), { audience: DASHBOARD_AUDIENCE });
  if (!result.ok || result.ctx.schema !== "ticketstub.context/2" || signal?.aborted || saved.expiresAt <= Date.now()) return false;
  const ctx = result.ctx;
  if (saved.admin && !ctx.capabilities.includes("admin.view")) return false;
  if (!ctx.project && !ctx.capabilities.includes("admin.view")) return false;
  const mapped = toFinanceScope(ctx);
  return mapped.ok && (Object.keys(saved.scope) as (keyof FinanceScope)[]).every((key) => mapped.scope[key] === saved.scope[key]);
}

/** App-owned asynchronous read fence, not a Finance port or a cross-database
 * transaction. The real live verifier runs before and after every awaited read.
 * Callers must supply their own accepted minimal-field projection. This function
 * grants nothing: a missing explicit finance.read capability denies the callback. */
export async function guardDashboardRead<T>(session: DashboardSession, read: (scope: Readonly<FinanceScope>) => Promise<T>, signal?: AbortSignal): Promise<Denied | Unavailable | { state: "ready"; value: T }> {
  try {
    if (!session.summary.capabilities.includes("finance.read") || !await current(session, signal)) return { state: "denied" };
    const value = await read(credentials.get(session)!.scope);
    if (!await current(session, signal)) return { state: "denied" };
    return { state: "ready", value };
  } catch { return { state: "unavailable" }; }
}

/** Current production boundary: no accepted configured Finance read adapter is
 * installed. Never turn that absence into zero-valued reports or synthetic data.
 * The display-only summary itself is rechecked before disclosure. */
export async function dashboardHostView(session: DashboardSession, signal?: AbortSignal): Promise<Denied | Unavailable | {
  state: "ready"; summary: AdminContextSummary; finance: "restricted" | "unavailable"; mount: "runtime-pending";
}> {
  try {
    if (!await current(session, signal)) return { state: "denied" };
    return { state: "ready", summary: session.summary,
      finance: session.summary.capabilities.includes("finance.read") ? "unavailable" : "restricted", mount: "runtime-pending" };
  } catch { return { state: "unavailable" }; }
}
