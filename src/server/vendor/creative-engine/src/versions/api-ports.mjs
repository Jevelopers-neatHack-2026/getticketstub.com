import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { canonicalHash, canonicalSerialize } from "../contracts/index.mjs";
import { CreativeVersionStore, VersionStoreError, creativeAssetRightsFenceCurrent, creativeCompositionFenceCurrent } from "./store.mjs";
import { applyResearchInvalidation } from "../planning/index.mjs";
import { createSqliteInspectionRepairController, inspectionRepairFenceCurrent } from "../inspection/repair-controller.mjs";

const OPERATIONS = new Set(["generate", "edit", "concepts.create", "composition.create", "composition.update", "composition.revalidate", "composition.get", "composition.history",
  "inspect", "list", "compare", "restore", "cancel", "handoff", "job.status"]);
const HASH = /^sha256:[a-f0-9]{64}$/;

function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

function safeReference(value, field, max = 256) {
  if (typeof value !== "string" || value.length < 1 || value.length > max ||
    !/^[A-Za-z0-9_.:-]+$/.test(value) || /(?:gh[pousr]_[A-Za-z0-9]{20,}|(?:sk|rk|pk)-[A-Za-z0-9_-]{12,})/i.test(value)) {
    throw new VersionStoreError("invalid_request", field);
  }
  return value;
}

/** A routed model id such as "author/slug" additionally allows "/"; all other identifier rules still apply. */
function safeModelReference(value, field) {
  if (typeof value === "string" && value.includes("/")) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.:-]*)+$/.test(value)) {
      throw new VersionStoreError("invalid_request", field);
    }
    safeReference(value.replaceAll("/", "."), field);
    return value;
  }
  return safeReference(value, field);
}

function safeHash(value, field) {
  if (typeof value !== "string" || !HASH.test(value)) throw new VersionStoreError("invalid_request", field);
  return value;
}

function safeJson(value, field) {
  try { return JSON.parse(canonicalSerialize(value)); }
  catch { throw new VersionStoreError("invalid_request", field); }
}

function jsonWithHash(json, expectedHash, field) {
  let value;
  try { value = JSON.parse(json); } catch { throw new VersionStoreError("integrity_error", field); }
  if (canonicalHash(value) !== expectedHash) throw new VersionStoreError("integrity_error", field);
  return value;
}

function inspectionSessionFromRows(session, stages) {
  if (!session) return null;
  const result = session.result_json === null ? undefined
    : jsonWithHash(session.result_json, session.result_hash, "inspection.result");
  const scope = Object.freeze({
    tenant_id: session.tenant_id,
    project_id: session.project_id,
    brief_id: session.brief_id,
  });
  return Object.freeze({
    scope,
    tenant_id: session.tenant_id, project_id: session.project_id, action_id: session.action_id,
    actor_id: session.actor_id, job_id: session.job_id, request_hash: session.request_hash,
    brief_id: session.brief_id, brief_hash: session.brief_hash,
    design_version_id: session.design_version_id, design_hash: session.design_hash,
    parent_version_id: session.parent_version_id, parent_design_hash: session.parent_design_hash,
    artifact_id: session.artifact_id, artifact_hash: session.artifact_hash,
    root_design_version_id: session.root_design_version_id, root_design_hash: session.root_design_hash,
    status: session.status, ...(result !== undefined ? { result } : {}),
    stages: Object.freeze(stages.map((stage) => Object.freeze({
      stage: stage.stage, attempt_id: stage.attempt_id,
      intent: jsonWithHash(stage.intent_json, stage.intent_hash, "inspection.stage.intent"),
      status: stage.status,
      ...(stage.result_json !== null ? { result: jsonWithHash(stage.result_json, stage.result_hash, "inspection.stage.result") } : {}),
    }))),
  });
}

function tokenHash(value) { return createHash("sha256").update(value).digest("hex"); }

function jobFromRow(row) {
  if (!row) return null;
  let result;
  let error;
  try { result = row.result_json === null ? undefined : JSON.parse(row.result_json); }
  catch { throw new VersionStoreError("integrity_error", "job.result"); }
  try { error = row.error_json === null ? undefined : JSON.parse(row.error_json); }
  catch { throw new VersionStoreError("integrity_error", "job.error"); }
  return Object.freeze({
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    ...(row.brief_id ? { brief_id: row.brief_id } : {}),
    actor_id: row.actor_id,
    action_id: row.action_id,
    operation: row.operation,
    job_id: row.job_id,
    status: row.status,
    request_hash: row.request_hash,
    ...(result !== undefined ? { result } : {}),
    ...(error !== undefined ? { error } : {}),
  });
}

function briefScope(scope, briefId) {
  const tenant_id = safeReference(scope?.tenant_id, "scope.tenant_id");
  const project_id = safeReference(scope?.project_id, "scope.project_id");
  const checkedBriefId = safeReference(briefId ?? scope?.brief_id, "brief_id");
  if (scope?.brief_id !== undefined && scope.brief_id !== checkedBriefId) throw new VersionStoreError("scope_denied", "scope.brief_id");
  return Object.freeze({ tenant_id, project_id, brief_id: checkedBriefId });
}

function contextFenceMatches(store, scope, fence, { requireRecordedRepair = false, afterPublication = false } = {}) {
  if (!record(fence) || Object.keys(fence).some((key) => ![
    "brief_id", "brief_hash", "design_version_id", "design_hash",
    "expected_current_design_version_id", "expected_current_design_hash", "inspection_repair", "inspection_rights", "composition",
  ].includes(key))) return false;
  try {
    const checkedScope = briefScope(scope, fence.brief_id);
    const brief = store.getBrief({ scope: checkedScope, brief_id: checkedScope.brief_id });
    if (!brief || canonicalHash(brief) !== fence.brief_hash) return false;
    if (!store.isBriefUsable({ scope: checkedScope, brief_id: checkedScope.brief_id, brief_hash: fence.brief_hash })) return false;
    if (fence.design_version_id !== undefined) {
      safeReference(fence.design_version_id, "context_fence.design_version_id");
      safeHash(fence.design_hash, "context_fence.design_hash");
      const design = store.getDesignVersion({ scope: checkedScope, brief_id: checkedScope.brief_id,
        design_version_id: fence.design_version_id });
      if (!design || design.design_hash !== fence.design_hash) return false;
    }
    if (!afterPublication && Object.hasOwn(fence, "expected_current_design_version_id")) {
      const selection = store.getSelection({ scope: checkedScope, brief_id: checkedScope.brief_id });
      const selectedId = selection?.design_version_id ?? null;
      const selectedHash = selection?.design_hash ?? null;
      if (selectedId !== fence.expected_current_design_version_id || selectedHash !== fence.expected_current_design_hash) return false;
    }
    if (Object.hasOwn(fence, "inspection_repair")) {
      const proof = fence.inspection_repair;
      if (!record(proof) || Object.keys(proof).some((key) => ![
        "inspection_id", "action_id", "request_hash", "claim_ref", "root_brief_hash", "root_design_hash",
        "root_design_version_id", "started_at_ms", "deadline_at_ms", "simulated_units_milli", "result_hash",
      ].includes(key)) || typeof proof.root_design_version_id !== "string" ||
        !inspectionRepairFenceCurrent(store.db, store.now,
          { ...checkedScope, design_version_id: proof.root_design_version_id }, proof,
          { requireRecorded: requireRecordedRepair })) return false;
    }
    if (Object.hasOwn(fence, "inspection_rights") &&
      !creativeAssetRightsFenceCurrent(store.db, store.now, checkedScope, fence.inspection_rights)) return false;
    if (Object.hasOwn(fence, "composition") &&
      !creativeCompositionFenceCurrent(store, checkedScope, fence.composition, { afterPublication })) return false;
    return true;
  } catch {
    return false;
  }
}

