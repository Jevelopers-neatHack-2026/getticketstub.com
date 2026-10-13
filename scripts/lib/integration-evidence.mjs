// Evidence for one new, correlated run of the available app adapters. This is not
// an integration-evals OwnerResponse or an assertion of specialist acceptance.
import { createHash } from "node:crypto";

export const INTEGRATION_PLAN = Object.freeze([
  "invalid_intake", "late_research_ignored", "url_intake", "correction_apply",
  "revision_compare_select", "account_sync", "current_approval", "duplicate_approval",
  "changed_content", "native_download", "failed_local_preflight", "ambiguous_sandbox_handoff",
  "duplicate_sandbox_order", "expired_session_recovery",
]);
export const PENDING_JOINS = Object.freeze([
  "canonical_private_caller_and_event_package", "canonical_creative_generation",
  "production_bundle_and_consumer_preflight", "approval_consumed_by_download_or_order",
  "supplier_quote_order_status_and_physical_mapping", "generation_and_provider_cancellation",
  "canonical_assembly_and_accountable_acceptance",
]);
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const objectHash = (value) => sha256(canonical(value));
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const CODE = /^[a-z][a-z0-9_]{0,79}$/;
const SECRET_KEY = /^(?:token|cookie|authorization|password|secret|email|devLink|requestBody|responseBody)$/i;

/** Reject private payloads, rather than trying to print and redact arbitrary error text. */
export function evidenceIsSafe(value, depth = 0) {
  if (depth > 20) return false;
  if (typeof value === "string") return value.length <= 4096 && !/(?:https?:\/\/|data:[^\s]*;base64,|token=|Bearer\s|[\w.+-]+@[\w.-]+\.[a-z]{2,})/i.test(value);
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 1024 && value.every((item) => evidenceIsSafe(item, depth + 1));
  return !!value && typeof value === "object" && Object.keys(value).length <= 128
    && Object.entries(value).every(([key, item]) => !SECRET_KEY.test(key) && evidenceIsSafe(item, depth + 1));
}

export class IntegrationEvidence {
  constructor(plan = INTEGRATION_PLAN) {
    if (!plan.length || new Set(plan).size !== plan.length || !plan.every((id) => CODE.test(id))) throw new Error("invalid_case_plan");
    this.plan = [...plan]; this.cases = new Map(); this.snapshots = []; this.project = null; this.faults = []; this.closed = false;
  }
  begin(id) {
    if (this.closed || !this.plan.includes(id) || this.cases.has(id)) { this.faults.push("unexpected_or_duplicate_case"); throw new Error("unexpected_or_duplicate_case"); }
    this.cases.set(id, { id, status: "running", assertions: [] });
  }
  assert(id, name, ok, evidence = {}) {
    const row = this.cases.get(id);
    if (this.closed || !row || row.status !== "running" || !CODE.test(name)) { this.faults.push("assertion_outside_case"); throw new Error("assertion_outside_case"); }
    const safe = evidenceIsSafe(evidence);
    const result = { name, ok: ok === true && safe, evidence: safe ? structuredClone(evidence) : { code: "unsafe_evidence_refused" } };
    row.assertions.push(result);
    return result.ok;
  }
  finish(id, code = null) {
    const row = this.cases.get(id);
    if (this.closed || !row || row.status !== "running") { this.faults.push("duplicate_case_terminal"); throw new Error("duplicate_case_terminal"); }
    row.status = !code && row.assertions.length > 0 && row.assertions.every((item) => item.ok) ? "passed" : "failed";
    if (code) row.code = CODE.test(code) ? code : "unexpected_exception";
  }
  blocked(id, dependency) {
    this.begin(id); this.assert(id, "dependency_available", false, { dependency }); this.finish(id, "dependency_failed");
  }
  snapshot(label, stub) {
    const reject = (code) => { this.faults.push(code); throw new Error(code); };
    if (this.closed || !CODE.test(label) || this.snapshots.some((item) => item.label === label)) reject("invalid_snapshot_label");
    if (!stub || !ID.test(stub.id ?? "") || !ID.test(stub.currentVersionId ?? "") || !Array.isArray(stub.versions)
      || !stub.versions.length || stub.versions.length > 100 || new Set(stub.versions.map((v) => v?.id)).size !== stub.versions.length
      || !stub.versions.every((v) => v && ID.test(v.id ?? "") && (!v.parentId || ID.test(v.parentId)))
      || !stub.versions.some((v) => v.id === stub.currentVersionId) || !stub.event || !Array.isArray(stub.event.facts)
      || !stub.personal || !Array.isArray(stub.corrections ?? [])) reject("invalid_project_snapshot");
    if (this.project && this.project !== stub.id) reject("cross_project_snapshot");
    this.project = stub.id;
    const row = { label, projectId: stub.id, selectedVersionId: stub.currentVersionId,
      versions: stub.versions.map((v) => ({ id: v.id, parentId: v.parentId ?? null, sha256: objectHash(v) })),
      versionsSha256: objectHash(stub.versions), factsSha256: objectHash(stub.event),
      compositionSha256: objectHash({ material: stub.material, finish: stub.finish, personal: stub.personal }),
      corrections: (stub.corrections ?? []).length, stateSha256: objectHash(stub) };
    this.snapshots.push(row); return structuredClone(row);
  }
  result(cleanup) {
    this.closed = true;
    const cases = this.plan.map((id) => this.cases.get(id) ?? { id, status: "missing", assertions: [] });
    const complete = cases.every((row) => ["passed", "failed"].includes(row.status));
    const safeCleanup = evidenceIsSafe(cleanup);
    return { schema: "ticketstub.available-app-integration.v1", mode: "fixture", acceptance: "not_recorded",
      scope: "available_app_adapters", canonicalAssembly: false, pendingJoins: [...PENDING_JOINS],
      plan: this.plan, cases: structuredClone(cases), snapshots: structuredClone(this.snapshots), faults: [...this.faults],
      complete, cleanup: safeCleanup ? structuredClone(cleanup) : { complete: false, code: "unsafe_cleanup_evidence" },
      passed: complete && cases.every((row) => row.status === "passed") && !this.faults.length && safeCleanup && cleanup?.complete === true };
  }
}

