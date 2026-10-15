// Pure app-owned mapping, shared with the offline reference verifier. This is a
// projection, never authentication or a grant. Finance consumer acceptance is separate.
export const FINANCE_SCOPE_ADAPTER = "ticketstub.finance-scope-adapter/1";
export const FINANCE_ID_MAX = 128;

export interface FinanceScope {
  tenantId: string;
  projectId: string;
  environment: "development" | "test" | "production";
  billingMode: "simulated" | "sandbox" | "live";
  actorId: string;
}
export type FinanceScopeResult =
  | { ok: true; schema: typeof FINANCE_SCOPE_ADAPTER; scope: FinanceScope; evidenceMode: "mocked" | "sandbox" | "live" }
  | { ok: false; schema: typeof FINANCE_SCOPE_ADAPTER; reason: "unsupported_context" | "identifier_too_long"; fields?: string[] };

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Preserve the fixture's exact table and bounds; never truncate kind-prefixed identifiers.
 * A caller must first verify /2 and its current membership. No project means
 * platform only when the issuer separately grants that authority to staff. */
export function toFinanceScope(ctx: unknown): FinanceScopeResult {
  const refuse = (reason: "unsupported_context" | "identifier_too_long", fields?: string[]): FinanceScopeResult =>
    ({ ok: false, schema: FINANCE_SCOPE_ADAPTER, reason, ...(fields ? { fields } : {}) });
  if (!object(ctx) || ctx.schema !== "ticketstub.context/2" || !object(ctx.tenant) || !object(ctx.actor) ||
      (ctx.project !== undefined && !object(ctx.project))) return refuse("unsupported_context");
  // Explicit enum membership also refuses prototype-property names and coercible objects.
  const environment = ctx.environment === "development" ? "development" : ctx.environment === "preview" ? "test" : ctx.environment === "live" ? "production" : null;
  const billingMode = ctx.economicMode === "none" ? "simulated" : ctx.economicMode === "sandbox" ? "sandbox" : ctx.economicMode === "paid_test" || ctx.economicMode === "live" ? "live" : null;
  const evidenceMode = ctx.evidenceMode === "fixture" ? "mocked" : ctx.evidenceMode === "synthetic" ? "sandbox" : ctx.evidenceMode === "live" ? "live" : null;
  if (!environment || !billingMode || !evidenceMode) return refuse("unsupported_context");
  const ids = { tenantId: ctx.tenant.id, projectId: ctx.project ? ctx.project.ref : "platform", actorId: ctx.actor.id };
  const tooLong = (Object.keys(ids) as (keyof typeof ids)[]).filter((k) => typeof ids[k] !== "string" || (ids[k] as string).length < 1 || (ids[k] as string).length > FINANCE_ID_MAX);
  if (tooLong.length) return refuse("identifier_too_long", tooLong);
  const scope: FinanceScope = { tenantId: ids.tenantId as string, projectId: ids.projectId as string, environment, billingMode, actorId: ids.actorId as string };
  return { ok: true, schema: FINANCE_SCOPE_ADAPTER, scope, evidenceMode };
}