function sameDispatchFence(existingJson, currentFence) {
  let existing;
  try { existing = JSON.parse(existingJson); } catch { return false; }
  const comparable = (value) => {
    if (!record(value)) return value;
    const result = { ...value };
    if (record(result.inspection_rights) && Array.isArray(result.inspection_rights.proofs)) {
      result.inspection_rights = { ...result.inspection_rights,
        proofs: result.inspection_rights.proofs.map((proof) => {
          if (!record(proof)) return proof;
          const { expires_at: _expiresAt, checked_at: _checkedAt, ...identity } = proof;
          return identity;
        }) };
    }
    return result;
  };
  return canonicalSerialize(comparable(existing)) === canonicalSerialize(comparable(currentFence));
}

function transactionStatusFor(row, scope, actorId, leaseToken, now) {
  if (!row || row.tenant_id !== scope.tenant_id || row.project_id !== scope.project_id ||
    row.actor_id !== actorId || row.lease_hash !== tokenHash(leaseToken)) return "lease_lost";
  if (row.status === "cancelled") return "cancelled";
  if (row.status !== "running" || Date.parse(row.lease_expires_at) <= now) return "lease_lost";
  return "active";
}

/**
 * Bind the durable version store and CE-01 jobs port to the same SQLite
 * connection. `completeIfActive` runs its publication callback while holding
 * one BEGIN IMMEDIATE transaction; version metadata/selection and the job
 * result commit together. Provider, metering, decision, inspection, approval,
 * handoff, and trace capabilities remain caller-injected. Handoff submission
 * is rejected by this adapter until it has a durable external-result staging
 * protocol, because external approval/consumer calls cannot run under SQLite's
 * write transaction.
 */
