import { canonicalHash } from "../contracts/validation.mjs";
import { InspectionError, isSafePublicInspectionReference } from "./deterministic.mjs";

export const REPAIR_LIMITS = Object.freeze({ maxRepairs: 2, maxElapsedMs: 60_000, maxSimulatedUnits: 3 });
const ACTIONS = new Set(["image.edit", "composition.update", "correction.apply", "concept.generate"]);

function fail(code, field, message) {
  throw new InspectionError(code, field, message);
}

function isHash(value) { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value); }
function isSafeStoredState(row) {
  return row && isSafePublicInspectionReference(row.tenant_id) && isSafePublicInspectionReference(row.project_id) &&
    isSafePublicInspectionReference(row.brief_id) && isSafePublicInspectionReference(row.design_version_id) &&
    isSafePublicInspectionReference(row.inspection_id) && isHash(row.brief_hash) && isHash(row.design_hash) &&
    Number.isSafeInteger(row.started_at_ms) && row.started_at_ms >= 0 &&
    Number.isInteger(row.repairs_used) && row.repairs_used >= 0 && row.repairs_used <= REPAIR_LIMITS.maxRepairs &&
    Number.isInteger(row.simulated_units_milli) && row.simulated_units_milli >= 0 &&
    row.simulated_units_milli <= REPAIR_LIMITS.maxSimulatedUnits * 1000 &&
    (row.status === "active" || row.status === "cancelled");
}
function isSafeStoredAction(action) {
  return action && isSafePublicInspectionReference(action.tenant_id) && isSafePublicInspectionReference(action.project_id) &&
    isSafePublicInspectionReference(action.brief_id) && isSafePublicInspectionReference(action.design_version_id) &&
    isSafePublicInspectionReference(action.inspection_id) && isSafePublicInspectionReference(action.action_id) && isHash(action.request_hash) &&
    ACTIONS.has(action.repair_action) && Number.isInteger(action.simulated_units_milli) &&
    action.simulated_units_milli > 0 && action.simulated_units_milli <= REPAIR_LIMITS.maxSimulatedUnits * 1000 &&
    isHash(action.claim_ref) && ["claimed", "recorded", "cancelled"].includes(action.status) &&
    (action.result_hash === null || action.result_hash === undefined || isHash(action.result_hash)) &&
    Number.isSafeInteger(action.created_at_ms) && action.created_at_ms >= 0 &&
    Number.isSafeInteger(action.updated_at_ms) && action.updated_at_ms >= 0;
}

function validateScope(scope) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope) ||
    !isSafePublicInspectionReference(scope.tenant_id) || !isSafePublicInspectionReference(scope.project_id) ||
    !isSafePublicInspectionReference(scope.brief_id) || !isSafePublicInspectionReference(scope.design_version_id)) {
    fail("invalid_scope", "scope", "Trusted tenant, project, brief, and design identity are required.");
  }
  return Object.freeze({ tenant_id: scope.tenant_id, project_id: scope.project_id,
    brief_id: scope.brief_id, design_version_id: scope.design_version_id });
}

function clockValue(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) fail("invalid_clock", "clock", "Repair controller clock must return epoch milliseconds.");
  return value;
}