export function approvalBindsSnapshot(approval, snapshot, computedBinding) {
  return approval?.project?.kind === "stub" && approval.project.id === snapshot?.projectId
    && approval.binding?.versionId === snapshot.selectedVersionId && approval.purpose === "print.compose"
    && approval.mode === "sandbox" && canonical(approval.binding) === canonical(computedBinding)
    && ["purchase", "payment", "order", "asset_rights"].every((item) => approval.notAuthorizes?.includes(item));
}

export function nativeFileBindsAction(file, action, bytes) {
  const r = file?.receipt;
  return !!r && action?.settled === true && action.controls === 1 && action.producerIds?.length === 1
    && r.actionId === action.id && r.documentId === action.documentId && r.executionContextUniqueId === action.executionContextUniqueId
    && /^[A-Za-z0-9_-]{1,100}$/.test(r.guid) && r.bytes === bytes.length && r.sha256 === sha256(bytes)
    && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

/** Only fixed route names, status and counts leave the in-page probe. Raw payloads stay transient. */
export function integrationFetchProbe() {
  const slot = "__ticketstubIntegrationFixture";
  if (globalThis[slot]) throw new Error("integration_probe_already_installed");
  const original = globalThis.fetch;
  const routes = new Set(["/api/research", "/api/agent", "/api/art", "/api/auth/link", "/api/auth/confirm", "/api/auth/me", "/api/wall/sync", "/api/approvals", "/api/approvals/verify", "/api/orders"]);
  const rows = [], faults = [];
  let rule = null, active = true;
  function routeOf(input) {
    try { const u = new URL(typeof input === "string" ? input : input.url, location.href); return u.origin === location.origin && routes.has(u.pathname) ? u.pathname : null; }
    catch { return null; }
  }
  globalThis.fetch = async function (input, init) {
    const route = routeOf(input);
    if (!active || !route) return original.apply(this, arguments);
    if (rows.length >= 256) { faults.push("request_limit"); return original.apply(this, arguments); }
    const row = { id: rows.length + 1, route, method: String(init?.method ?? (typeof input === "object" ? input.method : null) ?? "GET").toUpperCase(),
      started: true, responseObserved: false, returned: false, status: null, error: null, request: null, response: null };
    try { if (typeof init?.body === "string" && init.body.length <= 32 * 1024 * 1024) row.request = JSON.parse(init.body); } catch { /* not a JSON body */ }
    rows.push(row);
    const held = rule?.state === "armed" && rule.route === route && row.method === "POST" ? rule : null;
    if (held) { held.state = "requested"; held.id = row.id; }
    try {
      const response = await original.apply(this, arguments);
      row.status = response.status; row.responseObserved = true;
      // Clone observation never consumes/replaces the Response returned to the app.
      row.observation = response.clone().text().then((text) => {
        if (text.length > 32 * 1024 * 1024) { faults.push("response_limit"); return; }
        try { row.response = JSON.parse(text); } catch { row.error = "non_json_response"; }
      }).catch(() => { row.error = "response_observation_failed"; });
      if (held) {
        held.state = "held";
        await row.observation;
        if (held.mode === "drop") { held.state = "dropped"; row.error = "synthetic_response_lost_after_commit"; throw new TypeError("integration fixture response loss"); }
        await new Promise((resolve) => {
          const timer = setTimeout(() => { held.state = "deadline"; faults.push("hold_deadline"); resolve(); }, 15_000);
          held.release = () => { clearTimeout(timer); held.state = "released"; resolve(); };
        });
      }
      row.returned = true; return response;
    } catch (error) { row.error ??= "request_failed"; throw error; }
  };
  globalThis[slot] = {
    arm(route, mode) {
      if (!["/api/research", "/api/orders"].includes(route) || !["hold", "drop"].includes(mode) || (rule && !["released", "dropped"].includes(rule.state))) throw new Error("invalid_fault_plan");
      rule = { route, mode, state: "armed", id: null }; return true;
    },
    fault() { return rule && { route: rule.route, mode: rule.mode, state: rule.state, id: rule.id }; },
    release() { if (rule?.state !== "held" || !rule.release) throw new Error("no_held_response"); rule.release(); },
    raw(id) { const r = rows.find((row) => row.id === id); return r && { request: r.request, response: r.response }; },
    async summary() {
      await Promise.all(rows.map((row) => row.observation));
      return { records: rows.map(({ id, route, method, started, responseObserved, returned, status, error }) => ({ id, route, method, started, responseObserved, returned, status, error })), faults: [...faults], fault: this.fault() };
    },
    restore() { active = false; if (rule?.release && rule.state === "held") rule.release(); globalThis.fetch = original; return true; },
  };
}