export function createCreativeVersionApiPorts({ store, otherPorts = {}, idFactory = randomUUID,
  leaseDurationMs = 60_000, faultInjector } = {}) {
  if (!(store instanceof CreativeVersionStore) || typeof idFactory !== "function" ||
    !Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1_000 || leaseDurationMs > 24 * 60 * 60 * 1000 ||
    faultInjector !== undefined && typeof faultInjector !== "function") {
    throw new VersionStoreError("invalid_request", "adapter_options");
  }
  const transactionContext = new AsyncLocalStorage();
  const inspectionRepair = createSqliteInspectionRepairController({ database: store.db, now: store.now });
  let serialQueue = Promise.resolve();
  const serial = (work) => {
    if (transactionContext.getStore() === store) return Promise.resolve().then(work);
    const prior = serialQueue;
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    serialQueue = prior.then(() => barrier);
    return prior.then(() => transactionContext.run(store, work)).finally(() => release());
  };

  const storage = {
    getBrief(input) { return serial(() => store.getBrief(input)); },
    getBriefVersionByHash(input) { return serial(() => store.getBriefVersionByHash(input)); },
    isBriefUsable(input) { return serial(() => store.isBriefUsable(input)); },
    isAssetFenced(input) { return serial(() => store.isAssetFenced(input)); },
    getDesignVersion(input) { return serial(() => store.getDesignVersion(input)); },
    getCurrentDesignVersion(input) { return serial(() => store.getCurrentDesignVersion(input)); },
    getSelection(input) { return serial(() => store.getSelection(input)); },
    listDesignVersions(input) { return serial(() => store.listDesignVersions(input)); },
    getArtifactBytes(input) { return serial(() => store.getArtifactBytes(input)); },
    beginConceptBatch(input) { return serial(() => store.beginConceptBatch(input)); },
    appendConceptEvent(input) { return serial(() => store.appendConceptEvent(input)); },
    recordConceptDispatchBinding(input) { return serial(() => store.recordConceptDispatchBinding(input)); },
    stageConceptResponse(input) { return serial(() => store.stageConceptResponse(input)); },
    getConceptBatch(input) { return serial(() => store.getConceptBatch(input)); },
    getConceptResponseStage(input) { return serial(() => store.getConceptResponseStage(input)); },
    prepareConceptArtifactObjects(input) { return serial(() => store.prepareConceptArtifactObjects(input)); },
    publishConceptBatch(input, transaction) { return serial(() => store.publishConceptBatch(input, transaction)); },
    getConceptVersions(input) { return serial(() => store.getConceptVersions(input)); },
    beginCompositionAction(input) { return serial(() => store.beginCompositionAction(input)); },
    getCompositionAction(input) { return serial(() => store.getCompositionAction(input)); },
    getCompositionActionIdentityByJob(input) { return serial(() => store.getCompositionActionIdentityByJob(input)); },
    stageCompositionRevision(input) { return serial(() => store.stageCompositionRevision(input)); },
    finishCompositionAction(input) { return serial(() => store.finishCompositionAction(input)); },
    recoverCompositionAction(input) { return serial(() => store.recoverCompositionAction(input)); },
    getCurrentComposition(input) { return serial(() => store.getCurrentComposition(input)); },
    getCurrentCompositionIdentity(input) { return serial(() => store.getCurrentCompositionIdentity(input)); },
    assertCurrentComposition(input) { return store.assertCurrentComposition(input); },
    getCompositionRevision(input) { return serial(() => store.getCompositionRevision(input)); },
    listCompositionRevisions(input) { return serial(() => store.listCompositionRevisions(input)); },
    commitCompositionRevision(input, transaction) {
      // Publication calls this from completeIfActive while that adapter owns
      // the same connection's BEGIN IMMEDIATE transaction. Preserve a truly
      // synchronous final-owner-fence→CAS ordering inside that transaction.
      if (transactionContext.getStore() === store) return store.commitCompositionRevision(input, transaction);
      return serial(() => store.commitCompositionRevision(input, transaction));
    },
    inspectionRepair,
    beginInspectionSession(input) {
      return serial(() => {
        if (!record(input) || !record(input.scope)) throw new VersionStoreError("invalid_request", "inspection.session");
        const scope = briefScope(input.scope, input.brief_id);
        const actor_id = safeReference(input.actor_id, "actor_id");
        const job_id = safeReference(input.job_id, "job_id");
        const action_id = safeReference(input.action_id, "action_id");
        const request_hash = safeHash(input.request_hash, "request_hash");
        const lease_token = safeReference(input.lease_token, "lease_token");
        const design_version_id = safeReference(input.design_version_id, "design_version_id");
        const root_design_version_id = safeReference(input.root_design_version_id, "root_design_version_id");
        for (const field of ["brief_hash", "design_hash", "artifact_hash", "root_design_hash"]) safeHash(input[field], `inspection.${field}`);
        const artifact_id = safeReference(input.artifact_id, "artifact_id");
        const parent_version_id = input.parent_version_id === null ? null : safeReference(input.parent_version_id, "parent_version_id");
        const parent_design_hash = input.parent_design_hash === null ? null : safeHash(input.parent_design_hash, "parent_design_hash");
        const expected = { scope, actor_id, job_id, action_id, request_hash, lease_token, brief_id: scope.brief_id,
          brief_hash: input.brief_hash, design_version_id, design_hash: input.design_hash, artifact_id,
          artifact_hash: input.artifact_hash, parent_version_id, parent_design_hash, root_design_version_id,
          root_design_hash: input.root_design_hash };
        store.db.exec("BEGIN IMMEDIATE");
        try {
          const timestamp = store.timestamp();
          const job = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
            .get(scope.tenant_id, scope.project_id, job_id);
          if (transactionStatusFor(job, scope, actor_id, lease_token, Date.parse(timestamp)) !== "active" ||
            job.action_id !== action_id || job.operation !== "inspect" || job.request_hash !== request_hash) {
            store.db.exec("ROLLBACK");
            throw new VersionStoreError("cancelled", "inspection.job");
          }
          const brief = store.getBrief({ scope, brief_id: scope.brief_id });
          const design = store.getDesignVersion({ scope, brief_id: scope.brief_id, design_version_id });
          const root = store.getDesignVersion({ scope, brief_id: scope.brief_id, design_version_id: root_design_version_id });
          if (!brief || canonicalHash(brief) !== input.brief_hash || !store.isBriefUsable({ scope,
            brief_id: scope.brief_id, brief_hash: input.brief_hash }) || !design || design.design_hash !== input.design_hash ||
            design.artifact.artifact_id !== artifact_id || design.artifact.content_hash !== input.artifact_hash ||
            (design.parent_version_id ?? null) !== parent_version_id || !root || root.design_hash !== input.root_design_hash) {
            store.db.exec("ROLLBACK");
            throw new VersionStoreError("stale_version", "inspection.subject");
          }
          const existing = store.db.prepare(`SELECT * FROM creative_inspection_sessions_v1
            WHERE tenant_id=? AND project_id=? AND action_id=?`).get(scope.tenant_id, scope.project_id, action_id);
          if (existing) {
            const same = existing.actor_id === actor_id && existing.job_id === job_id && existing.request_hash === request_hash &&
              existing.brief_id === scope.brief_id && existing.brief_hash === input.brief_hash &&
              existing.design_version_id === design_version_id && existing.design_hash === input.design_hash &&
              existing.artifact_id === artifact_id && existing.artifact_hash === input.artifact_hash &&
              existing.parent_version_id === parent_version_id && existing.parent_design_hash === parent_design_hash &&
              existing.root_design_version_id === root_design_version_id && existing.root_design_hash === input.root_design_hash;
            if (!same) throw new VersionStoreError("conflict", "inspection.action_id");
            const stages = store.db.prepare(`SELECT * FROM creative_inspection_stages_v1
              WHERE tenant_id=? AND project_id=? AND action_id=? ORDER BY CASE stage
                WHEN 'observer' THEN 1 WHEN 'decision_evidence' THEN 2 ELSE 3 END`)
              .all(scope.tenant_id, scope.project_id, action_id);
            store.db.exec("COMMIT");
            return inspectionSessionFromRows(existing, stages);
          }
          store.db.prepare(`INSERT INTO creative_inspection_sessions_v1
            (tenant_id,project_id,action_id,actor_id,job_id,request_hash,brief_id,brief_hash,design_version_id,design_hash,
              parent_version_id,parent_design_hash,artifact_id,artifact_hash,root_design_version_id,root_design_hash,status,
              result_json,result_hash,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'active',NULL,NULL,?,?)`)
            .run(scope.tenant_id, scope.project_id, action_id, actor_id, job_id, request_hash, scope.brief_id,
              input.brief_hash, design_version_id, input.design_hash, parent_version_id, parent_design_hash,
              artifact_id, input.artifact_hash, root_design_version_id, input.root_design_hash, timestamp, timestamp);
          store.db.exec("COMMIT");
          return Object.freeze({ ...expected, tenant_id: scope.tenant_id, project_id: scope.project_id,
            status: "active", stages: Object.freeze([]) });
        } catch (error) {
          store.rollback();
          if (error instanceof VersionStoreError) throw error;
          throw new VersionStoreError("unavailable", "inspection.session", true);
        }
      });
    },
    getInspectionSession(input) {
      return serial(() => {
        const scope = briefScope(input?.scope, input?.brief_id ?? input?.scope?.brief_id);
        const action_id = safeReference(input?.action_id, "action_id");
        const session = store.db.prepare(`SELECT * FROM creative_inspection_sessions_v1
          WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=?`)
          .get(scope.tenant_id, scope.project_id, scope.brief_id, action_id);
        if (!session) return null;
        const stages = store.db.prepare(`SELECT * FROM creative_inspection_stages_v1
          WHERE tenant_id=? AND project_id=? AND action_id=? ORDER BY CASE stage
            WHEN 'observer' THEN 1 WHEN 'decision_evidence' THEN 2 ELSE 3 END`)
          .all(scope.tenant_id, scope.project_id, action_id);
        return inspectionSessionFromRows(session, stages);
      });
    },
    stageInspectionStage(input) {
      return serial(() => {
        const scope = briefScope(input?.scope, input?.brief_id ?? input?.scope?.brief_id);
        const actor_id = safeReference(input?.actor_id, "actor_id");
        const job_id = safeReference(input?.job_id, "job_id");
        const action_id = safeReference(input?.action_id, "action_id");
        const request_hash = safeHash(input?.request_hash, "request_hash");
        const lease_token = safeReference(input?.lease_token, "lease_token");
        const stage = input?.stage;
        if (!["observer", "decision_evidence", "decision_route"].includes(stage)) throw new VersionStoreError("invalid_request", "inspection.stage");
        const attempt_id = safeReference(input?.attempt_id, "attempt_id");
        const intent = safeJson(input?.intent, "inspection.stage.intent");
        const intent_json = canonicalSerialize(intent);
        const intent_hash = canonicalHash(intent);
        store.db.exec("BEGIN IMMEDIATE");
        try {
          const timestamp = store.timestamp();
          const job = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
            .get(scope.tenant_id, scope.project_id, job_id);
          if (transactionStatusFor(job, scope, actor_id, lease_token, Date.parse(timestamp)) !== "active" ||
            job.action_id !== action_id || job.request_hash !== request_hash || job.operation !== "inspect") {
            store.db.exec("ROLLBACK");
            throw new VersionStoreError("cancelled", "inspection.job");
          }
          const session = store.db.prepare(`SELECT * FROM creative_inspection_sessions_v1
            WHERE tenant_id=? AND project_id=? AND action_id=? AND job_id=? AND request_hash=?`)
            .get(scope.tenant_id, scope.project_id, action_id, job_id, request_hash);
          if (!session || session.status !== "active") throw new VersionStoreError("conflict", "inspection.session");
          const prior = store.db.prepare(`SELECT * FROM creative_inspection_stages_v1
            WHERE tenant_id=? AND project_id=? AND action_id=? AND stage=?`)
            .get(scope.tenant_id, scope.project_id, action_id, stage);
          if (prior) {
            if (prior.attempt_id !== attempt_id || prior.intent_hash !== intent_hash || prior.intent_json !== intent_json) {
              throw new VersionStoreError("conflict", "inspection.stage");
            }
            const stages = store.db.prepare(`SELECT * FROM creative_inspection_stages_v1
              WHERE tenant_id=? AND project_id=? AND action_id=? ORDER BY CASE stage
                WHEN 'observer' THEN 1 WHEN 'decision_evidence' THEN 2 ELSE 3 END`)
              .all(scope.tenant_id, scope.project_id, action_id);
            store.db.exec("COMMIT");
            return inspectionSessionFromRows(session, stages);
          }
          store.db.prepare(`INSERT INTO creative_inspection_stages_v1
            (tenant_id,project_id,action_id,stage,attempt_id,intent_json,intent_hash,status,result_json,result_hash,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,'dispatching',NULL,NULL,?,?)`)
            .run(scope.tenant_id, scope.project_id, action_id, stage, attempt_id, intent_json, intent_hash, timestamp, timestamp);
          store.db.exec("COMMIT");
          const stages = store.db.prepare(`SELECT * FROM creative_inspection_stages_v1
            WHERE tenant_id=? AND project_id=? AND action_id=? ORDER BY CASE stage
              WHEN 'observer' THEN 1 WHEN 'decision_evidence' THEN 2 ELSE 3 END`)
            .all(scope.tenant_id, scope.project_id, action_id);
          return inspectionSessionFromRows(session, stages);
        } catch (error) {
          store.rollback();
          if (error instanceof VersionStoreError) throw error;
          throw new VersionStoreError("unavailable", "inspection.stage", true);
        }
      });
    },
    completeInspectionStage(input) {
      return serial(() => {
        const scope = briefScope(input?.scope, input?.brief_id ?? input?.scope?.brief_id);
        const actor_id = safeReference(input?.actor_id, "actor_id");
        const job_id = safeReference(input?.job_id, "job_id");
        const action_id = safeReference(input?.action_id, "action_id");
        const request_hash = safeHash(input?.request_hash, "request_hash");
        const lease_token = safeReference(input?.lease_token, "lease_token");
        const stage = input?.stage;
        const attempt_id = safeReference(input?.attempt_id, "attempt_id");
        const result = safeJson(input?.result, "inspection.stage.result");
        const result_json = canonicalSerialize(result);
        const result_hash = canonicalHash(result);
        store.db.exec("BEGIN IMMEDIATE");
        try {
          const timestamp = store.timestamp();
          const job = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
            .get(scope.tenant_id, scope.project_id, job_id);
          if (transactionStatusFor(job, scope, actor_id, lease_token, Date.parse(timestamp)) !== "active" ||
            job.action_id !== action_id || job.request_hash !== request_hash) {
            store.db.exec("ROLLBACK");
            throw new VersionStoreError("cancelled", "inspection.job");
          }
          const changes = store.db.prepare(`UPDATE creative_inspection_stages_v1
            SET status='completed',result_json=?,result_hash=?,updated_at=?
            WHERE tenant_id=? AND project_id=? AND action_id=? AND stage=? AND attempt_id=? AND status='dispatching'`)
            .run(result_json, result_hash, timestamp, scope.tenant_id, scope.project_id, action_id, stage, attempt_id).changes;
          if (changes !== 1) {
            const prior = store.db.prepare(`SELECT * FROM creative_inspection_stages_v1
              WHERE tenant_id=? AND project_id=? AND action_id=? AND stage=?`).get(scope.tenant_id, scope.project_id, action_id, stage);
            if (!prior || prior.attempt_id !== attempt_id || prior.status !== "completed" || prior.result_hash !== result_hash) {
              throw new VersionStoreError("conflict", "inspection.stage");
            }
          }
          store.db.exec("COMMIT");
          return Object.freeze({ status: changes === 1 ? "recorded" : "replayed", result_hash });
        } catch (error) {
          store.rollback();
          if (error instanceof VersionStoreError) throw error;
          throw new VersionStoreError("unavailable", "inspection.stage", true);
        }
      });
    },
    completeInspectionSession(input, transaction) {
      return serial(() => {
        const scope = briefScope(input?.scope, input?.brief_id ?? input?.scope?.brief_id);
        const action_id = safeReference(input?.action_id, "action_id");
        const job_id = safeReference(input?.job_id, "job_id");
        const request_hash = safeHash(input?.request_hash, "request_hash");
        const result = safeJson(input?.result, "inspection.result");
        const result_json = canonicalSerialize(result);
        const result_hash = canonicalHash(result);
        const timestamp = store.timestamp();
        const session = store.db.prepare(`SELECT * FROM creative_inspection_sessions_v1
          WHERE tenant_id=? AND project_id=? AND action_id=? AND job_id=? AND request_hash=?`)
          .get(scope.tenant_id, scope.project_id, action_id, job_id, request_hash);
        if (!session) throw new VersionStoreError("not_found", "inspection.session");
        if (session.status === "completed") {
          if (session.result_hash !== result_hash) throw new VersionStoreError("conflict", "inspection.result");
          return Object.freeze({ status: "replayed", result_hash });
        }
        if (session.status !== "active") throw new VersionStoreError("conflict", "inspection.session");
        const changes = store.db.prepare(`UPDATE creative_inspection_sessions_v1 SET status='completed',result_json=?,result_hash=?,updated_at=?
          WHERE tenant_id=? AND project_id=? AND action_id=? AND job_id=? AND request_hash=? AND status='active'`)
          .run(result_json, result_hash, timestamp, scope.tenant_id, scope.project_id, action_id, job_id, request_hash).changes;
        if (changes !== 1) throw new VersionStoreError("conflict", "inspection.session");
        return Object.freeze({ status: "completed", result_hash });
      });
    },
    getHandoffContext(input) {
      const get = otherPorts.storage?.getHandoffContext;
      return typeof get === "function" ? serial(() => get(input)) : Promise.resolve(null);
    },
    async prepareDesignVersion(input) {
      return serial(async () => {
        if (!record(input) || input.selection_mode !== "advance" && input.selection_mode !== "branch") {
          throw new VersionStoreError("invalid_request", "design_version");
        }
        const scope = briefScope(input.scope, input.brief_id);
        const brief = store.getBrief({ scope, brief_id: scope.brief_id });
        if (!brief || canonicalHash(brief) !== input.expected_brief_hash) {
          throw new VersionStoreError("stale_version", "brief_hash");
        }
        const selection = store.getSelection({ scope, brief_id: scope.brief_id });
        const versionSelection = input.selection_mode === "branch" ? { mode: "branch" } : {
          mode: "advance",
          expected_revision: selection?.revision ?? 0,
          expected_selected_design_version_id: input.expected_current_design_version_id,
          expected_selected_design_hash: input.expected_current_design_hash,
        };
        if (input.selection_mode === "advance" &&
          (selection?.design_version_id ?? null) !== input.expected_current_design_version_id ||
          input.selection_mode === "advance" && (selection?.design_hash ?? null) !== input.expected_current_design_hash) {
          throw new VersionStoreError("stale_version", "selection");
        }
        if (input.expected_parent_design_version_id !== (input.design_version.parent_version_id ?? null)) {
          throw new VersionStoreError("stale_version", "parent_version_id");
        }
        if (input.expected_parent_design_version_id !== null) {
          const parent = store.getDesignVersion({ scope, brief_id: scope.brief_id,
            design_version_id: input.expected_parent_design_version_id });
          if (!parent || parent.design_hash !== input.expected_parent_design_hash) throw new VersionStoreError("stale_version", "parent_design_hash");
        }
        const prepared = await store.prepareDesignVersion({
          ...input,
          scope,
          brief_snapshot: brief,
          actor_id: input.creation?.actor_id,
          selection: versionSelection,
          artifact_bytes: Uint8Array.from(input.artifact_bytes),
        }, { faultInjector });
        if (!record(prepared) || prepared.status !== "prepared") {
          throw new VersionStoreError("unavailable", "creation.intent", true);
        }
        return Object.freeze({ status: "prepared", action_id: prepared.action_id,
          job_id: prepared.job_id, payload_hash: prepared.payload_hash });
      });
    },
    commitPreparedDesignVersion(input, transaction) {
      return serial(() => store.commitPreparedDesignVersion(input, transaction));
    },
    saveDesignVersion(input, transaction) {
      // This fallback supports non-durable conformance adapters. The paired
      // adapter's API path uses prepare+commit so its creation intent survives
      // a process exit between bytes and publication.
      return serial(async () => {
        const scope = briefScope(input.scope, input.brief_id);
        const brief = store.getBrief({ scope, brief_id: scope.brief_id });
        if (!brief) throw new VersionStoreError("not_found", "brief_id");
        const selection = store.getSelection({ scope, brief_id: scope.brief_id });
        const prepared = await store.prepareDesignVersion({ ...input, scope, brief_snapshot: brief,
          selection: input.selection_mode === "branch" ? { mode: "branch" } : {
            mode: "advance", expected_revision: selection?.revision ?? 0,
            expected_selected_design_version_id: input.expected_current_design_version_id,
            expected_selected_design_hash: input.expected_current_design_hash,
          } });
        if (transaction) return store.commitPreparedDesignVersion({ ...prepared, scope,
          brief_id: scope.brief_id }, transaction);
        return store.finalizeAction(scope, prepared.action_id);
      });
    },
    selectDesignVersion(input, transaction) {
      return serial(() => store.selectDesignVersion(input, transaction));
    },
  };

  const externalPlanning = otherPorts.planning ?? {};
  const invalidationActionsInFlight = new Map();
  const planning = {
    ...externalPlanning,
    saveBriefAction(input) { return serial(() => store.saveBriefAction(input)); },
    getBriefAction(input) { return serial(() => store.getBriefAction(input)); },
    getBriefVersionByHash(input) { return serial(() => store.getBriefVersionByHash(input)); },
    isBriefUsable(input) { return serial(() => store.isBriefUsable(input)); },
    applyInvalidation(input) {
      if (!record(input?.trusted_scope)) throw new VersionStoreError("scope_denied", "planning.trusted_scope");
      const scope = Object.freeze({
        tenant_id: safeReference(input.trusted_scope.tenant_id, "scope.tenant_id"),
        project_id: safeReference(input.trusted_scope.project_id, "scope.project_id"),
      });
      const actor_id = safeReference(input.actor_id, "actor_id");
      const action_id = safeReference(input.action_id, "action_id");
      const request_hash = safeHash(input.request_hash, "request_hash");
      const event_id = safeReference(input.event_id, "event_id");
      if (input.operation !== "brief.invalidate") throw new VersionStoreError("invalid_request", "operation");
      const key = `${scope.tenant_id}\u0000${scope.project_id}\u0000${action_id}`;
      const running = invalidationActionsInFlight.get(key);
      if (running) return running.actor_id === actor_id && running.request_hash === request_hash
        ? running.promise
        : Promise.resolve(Object.freeze({ public_action_status: "conflict" }));
      const perform = async () => {
        const actionInput = { scope, actor_id, action_id, operation: "brief.invalidate", request_hash, event_id };
        const admitted = await serial(() => store.beginInvalidationAction(actionInput));
        if (admitted.status === "conflict") return Object.freeze({ public_action_status: "conflict" });
        if (admitted.status === "replayed") {
          return Object.freeze({ public_action_status: "replayed", invalidation: admitted.result });
        }
        if (admitted.status !== "started" && admitted.status !== "pending") {
          throw new VersionStoreError("unavailable", "invalidation_action", true);
        }
        if (typeof externalPlanning.getInvalidationEvent !== "function") {
          throw new VersionStoreError("unavailable", "planning.invalidation_event", true);
        }
        const event = await externalPlanning.getInvalidationEvent({ scope, event_id });
        if (!record(event) || event.event_id !== event_id) {
          throw new VersionStoreError("unavailable", "planning.invalidation_event", true);
        }
        const invalidation = await applyResearchInvalidation({ trusted_scope: scope, event, ports: {
          clock: { now: () => store.timestamp() },
          store: store.planningStore(scope),
          verifier: externalPlanning.invalidationVerifier,
          approvalStaleness: externalPlanning.approvalStaleness,
          producerAcknowledgment: externalPlanning.producerAcknowledgment,
        } });
        const completed = await serial(() => store.completeInvalidationAction({
          ...actionInput, result: invalidation,
        }));
        if (completed.status === "conflict") throw new VersionStoreError("conflict", "action_id");
        return Object.freeze({ public_action_status: completed.status === "replayed" ? "replayed"
          : completed.status === "pending" ? "pending" : "completed",
          invalidation: completed.result });
      };
      const promise = perform();
      invalidationActionsInFlight.set(key, { actor_id, request_hash, promise });
      return promise.finally(() => {
        if (invalidationActionsInFlight.get(key)?.promise === promise) invalidationActionsInFlight.delete(key);
      });
    },
  };

  const jobs = {
    assertOperationAvailable({ operation }) {
      if (operation === "handoff") {
        throw new VersionStoreError("unavailable", "handoff.durable_result_staging", true);
      }
      return Object.freeze({ status: "available" });
    },
    begin(input) {
      return serial(() => {
        store.assertOpen();
        store.assertNoBorrowedTransaction("job.begin.transaction");
        if (!record(input) || !record(input.scope)) throw new VersionStoreError("invalid_request", "job");
        const tenant_id = safeReference(input.scope.tenant_id, "scope.tenant_id");
        const project_id = safeReference(input.scope.project_id, "scope.project_id");
        const actor_id = safeReference(input.actor_id, "actor_id");
        const action_id = safeReference(input.action_id, "action_id");
        const request_hash = safeHash(input.request_hash, "request_hash");
        if (!OPERATIONS.has(input.operation)) throw new VersionStoreError("invalid_request", "operation");
        const brief_id = input.scope.brief_id === undefined ? null : safeReference(input.scope.brief_id, "brief_id");
        const now = store.timestamp();
        store.db.exec("BEGIN IMMEDIATE");
        try {
          const existing = store.db.prepare(`SELECT * FROM creative_jobs
            WHERE tenant_id=? AND project_id=? AND action_id=?`)
            .get(tenant_id, project_id, action_id);
          if (existing) {
            store.db.exec("COMMIT");
            if (existing.request_hash !== request_hash || existing.actor_id !== actor_id || existing.operation !== input.operation) {
              return Object.freeze({ kind: "conflict" });
            }
            return Object.freeze({ kind: "existing", job: jobFromRow(existing) });
          }
          const job_id = safeReference(idFactory(), "job_id");
          const lease_token = safeReference(idFactory(), "lease_token");
          const expires = new Date(Date.parse(now) + leaseDurationMs).toISOString();
          store.db.prepare(`INSERT INTO creative_jobs
            (tenant_id,project_id,job_id,brief_id,actor_id,action_id,operation,request_hash,status,lease_hash,
             lease_expires_at,result_json,error_json,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,'running',?,?,NULL,NULL,?,?)`)
            .run(tenant_id, project_id, job_id, brief_id, actor_id, action_id, input.operation, request_hash,
              tokenHash(lease_token), expires, now, now);
          store.db.exec("COMMIT");
          return Object.freeze({ kind: "started", job_id, lease_token });
        } catch (error) {
          store.rollback();
          if (error instanceof VersionStoreError) throw error;
          throw new VersionStoreError("unavailable", "job", true);
        }
      });
    },
    resumeExpired(input) {
      return serial(() => {
        if (!record(input) || !record(input.scope)) throw new VersionStoreError("invalid_request", "job.resume");
        const scope = briefScope(input.scope, input.scope.brief_id);
        const actor_id = safeReference(input.actor_id, "actor_id");
        const job_id = safeReference(input.job_id, "job_id");
        const action_id = safeReference(input.action_id, "action_id");
        const request_hash = safeHash(input.request_hash, "request_hash");
        store.db.exec("BEGIN IMMEDIATE");
        try {
          const row = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
            .get(scope.tenant_id, scope.project_id, job_id);
          if (!row || row.actor_id !== actor_id || row.action_id !== action_id || row.request_hash !== request_hash ||
            !["inspect", "concepts.create", "composition.create", "composition.update", "composition.revalidate"].includes(row.operation)) {
            store.db.exec("ROLLBACK");
            return Object.freeze({ kind: "conflict" });
          }
          if (row.status !== "running") {
            store.db.exec("COMMIT");
            return Object.freeze({ kind: "existing", job: jobFromRow(row) });
          }
          const now = store.timestamp();
          if (Date.parse(row.lease_expires_at) > Date.parse(now)) {
            store.db.exec("COMMIT");
            return Object.freeze({ kind: "existing", job: jobFromRow(row) });
          }
          const lease_token = safeReference(idFactory(), "lease_token");
          const expires = new Date(Date.parse(now) + leaseDurationMs).toISOString();
          const changes = store.db.prepare(`UPDATE creative_jobs SET lease_hash=?,lease_expires_at=?,updated_at=?
            WHERE tenant_id=? AND project_id=? AND job_id=? AND status='running' AND lease_hash=? AND lease_expires_at<=?`)
            .run(tokenHash(lease_token), expires, now, scope.tenant_id, scope.project_id, job_id,
              row.lease_hash, now).changes;
          if (changes !== 1) {
            store.db.exec("ROLLBACK");
            const current = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
              .get(scope.tenant_id, scope.project_id, job_id);
            return Object.freeze({ kind: "existing", job: jobFromRow(current) });
          }
          const updated = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
            .get(scope.tenant_id, scope.project_id, job_id);
          store.db.exec("COMMIT");
          return Object.freeze({ kind: "started", job_id, lease_token, job: jobFromRow(updated) });
        } catch (error) {
          store.rollback();
          if (error instanceof VersionStoreError) throw error;
          throw new VersionStoreError("unavailable", "job.resume", true);
        }
      });
    },
    async authorizeDispatch(input) {
      return serial(() => {
        store.db.exec("BEGIN IMMEDIATE");
        try {
          const row = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
            .get(input.scope.tenant_id, input.scope.project_id, input.job_id);
          const status = transactionStatusFor(row, input.scope, input.actor_id, input.lease_token, store.now());
          if (status !== "active") {
            store.db.exec("ROLLBACK");
            return Object.freeze({ status });
          }
          if (row.action_id !== input.action_id || row.operation !== input.operation) {
            store.db.exec("ROLLBACK");
            return Object.freeze({ status: "lease_lost" });
          }
          if (!contextFenceMatches(store, input.scope, input.context_fence)) {
            store.db.exec("ROLLBACK");
            return Object.freeze({ status: "stale_context" });
          }
          const transport_attempt_id = safeReference(input.transport_attempt_id, "transport_attempt_id");
          const billable_attempt_id = input.billable_attempt_id === undefined ? null
            : safeReference(input.billable_attempt_id, "billable_attempt_id");
          const reservation_ref = input.reservation_ref === undefined ? null
            : safeReference(input.reservation_ref, "reservation_ref");
          const provider_name = input.provider_name === undefined ? null : safeReference(input.provider_name, "provider_name");
          const provider_model = input.provider_model === undefined ? null : safeModelReference(input.provider_model, "provider_model");
          if ((provider_name === null) !== (provider_model === null)) throw new VersionStoreError("invalid_request", "provider_route");
          const existing = store.db.prepare(`SELECT dispatch_intent_ref,context_fence_json,billable_attempt_id,
            reservation_ref,provider_name,provider_model FROM creative_dispatch_intents
            WHERE tenant_id=? AND project_id=? AND job_id=? AND transport_attempt_id=?`)
            .get(input.scope.tenant_id, input.scope.project_id, input.job_id, transport_attempt_id);
          if (existing) {
            const sameFence = sameDispatchFence(existing.context_fence_json, input.context_fence);
            const sameAttempt = (existing.billable_attempt_id ?? null) === billable_attempt_id &&
              (existing.reservation_ref ?? null) === reservation_ref &&
              (existing.provider_name ?? null) === provider_name && (existing.provider_model ?? null) === provider_model;
            const finalStatus = transactionStatusFor(row, input.scope, input.actor_id, input.lease_token, store.now());
            if (finalStatus !== "active") {
              store.db.exec("ROLLBACK");
              return Object.freeze({ status: finalStatus });
            }
            store.db.exec("COMMIT");
            return sameFence && sameAttempt ? Object.freeze({ status: "authorized", dispatch_intent_ref: existing.dispatch_intent_ref })
              : Object.freeze({ status: "lease_lost" });
          }
          const dispatch_intent_ref = safeReference(idFactory(), "dispatch_intent_ref");
          const authorized_at = store.timestamp();
          const authorizedAtMs = Date.parse(authorized_at);
          if (!Number.isFinite(authorizedAtMs) ||
            transactionStatusFor(row, input.scope, input.actor_id, input.lease_token, authorizedAtMs) !== "active") {
            store.db.exec("ROLLBACK");
            return Object.freeze({ status: "lease_lost" });
          }
          store.db.prepare(`INSERT INTO creative_dispatch_intents
            (tenant_id,project_id,job_id,transport_attempt_id,billable_attempt_id,reservation_ref,provider_name,provider_model,
              dispatch_intent_ref,context_fence_json,authorized_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
            .run(input.scope.tenant_id, input.scope.project_id, input.job_id, transport_attempt_id,
              billable_attempt_id, reservation_ref, provider_name, provider_model,
              dispatch_intent_ref, canonicalSerialize(input.context_fence), authorized_at);
          store.db.exec("COMMIT");
          return Object.freeze({ status: "authorized", dispatch_intent_ref });
        } catch (error) {
          store.rollback();
          if (error instanceof VersionStoreError) throw error;
          return Object.freeze({ status: "lease_lost" });
        }
      });
    },
    assertDispatchCurrent(input) {
      // The send permit crosses a Finance await after authorizeDispatch has
      // committed. Re-read the durable owner state synchronously at the last
      // callback boundary; awaiting the serialized authorizer here would
      // recreate the cancellation/lease race this check closes.
      try {
        // This check must not borrow a transaction opened by another caller
        // on the shared connection. In that case the reads could observe
        // uncommitted owner state, so fail closed without touching the caller's
        // transaction.
        if (store.db.isTransaction) return Object.freeze({ status: "lease_lost" });
        if (!record(input) || !record(input.scope) || !record(input.context_fence)) {
          return Object.freeze({ status: "lease_lost" });
        }
        const scope = briefScope(input.scope, input.context_fence.brief_id);
        const actor_id = safeReference(input.actor_id, "actor_id");
        const job_id = safeReference(input.job_id, "job_id");
        const lease_token = safeReference(input.lease_token, "lease_token");
        const action_id = safeReference(input.action_id, "action_id");
        const operation = safeReference(input.operation, "operation");
        const transport_attempt_id = safeReference(input.transport_attempt_id, "transport_attempt_id");
        const dispatch_intent_ref = safeReference(input.dispatch_intent_ref, "dispatch_intent_ref");
        const billable_attempt_id = input.billable_attempt_id === undefined ? null
          : safeReference(input.billable_attempt_id, "billable_attempt_id");
        const reservation_ref = input.reservation_ref === undefined ? null
          : safeReference(input.reservation_ref, "reservation_ref");
        const provider_name = input.provider_name === undefined ? null
          : safeReference(input.provider_name, "provider_name");
        const provider_model = input.provider_model === undefined ? null
          : safeModelReference(input.provider_model, "provider_model");
        if ((provider_name === null) !== (provider_model === null)) {
          return Object.freeze({ status: "lease_lost" });
        }
        const readJob = () => store.db.prepare(`SELECT * FROM creative_jobs
          WHERE tenant_id=? AND project_id=? AND job_id=?`).get(scope.tenant_id, scope.project_id, job_id);
        const readIntent = () => store.db.prepare(`SELECT dispatch_intent_ref,context_fence_json,billable_attempt_id,
          reservation_ref,provider_name,provider_model FROM creative_dispatch_intents
          WHERE tenant_id=? AND project_id=? AND job_id=? AND transport_attempt_id=?`)
          .get(scope.tenant_id, scope.project_id, job_id, transport_attempt_id);
        const statusForCurrentJob = () => {
          const row = readJob();
          const status = transactionStatusFor(row, scope, actor_id, lease_token, store.now());
          if (status !== "active") return Object.freeze({ status });
          if (row.action_id !== action_id || row.operation !== operation) {
            return Object.freeze({ status: "lease_lost" });
          }
          return Object.freeze({ status: "authorized", row });
        };

        let current = statusForCurrentJob();
        if (current.status !== "authorized") return Object.freeze({ status: current.status });
        const intent = readIntent();
        if (!intent || intent.dispatch_intent_ref !== dispatch_intent_ref ||
            (intent.billable_attempt_id ?? null) !== billable_attempt_id ||
            (intent.reservation_ref ?? null) !== reservation_ref ||
            (intent.provider_name ?? null) !== provider_name ||
            (intent.provider_model ?? null) !== provider_model) {
          return Object.freeze({ status: "lease_lost" });
        }
        if (!sameDispatchFence(intent.context_fence_json, input.context_fence) ||
            !contextFenceMatches(store, scope, input.context_fence)) {
          return Object.freeze({ status: "stale_context" });
        }
        // Context and permission checks above may read several owner rows. Do
        // the job/token/lease read again after them so expiry, cancellation,
        // or a resumed worker cannot leave a stale permit at this boundary.
        current = statusForCurrentJob();
        if (current.status !== "authorized") return Object.freeze({ status: current.status });
        const finalIntent = readIntent();
        if (!finalIntent || finalIntent.dispatch_intent_ref !== dispatch_intent_ref ||
            (finalIntent.billable_attempt_id ?? null) !== billable_attempt_id ||
            (finalIntent.reservation_ref ?? null) !== reservation_ref ||
            (finalIntent.provider_name ?? null) !== provider_name ||
            (finalIntent.provider_model ?? null) !== provider_model ||
            !sameDispatchFence(finalIntent.context_fence_json, input.context_fence)) {
          return Object.freeze({ status: "stale_context" });
        }
        return Object.freeze({ status: "authorized", dispatch_intent_ref });
      } catch {
        return Object.freeze({ status: "lease_lost" });
      }
    },
    recordAttemptEvidence(input) {
      return serial(() => store.recordAttemptEvidence(input));
    },
    recordPrivateProviderAttribution(input) {
      return serial(() => store.recordPrivateProviderAttribution(input));
    },
    recordPrivateProviderUsageAttribution(input) {
      return serial(() => store.recordPrivateProviderUsageAttribution(input));
    },
    stagePrivateProviderAttribution(input) {
      return serial(() => store.stagePrivateProviderAttribution(input));
    },
    reconcilePrivateProviderAttributions(input) {
      return serial(() => store.reconcilePrivateProviderAttributions(input));
    },
    async completeIfActive(input, publish, beforeCommit) {
      return serial(async () => {
        // This adapter owns the publication transaction from BEGIN through
        // COMMIT. A caller BEGIN or SAVEPOINT must never be rolled back by the
        // catch path below, and cannot authorize external publication.
        store.assertNoBorrowedTransaction("job_publication.transaction");
        if (typeof publish !== "function" || (beforeCommit !== undefined && typeof beforeCommit !== "function")) {
          throw new VersionStoreError("invalid_request", "publish");
        }
        if (input?.operation === "handoff") {
          throw new VersionStoreError("unavailable", "handoff.durable_result_staging", true);
        }
        const scope = briefScope(input.scope, input.publication_fence?.brief_id);
        store.db.exec("BEGIN IMMEDIATE");
        let transaction;
        try {
          const row = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
            .get(scope.tenant_id, scope.project_id, input.job_id);
          const status = transactionStatusFor(row, scope, input.actor_id, input.lease_token, store.now());
          if (status !== "active") {
            store.db.exec("ROLLBACK");
            return Object.freeze({ status: status === "cancelled" ? "cancelled" : "cancelled", ...(row ? { job: jobFromRow(row) } : {}) });
          }
          if (row.action_id !== input.action_id || row.operation !== input.operation || !record(input.publication_fence) ||
            !contextFenceMatches(store, scope, input.publication_fence)) {
            store.db.exec("ROLLBACK");
            return Object.freeze({ status: "stale_context", job: jobFromRow(row) });
          }
          transaction = store.createPublicationTransaction({
            scope, actor_id: input.actor_id, job_id: input.job_id, lease_token: input.lease_token,
            action_id: row.action_id, request_hash: row.request_hash, result: input.result,
            publication_fence: input.publication_fence, faultInjector,
          });
          await publish(transaction);
          const fresh = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
            .get(scope.tenant_id, scope.project_id, input.job_id);
          if (transactionStatusFor(fresh, scope, input.actor_id, input.lease_token, store.now()) !== "active") {
            throw new VersionStoreError("cancelled", "job.lease_token");
          }
          if (!contextFenceMatches(store, scope, input.publication_fence,
            { requireRecordedRepair: true, afterPublication: true })) {
            throw new VersionStoreError("stale_version", "publication_fence");
          }
          const committedBrief = store.getBrief({ scope, brief_id: scope.brief_id });
          if (!committedBrief || canonicalHash(committedBrief) !== input.publication_fence.brief_hash) {
            throw new VersionStoreError("stale_version", "brief_hash");
          }
          const result_json = canonicalSerialize(safeJson(input.result, "job.result"));
          const updated_at = store.timestamp();
          const completedAt = Date.parse(updated_at);
          const finalRow = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
            .get(scope.tenant_id, scope.project_id, input.job_id);
          if (!Number.isFinite(completedAt) ||
            transactionStatusFor(finalRow, scope, input.actor_id, input.lease_token, completedAt) !== "active" ||
            finalRow.action_id !== input.action_id || finalRow.operation !== input.operation ||
            finalRow.request_hash !== row.request_hash ||
            !contextFenceMatches(store, scope, input.publication_fence,
              { requireRecordedRepair: true, afterPublication: true })) {
            throw new VersionStoreError("cancelled", "job.lease_token");
          }
          const completedChanges = store.db.prepare(`UPDATE creative_jobs SET status='completed',result_json=?,error_json=NULL,updated_at=?
            WHERE tenant_id=? AND project_id=? AND job_id=? AND status='running' AND actor_id=? AND action_id=?
              AND operation=? AND request_hash=? AND lease_hash=? AND lease_expires_at>?`)
            .run(result_json, updated_at, scope.tenant_id, scope.project_id, input.job_id,
              input.actor_id, input.action_id, input.operation, row.request_hash, tokenHash(input.lease_token), updated_at).changes;
          if (completedChanges !== 1) throw new VersionStoreError("cancelled", "job.lease_token");
          if (beforeCommit) {
            let fenceResult;
            try { fenceResult = beforeCommit(transaction); }
            catch (error) {
              if (error instanceof VersionStoreError) throw error;
              if (["stale_version", "scope_denied", "conflict"].includes(error?.code)) {
                throw new VersionStoreError(error.code, "job_publication.final_fence");
              }
              throw new VersionStoreError("unavailable", "job_publication.final_fence", true);
            }
            if (fenceResult !== null && typeof fenceResult === "object" && typeof fenceResult.then === "function") {
              throw new VersionStoreError("invalid_request", "job_publication.final_fence_async");
            }
            if (fenceResult !== true) {
              throw new VersionStoreError("invalid_request", "job_publication.final_fence_result");
            }
          }
          // beforeCommit is the last synchronous owner-backed assertion. It may
          // advance a test clock or observe a lease/context change, so recheck
          // the same-store lease and context after it returns and immediately
          // before the transaction becomes durable.
          const afterFence = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
            .get(scope.tenant_id, scope.project_id, input.job_id);
          const afterFenceNow = store.now();
          if (!afterFence || afterFence.status !== "completed" || afterFence.actor_id !== input.actor_id ||
              afterFence.lease_hash !== tokenHash(input.lease_token) ||
              !Number.isFinite(afterFenceNow) || Date.parse(afterFence.lease_expires_at) <= afterFenceNow ||
              afterFence.action_id !== input.action_id || afterFence.operation !== input.operation ||
              afterFence.request_hash !== row.request_hash ||
              !contextFenceMatches(store, scope, input.publication_fence,
                { requireRecordedRepair: true, afterPublication: true })) {
            throw new VersionStoreError("cancelled", "job.lease_token");
          }
          const finalBrief = store.getBrief({ scope, brief_id: scope.brief_id });
          if (!finalBrief || canonicalHash(finalBrief) !== input.publication_fence.brief_hash) {
            throw new VersionStoreError("stale_version", "brief_hash");
          }
          store.db.exec("COMMIT");
          faultInjector?.("after_job_commit");
          const completed = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
            .get(scope.tenant_id, scope.project_id, input.job_id);
          return Object.freeze({ status: "completed", job: jobFromRow(completed), result: JSON.parse(result_json) });
        } catch (error) {
          store.rollback();
          if (error instanceof VersionStoreError) {
            if (["stale_version", "scope_denied", "conflict"].includes(error.code)) {
              const current = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
                .get(scope.tenant_id, scope.project_id, input.job_id);
              return Object.freeze({ status: "stale_context", ...(current ? { job: jobFromRow(current) } : {}) });
            }
            throw error;
          }
          throw new VersionStoreError("unavailable", "job_publication", true);
        } finally {
          store.closePublicationTransaction(transaction);
        }
      });
    },
    failIfActive(input) {
      return serial(() => {
        store.assertNoBorrowedTransaction("job.failure.transaction");
        const scope = briefScope(input.scope, input.scope.brief_id ?? "job-scope");
        store.db.exec("BEGIN IMMEDIATE");
        try {
          const row = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
            .get(scope.tenant_id, scope.project_id, input.job_id);
          if (!row || row.actor_id !== input.actor_id || row.lease_hash !== tokenHash(input.lease_token) || row.status !== "running") {
            store.db.exec("ROLLBACK");
            return Object.freeze({ status: "cancelled", job: row ? jobFromRow(row) : undefined });
          }
          const error = safeJson(input.error, "job.error");
          store.db.prepare(`UPDATE creative_jobs SET status='failed',error_json=?,updated_at=?
            WHERE tenant_id=? AND project_id=? AND job_id=?`)
            .run(canonicalSerialize(error), store.timestamp(), scope.tenant_id, scope.project_id, input.job_id);
          store.db.exec("COMMIT");
          const updated = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
            .get(scope.tenant_id, scope.project_id, input.job_id);
          return Object.freeze({ status: "failed", job: jobFromRow(updated) });
        } catch (error) {
          store.rollback();
          if (error instanceof VersionStoreError) throw error;
          throw new VersionStoreError("unavailable", "job_failure", true);
        }
      });
    },
    get(input) {
      return serial(() => {
        const tenant_id = safeReference(input.scope?.tenant_id, "scope.tenant_id");
        const project_id = safeReference(input.scope?.project_id, "scope.project_id");
        const job_id = safeReference(input.job_id, "job_id");
        const row = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
          .get(tenant_id, project_id, job_id);
        return jobFromRow(row);
      });
    },
    cancel(input) {
      return serial(() => {
        store.assertNoBorrowedTransaction("job.cancel.transaction");
        const tenant_id = safeReference(input.scope?.tenant_id, "scope.tenant_id");
        const project_id = safeReference(input.scope?.project_id, "scope.project_id");
        const actor_id = safeReference(input.actor_id, "actor_id");
        const action_id = safeReference(input.action_id, "action_id");
        const target_action_id = safeReference(input.target_action_id, "target_action_id");
        const request_hash = safeHash(input.request_hash, "request_hash");
        store.db.exec("BEGIN IMMEDIATE");
        try {
          const prior = store.db.prepare(`SELECT * FROM creative_cancel_requests WHERE tenant_id=? AND project_id=? AND action_id=?`)
            .get(tenant_id, project_id, action_id);
          if (prior) {
            store.db.exec("COMMIT");
            if (prior.actor_id !== actor_id || prior.target_action_id !== target_action_id || prior.request_hash !== request_hash) {
              return Object.freeze({ kind: "conflict" });
            }
            const replayJob = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
              .get(tenant_id, project_id, prior.job_id);
            return replayJob ? Object.freeze({ kind: "replayed", job: jobFromRow(replayJob) }) : Object.freeze({ kind: "not_found" });
          }
          const row = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
            .get(tenant_id, project_id, input.job_id);
          if (!row || row.action_id !== target_action_id) {
            store.db.exec("ROLLBACK");
            return Object.freeze({ kind: "not_found" });
          }
          const now = store.timestamp();
          store.db.prepare(`INSERT INTO creative_cancel_requests
            (tenant_id,project_id,action_id,actor_id,target_action_id,request_hash,job_id,created_at)
            VALUES(?,?,?,?,?,?,?,?)`)
            .run(tenant_id, project_id, action_id, actor_id, target_action_id, request_hash, row.job_id, now);
          if (row.status === "running" || row.status === "queued") {
            // Keep the original lease hash as evidence identity. Terminal job
            // status fences dispatch/publication; a late worker with that
            // lease may still append usage references for reconciliation.
            store.db.prepare(`UPDATE creative_jobs SET status='cancelled',updated_at=?
              WHERE tenant_id=? AND project_id=? AND job_id=?`)
              .run(now, tenant_id, project_id, row.job_id);
          }
          store.db.exec("COMMIT");
          const updated = store.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
            .get(tenant_id, project_id, row.job_id);
          return Object.freeze({ kind: "cancelled", job: jobFromRow(updated) });
        } catch (error) {
          store.rollback();
          if (error instanceof VersionStoreError) throw error;
          throw new VersionStoreError("unavailable", "job_cancel", true);
        }
      });
    },
  };

  const ports = { ...otherPorts, storage: { ...otherPorts.storage, ...storage }, jobs: { ...otherPorts.jobs, ...jobs }, planning };
  return Object.freeze({ ports, storage: ports.storage, jobs: ports.jobs });
}