function makeTables(database) {
  if (!database || typeof database.exec !== "function" || typeof database.prepare !== "function") {
    fail("storage_unavailable", "database", "A trusted synchronous SQLite connection is required.");
  }
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("PRAGMA busy_timeout = 5000;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS creative_inspection_state_v1 (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      design_version_id TEXT NOT NULL,
      inspection_id TEXT NOT NULL,
      brief_hash TEXT NOT NULL,
      design_hash TEXT NOT NULL,
      started_at_ms INTEGER NOT NULL,
      repairs_used INTEGER NOT NULL DEFAULT 0 CHECK (repairs_used BETWEEN 0 AND 2),
      simulated_units_milli INTEGER NOT NULL DEFAULT 0 CHECK (simulated_units_milli BETWEEN 0 AND 3000),
      status TEXT NOT NULL CHECK (status IN ('active', 'cancelled')),
      PRIMARY KEY (tenant_id, project_id, brief_id, design_version_id, inspection_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS creative_inspection_action_v2 (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      design_version_id TEXT NOT NULL,
      inspection_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      repair_action TEXT NOT NULL,
      simulated_units_milli INTEGER NOT NULL CHECK (simulated_units_milli BETWEEN 1 AND 3000),
      claim_ref TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('claimed', 'recorded', 'cancelled')),
      result_hash TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, project_id, brief_id, design_version_id, inspection_id, action_id),
      UNIQUE (claim_ref),
      FOREIGN KEY (tenant_id, project_id, brief_id, design_version_id, inspection_id)
        REFERENCES creative_inspection_state_v1 (tenant_id, project_id, brief_id, design_version_id, inspection_id)
    ) STRICT;
  `);
}

function transaction(database, callback) {
  if (database.isTransaction === true) fail("transaction_unavailable", "database", "Repair controller requires ownership of its short local transaction.");
  database.exec("BEGIN IMMEDIATE;");
  try {
    const result = callback();
    database.exec("COMMIT;");
    return result;
  } catch (error) {
    try { database.exec("ROLLBACK;"); } catch { /* retain the original bounded failure */ }
    throw error;
  }
}

function scopedKey(scope, inspectionId) {
  return [scope.tenant_id, scope.project_id, scope.brief_id, scope.design_version_id, inspectionId];
}

function stateRow(database, scope, inspectionId) {
  return database.prepare(`SELECT * FROM creative_inspection_state_v1
    WHERE tenant_id=? AND project_id=? AND brief_id=? AND design_version_id=? AND inspection_id=?`)
    .get(...scopedKey(scope, inspectionId));
}

function actionRow(database, scope, inspectionId, actionId) {
  return database.prepare(`SELECT * FROM creative_inspection_action_v2
    WHERE tenant_id=? AND project_id=? AND brief_id=? AND design_version_id=? AND inspection_id=? AND action_id=?`)
    .get(...scopedKey(scope, inspectionId), actionId);
}

/**
 * Read a previously claimed repair while the caller owns the shared SQLite
 * connection. This deliberately opens no transaction: dispatch authorization
 * and publication call it under their own BEGIN IMMEDIATE fence.
 */
export function inspectionRepairFenceCurrent(database, now, rawScope, proof, { requireRecorded = false } = {}) {
  try {
    const scope = validateScope(rawScope);
    if (!proof || typeof proof !== "object" || Array.isArray(proof) ||
      !isSafePublicInspectionReference(proof.inspection_id) ||
      !isSafePublicInspectionReference(proof.action_id) || !isHash(proof.request_hash) ||
      !isHash(proof.claim_ref) || !isHash(proof.root_brief_hash) || !isHash(proof.root_design_hash) ||
      !Number.isSafeInteger(proof.started_at_ms) || !Number.isSafeInteger(proof.deadline_at_ms) ||
      proof.deadline_at_ms !== proof.started_at_ms + REPAIR_LIMITS.maxElapsedMs ||
      !Number.isInteger(proof.simulated_units_milli) || proof.simulated_units_milli < 1 ||
      proof.simulated_units_milli > REPAIR_LIMITS.maxSimulatedUnits * 1000 ||
      (proof.result_hash !== undefined && !isHash(proof.result_hash))) return false;
    const state = stateRow(database, scope, proof.inspection_id);
    const action = actionRow(database, scope, proof.inspection_id, proof.action_id);
    if (!isSafeStoredState(state) || !isSafeStoredAction(action) ||
      state.tenant_id !== scope.tenant_id || state.project_id !== scope.project_id ||
      state.brief_id !== scope.brief_id || state.design_version_id !== scope.design_version_id ||
      state.brief_hash !== proof.root_brief_hash || state.design_hash !== proof.root_design_hash ||
      state.started_at_ms !== proof.started_at_ms || state.status !== "active" ||
      action.action_id !== proof.action_id || action.inspection_id !== proof.inspection_id ||
      action.request_hash !== proof.request_hash || action.claim_ref !== proof.claim_ref ||
      action.repair_action !== "image.edit" || action.simulated_units_milli !== proof.simulated_units_milli ||
      action.created_at_ms < state.started_at_ms || action.created_at_ms >= proof.deadline_at_ms ||
      (proof.result_hash === undefined ? action.result_hash !== null :
        action.result_hash !== null && action.result_hash !== proof.result_hash)) return false;
    if (proof.result_hash === undefined ? action.status !== "claimed" :
      (requireRecorded ? action.status !== "recorded" || action.result_hash !== proof.result_hash :
        !((action.status === "claimed" && action.result_hash === null) ||
          (action.status === "recorded" && action.result_hash === proof.result_hash)))) {
      return false;
    }
    const current = clockValue(now);
    const currentOk = current >= state.started_at_ms && current < proof.deadline_at_ms &&
      state.repairs_used <= REPAIR_LIMITS.maxRepairs &&
      state.simulated_units_milli <= REPAIR_LIMITS.maxSimulatedUnits * 1000;
    return currentOk;
  } catch {
    return false;
  }
}

/**
 * Durable local repair counters only. This controller is not Finance, a budget
 * authority, a provider executor, or permission to dispatch an edit.
 */
export function createSqliteInspectionRepairController(options) {
  const database = options?.database;
  const now = options?.now ?? (() => Date.now());
  makeTables(database);

  function getState({ scope: rawScope, inspection_id }) {
    const scope = validateScope(rawScope);
    if (!isSafePublicInspectionReference(inspection_id)) fail("invalid_request", "inspection_id", "Inspection identity is invalid.");
    const row = stateRow(database, scope, inspection_id);
    if (!row) return null;
    if (!isSafeStoredState(row) || row.inspection_id !== inspection_id) {
      fail("invalid_request", "inspection_state", "Stored inspection state failed integrity validation.");
    }
    const current = clockValue(now);
    const elapsed = Math.max(0, current - row.started_at_ms);
    const actions = database.prepare(`SELECT tenant_id, project_id, brief_id, design_version_id, inspection_id,
      action_id, request_hash, repair_action, simulated_units_milli,
      claim_ref, status, result_hash, created_at_ms, updated_at_ms FROM creative_inspection_action_v2
      WHERE tenant_id=? AND project_id=? AND brief_id=? AND design_version_id=? AND inspection_id=? ORDER BY created_at_ms, action_id`)
      .all(...scopedKey(scope, inspection_id));
    if (actions.some((action) => !isSafeStoredAction(action))) {
      fail("invalid_request", "actions", "Stored repair records failed integrity validation.");
    }
    return Object.freeze({
      inspection_id,
      brief_hash: row.brief_hash,
      design_hash: row.design_hash,
      started_at_ms: row.started_at_ms,
      elapsed_ms: elapsed,
      status: row.status,
      repairs_used: row.repairs_used,
      simulated_units_used: row.simulated_units_milli / 1000,
      remaining_repairs: Math.max(0, REPAIR_LIMITS.maxRepairs - row.repairs_used),
      remaining_elapsed_ms: Math.max(0, REPAIR_LIMITS.maxElapsedMs - elapsed),
      remaining_simulated_units: Math.max(0, REPAIR_LIMITS.maxSimulatedUnits - row.simulated_units_milli / 1000),
      actions: Object.freeze(actions.map((action) => Object.freeze({
        action_id: action.action_id,
        request_hash: action.request_hash,
        repair_action: action.repair_action,
        simulated_units: action.simulated_units_milli / 1000,
        claim_ref: action.claim_ref,
        status: action.status,
        ...(action.result_hash ? { result_hash: action.result_hash } : {}),
      }))),
    });
  }

  function startInspection({ scope: rawScope, inspection_id, brief_hash, design_hash }) {
    const scope = validateScope(rawScope);
    if (!isSafePublicInspectionReference(inspection_id) ||
      !isHash(brief_hash) || !isHash(design_hash)) {
      fail("invalid_request", "inspection_identity", "Inspection identity and exact brief/design hashes are required.");
    }
    return transaction(database, () => {
      const startedAt = clockValue(now);
      const key = scopedKey(scope, inspection_id);
      const inserted = database.prepare(`INSERT OR IGNORE INTO creative_inspection_state_v1
        (tenant_id, project_id, brief_id, design_version_id, inspection_id, brief_hash, design_hash, started_at_ms, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`).run(...key, brief_hash, design_hash, startedAt);
      const row = stateRow(database, scope, inspection_id);
      if (!isSafeStoredState(row) || row.tenant_id !== scope.tenant_id || row.project_id !== scope.project_id ||
        row.brief_id !== scope.brief_id || row.design_version_id !== scope.design_version_id ||
        row.inspection_id !== inspection_id) {
        fail("invalid_request", "inspection_state", "Stored inspection state failed integrity validation.");
      }
      if (row.brief_hash !== brief_hash || row.design_hash !== design_hash) {
        fail("conflict", "inspection_identity", "Inspection identity already exists with different bound state.");
      }
      const current = clockValue(now);
      return Object.freeze({ status: row.status, inspection_id, started_at_ms: row.started_at_ms,
        elapsed_ms: Math.max(0, current - row.started_at_ms), replayed: inserted.changes !== 1 });
    });
  }

  function recordRepairClaim(input) {
    const scope = validateScope(input?.scope);
    const inspectionId = input?.inspection_id;
    const actionId = input?.action_id;
    const requestHash = input?.request_hash;
    const action = input?.repair_action;
    if (!isSafePublicInspectionReference(inspectionId) || !isSafePublicInspectionReference(actionId) ||
      !isHash(requestHash) || !ACTIONS.has(action)) {
      fail("invalid_request", "repair_request", "Repair request identity or action is invalid.");
    }
    if (input.simulated_units === undefined || input.simulated_units === null) {
      return Object.freeze({ status: "unknown_cost", reason: "fixture_limit_input_unknown" });
    }
    const units = input.simulated_units;
    if (typeof units !== "number" || !Number.isFinite(units) || units <= 0 || units > REPAIR_LIMITS.maxSimulatedUnits ||
      Math.round(units * 1000) !== units * 1000) {
      fail("invalid_request", "simulated_units", "Fixture repair units must be positive thousandth-unit values within the fixed bound.");
    }
    const unitsMilli = Math.round(units * 1000);
    return transaction(database, () => {
      const row = stateRow(database, scope, inspectionId);
      if (!row) return Object.freeze({ status: "not_found" });
      const key = [...scopedKey(scope, inspectionId), actionId];
      const existing = database.prepare(`SELECT * FROM creative_inspection_action_v2
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND design_version_id=? AND inspection_id=? AND action_id=?`).get(...key);
      if (existing) {
        if (!isSafeStoredAction(existing)) fail("invalid_request", "actions", "Stored repair record failed integrity validation.");
        if (existing.request_hash !== requestHash || existing.repair_action !== action || existing.simulated_units_milli !== unitsMilli) {
          return Object.freeze({ status: "conflict" });
        }
        const current = clockValue(now);
        if (row.status !== "active" || existing.status === "cancelled") return Object.freeze({ status: "cancelled" });
        if (current < row.started_at_ms || current >= row.started_at_ms + REPAIR_LIMITS.maxElapsedMs) {
          return Object.freeze({ status: "expired" });
        }
        return Object.freeze({ status: existing.status === "cancelled" || row.status === "cancelled" ? "cancelled" : "replayed",
          claim_ref: existing.claim_ref, action_id: existing.action_id,
          simulated_units: existing.simulated_units_milli / 1000, started_at_ms: row.started_at_ms,
          root_brief_hash: row.brief_hash, root_design_hash: row.design_hash });
      }
      if (row.status !== "active") return Object.freeze({ status: "cancelled" });
      const current = clockValue(now);
      if (current < row.started_at_ms || current >= row.started_at_ms + REPAIR_LIMITS.maxElapsedMs) {
        return Object.freeze({ status: "expired" });
      }
      if (row.repairs_used >= REPAIR_LIMITS.maxRepairs || row.simulated_units_milli + unitsMilli > REPAIR_LIMITS.maxSimulatedUnits * 1000) {
        return Object.freeze({ status: "limit_reached" });
      }
      const claimRef = canonicalHash({ scope, inspection_id: inspectionId, action_id: actionId, request_hash: requestHash });
      database.prepare(`INSERT INTO creative_inspection_action_v2
        (tenant_id, project_id, brief_id, design_version_id, inspection_id, action_id, request_hash, repair_action,
         simulated_units_milli, claim_ref, status, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?)`).run(...key, requestHash, action, unitsMilli, claimRef, current, current);
      database.prepare(`UPDATE creative_inspection_state_v1 SET repairs_used=repairs_used+1,
        simulated_units_milli=simulated_units_milli+? WHERE tenant_id=? AND project_id=? AND brief_id=? AND design_version_id=? AND inspection_id=? AND status='active'`)
        .run(unitsMilli, ...scopedKey(scope, inspectionId));
      return Object.freeze({ status: "recorded", local_limit_status: "within_limits", claim_ref: claimRef,
        action_id: actionId, repair_action: action, simulated_units: units, started_at_ms: row.started_at_ms,
        root_brief_hash: row.brief_hash, root_design_hash: row.design_hash });
    });
  }

  function recordRepairOutcome(input) {
    const scope = validateScope(input?.scope);
    const inspectionId = input?.inspection_id;
    const actionId = input?.action_id;
    const resultHash = input?.result_hash;
    if (!isSafePublicInspectionReference(inspectionId) || !isSafePublicInspectionReference(actionId) || !isHash(resultHash)) {
      fail("invalid_request", "repair_completion", "Repair completion requires exact inspection, action, and result identities.");
    }
    return transaction(database, () => {
      const key = [...scopedKey(scope, inspectionId), actionId];
      const action = database.prepare(`SELECT * FROM creative_inspection_action_v2 WHERE tenant_id=? AND project_id=? AND brief_id=?
        AND design_version_id=? AND inspection_id=? AND action_id=?`).get(...key);
      const state = stateRow(database, scope, inspectionId);
      if (!action || !state) return Object.freeze({ status: "not_found" });
      if (!isSafeStoredState(state) || !isSafeStoredAction(action)) {
        fail("invalid_request", "repair_completion", "Stored repair state failed integrity validation.");
      }
      if (action.result_hash) {
        if (action.result_hash !== resultHash) return Object.freeze({ status: "conflict" });
        return Object.freeze({ status: action.status === "recorded" && state.status === "active" ? "replayed" : "cancelled",
          result_hash: action.result_hash });
      }
      const current = clockValue(now);
      if (action.status !== "claimed" || state.status !== "active" || current < state.started_at_ms ||
        current - state.started_at_ms > REPAIR_LIMITS.maxElapsedMs) {
        database.prepare(`UPDATE creative_inspection_action_v2 SET status='cancelled', result_hash=?, updated_at_ms=?
          WHERE tenant_id=? AND project_id=? AND brief_id=? AND design_version_id=? AND inspection_id=? AND action_id=?`)
          .run(resultHash, current, ...key);
        return Object.freeze({ status: "cancelled", result_hash: resultHash });
      }
      database.prepare(`UPDATE creative_inspection_action_v2 SET status='recorded', result_hash=?, updated_at_ms=?
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND design_version_id=? AND inspection_id=? AND action_id=? AND status='claimed'`)
        .run(resultHash, current, ...key);
      return Object.freeze({ status: "recorded", result_hash: resultHash });
    });
  }

  function recordRepairOutcomeInPublication(input) {
    if (database.isTransaction !== true) fail("transaction_unavailable", "database",
      "Repair completion must share the version publication transaction.");
    const scope = validateScope(input?.scope);
    const inspectionId = input?.inspection_id;
    const actionId = input?.action_id;
    const resultHash = input?.result_hash;
    const proof = input?.proof;
    if (!isSafePublicInspectionReference(inspectionId) || !isSafePublicInspectionReference(actionId) ||
      !isHash(resultHash) || !proof || proof.inspection_id !== inspectionId || proof.action_id !== actionId ||
      proof.result_hash !== undefined) {
      fail("invalid_request", "repair_completion", "Repair publication requires the exact unrecorded claim and result.");
    }
    const current = clockValue(now);
    if (!inspectionRepairFenceCurrent(database, now, scope, proof)) return Object.freeze({ status: "cancelled" });
    const key = [...scopedKey(scope, inspectionId), actionId];
    const action = actionRow(database, scope, inspectionId, actionId);
    if (action.status !== "claimed" || action.result_hash !== null) return Object.freeze({ status: "cancelled" });
    const changes = database.prepare(`UPDATE creative_inspection_action_v2 SET status='recorded', result_hash=?, updated_at_ms=?
      WHERE tenant_id=? AND project_id=? AND brief_id=? AND design_version_id=? AND inspection_id=? AND action_id=?
        AND status='claimed' AND result_hash IS NULL`)
      .run(resultHash, current, ...key).changes;
    return changes === 1 ? Object.freeze({ status: "recorded", result_hash: resultHash })
      : Object.freeze({ status: "cancelled" });
  }

  function cancelInspection({ scope: rawScope, inspection_id }) {
    const scope = validateScope(rawScope);
    if (!isSafePublicInspectionReference(inspection_id)) fail("invalid_request", "inspection_id", "Inspection identity is invalid.");
    return transaction(database, () => {
      const current = clockValue(now);
      const key = scopedKey(scope, inspection_id);
      const row = stateRow(database, scope, inspection_id);
      if (!row) return Object.freeze({ status: "not_found" });
      database.prepare(`UPDATE creative_inspection_state_v1 SET status='cancelled'
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND design_version_id=? AND inspection_id=?`).run(...key);
      database.prepare(`UPDATE creative_inspection_action_v2 SET status='cancelled', updated_at_ms=?
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND design_version_id=? AND inspection_id=? AND status='claimed'`)
        .run(current, ...key);
      return Object.freeze({ status: row.status === "cancelled" ? "replayed" : "cancelled" });
    });
  }

  function isClaimCurrent(input) {
    return inspectionRepairFenceCurrent(database, now, input?.scope, input?.proof);
  }

  return Object.freeze({ startInspection, recordRepairClaim, recordRepairOutcome, recordRepairOutcomeInPublication,
    isClaimCurrent, cancelInspection, getState,
    limits: REPAIR_LIMITS });
}
