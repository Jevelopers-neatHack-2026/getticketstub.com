import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  canonicalHash,
  canonicalSerialize,
  computeDesignVersionHash,
  validateCreativeBrief,
  validateDesignVersion,
} from "../contracts/index.mjs";
import {
  ContentAddressedStorageError,
  hashArtifactBytes,
  readContentAddressedObject,
  writeContentAddressedObject,
} from "../storage/content-addressed.mjs";
import { createCreativeBriefStore } from "../planning/index.mjs";
import { initializeCreativeBriefDatabase } from "../planning/store.mjs";
import { createSqliteInspectionRepairController, inspectionRepairFenceCurrent } from "../inspection/repair-controller.mjs";
import { applyCreativeConceptEvent, inspectCreativeConceptImageBytes } from "../generation/concepts.mjs";
import { compositionPreviewHash, snapshotCompositionBytesRecord, snapshotCompositionJson,
  createCompositionProductionEnvelope, validateCompositionProductionEnvelope,
  validateCompositionRevision } from "../contracts/composition-authority.mjs";
import { imageProviderRoute } from "../models/image-routes.mjs";

const STORAGE_VERSION = 13;
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,256}$/;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ATTEMPT_FIELDS = [
  "job_id", "action_id", "actor_id", "request_hash", "logical_operation_id", "billable_attempt_id",
  "parent_design_hash", "transport_attempt_ids", "provider_request_ids", "usage_refs", "trace_refs",
];
const publicationTransactionRegistries = new WeakMap();

function providerTargetHash(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { reject("invalid_request", "concept.target_binding"); }
  if (typeof serialized !== "string") reject("invalid_request", "concept.target_binding");
  return `sha256:${createHash("sha256").update(serialized, "utf8").digest("hex")}`;
}

function creativeConceptLineage(batch, slot, version) {
  const attempt = slot?.attempts?.find((item) => item.billable_attempt_id === slot.current_billable_attempt_id);
  if (!slot || !attempt || !attempt.metering_attempt || !attempt.dispatch_intent_ref ||
      !attempt.provider_target_binding_sha256 || !attempt.rendered_prompt_sha256 ||
      !attempt.usage_evidence_ref) reject("integrity_error", "concept.lineage_attempt");
  return {
    contract: "CreativeConceptLineage",
    schema_version: "1.1",
    mapping_status: "local_mapping_external_acceptance_pending",
    concept_id: slot.concept_id,
    ordinal: slot.ordinal,
    parent_version_id: null,
    brief_sha256: batch.brief_sha256,
    package_id: batch.package_id,
    package_sha256: batch.package_sha256,
    plan_id: batch.plan_id,
    plan_sha256: batch.plan_sha256,
    policy_snapshot: batch.policy_snapshot,
    adapter_snapshot: batch.adapter_snapshot,
    source_assets: batch.references,
    attempt: attempt.metering_attempt,
    logical_operation_id: slot.logical_operation_id,
    billable_attempt_id: attempt.billable_attempt_id,
    transport_attempt_id: attempt.transport_attempt_id,
    provider_request_ref: attempt.latest_provider_request_id,
    dispatch_intent_ref: attempt.dispatch_intent_ref,
    provider_target_binding_sha256: attempt.provider_target_binding_sha256,
    rendered_prompt_sha256: attempt.rendered_prompt_sha256,
    usage_evidence_refs: [...attempt.usage_evidence_refs],
    usage_completeness: attempt.usage_completeness ?? "unknown",
    unknown_financial_exposure: attempt.unknown_financial_exposure,
    design_version_id: version.design_version_id,
    design_sha256: version.design_hash,
    artifact_id: version.artifact.artifact_id,
    artifact_sha256: version.artifact.content_hash,
    artifact_media_type: version.artifact.media_type,
  };
}

const ERROR_MESSAGES = Object.freeze({
  invalid_request: "The version write does not match the supported local contract.",
  unsupported_version: "The stored version schema is not supported.",
  scope_denied: "The operation is outside the trusted project scope.",
  not_found: "The scoped version was not found.",
  conflict: "The action identity conflicts with an existing operation.",
  stale_version: "The selected version changed before this operation committed.",
  integrity_error: "Stored version or artifact integrity could not be verified.",
  unknown_completion: "The durable operation requires reconciliation.",
  unavailable: "Durable version storage is unavailable.",
});

export class VersionStoreError extends Error {
  constructor(code, field = "", retryable = false) {
    super(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.unavailable);
    this.name = "VersionStoreError";
    this.code = Object.hasOwn(ERROR_MESSAGES, code) ? code : "unavailable";
    this.module = "creative-engine.versions";
    this.field = typeof field === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(field) ? field : "";
    this.retryable = retryable;
  }
}

function reject(code, field, retryable = false) {
  throw new VersionStoreError(code, field, retryable);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function snapshotJson(value, code = "invalid_request", field = "record") {
  try { return JSON.parse(canonicalSerialize(value)); }
  catch { reject(code, field); }
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function activeJobLease(row, scope, actorId, leaseToken, now) {
  return Boolean(row && row.tenant_id === scope.tenant_id && row.project_id === scope.project_id &&
    row.actor_id === actorId && row.status === "running" &&
    row.lease_hash === createHash("sha256").update(leaseToken).digest("hex") &&
    Date.parse(row.lease_expires_at) > now);
}

function reference(value, field, max = 256) {
  if (typeof value !== "string" || value.length > max || !ID_PATTERN.test(value) ||
    /(?:gh[pousr]_[A-Za-z0-9]{20,}|(?:sk|rk|pk)-[A-Za-z0-9_-]{12,})/i.test(value)) {
    reject("invalid_request", field);
  }
  return value;
}

/** A routed model id such as "author/slug" additionally allows "/"; every other identifier rule still applies. */
function modelReference(value, field, max = 256) {
  if (typeof value === "string" && value.includes("/")) {
    if (value.length > max || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.:-]*)+$/.test(value)) {
      reject("invalid_request", field);
    }
    reference(value.replaceAll("/", "."), field, max);
    return value;
  }
  return reference(value, field, max);
}

function hash(value, field) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) reject("invalid_request", field);
  return value;
}

function validScope(scope, briefId) {
  if (!isRecord(scope)) reject("scope_denied", "scope");
  const tenant_id = reference(scope.tenant_id, "scope.tenant_id");
  const project_id = reference(scope.project_id, "scope.project_id");
  if (scope.brief_id !== undefined && scope.brief_id !== briefId) reject("scope_denied", "scope.brief_id");
  const brief_id = reference(briefId, "brief_id");
  return Object.freeze({ tenant_id, project_id, brief_id });
}

function attemptEvidence(input) {
  if (!isRecord(input) || Object.keys(input).some((key) => !ATTEMPT_FIELDS.includes(key))) {
    reject("invalid_request", "creation");
  }
  const evidence = {
    job_id: reference(input.job_id, "creation.job_id"),
    action_id: reference(input.action_id, "creation.action_id"),
    actor_id: reference(input.actor_id, "creation.actor_id"),
    request_hash: hash(input.request_hash, "creation.request_hash"),
  };
  for (const field of ["logical_operation_id", "billable_attempt_id"]) {
    if (input[field] !== undefined) evidence[field] = reference(input[field], `creation.${field}`);
  }
  if (input.parent_design_hash !== undefined) evidence.parent_design_hash = hash(input.parent_design_hash, "creation.parent_design_hash");
  for (const field of ["transport_attempt_ids", "provider_request_ids", "usage_refs", "trace_refs"]) {
    if (input[field] === undefined) continue;
    if (!Array.isArray(input[field]) || input[field].length > 100) reject("invalid_request", `creation.${field}`);
    const values = input[field].map((value, index) => reference(value, `creation.${field}[${index}]`));
    if (new Set(values).size !== values.length) reject("invalid_request", `creation.${field}`);
    evidence[field] = values;
  }
  return deepFreeze(evidence);
}

function selectionRequest(value, design) {
  if (!isRecord(value) || Object.keys(value).some((key) => ![
    "mode", "expected_revision", "expected_selected_design_version_id", "expected_selected_design_hash",
  ].includes(key))) reject("invalid_request", "selection");
  if (value.mode !== "advance" && value.mode !== "branch" && value.mode !== "concept") reject("invalid_request", "selection.mode");
  if (value.mode === "advance") {
    if (!Number.isSafeInteger(value.expected_revision) || value.expected_revision < 0) reject("invalid_request", "selection.expected_revision");
    const id = value.expected_selected_design_version_id;
    const parentHash = value.expected_selected_design_hash;
    if (id === null) {
      if (parentHash !== null) reject("invalid_request", "selection.expected_selected_design_hash");
    } else {
      reference(id, "selection.expected_selected_design_version_id");
      hash(parentHash, "selection.expected_selected_design_hash");
    }
  } else if (value.mode === "branch") {
    if (design.parent_version_id === null) reject("invalid_request", "selection.mode");
    if (Object.hasOwn(value, "expected_revision") || Object.hasOwn(value, "expected_selected_design_version_id") ||
      Object.hasOwn(value, "expected_selected_design_hash")) reject("invalid_request", "selection");
  } else if (design.parent_version_id !== null || Object.keys(value).length !== 1) {
    reject("invalid_request", "selection");
  }
  if (value.mode === "advance" && design.parent_version_id !== value.expected_selected_design_version_id &&
    !(design.parent_version_id === null && value.expected_selected_design_version_id !== null)) {
    reject("stale_version", "design_version.parent_version_id");
  }
  return deepFreeze(snapshotJson(value));
}

function validateContextSnapshot(value, scope) {
  const fields = ["brief_snapshot", "brief_hash", "fact_hash", "permission_hash", "lock_hash", "source_identity_hash",
    "configuration_snapshot", "configuration_hash"];
  if (!hasOnlyKeys(value, fields) || Object.keys(value).length !== fields.length) reject("integrity_error", "version_context");
  let brief;
  try { brief = validateCreativeBrief(value.brief_snapshot, { trustedScope: scope }); }
  catch { reject("integrity_error", "version_context.brief_snapshot"); }
  const computed = {
    brief_hash: canonicalHash(brief),
    fact_hash: canonicalHash(brief.facts),
    permission_hash: canonicalHash(brief.permissions),
    lock_hash: canonicalHash(brief.locks),
    source_identity_hash: canonicalHash(brief.source_identity),
  };
  if (Object.entries(computed).some(([field, valueHash]) => value[field] !== valueHash)) {
    reject("integrity_error", "version_context.hashes");
  }
  if (value.configuration_snapshot === null) {
    if (value.configuration_hash !== null) reject("integrity_error", "version_context.configuration_hash");
  } else {
    if (!isRecord(value.configuration_snapshot) || canonicalHash(value.configuration_snapshot) !== value.configuration_hash) {
      reject("integrity_error", "version_context.configuration_hash");
    }
  }
  return brief;
}

function validateContextRecord(value, scope, field = "version_context") {
  try {
    return validateContextSnapshot(value, scope);
  } catch (error) {
    if (error instanceof VersionStoreError) throw error;
    reject("integrity_error", field);
  }
}

function validateCommitIntentRow(row, expectedScope) {
  try {
    if (!isRecord(row) || typeof row.intent_json !== "string" || typeof row.payload_hash !== "string" ||
      !HASH_PATTERN.test(row.payload_hash)) reject("integrity_error", "creation.intent");
    const intent = JSON.parse(row.intent_json);
    if (!isRecord(intent) || Object.keys(intent).some((key) => ![
      "storage_contract", "schema_version", "scope", "actor_id", "brief_id", "design_version", "artifact",
      "context", "evidence", "selection", "created_at", "job_result", "publication_fence",
    ].includes(key)) || canonicalSerialize(intent) !== row.intent_json ||
      intent.storage_contract !== "CreativeVersionCommitIntent" || intent.schema_version !== "1.0") {
      reject("integrity_error", "creation.intent");
    }
    const { created_at: createdAt, ...stableIntent } = intent;
    if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt)) ||
      new Date(createdAt).toISOString() !== createdAt || row.created_at !== createdAt ||
      canonicalHash(stableIntent) !== row.payload_hash) reject("integrity_error", "creation.intent");

    const scope = validScope({ tenant_id: row.tenant_id, project_id: row.project_id }, row.brief_id);
    if (expectedScope && (scope.tenant_id !== expectedScope.tenant_id ||
      scope.project_id !== expectedScope.project_id || scope.brief_id !== expectedScope.brief_id)) {
      reject("integrity_error", "creation.intent.scope");
    }
    const exactScope = { tenant_id: scope.tenant_id, project_id: scope.project_id, brief_id: scope.brief_id };
    if (!hasOnlyKeys(intent.scope, ["tenant_id", "project_id", "brief_id"]) ||
      canonicalSerialize(intent.scope) !== canonicalSerialize(exactScope) || intent.brief_id !== row.brief_id ||
      reference(row.action_id, "creation.action_id") !== intent.evidence?.creation?.action_id ||
      reference(row.actor_id, "creation.actor_id") !== intent.actor_id ||
      reference(row.job_id, "creation.job_id") !== intent.evidence?.creation?.job_id ||
      hash(row.request_hash, "creation.request_hash") !== intent.evidence?.creation?.request_hash) {
      reject("integrity_error", "creation.intent.identity");
    }

    const creation = attemptEvidence(intent.evidence?.creation);
    if (creation.action_id !== row.action_id || creation.actor_id !== row.actor_id ||
      creation.job_id !== row.job_id || creation.request_hash !== row.request_hash) {
      reject("integrity_error", "creation.intent.identity");
    }
    const expectedEvidence = {
      creation,
      usage_refs: creation.usage_refs ?? [],
      trace_refs: creation.trace_refs ?? [],
      attempt_identities: {
        ...(creation.logical_operation_id ? { logical_operation_id: creation.logical_operation_id } : {}),
        ...(creation.billable_attempt_id ? { billable_attempt_id: creation.billable_attempt_id } : {}),
        transport_attempt_ids: creation.transport_attempt_ids ?? [],
        provider_request_ids: creation.provider_request_ids ?? [],
      },
    };
    if (!isRecord(intent.evidence) || canonicalSerialize(intent.evidence) !== canonicalSerialize(expectedEvidence)) {
      reject("integrity_error", "creation.intent.evidence");
    }

    const brief = validateContextRecord(intent.context, exactScope, "creation.intent.context");
    if (!isRecord(intent.design_version)) reject("integrity_error", "creation.intent.design_version");
    const design = validateDesignVersion(intent.design_version, {
      trustedScope: { ...exactScope, design_version_id: intent.design_version.design_version_id },
      brief_hash: intent.context.brief_hash,
      known_source_refs: brief.source_identity.map((source) => source.source_id),
    });
    if (!hasOnlyKeys(intent.artifact, ["content_hash", "byte_length"]) ||
      intent.artifact.content_hash !== design.artifact.content_hash || !Number.isSafeInteger(intent.artifact.byte_length) ||
      intent.artifact.byte_length < 1 || intent.artifact.byte_length > MAX_ARTIFACT_BYTES) {
      reject("integrity_error", "creation.intent.artifact");
    }
    const selection = selectionRequest(intent.selection, design);
    if (canonicalSerialize(selection) !== canonicalSerialize(intent.selection)) reject("integrity_error", "creation.intent.selection");
    if (intent.job_result !== null && (!isRecord(intent.job_result) ||
      intent.job_result.design?.design_version_id !== design.design_version_id ||
      canonicalSerialize(intent.job_result.design) !== canonicalSerialize(design))) {
      reject("integrity_error", "creation.intent.job_result");
    }
    if (Object.hasOwn(intent, "publication_fence") && !isRecord(intent.publication_fence)) {
      reject("integrity_error", "creation.intent.publication_fence");
    }
    return intent;
  } catch (error) {
    if (error instanceof VersionStoreError && error.code === "integrity_error") throw error;
    reject("integrity_error", "creation.intent");
  }
}

function configurationSnapshot(value) {
  if (value === undefined) return null;
  if (!isRecord(value)) reject("invalid_request", "configuration_snapshot");
  return deepFreeze(snapshotJson(value));
}

function getDesignHashAt(db, scope, designVersionId) {
  if (designVersionId === null) return null;
  return db.prepare(`SELECT design_hash FROM design_versions
    WHERE tenant_id=? AND project_id=? AND brief_id=? AND design_version_id=?`)
    .get(scope.tenant_id, scope.project_id, scope.brief_id, designVersionId)?.design_hash ?? null;
}

export function creativeAssetRightsFenceCurrent(database, now, scope, rights) {
  try {
    if (!isRecord(rights) || Object.keys(rights).some((key) => key !== "proofs") ||
      !Array.isArray(rights.proofs) || rights.proofs.length > 64) return false;
    const checkedAt = now();
    if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) return false;
    const seen = new Set();
    for (const proof of rights.proofs) {
      if (!isRecord(proof) || Object.keys(proof).some((key) => ![
        "asset_id", "action", "source_ref", "content_hash", "package_id", "package_hash", "checked_at", "expires_at",
      ].includes(key))) return false;
      const assetId = reference(proof.asset_id, "inspection_rights.asset_id");
      if (!["reproduce", "modify", "publish", "display"].includes(proof.action)) return false;
      reference(proof.source_ref, "inspection_rights.source_ref");
      hash(proof.content_hash, "inspection_rights.content_hash");
      reference(proof.package_id, "inspection_rights.package_id");
      hash(proof.package_hash, "inspection_rights.package_hash");
      if (proof.checked_at !== undefined && (!Number.isSafeInteger(proof.checked_at) || proof.checked_at < 0 ||
        proof.checked_at > checkedAt)) return false;
      if (!Number.isSafeInteger(proof.expires_at) || proof.expires_at <= checkedAt) return false;
      const identity = `${assetId}\u0000${proof.action}\u0000${proof.content_hash}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      if (database.prepare(`SELECT 1 AS found FROM creative_invalidation_fences
        WHERE tenant_id=? AND project_id=? AND kind='asset' AND target_id=? AND target_hash=? LIMIT 1`)
        .get(scope.tenant_id, scope.project_id, assetId, proof.content_hash)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function creativeCompositionFenceCurrent(store, scope, fence, { afterPublication = false } = {}) {
  const allowed = ["composition_id", "action_id", "job_id", "target_revision_id", "target_revision_sha256",
    "expected_current_revision_id", "expected_current_revision_sha256"];
  if (!isRecord(fence) || Object.keys(fence).length !== allowed.length ||
      Object.keys(fence).some((key) => !allowed.includes(key))) return false;
  try {
    const composition_id = reference(fence.composition_id, "publication_fence.composition.composition_id");
    const action_id = reference(fence.action_id, "publication_fence.composition.action_id");
    const job_id = reference(fence.job_id, "publication_fence.composition.job_id");
    const target_revision_id = reference(fence.target_revision_id, "publication_fence.composition.target_revision_id");
    const target_revision_sha256 = hash(fence.target_revision_sha256, "publication_fence.composition.target_revision_sha256");
    const expected_current_revision_id = fence.expected_current_revision_id === null ? null
      : reference(fence.expected_current_revision_id, "publication_fence.composition.expected_current_revision_id");
    const expected_current_revision_sha256 = fence.expected_current_revision_sha256 === null ? null
      : hash(fence.expected_current_revision_sha256, "publication_fence.composition.expected_current_revision_sha256");
    if ((expected_current_revision_id === null) !== (expected_current_revision_sha256 === null)) return false;

    const actionRow = store.db.prepare(`SELECT * FROM creative_composition_actions_v1
      WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=?`)
      .get(scope.tenant_id, scope.project_id, scope.brief_id, action_id);
    if (!actionRow) return false;
    const action = compositionActionRowValue(store, scope, actionRow);
    const actionExpectedId = action.expected_current?.revision_id ?? null;
    const actionExpectedHash = action.expected_current?.revision_sha256 ?? null;
    if (action.job_id !== job_id || action.intent.composition_id !== composition_id ||
        action.intent.candidate_revision_id !== target_revision_id ||
        actionExpectedId !== expected_current_revision_id || actionExpectedHash !== expected_current_revision_sha256 ||
        !action.revision || action.revision.revision_id !== target_revision_id ||
        action.revision.revision_sha256 !== target_revision_sha256 ||
        action.revision.composition_id !== composition_id) return false;

    const current = store.db.prepare(`SELECT * FROM creative_composition_current_v1
      WHERE tenant_id=? AND project_id=? AND brief_id=? AND composition_id=?`)
      .get(scope.tenant_id, scope.project_id, scope.brief_id, composition_id);
    const requiredId = afterPublication ? target_revision_id : expected_current_revision_id;
    const requiredHash = afterPublication ? target_revision_sha256 : expected_current_revision_sha256;
    if ((current?.revision_id ?? null) !== requiredId || (current?.revision_sha256 ?? null) !== requiredHash) return false;
    if (afterPublication ? action.status !== "published" : action.status !== "staged") return false;

    if (expected_current_revision_id !== null) {
      const expectedRow = store.db.prepare(`SELECT * FROM creative_composition_revisions_v1
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND composition_id=? AND revision_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, composition_id, expected_current_revision_id);
      const expected = compositionRevisionFromRow(store, scope, expectedRow);
      if (expected.revision.revision_sha256 !== expected_current_revision_sha256 ||
          action.operation !== "composition.revalidate" &&
            !compositionRevisionIsCurrent(store, scope, expected.revision, afterPublication ? undefined : current)) return false;
    }
    if (afterPublication) {
      const targetRow = store.db.prepare(`SELECT * FROM creative_composition_revisions_v1
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND composition_id=? AND revision_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, composition_id, target_revision_id);
      const target = compositionRevisionFromRow(store, scope, targetRow);
      if (target.revision.revision_sha256 !== target_revision_sha256 ||
          !compositionRevisionIsCurrent(store, scope, target.revision, current)) return false;
    } else if (!compositionRevisionIsCurrent(store, scope, action.revision)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function publicationFenceCurrent(store, scope, fence, { requireRecordedRepair = false, afterPublication = false } = {}) {
  const allowed = ["brief_id", "brief_hash", "design_version_id", "design_hash",
    "expected_current_design_version_id", "expected_current_design_hash", "inspection_repair", "inspection_rights", "composition"];
  if (!isRecord(fence) || Object.keys(fence).some((key) => !allowed.includes(key)) ||
    fence.brief_id !== scope.brief_id || typeof fence.brief_hash !== "string") return false;
  try {
    const brief = store.getBrief({ scope, brief_id: scope.brief_id });
    if (!brief || canonicalHash(brief) !== fence.brief_hash) return false;
    if (!store.isBriefUsable({ scope, brief_id: scope.brief_id, brief_hash: fence.brief_hash })) return false;
    if (fence.design_version_id !== undefined) {
      const design = store.getDesignVersion({ scope, brief_id: scope.brief_id,
        design_version_id: reference(fence.design_version_id, "publication_fence.design_version_id") });
      if (!design || design.design_hash !== fence.design_hash) return false;
    }
    if (!afterPublication && Object.hasOwn(fence, "expected_current_design_version_id")) {
      const selection = store.getSelection({ scope, brief_id: scope.brief_id });
      if ((selection?.design_version_id ?? null) !== fence.expected_current_design_version_id ||
        (selection?.design_hash ?? null) !== fence.expected_current_design_hash) return false;
    }
    if (Object.hasOwn(fence, "inspection_repair")) {
      const proof = fence.inspection_repair;
      if (!isRecord(proof) || Object.keys(proof).some((key) => ![
        "inspection_id", "action_id", "request_hash", "claim_ref", "root_brief_hash", "root_design_hash",
        "root_design_version_id", "started_at_ms", "deadline_at_ms", "simulated_units_milli", "result_hash",
      ].includes(key)) || proof.root_design_version_id !== undefined && typeof proof.root_design_version_id !== "string" ||
        !inspectionRepairFenceCurrent(store.db, store.now, { ...scope,
          design_version_id: proof.root_design_version_id }, proof, { requireRecorded: requireRecordedRepair })) return false;
    }
    if (Object.hasOwn(fence, "inspection_rights") &&
      !creativeAssetRightsFenceCurrent(store.db, store.now, scope, fence.inspection_rights)) return false;
    if (Object.hasOwn(fence, "composition") &&
      !creativeCompositionFenceCurrent(store, scope, fence.composition, { afterPublication })) return false;
    return true;
  } catch {
    return false;
  }
}

function comparableRecoveryFence(fence) {
  if (!isRecord(fence)) return null;
  const comparable = snapshotJson(fence);
  if (isRecord(comparable.inspection_repair)) {
    delete comparable.inspection_repair.result_hash;
  }
  if (isRecord(comparable.inspection_rights) && Array.isArray(comparable.inspection_rights.proofs)) {
    comparable.inspection_rights.proofs = comparable.inspection_rights.proofs.map((proof) => {
      if (!isRecord(proof)) return proof;
      const { checked_at: _checkedAt, expires_at: _expiresAt, ...identity } = proof;
      return identity;
    });
  }
  return canonicalSerialize(comparable);
}

function recoveryRepairResultHash(intent) {
  const repair = intent.job_result?.inspection_repair;
  if (repair === undefined) return null;
  const creation = intent.evidence.creation;
  const telemetry = intent.job_result.telemetry_evidence;
  if (!isRecord(repair) || !isRecord(telemetry) ||
    repair.repair_action !== "image.edit" || repair.inspection_id === undefined ||
    typeof repair.inspection_action_id !== "string" || typeof repair.source_report_hash !== "string" ||
    repair.output_design_version_id !== intent.design_version.design_version_id ||
    repair.output_design_hash !== intent.design_version.design_hash ||
    repair.billable_attempt_id !== creation.billable_attempt_id ||
    intent.evidence.creation.action_id === repair.inspection_id) {
    reject("integrity_error", "creation.intent.job_result.inspection_repair");
  }
  return canonicalHash({ design_hash: intent.design_version.design_hash,
    billable_attempt_id: creation.billable_attempt_id, telemetry_evidence: telemetry });
}

function assertRepairSourceRecord(store, scope, intent) {
  const repair = intent.job_result?.inspection_repair;
  if (repair === undefined) return;
  let session;
  try {
    session = store.db.prepare(`SELECT status,result_json,result_hash,brief_id,brief_hash,design_version_id,
      design_hash,root_design_version_id,root_design_hash FROM creative_inspection_sessions_v1
      WHERE tenant_id=? AND project_id=? AND action_id=?`)
      .get(scope.tenant_id, scope.project_id, repair.inspection_action_id);
  } catch { reject("integrity_error", "creation.intent.inspection_session"); }
  let result;
  try {
    if (!session || session.status !== "completed" || typeof session.result_json !== "string" ||
      canonicalHash(JSON.parse(session.result_json)) !== session.result_hash) {
      reject("integrity_error", "creation.intent.inspection_session");
    }
    result = JSON.parse(session.result_json);
  } catch { reject("integrity_error", "creation.intent.inspection_session"); }
  if (session.brief_id !== scope.brief_id || session.brief_hash !== intent.context.brief_hash ||
    session.root_design_version_id !== repair.root_design_version_id ||
    session.root_design_hash !== repair.root_design_hash ||
    result.inspection_id !== repair.inspection_id || !isRecord(result.report) ||
    canonicalHash(result.report) !== repair.source_report_hash) {
    reject("integrity_error", "creation.intent.inspection_session");
  }
  const rootDesign = store.getDesignVersion({ scope, brief_id: scope.brief_id,
    design_version_id: repair.root_design_version_id });
  if (!rootDesign || rootDesign.design_hash !== repair.root_design_hash) {
    reject("integrity_error", "creation.intent.inspection_session");
  }
}

function assertRecoveryFenceMatchesIntent(store, fence, scope, intent, { allowMissingRepairResultHash = false } = {}) {
  if (!isRecord(fence) || fence.brief_id !== scope.brief_id ||
    fence.brief_hash !== intent.context.brief_hash || !isRecord(fence.inspection_rights) ||
    !Array.isArray(fence.inspection_rights.proofs)) reject("integrity_error", "creation.intent.publication_fence");
  const selection = intent.selection;
  if (selection.mode === "advance") {
    if (fence.expected_current_design_version_id !== selection.expected_selected_design_version_id ||
      fence.expected_current_design_hash !== selection.expected_selected_design_hash) {
      reject("integrity_error", "creation.intent.publication_fence");
    }
  } else if (Object.hasOwn(fence, "expected_current_design_version_id") ||
    Object.hasOwn(fence, "expected_current_design_hash")) {
    reject("integrity_error", "creation.intent.publication_fence");
  }
  if (fence.design_version_id !== undefined &&
    (fence.design_version_id !== intent.design_version.parent_version_id ||
      fence.design_hash !== intent.evidence.creation.parent_design_hash)) {
    reject("integrity_error", "creation.intent.publication_fence");
  }
  if (intent.design_version.parent_version_id !== null &&
    (fence.design_version_id !== intent.design_version.parent_version_id ||
      fence.design_hash !== intent.evidence.creation.parent_design_hash)) {
    reject("integrity_error", "creation.intent.publication_fence");
  }
  if (intent.job_result?.inspection_repair !== undefined) {
    const proof = fence.inspection_repair;
    const repair = intent.job_result.inspection_repair;
    const creation = intent.evidence.creation;
    const resultHash = recoveryRepairResultHash(intent);
    if (!isRecord(proof) || !isRecord(repair) ||
      proof.inspection_id !== repair.inspection_id || proof.action_id !== creation.action_id ||
      proof.request_hash !== creation.request_hash || proof.claim_ref !== repair.claim_ref ||
      proof.root_design_version_id !== repair.root_design_version_id ||
      proof.root_design_hash !== repair.root_design_hash ||
      repair.repair_action !== "image.edit" ||
      repair.output_design_version_id !== intent.design_version.design_version_id ||
      repair.output_design_hash !== intent.design_version.design_hash ||
      repair.billable_attempt_id !== creation.billable_attempt_id ||
      (allowMissingRepairResultHash
        ? proof.result_hash !== undefined && proof.result_hash !== resultHash
        : proof.result_hash !== resultHash)) {
      reject("integrity_error", "creation.intent.publication_fence");
    }
    assertRepairSourceRecord(store, scope, intent);
  } else if (Object.hasOwn(fence, "inspection_repair") ||
    intent.job_result?.inspection_repair !== undefined) {
    reject("integrity_error", "creation.intent.publication_fence");
  }
  return fence;
}

function recoveryPublicationFence(store, scope, job, intent) {
  const creation = intent.evidence.creation;
  const repairResultHash = recoveryRepairResultHash(intent);
  if (typeof job.attempt_evidence_json !== "string" ||
    job.attempt_evidence_json !== canonicalSerialize(creation) ||
    typeof creation.billable_attempt_id !== "string" || !Array.isArray(creation.transport_attempt_ids) ||
    creation.transport_attempt_ids.length === 0 || new Set(creation.transport_attempt_ids).size !== creation.transport_attempt_ids.length) {
    reject("integrity_error", "creation.intent.evidence");
  }
  const dispatchRows = store.db.prepare(`SELECT transport_attempt_id,billable_attempt_id,context_fence_json
    FROM creative_dispatch_intents WHERE tenant_id=? AND project_id=? AND job_id=?
    ORDER BY transport_attempt_id`).all(scope.tenant_id, scope.project_id, job.job_id);
  const expectedTransportIds = new Set(creation.transport_attempt_ids);
  if (dispatchRows.length !== expectedTransportIds.size ||
    dispatchRows.some((row) => !expectedTransportIds.has(row.transport_attempt_id) ||
      row.billable_attempt_id !== creation.billable_attempt_id)) {
    reject("integrity_error", "creation.intent.dispatch_identity");
  }
  let dispatchFence;
  for (const row of dispatchRows) {
    let parsed;
    try { parsed = JSON.parse(row.context_fence_json); } catch { reject("integrity_error", "creation.intent.dispatch_fence"); }
    if (!isRecord(parsed) || canonicalSerialize(parsed) !== row.context_fence_json ||
      Object.hasOwn(parsed.inspection_repair ?? {}, "result_hash")) {
      reject("integrity_error", "creation.intent.dispatch_fence");
    }
    if (dispatchFence === undefined) dispatchFence = parsed;
    else if (comparableRecoveryFence(dispatchFence) !== comparableRecoveryFence(parsed)) {
      reject("integrity_error", "creation.intent.dispatch_fence");
    }
  }
  assertRecoveryFenceMatchesIntent(store, dispatchFence, scope, intent, { allowMissingRepairResultHash: true });
  const reconstructed = repairResultHash === null ? dispatchFence : {
    ...dispatchFence,
    inspection_repair: { ...dispatchFence.inspection_repair, result_hash: repairResultHash },
  };
  if (Object.hasOwn(intent, "publication_fence")) {
    const persisted = assertRecoveryFenceMatchesIntent(store, intent.publication_fence, scope, intent);
    if (comparableRecoveryFence(dispatchFence) !== comparableRecoveryFence(persisted)) {
      reject("integrity_error", "creation.intent.publication_fence");
    }
    return persisted;
  }
  // Existing intents predate the publication_fence field. Their complete authority
  // is reconstructed only from the canonical, job-bound dispatch intents above.
  return reconstructed;
}

function rowScope(row, scope) {
  return row && row.tenant_id === scope.tenant_id && row.project_id === scope.project_id && row.brief_id === scope.brief_id;
}

function injectFault(faultInjector, point) {
  if (faultInjector === undefined) return;
  if (typeof faultInjector !== "function") reject("invalid_request", "fault_injector");
  try {
    const result = faultInjector(point);
    if (result && typeof result.then === "function") reject("invalid_request", "fault_injector");
  } catch (error) {
    if (error instanceof VersionStoreError) throw error;
    reject("unavailable", "fault_injector");
  }
}

function readStoredObjectSync(objectRoot, contentHash) {
  const digest = contentHash.slice(7);
  const path = resolve(objectRoot, "objects", "sha256", digest.slice(0, 2), digest);
  try {
    if (!lstatSync(path).isFile()) return null;
    const bytes = readFileSync(path);
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) return null;
    if (hashArtifactBytes(bytes) !== contentHash) return null;
    return bytes;
  } catch {
    return null;
  }
}

const PRIVATE_ATTRIBUTION_TRIGGERS = Object.freeze({
  private_provider_attributions: `
    CREATE TRIGGER private_provider_attributions_no_update
      BEFORE UPDATE ON private_provider_attributions BEGIN SELECT RAISE(ABORT,'private provider attribution is immutable'); END;
    CREATE TRIGGER private_provider_attributions_no_delete
      BEFORE DELETE ON private_provider_attributions BEGIN SELECT RAISE(ABORT,'private provider attribution is immutable'); END;`,
  private_provider_usage_attributions: `
    CREATE TRIGGER private_provider_usage_attributions_no_update
      BEFORE UPDATE ON private_provider_usage_attributions BEGIN SELECT RAISE(ABORT,'private provider usage attribution is immutable'); END;
    CREATE TRIGGER private_provider_usage_attributions_no_delete
      BEFORE DELETE ON private_provider_usage_attributions BEGIN SELECT RAISE(ABORT,'private provider usage attribution is immutable'); END;`,
});

/**
 * Databases created before the OpenRouter route was added constrain private attribution rows to
 * provider_name='openai'. Rebuild only those tables, in one transaction, with the explicit native
 * image provider allowlist. The rows, keys, foreign keys and immutability triggers are preserved and
 * the rebuild is idempotent, so user_version is unchanged.
 */
const OPENAI_USAGE_DETAIL_KEYS = Object.freeze({
  input_tokens_details: Object.freeze(["text_tokens", "image_tokens"]),
  output_tokens_details: Object.freeze(["text_tokens", "image_tokens"]),
});
// OpenRouter's documented prompt/completion token details, normalized under the same input/output names.
const OPENROUTER_USAGE_DETAIL_KEYS = Object.freeze({
  input_tokens_details: Object.freeze(["audio_tokens", "cache_write_tokens", "cached_tokens", "file_tokens", "video_tokens"]),
  output_tokens_details: Object.freeze(["audio_tokens", "image_tokens", "reasoning_tokens"]),
});
const OPENROUTER_COST_DETAIL_KEYS = Object.freeze([
  "upstream_inference_cost", "upstream_inference_prompt_cost", "upstream_inference_completions_cost"]);
const USAGE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/;

/** Returns the first token-detail key that uses undocumented or invalid counters, else undefined. */
function invalidUsageDetail(usage, provider) {
  const allowed = provider === "openrouter" ? OPENROUTER_USAGE_DETAIL_KEYS : OPENAI_USAGE_DETAIL_KEYS;
  for (const key of ["input_tokens_details", "output_tokens_details"]) {
    if (usage[key] === undefined) continue;
    if (!isRecord(usage[key]) || Object.keys(usage[key]).some((name) => !allowed[key].includes(name)) ||
        Object.values(usage[key]).some((count) => !Number.isSafeInteger(count) || count < 0)) return key;
  }
  return undefined;
}

/** Validates the OpenRouter-only cost fields of an already key-allowlisted usage record. Returns the first bad field. */
function invalidOpenRouterUsageField(usage) {
  if (usage.cost !== undefined && (!isRecord(usage.cost) || Object.keys(usage.cost).length !== 3 ||
      typeof usage.cost.amount !== "string" || !USAGE_DECIMAL.test(usage.cost.amount) || usage.cost.currency !== "USD" ||
      usage.cost.provenance !== "provider_reported_unsettled")) return "cost";
  if (usage.cost_details !== undefined && (!isRecord(usage.cost_details) ||
      Object.entries(usage.cost_details).some(([name, amount]) => !OPENROUTER_COST_DETAIL_KEYS.includes(name) ||
        typeof amount !== "string" || !USAGE_DECIMAL.test(amount)))) return "cost_details";
  if (usage.is_byok !== undefined && typeof usage.is_byok !== "boolean") return "is_byok";
  return undefined;
}

const PRIVATE_MIGRATION_DIAGNOSTICS = new WeakMap();

/** Internal accessor for tests and operators: a sanitized SQLite cause (no SQL text, paths, or values). */
export function readPrivateStoreMigrationDiagnostic(error) {
  return error !== null && typeof error === "object" ? PRIVATE_MIGRATION_DIAGNOSTICS.get(error) : undefined;
}

/**
 * Only SQLITE_BUSY (base code 5, including extended codes such as BUSY_RECOVERY or BUSY_SNAPSHOT) is retryable
 * contention: another connection holds the write lock and the busy timeout elapsed. SQLITE_LOCKED (6) is a conflict
 * inside one connection or shared cache, which a retry of the same open cannot fix, so it stays a migration failure.
 * Detection: node:sqlite's SQLite errors carry the numeric extended result code as `errcode` (and `errstr`); the base
 * code is `errcode & 0xff`. An error without an integer `errcode` is never treated as contention.
 */
export function isSqliteBusy(cause) {
  return Number.isInteger(cause?.errcode) && (cause.errcode & 0xff) === 5;
}

/** Map a raw failure during schema migration to the public store error (returned, not thrown). */
export function mapStoreMigrationFailure(cause) {
  try {
    if (isSqliteBusy(cause)) reject("unavailable", "storage_version", true);
    reject("migration_failed", "storage_version");
  } catch (error) {
    return error;
  }
}

/** Runs only inside makeSchema's single BEGIN IMMEDIATE transaction, which also owns rollback and close. */
export function widenPrivateAttributionProviderChecks(db) {
  if (!db.isTransaction) throw new Error("The provider CHECK widening must run inside the schema transaction.");
  const legacy = "CHECK(provider_name='openai')";
  const widened = "CHECK(provider_name IN ('openai','openrouter'))";
  const staleTables = () => db.prepare(`SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN
    ('private_provider_attributions','private_provider_usage_attributions') ORDER BY name`).all()
    .filter((table) => typeof table.sql === "string" && table.sql.includes(legacy));
  try {
    for (const { name, sql } of staleTables()) {
      db.exec(`ALTER TABLE ${name} RENAME TO ${name}_widen_old`);
      db.exec(sql.replace(legacy, widened));
      db.exec(`INSERT INTO ${name} SELECT * FROM ${name}_widen_old`);
      db.exec(`DROP TABLE ${name}_widen_old`);
      db.exec(PRIVATE_ATTRIBUTION_TRIGGERS[name]);
    }
  } catch (cause) {
    // The caller's transaction rolls back and closes the connection. Keep a sanitized private cause for operators.
    const error = mapStoreMigrationFailure(cause);
    PRIVATE_MIGRATION_DIAGNOSTICS.set(error, Object.freeze({
      sqlite_errcode: Number.isInteger(cause?.errcode) ? cause.errcode : undefined,
      sqlite_errstr: typeof cause?.errstr === "string" ? cause.errstr.slice(0, 120) : undefined,
      error_name: typeof cause?.name === "string" ? cause.name.slice(0, 64) : undefined,
    }));
    throw error;
  }
}

function makeSchema(db) {
  try {
    // The busy timeout applies to every statement after it, including this first read; the catch below closes the
    // connection whichever step fails.
    db.exec("PRAGMA busy_timeout=5000;");
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, STORAGE_VERSION].includes(version)) reject("unsupported_version", "storage_version");
    // All supported upgrades share one write transaction. A failed final schema
    // check must leave even the oldest supported producer at its original DDL,
    // rows, objects, and user_version.
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=OFF; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;");
    db.exec(`
    CREATE TABLE IF NOT EXISTS creative_briefs (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      brief_hash TEXT NOT NULL,
      brief_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id, project_id, brief_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS creative_brief_actions (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      brief_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id, project_id, action_id)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS creative_brief_actions_no_update
      BEFORE UPDATE ON creative_brief_actions BEGIN SELECT RAISE(ABORT,'brief actions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS creative_brief_actions_no_delete
      BEFORE DELETE ON creative_brief_actions BEGIN SELECT RAISE(ABORT,'brief actions are immutable'); END;
    CREATE TABLE IF NOT EXISTS creative_invalidation_actions (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation='brief.invalidate'),
      request_hash TEXT NOT NULL,
      event_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','completed')),
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id,project_id,action_id),
      CHECK((status='pending' AND result_json IS NULL) OR (status='completed' AND result_json IS NOT NULL))
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS creative_invalidation_actions_transition
      BEFORE UPDATE ON creative_invalidation_actions
      WHEN OLD.status!='pending' OR NEW.status!='completed' OR
        NEW.tenant_id!=OLD.tenant_id OR NEW.project_id!=OLD.project_id OR NEW.action_id!=OLD.action_id OR
        NEW.actor_id!=OLD.actor_id OR NEW.operation!=OLD.operation OR NEW.request_hash!=OLD.request_hash OR
        NEW.event_id!=OLD.event_id OR NEW.created_at!=OLD.created_at
      BEGIN SELECT RAISE(ABORT,'invalidation action identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS creative_invalidation_actions_no_delete
      BEFORE DELETE ON creative_invalidation_actions BEGIN SELECT RAISE(ABORT,'invalidation actions are immutable'); END;
    CREATE TABLE IF NOT EXISTS creative_jobs (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      brief_id TEXT,
      actor_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','running','completed','cancelled','failed')),
      lease_hash TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      attempt_evidence_json TEXT,
      result_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id, project_id, job_id),
      UNIQUE(tenant_id, project_id, action_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS creative_concept_batches_v1 (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','partial','completed','unknown_hold','cancelled')),
      batch_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id,project_id,brief_id,action_id),
      UNIQUE(tenant_id,project_id,brief_id,batch_id),
      UNIQUE(tenant_id,project_id,job_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS creative_concept_events_v1 (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK(sequence > 0),
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_hash TEXT NOT NULL,
      event_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id,project_id,brief_id,action_id,sequence),
      UNIQUE(tenant_id,project_id,brief_id,event_id),
      FOREIGN KEY(tenant_id,project_id,brief_id,action_id)
        REFERENCES creative_concept_batches_v1(tenant_id,project_id,brief_id,action_id)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS creative_concept_events_no_update
      BEFORE UPDATE ON creative_concept_events_v1 BEGIN SELECT RAISE(ABORT,'concept events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS creative_concept_events_no_delete
      BEFORE DELETE ON creative_concept_events_v1 BEGIN SELECT RAISE(ABORT,'concept events are immutable'); END;
    CREATE TABLE IF NOT EXISTS creative_concept_response_stages_v1 (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      concept_id TEXT NOT NULL,
      billable_attempt_id TEXT NOT NULL,
      transport_attempt_id TEXT NOT NULL,
      reservation_ref TEXT NOT NULL,
      dispatch_intent_ref TEXT NOT NULL,
      target_binding_sha256 TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      media_type TEXT NOT NULL,
      width INTEGER NOT NULL CHECK(width > 0),
      height INTEGER NOT NULL CHECK(height > 0),
      byte_length INTEGER NOT NULL CHECK(byte_length > 0),
      response_bytes BLOB NOT NULL,
      stage_ref TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('response_received','published','rejected','unknown_hold')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id,project_id,brief_id,action_id,concept_id),
      UNIQUE(tenant_id,project_id,brief_id,billable_attempt_id),
      UNIQUE(tenant_id,project_id,brief_id,transport_attempt_id),
      FOREIGN KEY(tenant_id,project_id,brief_id,action_id)
        REFERENCES creative_concept_batches_v1(tenant_id,project_id,brief_id,action_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS creative_concept_dispatch_bindings_v1 (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      billable_attempt_id TEXT NOT NULL,
      transport_attempt_id TEXT NOT NULL,
      reservation_ref TEXT NOT NULL,
      dispatch_intent_ref TEXT NOT NULL,
      target_binding_sha256 TEXT NOT NULL,
      target_binding_json TEXT NOT NULL,
      rendered_prompt_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id,project_id,brief_id,action_id,transport_attempt_id),
      UNIQUE(tenant_id,project_id,dispatch_intent_ref),
      FOREIGN KEY(tenant_id,project_id,brief_id,action_id)
        REFERENCES creative_concept_batches_v1(tenant_id,project_id,brief_id,action_id),
      FOREIGN KEY(tenant_id,project_id,job_id,transport_attempt_id)
        REFERENCES creative_dispatch_intents(tenant_id,project_id,job_id,transport_attempt_id)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS creative_concept_dispatch_bindings_no_update
      BEFORE UPDATE ON creative_concept_dispatch_bindings_v1 BEGIN SELECT RAISE(ABORT,'concept dispatch bindings are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS creative_concept_dispatch_bindings_no_delete
      BEFORE DELETE ON creative_concept_dispatch_bindings_v1 BEGIN SELECT RAISE(ABORT,'concept dispatch bindings are immutable'); END;
    CREATE TABLE IF NOT EXISTS creative_concept_versions_v1 (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      concept_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK(ordinal > 0),
      design_version_id TEXT NOT NULL,
      design_hash TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      artifact_hash TEXT NOT NULL,
      media_type TEXT NOT NULL,
      parent_version_id TEXT CHECK(parent_version_id IS NULL),
      lineage_json TEXT NOT NULL,
      design_version_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id,project_id,brief_id,action_id,concept_id),
      UNIQUE(tenant_id,project_id,brief_id,design_version_id),
      UNIQUE(tenant_id,project_id,brief_id,ordinal,action_id),
      FOREIGN KEY(tenant_id,project_id,brief_id,action_id)
        REFERENCES creative_concept_batches_v1(tenant_id,project_id,brief_id,action_id)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS creative_concept_versions_no_update
      BEFORE UPDATE ON creative_concept_versions_v1 BEGIN SELECT RAISE(ABORT,'concept versions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS creative_concept_versions_no_delete
      BEFORE DELETE ON creative_concept_versions_v1 BEGIN SELECT RAISE(ABORT,'concept versions are immutable'); END;
    CREATE TABLE IF NOT EXISTS creative_dispatch_intents (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      transport_attempt_id TEXT NOT NULL,
      billable_attempt_id TEXT,
      reservation_ref TEXT,
      provider_name TEXT,
      provider_model TEXT,
      dispatch_intent_ref TEXT NOT NULL,
      context_fence_json TEXT NOT NULL,
      target_binding_sha256 TEXT,
      target_binding_json TEXT,
      rendered_prompt_sha256 TEXT,
      authorized_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id, project_id, job_id, transport_attempt_id),
      UNIQUE(tenant_id, project_id, dispatch_intent_ref),
      FOREIGN KEY(tenant_id, project_id, job_id)
        REFERENCES creative_jobs(tenant_id, project_id, job_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS private_provider_attributions (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('generate','edit','concepts.create')),
      provider_name TEXT NOT NULL CHECK(provider_name IN ('openai','openrouter')),
      provider_model TEXT NOT NULL,
      reservation_ref TEXT NOT NULL,
      billable_attempt_id TEXT NOT NULL,
      transport_attempt_id TEXT NOT NULL,
      dispatch_intent_ref TEXT NOT NULL,
      provider_request_id TEXT NOT NULL,
      provider_request_ref TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id,project_id,job_id,transport_attempt_id),
      UNIQUE(tenant_id,project_id,dispatch_intent_ref),
      FOREIGN KEY(tenant_id,project_id,job_id,transport_attempt_id)
        REFERENCES creative_dispatch_intents(tenant_id,project_id,job_id,transport_attempt_id)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS private_provider_attributions_no_update
      BEFORE UPDATE ON private_provider_attributions BEGIN SELECT RAISE(ABORT,'private provider attribution is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS private_provider_attributions_no_delete
      BEFORE DELETE ON private_provider_attributions BEGIN SELECT RAISE(ABORT,'private provider attribution is immutable'); END;
    CREATE TABLE IF NOT EXISTS private_provider_usage_attributions (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('generate','edit','concepts.create')),
      provider_name TEXT NOT NULL CHECK(provider_name IN ('openai','openrouter')),
      provider_model TEXT NOT NULL,
      reservation_ref TEXT NOT NULL,
      billable_attempt_id TEXT NOT NULL,
      transport_attempt_id TEXT NOT NULL,
      dispatch_intent_ref TEXT NOT NULL,
      target_binding_sha256 TEXT NOT NULL,
      usage_sha256 TEXT NOT NULL,
      usage_json TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id,project_id,job_id,transport_attempt_id),
      UNIQUE(tenant_id,project_id,dispatch_intent_ref),
      FOREIGN KEY(tenant_id,project_id,job_id,transport_attempt_id)
        REFERENCES creative_dispatch_intents(tenant_id,project_id,job_id,transport_attempt_id)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS private_provider_usage_attributions_no_update
      BEFORE UPDATE ON private_provider_usage_attributions BEGIN SELECT RAISE(ABORT,'private provider usage attribution is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS private_provider_usage_attributions_no_delete
      BEFORE DELETE ON private_provider_usage_attributions BEGIN SELECT RAISE(ABORT,'private provider usage attribution is immutable'); END;
    CREATE TABLE IF NOT EXISTS private_provider_attribution_pending (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      pending_ref TEXT NOT NULL,
      job_id TEXT NOT NULL,
      transport_attempt_id TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id,project_id,pending_ref),
      UNIQUE(tenant_id,project_id,job_id,transport_attempt_id,payload_sha256),
      FOREIGN KEY(tenant_id,project_id,job_id,transport_attempt_id)
        REFERENCES creative_dispatch_intents(tenant_id,project_id,job_id,transport_attempt_id)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS private_provider_attribution_pending_no_update
      BEFORE UPDATE ON private_provider_attribution_pending BEGIN SELECT RAISE(ABORT,'pending provider attribution is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS private_provider_attribution_pending_no_delete
      BEFORE DELETE ON private_provider_attribution_pending BEGIN SELECT RAISE(ABORT,'pending provider attribution is immutable'); END;
    CREATE TABLE IF NOT EXISTS private_provider_attribution_reconciliations (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      pending_ref TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      reconciled_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id,project_id,pending_ref),
      FOREIGN KEY(tenant_id,project_id,pending_ref)
        REFERENCES private_provider_attribution_pending(tenant_id,project_id,pending_ref)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS private_provider_attribution_reconciliations_no_update
      BEFORE UPDATE ON private_provider_attribution_reconciliations BEGIN SELECT RAISE(ABORT,'provider attribution reconciliation is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS private_provider_attribution_reconciliations_no_delete
      BEFORE DELETE ON private_provider_attribution_reconciliations BEGIN SELECT RAISE(ABORT,'provider attribution reconciliation is immutable'); END;
    CREATE TABLE IF NOT EXISTS creative_cancel_requests (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      target_action_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      job_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id, project_id, action_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS creation_actions (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('commit_intent','committed','conflict','cancelled','unknown')),
      intent_json TEXT NOT NULL,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id, project_id, action_id),
      UNIQUE(tenant_id, project_id, job_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS design_versions (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      design_version_id TEXT NOT NULL,
      parent_version_id TEXT,
      parent_design_hash TEXT,
      brief_hash TEXT NOT NULL,
      design_hash TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      media_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      creation_job_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id, project_id, brief_id, design_version_id),
      UNIQUE(tenant_id, project_id, brief_id, action_id),
      FOREIGN KEY(tenant_id, project_id, brief_id, parent_version_id)
        REFERENCES design_versions(tenant_id, project_id, brief_id, design_version_id),
      FOREIGN KEY(tenant_id, project_id, creation_job_id)
        REFERENCES creation_actions(tenant_id, project_id, job_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS version_evidence (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      design_version_id TEXT NOT NULL,
      context_json TEXT NOT NULL,
      context_hash TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      PRIMARY KEY(tenant_id, project_id, brief_id, design_version_id),
      FOREIGN KEY(tenant_id, project_id, brief_id, design_version_id)
        REFERENCES design_versions(tenant_id, project_id, brief_id, design_version_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS version_selections (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      design_version_id TEXT NOT NULL,
      design_hash TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id, project_id, brief_id),
      FOREIGN KEY(tenant_id, project_id, brief_id, design_version_id)
        REFERENCES design_versions(tenant_id, project_id, brief_id, design_version_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS creative_inspection_sessions_v1 (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      brief_id TEXT NOT NULL,
      brief_hash TEXT NOT NULL,
      design_version_id TEXT NOT NULL,
      design_hash TEXT NOT NULL,
      parent_version_id TEXT,
      parent_design_hash TEXT,
      artifact_id TEXT NOT NULL,
      artifact_hash TEXT NOT NULL,
      root_design_version_id TEXT NOT NULL,
      root_design_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','completed','failed','unknown')),
      result_json TEXT,
      result_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id,project_id,action_id),
      UNIQUE(tenant_id,project_id,job_id),
      FOREIGN KEY(tenant_id,project_id,job_id) REFERENCES creative_jobs(tenant_id,project_id,job_id),
      CHECK((status='completed' AND result_json IS NOT NULL AND result_hash IS NOT NULL) OR
        (status!='completed' AND result_json IS NULL AND result_hash IS NULL))
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS creative_inspection_session_identity_immutable
      BEFORE UPDATE ON creative_inspection_sessions_v1
      WHEN NEW.tenant_id!=OLD.tenant_id OR NEW.project_id!=OLD.project_id OR NEW.action_id!=OLD.action_id OR
        NEW.actor_id!=OLD.actor_id OR NEW.job_id!=OLD.job_id OR NEW.request_hash!=OLD.request_hash OR
        NEW.brief_id!=OLD.brief_id OR NEW.brief_hash!=OLD.brief_hash OR
        NEW.design_version_id!=OLD.design_version_id OR NEW.design_hash!=OLD.design_hash OR
        NEW.parent_version_id IS NOT OLD.parent_version_id OR NEW.parent_design_hash IS NOT OLD.parent_design_hash OR
        NEW.artifact_id!=OLD.artifact_id OR NEW.artifact_hash!=OLD.artifact_hash OR
        NEW.root_design_version_id!=OLD.root_design_version_id OR NEW.root_design_hash!=OLD.root_design_hash OR
        NEW.created_at!=OLD.created_at
      BEGIN SELECT RAISE(ABORT,'inspection session identity is immutable'); END;
    CREATE TABLE IF NOT EXISTS creative_inspection_stages_v1 (
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      stage TEXT NOT NULL CHECK(stage IN ('observer','decision_evidence','decision_route')),
      attempt_id TEXT NOT NULL,
      intent_json TEXT NOT NULL,
      intent_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('dispatching','completed','unknown')),
      result_json TEXT,
      result_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(tenant_id,project_id,action_id,stage),
      FOREIGN KEY(tenant_id,project_id,action_id)
        REFERENCES creative_inspection_sessions_v1(tenant_id,project_id,action_id),
      CHECK((status='completed' AND result_json IS NOT NULL AND result_hash IS NOT NULL) OR
        (status!='completed' AND result_json IS NULL AND result_hash IS NULL))
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS creative_inspection_stage_identity_immutable
      BEFORE UPDATE ON creative_inspection_stages_v1
      WHEN NEW.tenant_id!=OLD.tenant_id OR NEW.project_id!=OLD.project_id OR NEW.action_id!=OLD.action_id OR
        NEW.stage!=OLD.stage OR NEW.attempt_id!=OLD.attempt_id OR NEW.intent_json!=OLD.intent_json OR
        NEW.intent_hash!=OLD.intent_hash OR NEW.created_at!=OLD.created_at
      BEGIN SELECT RAISE(ABORT,'inspection stage identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS creative_inspection_stages_no_delete
      BEFORE DELETE ON creative_inspection_stages_v1 BEGIN SELECT RAISE(ABORT,'inspection stages are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_design_versions_update
      BEFORE UPDATE ON design_versions BEGIN SELECT RAISE(ABORT,'immutable version'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_design_versions_delete
      BEFORE DELETE ON design_versions BEGIN SELECT RAISE(ABORT,'immutable version'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_version_evidence_update
      BEFORE UPDATE ON version_evidence BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_version_evidence_delete
      BEFORE DELETE ON version_evidence BEGIN SELECT RAISE(ABORT,'immutable evidence'); END;
    `);
  const jobColumns = db.prepare("PRAGMA table_info(creative_jobs)").all();
  if (!jobColumns.some((column) => column.name === "attempt_evidence_json")) {
    db.exec("ALTER TABLE creative_jobs ADD COLUMN attempt_evidence_json TEXT");
  }
  const dispatchColumns = db.prepare("PRAGMA table_info(creative_dispatch_intents)").all();
  for (const [name, type] of [["reservation_ref", "TEXT"], ["provider_name", "TEXT"], ["provider_model", "TEXT"],
    ["target_binding_sha256", "TEXT"], ["target_binding_json", "TEXT"], ["rendered_prompt_sha256", "TEXT"]]) {
    if (!dispatchColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE creative_dispatch_intents ADD COLUMN ${name} ${type}`);
    }
  }
  const conceptBindingColumns = db.prepare("PRAGMA table_info(creative_concept_dispatch_bindings_v1)").all();
  for (const [name, type] of [["target_binding_json", "TEXT"], ["rendered_prompt_sha256", "TEXT"]]) {
    if (!conceptBindingColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE creative_concept_dispatch_bindings_v1 ADD COLUMN ${name} ${type}`);
    }
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS creative_dispatch_target_binding_once
    BEFORE UPDATE ON creative_dispatch_intents
    WHEN NEW.tenant_id!=OLD.tenant_id OR NEW.project_id!=OLD.project_id OR NEW.job_id!=OLD.job_id OR
      NEW.transport_attempt_id!=OLD.transport_attempt_id OR NEW.billable_attempt_id IS NOT OLD.billable_attempt_id OR
      NEW.reservation_ref IS NOT OLD.reservation_ref OR NEW.provider_name IS NOT OLD.provider_name OR
      NEW.provider_model IS NOT OLD.provider_model OR NEW.dispatch_intent_ref!=OLD.dispatch_intent_ref OR
      NEW.context_fence_json!=OLD.context_fence_json OR NEW.authorized_at!=OLD.authorized_at OR
      OLD.target_binding_sha256 IS NOT NULL OR OLD.target_binding_json IS NOT NULL OR OLD.rendered_prompt_sha256 IS NOT NULL OR
      NEW.target_binding_sha256 IS NULL OR NEW.target_binding_json IS NULL OR NEW.rendered_prompt_sha256 IS NULL
    BEGIN SELECT RAISE(ABORT,'dispatch target binding is immutable'); END;`);
  if (version > 0 && version < 10) {
    try {
      db.exec(`CREATE TABLE private_provider_attributions_v10 (
        tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, job_id TEXT NOT NULL, action_id TEXT NOT NULL,
        actor_id TEXT NOT NULL, request_hash TEXT NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('generate','edit','concepts.create')),
        provider_name TEXT NOT NULL CHECK(provider_name IN ('openai','openrouter')), provider_model TEXT NOT NULL,
        reservation_ref TEXT NOT NULL, billable_attempt_id TEXT NOT NULL, transport_attempt_id TEXT NOT NULL,
        dispatch_intent_ref TEXT NOT NULL, provider_request_id TEXT NOT NULL, provider_request_ref TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id,project_id,job_id,transport_attempt_id),
        UNIQUE(tenant_id,project_id,dispatch_intent_ref),
        FOREIGN KEY(tenant_id,project_id,job_id,transport_attempt_id)
          REFERENCES creative_dispatch_intents(tenant_id,project_id,job_id,transport_attempt_id)
      ) STRICT;
      INSERT INTO private_provider_attributions_v10 SELECT tenant_id,project_id,job_id,action_id,actor_id,request_hash,
        operation,provider_name,provider_model,reservation_ref,billable_attempt_id,transport_attempt_id,
        dispatch_intent_ref,provider_request_id,provider_request_ref,captured_at FROM private_provider_attributions;
      DROP TABLE private_provider_attributions;
      ALTER TABLE private_provider_attributions_v10 RENAME TO private_provider_attributions;
      CREATE TRIGGER private_provider_attributions_no_update
        BEFORE UPDATE ON private_provider_attributions BEGIN SELECT RAISE(ABORT,'private provider attribution is immutable'); END;
      CREATE TRIGGER private_provider_attributions_no_delete
        BEFORE DELETE ON private_provider_attributions BEGIN SELECT RAISE(ABORT,'private provider attribution is immutable'); END;

      CREATE TABLE private_provider_usage_attributions_v10 (
        tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, job_id TEXT NOT NULL, action_id TEXT NOT NULL,
        actor_id TEXT NOT NULL, request_hash TEXT NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('generate','edit','concepts.create')),
        provider_name TEXT NOT NULL CHECK(provider_name IN ('openai','openrouter')), provider_model TEXT NOT NULL,
        reservation_ref TEXT NOT NULL, billable_attempt_id TEXT NOT NULL, transport_attempt_id TEXT NOT NULL,
        dispatch_intent_ref TEXT NOT NULL, target_binding_sha256 TEXT NOT NULL, usage_sha256 TEXT NOT NULL,
        usage_json TEXT NOT NULL, captured_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id,project_id,job_id,transport_attempt_id),
        UNIQUE(tenant_id,project_id,dispatch_intent_ref),
        FOREIGN KEY(tenant_id,project_id,job_id,transport_attempt_id)
          REFERENCES creative_dispatch_intents(tenant_id,project_id,job_id,transport_attempt_id)
      ) STRICT;
      INSERT INTO private_provider_usage_attributions_v10 SELECT tenant_id,project_id,job_id,action_id,actor_id,request_hash,
        operation,provider_name,provider_model,reservation_ref,billable_attempt_id,transport_attempt_id,
        dispatch_intent_ref,target_binding_sha256,usage_sha256,usage_json,captured_at FROM private_provider_usage_attributions;
      DROP TABLE private_provider_usage_attributions;
      ALTER TABLE private_provider_usage_attributions_v10 RENAME TO private_provider_usage_attributions;
      CREATE TRIGGER private_provider_usage_attributions_no_update
        BEFORE UPDATE ON private_provider_usage_attributions BEGIN SELECT RAISE(ABORT,'private provider usage attribution is immutable'); END;
      CREATE TRIGGER private_provider_usage_attributions_no_delete
        BEFORE DELETE ON private_provider_usage_attributions BEGIN SELECT RAISE(ABORT,'private provider usage attribution is immutable'); END;
      PRAGMA user_version=10;
      `);
    } catch (error) {
      throw error;
    }
  }
  // Schema 11, 12, and 13 form one migration unit. If a final composition
  // invariant fails, a genuine schema-10 database must remain at schema 10
  // rather than being left at an intermediate committed version.
  if (version < 11) {
    try {
      db.exec(`CREATE TABLE creative_composition_revisions_v1 (
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        brief_id TEXT NOT NULL,
        composition_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        parent_revision_id TEXT,
        design_version_id TEXT NOT NULL,
        design_hash TEXT NOT NULL,
        revision_sha256 TEXT NOT NULL,
        state_sha256 TEXT NOT NULL,
        preview_sha256 TEXT NOT NULL,
        preview_byte_length INTEGER NOT NULL CHECK(preview_byte_length > 0),
        preview_bytes BLOB NOT NULL,
        revision_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id,project_id,brief_id,composition_id,revision_id),
        UNIQUE(tenant_id,project_id,brief_id,composition_id,revision_sha256),
        FOREIGN KEY(tenant_id,project_id,brief_id,design_version_id)
          REFERENCES design_versions(tenant_id,project_id,brief_id,design_version_id),
        FOREIGN KEY(tenant_id,project_id,brief_id,composition_id,parent_revision_id)
          REFERENCES creative_composition_revisions_v1(tenant_id,project_id,brief_id,composition_id,revision_id)
      ) STRICT;
      CREATE TRIGGER creative_composition_revisions_no_update
        BEFORE UPDATE ON creative_composition_revisions_v1 BEGIN SELECT RAISE(ABORT,'composition revisions are immutable'); END;
      CREATE TRIGGER creative_composition_revisions_no_delete
        BEFORE DELETE ON creative_composition_revisions_v1 BEGIN SELECT RAISE(ABORT,'composition revisions are immutable'); END;
      CREATE TABLE creative_composition_current_v1 (
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        brief_id TEXT NOT NULL,
        composition_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        revision_sha256 TEXT NOT NULL,
        design_version_id TEXT NOT NULL,
        design_hash TEXT NOT NULL,
        selection_revision INTEGER NOT NULL CHECK(selection_revision > 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id,project_id,brief_id,composition_id),
        FOREIGN KEY(tenant_id,project_id,brief_id,composition_id,revision_id)
          REFERENCES creative_composition_revisions_v1(tenant_id,project_id,brief_id,composition_id,revision_id),
        FOREIGN KEY(tenant_id,project_id,brief_id,design_version_id)
          REFERENCES design_versions(tenant_id,project_id,brief_id,design_version_id)
      ) STRICT;
      CREATE TRIGGER creative_composition_current_identity_immutable
        BEFORE UPDATE ON creative_composition_current_v1
        WHEN NEW.tenant_id!=OLD.tenant_id OR NEW.project_id!=OLD.project_id OR NEW.brief_id!=OLD.brief_id OR
          NEW.composition_id!=OLD.composition_id
        BEGIN SELECT RAISE(ABORT,'composition current identity is immutable'); END;
      CREATE TABLE creative_composition_actions_v1 (
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        brief_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('composition.create','composition.update')),
        request_hash TEXT NOT NULL,
        intent_hash TEXT NOT NULL,
        intent_json TEXT NOT NULL,
        expected_current_revision_id TEXT,
        expected_current_revision_sha256 TEXT,
        expected_design_version_id TEXT NOT NULL,
        expected_design_hash TEXT NOT NULL,
        expected_selection_revision INTEGER NOT NULL CHECK(expected_selection_revision > 0),
        candidate_revision_json TEXT,
        preview_sha256 TEXT,
        preview_bytes BLOB,
        status TEXT NOT NULL CHECK(status IN ('pending','staged','published','stale','cancelled','unknown','abandoned')),
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id,project_id,brief_id,action_id),
        UNIQUE(tenant_id,project_id,job_id),
        FOREIGN KEY(tenant_id,project_id,job_id)
          REFERENCES creative_jobs(tenant_id,project_id,job_id),
        CHECK((status IN ('pending','staged') AND result_json IS NULL) OR
          (status IN ('published','stale','cancelled','unknown','abandoned') AND result_json IS NOT NULL)),
        CHECK((status IN ('pending','abandoned','cancelled','unknown') AND candidate_revision_json IS NULL AND preview_sha256 IS NULL AND preview_bytes IS NULL) OR
          (status IN ('staged','published','stale','cancelled','unknown') AND candidate_revision_json IS NOT NULL AND
            preview_sha256 IS NOT NULL AND preview_bytes IS NOT NULL))
      ) STRICT;
      CREATE TRIGGER creative_composition_actions_identity_immutable
        BEFORE UPDATE ON creative_composition_actions_v1
        WHEN NEW.tenant_id!=OLD.tenant_id OR NEW.project_id!=OLD.project_id OR NEW.brief_id!=OLD.brief_id OR
          NEW.action_id!=OLD.action_id OR NEW.job_id!=OLD.job_id OR NEW.actor_id!=OLD.actor_id OR
          NEW.operation!=OLD.operation OR NEW.request_hash!=OLD.request_hash OR NEW.intent_hash!=OLD.intent_hash OR
          NEW.intent_json!=OLD.intent_json OR NEW.expected_current_revision_id IS NOT OLD.expected_current_revision_id OR
          NEW.expected_current_revision_sha256 IS NOT OLD.expected_current_revision_sha256 OR
          NEW.expected_design_version_id!=OLD.expected_design_version_id OR NEW.expected_design_hash!=OLD.expected_design_hash OR
          NEW.expected_selection_revision!=OLD.expected_selection_revision OR NEW.created_at!=OLD.created_at
        BEGIN SELECT RAISE(ABORT,'composition action identity is immutable'); END;
      CREATE TRIGGER creative_composition_actions_stage_once
        BEFORE UPDATE ON creative_composition_actions_v1
        WHEN OLD.status!='pending' AND (NEW.candidate_revision_json IS NOT OLD.candidate_revision_json OR
          NEW.preview_sha256 IS NOT OLD.preview_sha256 OR NEW.preview_bytes IS NOT OLD.preview_bytes)
        BEGIN SELECT RAISE(ABORT,'composition preview stage is immutable'); END;
      CREATE TRIGGER creative_composition_actions_transition
        BEFORE UPDATE ON creative_composition_actions_v1
        WHEN NOT ((OLD.status='pending' AND NEW.status='staged' AND NEW.result_json IS NULL) OR
          (OLD.status='pending' AND NEW.status IN ('abandoned','cancelled','unknown') AND NEW.result_json IS NOT NULL) OR
          (OLD.status='staged' AND NEW.status IN ('published','stale','cancelled','unknown') AND NEW.result_json IS NOT NULL))
        BEGIN SELECT RAISE(ABORT,'invalid composition action transition'); END;
      CREATE TRIGGER creative_composition_actions_no_delete
        BEFORE DELETE ON creative_composition_actions_v1 BEGIN SELECT RAISE(ABORT,'composition actions are immutable'); END;
      CREATE TABLE creative_composition_action_leases_v1 (
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        brief_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        lease_hash TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id,project_id,brief_id,action_id,lease_hash),
        FOREIGN KEY(tenant_id,project_id,brief_id,action_id)
          REFERENCES creative_composition_actions_v1(tenant_id,project_id,brief_id,action_id)
      ) STRICT;
      CREATE TRIGGER creative_composition_action_leases_no_update
        BEFORE UPDATE ON creative_composition_action_leases_v1 BEGIN SELECT RAISE(ABORT,'composition action leases are immutable'); END;
      CREATE TRIGGER creative_composition_action_leases_no_delete
        BEFORE DELETE ON creative_composition_action_leases_v1 BEGIN SELECT RAISE(ABORT,'composition action leases are immutable'); END;
      CREATE TRIGGER creative_composition_current_no_delete
        BEFORE DELETE ON creative_composition_current_v1 BEGIN SELECT RAISE(ABORT,'composition current pointer cannot be deleted'); END;
      PRAGMA user_version=11;`);
    } catch (error) {
      throw error;
    }
  }
  if (version < 12) {
    try {
      const duplicate = db.prepare(`SELECT tenant_id,project_id,brief_id,design_version_id
        FROM creative_composition_current_v1 GROUP BY tenant_id,project_id,brief_id,design_version_id
        HAVING count(*) > 1 LIMIT 1`).get();
      if (duplicate) reject("integrity_error", "composition.current_design_identity");
      db.exec(`CREATE UNIQUE INDEX creative_composition_one_current_per_design_v1
        ON creative_composition_current_v1(tenant_id,project_id,brief_id,design_version_id);
        PRAGMA user_version=12;`);
    } catch (error) {
      throw error;
    }
  }
  if (version < 13) {
    // API 1.3 adds a separate stale-proof revalidation action. Rebuild both
    // related tables so their closed operation CHECK and foreign key agree;
    // copy every row byte-for-byte and recreate all immutability/transition
    // triggers before re-enabling foreign-key enforcement.
    try {
      db.exec(`DROP TRIGGER IF EXISTS creative_composition_actions_identity_immutable;
        DROP TRIGGER IF EXISTS creative_composition_actions_stage_once;
        DROP TRIGGER IF EXISTS creative_composition_actions_transition;
        DROP TRIGGER IF EXISTS creative_composition_actions_no_delete;
        DROP TRIGGER IF EXISTS creative_composition_action_leases_no_update;
        DROP TRIGGER IF EXISTS creative_composition_action_leases_no_delete;
        ALTER TABLE creative_composition_action_leases_v1 RENAME TO creative_composition_action_leases_v12;
        ALTER TABLE creative_composition_actions_v1 RENAME TO creative_composition_actions_v12;
        CREATE TABLE creative_composition_actions_v1 (
          tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, brief_id TEXT NOT NULL, action_id TEXT NOT NULL,
          job_id TEXT NOT NULL, actor_id TEXT NOT NULL,
          operation TEXT NOT NULL CHECK(operation IN ('composition.create','composition.update','composition.revalidate')),
          request_hash TEXT NOT NULL, intent_hash TEXT NOT NULL, intent_json TEXT NOT NULL,
          expected_current_revision_id TEXT, expected_current_revision_sha256 TEXT,
          expected_design_version_id TEXT NOT NULL, expected_design_hash TEXT NOT NULL,
          expected_selection_revision INTEGER NOT NULL CHECK(expected_selection_revision > 0),
          candidate_revision_json TEXT, preview_sha256 TEXT, preview_bytes BLOB,
          status TEXT NOT NULL CHECK(status IN ('pending','staged','published','stale','cancelled','unknown','abandoned')),
          result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY(tenant_id,project_id,brief_id,action_id), UNIQUE(tenant_id,project_id,job_id),
          FOREIGN KEY(tenant_id,project_id,job_id) REFERENCES creative_jobs(tenant_id,project_id,job_id),
          CHECK((status IN ('pending','staged') AND result_json IS NULL) OR
            (status IN ('published','stale','cancelled','unknown','abandoned') AND result_json IS NOT NULL)),
          CHECK((status IN ('pending','abandoned','cancelled','unknown') AND candidate_revision_json IS NULL AND
            preview_sha256 IS NULL AND preview_bytes IS NULL) OR
            (status IN ('staged','published','stale','cancelled','unknown') AND candidate_revision_json IS NOT NULL AND
            preview_sha256 IS NOT NULL AND preview_bytes IS NOT NULL))
        ) STRICT;
        INSERT INTO creative_composition_actions_v1 SELECT * FROM creative_composition_actions_v12;
        CREATE TABLE creative_composition_action_leases_v1 (
          tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, brief_id TEXT NOT NULL, action_id TEXT NOT NULL,
          lease_hash TEXT NOT NULL, observed_at TEXT NOT NULL,
          PRIMARY KEY(tenant_id,project_id,brief_id,action_id,lease_hash),
          FOREIGN KEY(tenant_id,project_id,brief_id,action_id)
            REFERENCES creative_composition_actions_v1(tenant_id,project_id,brief_id,action_id)
        ) STRICT;
        INSERT INTO creative_composition_action_leases_v1 SELECT * FROM creative_composition_action_leases_v12;
        DROP TABLE creative_composition_action_leases_v12;
        DROP TABLE creative_composition_actions_v12;
        CREATE TRIGGER creative_composition_actions_identity_immutable
          BEFORE UPDATE ON creative_composition_actions_v1
          WHEN NEW.tenant_id!=OLD.tenant_id OR NEW.project_id!=OLD.project_id OR NEW.brief_id!=OLD.brief_id OR
            NEW.action_id!=OLD.action_id OR NEW.job_id!=OLD.job_id OR NEW.actor_id!=OLD.actor_id OR
            NEW.operation!=OLD.operation OR NEW.request_hash!=OLD.request_hash OR NEW.intent_hash!=OLD.intent_hash OR
            NEW.intent_json!=OLD.intent_json OR NEW.expected_current_revision_id IS NOT OLD.expected_current_revision_id OR
            NEW.expected_current_revision_sha256 IS NOT OLD.expected_current_revision_sha256 OR
            NEW.expected_design_version_id!=OLD.expected_design_version_id OR NEW.expected_design_hash!=OLD.expected_design_hash OR
            NEW.expected_selection_revision!=OLD.expected_selection_revision OR NEW.created_at!=OLD.created_at
          BEGIN SELECT RAISE(ABORT,'composition action identity is immutable'); END;
        CREATE TRIGGER creative_composition_actions_stage_once
          BEFORE UPDATE ON creative_composition_actions_v1
          WHEN OLD.status!='pending' AND (NEW.candidate_revision_json IS NOT OLD.candidate_revision_json OR
            NEW.preview_sha256 IS NOT OLD.preview_sha256 OR NEW.preview_bytes IS NOT OLD.preview_bytes)
          BEGIN SELECT RAISE(ABORT,'composition preview stage is immutable'); END;
        CREATE TRIGGER creative_composition_actions_transition
          BEFORE UPDATE ON creative_composition_actions_v1
          WHEN NOT ((OLD.status='pending' AND NEW.status='staged' AND NEW.result_json IS NULL) OR
            (OLD.status='pending' AND NEW.status IN ('abandoned','cancelled','unknown') AND NEW.result_json IS NOT NULL) OR
            (OLD.status='staged' AND NEW.status IN ('published','stale','cancelled','unknown') AND NEW.result_json IS NOT NULL))
          BEGIN SELECT RAISE(ABORT,'invalid composition action transition'); END;
        CREATE TRIGGER creative_composition_actions_no_delete BEFORE DELETE ON creative_composition_actions_v1
          BEGIN SELECT RAISE(ABORT,'composition actions are immutable'); END;
        CREATE TRIGGER creative_composition_action_leases_no_update BEFORE UPDATE ON creative_composition_action_leases_v1
          BEGIN SELECT RAISE(ABORT,'composition action leases are immutable'); END;
        CREATE TRIGGER creative_composition_action_leases_no_delete BEFORE DELETE ON creative_composition_action_leases_v1
          BEGIN SELECT RAISE(ABORT,'composition action leases are immutable'); END;
        PRAGMA user_version=13;`);
      // The OpenRouter allowlist change is part of this schema transaction. If
      // rebuilding either private attribution table fails, the composition
      // schema and every old row remain at the original version as well.
      widenPrivateAttributionProviderChecks(db);
      const violation = db.prepare("PRAGMA foreign_key_check").get();
      if (violation) reject("integrity_error", "composition.action_foreign_key");
      const actionCheck = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='creative_composition_actions_v1'").get();
      const leaseCheck = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='creative_composition_action_leases_v1'").get();
      if (!actionCheck?.sql?.includes("composition.revalidate") || !leaseCheck?.sql?.includes("FOREIGN KEY")) {
        reject("integrity_error", "composition.action_schema");
      }
    } catch (error) {
      throw error;
    }
  }
  // Schema-13 databases may still have the earlier private provider CHECK.
  // Upgrade that additive constraint atomically for already-current stores.
  widenPrivateAttributionProviderChecks(db);
  db.exec(`PRAGMA user_version=${STORAGE_VERSION};`);
  const violation = db.prepare("PRAGMA foreign_key_check").get();
  if (violation) reject("integrity_error", "storage.foreign_key");
    db.exec("COMMIT; PRAGMA foreign_keys=ON;");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    try { db.exec("PRAGMA foreign_keys=ON;"); } catch { /* Preserve the original migration failure. */ }
    db.close();
    if (error instanceof VersionStoreError) throw error;
    // The first BEGIN IMMEDIATE sits inside this try, so a busy timeout closes the connection and is retryable.
    throw mapStoreMigrationFailure(error);
  }
}

function freezeReturned(value) {
  return deepFreeze(snapshotJson(value, "integrity_error", "stored_record"));
}

function compositionRevisionFromRow(store, scope, row) {
  if (!row || !(row.preview_bytes instanceof Uint8Array)) reject("integrity_error", "composition.storage_record");
  const previewBytes = Uint8Array.from(row.preview_bytes);
  let raw;
  let revision;
  try {
    raw = JSON.parse(row.revision_json);
    revision = validateCompositionRevision(raw, { trustedScope: scope, previewBytes, allowExpired: true });
  } catch (error) {
    if (error instanceof VersionStoreError) throw error;
    reject("integrity_error", "composition.revision");
  }
  if (canonicalSerialize(revision) !== row.revision_json || revision.composition_id !== row.composition_id ||
      revision.revision_id !== row.revision_id || revision.revision_sha256 !== row.revision_sha256 ||
      revision.state_sha256 !== row.state_sha256 || revision.preview.preview_sha256 !== row.preview_sha256 ||
      revision.preview.byte_length !== row.preview_byte_length || revision.dependencies.design_version_id !== row.design_version_id ||
      revision.dependencies.design_version_sha256 !== row.design_hash || previewBytes.byteLength !== row.preview_byte_length ||
      compositionPreviewHash(previewBytes) !== row.preview_sha256) {
    reject("integrity_error", "composition.revision");
  }
  return Object.freeze({ revision, preview_bytes: previewBytes });
}

function compositionRevisionIsCurrent(store, scope, revision, currentRow = undefined) {
  const now = store.now();
  const dependencies = revision.dependencies;
  if (!Number.isSafeInteger(now) || revision.preview.checked_at > now || revision.preview.expires_at <= now ||
      dependencies.authority_proof.checked_at > now || dependencies.authority_proof.expires_at <= now ||
      dependencies.edit_policy.checked_at > now || dependencies.edit_policy.expires_at <= now ||
      !store.isBriefUsable({ scope, brief_id: scope.brief_id, brief_hash: dependencies.brief_hash })) return false;
  const brief = store.getBrief({ scope, brief_id: scope.brief_id });
  if (!brief || canonicalHash(brief) !== dependencies.brief_hash ||
      brief.research_package_ref.package_id !== dependencies.package_id ||
      brief.research_package_ref.content_hash !== dependencies.package_sha256) return false;
  const selection = store.getSelection({ scope, brief_id: scope.brief_id });
  if (!selection || selection.design_version_id !== dependencies.design_version_id ||
      selection.design_hash !== dependencies.design_version_sha256 || selection.revision !== dependencies.selection_revision) return false;
  const design = store.getDesignVersion({ scope, brief_id: scope.brief_id,
    design_version_id: dependencies.design_version_id });
  if (!design || design.design_hash !== dependencies.design_version_sha256 ||
      design.artifact.content_hash !== dependencies.artwork_sha256 ||
      design.parent_version_id !== dependencies.parent_version_id) return false;
  if (design.parent_version_id === null) {
    if (dependencies.parent_design_hash !== null) return false;
  } else {
    const parent = store.getDesignVersion({ scope, brief_id: scope.brief_id,
      design_version_id: design.parent_version_id });
    if (!parent || parent.design_hash !== dependencies.parent_design_hash) return false;
  }
  if (revision.artwork.artifact_id !== design.artifact.artifact_id || revision.artwork.sha256 !== design.artifact.content_hash.slice(7) ||
      revision.artwork.mime_type !== design.artifact.media_type ||
      design.artifact.width_px !== undefined && revision.artwork.width_px !== design.artifact.width_px ||
      design.artifact.height_px !== undefined && revision.artwork.height_px !== design.artifact.height_px) return false;
  for (const proof of dependencies.asset_rights) {
    if (proof.checked_at > now || proof.expires_at <= now || proof.package_id !== dependencies.package_id ||
        proof.package_hash !== dependencies.package_sha256 || store.isAssetFenced({ scope,
          asset_id: proof.asset_id, content_hash: proof.content_hash })) return false;
  }
  if (currentRow && (currentRow.revision_id !== revision.revision_id ||
      currentRow.revision_sha256 !== revision.revision_sha256 ||
      currentRow.design_version_id !== dependencies.design_version_id ||
      currentRow.design_hash !== dependencies.design_version_sha256 ||
      currentRow.selection_revision !== dependencies.selection_revision)) return false;
  return true;
}

function compositionExpectedCurrent(value, field = "expected_current") {
  if (value === null) return null;
  if (!isRecord(value) || Object.keys(value).length !== 2 ||
      Object.keys(value).some((key) => !["revision_id", "revision_sha256"].includes(key))) {
    reject("invalid_request", field);
  }
  return Object.freeze({ revision_id: reference(value.revision_id, `${field}.revision_id`),
    revision_sha256: hash(value.revision_sha256, `${field}.revision_sha256`) });
}

function compositionActionRowValue(store, scope, row) {
  if (!row || !rowScope(row, scope)) reject("integrity_error", "composition.action");
  let intent;
  let result = null;
  try {
    intent = snapshotCompositionJson(JSON.parse(row.intent_json));
    const intentKeys = ["contract", "schema_version", "operation", "composition_id", "candidate_revision_id",
      "source_revision_id", "source_revision_sha256", "plan"];
    const isLegacyIntent = intent?.schema_version === "1.0" &&
      ["composition.create", "composition.update"].includes(intent.operation);
    const isRevalidationIntent = intent?.schema_version === "1.1" && intent.operation === "composition.revalidate";
    if (!isRecord(intent) || Object.keys(intent).length !== intentKeys.length ||
        intentKeys.some((key) => !Object.hasOwn(intent, key)) ||
        intent.contract !== "CreativeCompositionActionIntent" || (!isLegacyIntent && !isRevalidationIntent) ||
        intent.operation !== row.operation || intent.source_revision_id !== row.expected_current_revision_id ||
        intent.source_revision_sha256 !== row.expected_current_revision_sha256 ||
        intent.candidate_revision_id === row.expected_current_revision_id ||
        (intent.operation === "composition.create" && (intent.source_revision_id !== null ||
          intent.source_revision_sha256 !== null || intent.plan !== null)) ||
        (intent.operation === "composition.update" && !isRecord(intent.plan)) ||
        (intent.operation === "composition.revalidate" && intent.plan !== null) ||
        canonicalSerialize(intent) !== row.intent_json || canonicalHash(intent) !== row.intent_hash) {
      reject("integrity_error", "composition.action.intent");
    }
    if (row.result_json !== null) {
      result = snapshotCompositionJson(JSON.parse(row.result_json));
      if (canonicalSerialize(result) !== row.result_json) reject("integrity_error", "composition.action.result");
    }
  } catch (error) {
    if (error instanceof VersionStoreError) throw error;
    reject("integrity_error", "composition.action");
  }
  let revision = null;
  let preview_bytes = null;
  const hasCandidate = row.candidate_revision_json !== null || row.preview_sha256 !== null || row.preview_bytes !== null;
  if (hasCandidate) {
    if (typeof row.candidate_revision_json !== "string" || typeof row.preview_sha256 !== "string" ||
        !(row.preview_bytes instanceof Uint8Array)) reject("integrity_error", "composition.action.stage");
    preview_bytes = Uint8Array.from(row.preview_bytes);
    try {
      const raw = JSON.parse(row.candidate_revision_json);
      revision = validateCompositionRevision(raw, { trustedScope: scope, previewBytes: preview_bytes, allowExpired: true });
      if (canonicalSerialize(revision) !== row.candidate_revision_json || revision.composition_id !== intent.composition_id ||
          revision.revision_id !== intent.candidate_revision_id ||
          revision.parent_revision_id !== row.expected_current_revision_id ||
          revision.parent_revision_sha256 !== row.expected_current_revision_sha256 ||
          revision.dependencies.design_version_id !== row.expected_design_version_id ||
          revision.dependencies.design_version_sha256 !== row.expected_design_hash ||
          revision.dependencies.selection_revision !== row.expected_selection_revision ||
          revision.preview.preview_sha256 !== row.preview_sha256 ||
          compositionPreviewHash(preview_bytes) !== row.preview_sha256) {
        reject("integrity_error", "composition.action.stage");
      }
    } catch (error) {
      if (error instanceof VersionStoreError) throw error;
      reject("integrity_error", "composition.action.stage");
    }
  }
  return Object.freeze({ status: row.status, scope, actor_id: row.actor_id, job_id: row.job_id,
    action_id: row.action_id, operation: row.operation, request_hash: row.request_hash, intent: deepFreeze(intent),
    expected_current: row.expected_current_revision_id === null ? null : Object.freeze({
      revision_id: row.expected_current_revision_id, revision_sha256: row.expected_current_revision_sha256,
    }), expected_design_version_id: row.expected_design_version_id, expected_design_hash: row.expected_design_hash,
    expected_selection_revision: row.expected_selection_revision, revision, preview_bytes,
    result: result === null ? null : deepFreeze(result), created_at: row.created_at, updated_at: row.updated_at });
}

/** Durable local version metadata, artifact objects, selection CAS, and commit-intent recovery. */
export class CreativeVersionStore {
  constructor({ databasePath, objectRoot, now = () => Date.now(), maxArtifactBytes = MAX_ARTIFACT_BYTES } = {}) {
    if (typeof databasePath !== "string" || databasePath.length === 0 || typeof objectRoot !== "string" || objectRoot.length === 0) {
      reject("invalid_request", "store_paths");
    }
    this.databasePath = databasePath === ":memory:" ? databasePath : resolve(databasePath);
    this.objectRoot = resolve(objectRoot);
    this.now = now;
    this.maxArtifactBytes = maxArtifactBytes;
    if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 1 || maxArtifactBytes > MAX_ARTIFACT_BYTES) {
      reject("invalid_request", "max_artifact_bytes");
    }
    if (this.databasePath !== ":memory:") mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 });
    mkdirSync(this.objectRoot, { recursive: true, mode: 0o700 });
    try {
      this.db = new DatabaseSync(this.databasePath);
      makeSchema(this.db);
      initializeCreativeBriefDatabase(this.db);
    } catch (error) {
      if (error instanceof VersionStoreError) throw error;
      reject("unavailable", "database", true);
    }
    this.closed = false;
    publicationTransactionRegistries.set(this, new WeakMap());
  }

  close() {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  assertOpen() {
    if (this.closed) reject("unavailable", "database");
  }

  assertNoBorrowedTransaction(field) {
    // These methods own their complete BEGIN IMMEDIATE transaction. A SAVEPOINT
    // would still borrow and later roll back the caller's surrounding transaction.
    if (this.db.isTransaction) reject("unavailable", field, true);
  }

  timestamp() {
    const value = this.now();
    if (!Number.isFinite(value)) reject("unavailable", "clock");
    return new Date(value).toISOString();
  }

  planningStore(scope) {
    this.assertOpen();
    return createCreativeBriefStore({ database: this.db, trustedScope: scope });
  }

  #assertBriefNotInvalidated(scope, brief) {
    const packageRef = brief.research_package_ref;
    const store = this.planningStore(scope);
    if (store.isPackageFenced(scope.tenant_id, scope.project_id, packageRef.package_id, packageRef.content_hash)) {
      reject("stale_version", "brief.source_package_ref");
    }
    for (const fact of [...(brief.facts?.verified ?? []), ...(brief.facts?.unresolved ?? [])]) {
      if (store.isFactFenced(scope.tenant_id, scope.project_id, packageRef.package_id, packageRef.content_hash, fact.fact_id)) {
        reject("stale_version", "brief.facts");
      }
    }
  }

  isBriefUsable({ scope: inputScope, brief_id, brief_hash = undefined }) {
    this.assertOpen();
    const scope = validScope(inputScope, brief_id);
    const brief = this.getBrief({ scope, brief_id: scope.brief_id });
    if (!brief || (brief_hash !== undefined && canonicalHash(brief) !== brief_hash)) return false;
    try {
      this.#assertBriefNotInvalidated(scope, brief);
      return true;
    } catch (error) {
      if (error instanceof VersionStoreError && error.code === "stale_version") return false;
      throw error;
    }
  }

  isAssetFenced({ scope: inputScope, asset_id, content_hash }) {
    this.assertOpen();
    const scope = validScope(inputScope, inputScope?.brief_id ?? "asset-check");
    return this.planningStore(scope).isAssetFenced(scope.tenant_id, scope.project_id, asset_id, content_hash);
  }

  getBriefVersionByHash({ scope: inputScope, brief_id, brief_hash }) {
    this.assertOpen();
    const scope = validScope(inputScope, brief_id);
    hash(brief_hash, "brief_hash");
    const version = this.planningStore(scope).getBriefHistory(scope.brief_id)
      .find((item) => item.brief_hash === brief_hash);
    return version ? freezeReturned(version.brief) : null;
  }

  getBrief({ scope: inputScope, brief_id }) {
    this.assertOpen();
    const scope = validScope(inputScope, brief_id);
    const row = this.db.prepare(`SELECT brief_hash,brief_json FROM creative_briefs
      WHERE tenant_id=? AND project_id=? AND brief_id=?`)
      .get(scope.tenant_id, scope.project_id, scope.brief_id);
    if (!row) return null;
    const brief = snapshotJson(JSON.parse(row.brief_json), "integrity_error", "brief_snapshot");
    const validated = validateCreativeBrief(brief, { trustedScope: scope });
    if (canonicalHash(validated) !== row.brief_hash) reject("integrity_error", "brief_hash");
    const historyStore = this.planningStore(scope);
    let history = historyStore.getBriefHistory(scope.brief_id);
    if (history.length === 0) {
      // Supported migration path for a validated legacy head: copy its exact
      // canonical CreativeBrief and hash into immutable history. This adds no
      // source verification or rights claim that was not already stored.
      historyStore.appendBriefVersion({ brief: validated, brief_hash: row.brief_hash,
        created_at: validated.occurred_at });
      history = historyStore.getBriefHistory(scope.brief_id);
    }
    if (history.at(-1)?.brief_hash !== row.brief_hash) reject("integrity_error", "brief_history.head");
    return freezeReturned(validated);
  }

  getBriefAction({ scope: inputScope, actor_id, action_id, request_hash }) {
    this.assertOpen();
    if (!isRecord(inputScope)) reject("scope_denied", "scope");
    const tenant_id = reference(inputScope.tenant_id, "scope.tenant_id");
    const project_id = reference(inputScope.project_id, "scope.project_id");
    const actorId = reference(actor_id, "actor_id");
    const actionId = reference(action_id, "action_id");
    const requestHash = hash(request_hash, "request_hash");
    const prior = this.db.prepare(`SELECT actor_id,request_hash,brief_id,brief_hash,result_json
      FROM creative_brief_actions WHERE tenant_id=? AND project_id=? AND action_id=?`)
      .get(tenant_id, project_id, actionId);
    if (!prior) return null;
    if (prior.actor_id !== actorId || prior.request_hash !== requestHash) return freezeReturned({ status: "conflict" });
    const plan = snapshotJson(JSON.parse(prior.result_json), "integrity_error", "brief_action.result");
    const briefId = reference(plan?.brief?.brief_id, "brief_action.brief_id");
    if (briefId !== prior.brief_id || prior.brief_hash !== plan.brief_hash) reject("integrity_error", "brief_action.identity");
    const scope = validScope({ tenant_id, project_id }, briefId);
    const brief = validateCreativeBrief(plan.brief, { trustedScope: scope });
    const { plan_hash: planHash, ...planBody } = plan;
    if (canonicalHash(brief) !== prior.brief_hash || planHash !== canonicalHash(planBody)) {
      reject("integrity_error", "brief_action.plan_hash");
    }
    return freezeReturned({ status: "replayed", brief_hash: prior.brief_hash, plan });
  }

  #persistBrief(scope, brief, expectedBriefHash) {
    const current = this.getBrief({ scope, brief_id: brief.brief_id });
    const currentHash = current ? canonicalHash(current) : null;
    if (currentHash !== expectedBriefHash) return freezeReturned({ status: "stale", brief_hash: currentHash });
    this.#assertBriefNotInvalidated(scope, brief);
    if (currentHash === canonicalHash(brief)) return freezeReturned({ status: "saved", brief_hash: currentHash });
    const historyStore = this.planningStore(scope);
    if (historyStore.getBriefHistory(brief.brief_id).some((item) => item.brief_hash === canonicalHash(brief))) {
      reject("stale_version", "brief_history.reactivation");
    }
    historyStore.appendBriefVersion({ brief, brief_hash: canonicalHash(brief), created_at: brief.occurred_at });
    this.db.prepare(`INSERT INTO creative_briefs (tenant_id,project_id,brief_id,brief_hash,brief_json,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(tenant_id,project_id,brief_id) DO UPDATE SET
      brief_hash=excluded.brief_hash,brief_json=excluded.brief_json,updated_at=excluded.updated_at`)
      .run(scope.tenant_id, scope.project_id, scope.brief_id, canonicalHash(brief), canonicalSerialize(brief), this.timestamp());
    return freezeReturned({ status: "saved", brief_hash: canonicalHash(brief) });
  }

  putBrief({ scope: inputScope, brief: briefInput, expected_brief_hash = null }) {
    this.assertOpen();
    const briefSnapshot = snapshotJson(briefInput, "invalid_request", "brief");
    const briefId = reference(briefSnapshot?.brief_id, "brief_id");
    const scope = validScope(inputScope, briefId);
    const brief = validateCreativeBrief(briefSnapshot, { trustedScope: scope });
    const briefHash = canonicalHash(brief);
    if (expected_brief_hash !== null) hash(expected_brief_hash, "expected_brief_hash");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#persistBrief(scope, brief, expected_brief_hash);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.rollback();
      if (error instanceof VersionStoreError) throw error;
      reject("unavailable", "brief", true);
    }
  }

  saveBriefAction({ scope: inputScope, actor_id, action_id, request_hash, plan, expected_brief_hash = null }) {
    this.assertOpen();
    const briefSnapshot = snapshotJson(plan?.brief, "invalid_request", "brief");
    const briefId = reference(briefSnapshot?.brief_id, "brief_id");
    const scope = validScope(inputScope, briefId);
    const actorId = reference(actor_id, "actor_id");
    const actionId = reference(action_id, "action_id");
    const requestHash = hash(request_hash, "request_hash");
    if (expected_brief_hash !== null) hash(expected_brief_hash, "expected_brief_hash");
    const checkedPlan = snapshotJson(plan, "invalid_request", "plan");
    const brief = validateCreativeBrief(briefSnapshot, { trustedScope: scope });
    const { plan_hash: planHash, ...planBody } = checkedPlan;
    if (checkedPlan.brief_hash !== canonicalHash(brief) || planHash !== canonicalHash(planBody)) {
      reject("integrity_error", "brief_action.plan_hash");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db.prepare(`SELECT actor_id,request_hash,brief_id,brief_hash,result_json FROM creative_brief_actions
        WHERE tenant_id=? AND project_id=? AND action_id=?`).get(scope.tenant_id, scope.project_id, actionId);
      if (prior) {
        this.db.exec("COMMIT");
        if (prior.actor_id !== actorId || prior.request_hash !== requestHash) return freezeReturned({ status: "conflict" });
        return freezeReturned({ status: "replayed", brief_hash: prior.brief_hash,
          plan: JSON.parse(prior.result_json) });
      }
      const result = this.#persistBrief(scope, brief, expected_brief_hash);
      if (result.status !== "saved") {
        this.db.exec("ROLLBACK");
        return result;
      }
      this.db.prepare(`INSERT INTO creative_brief_actions
        (tenant_id,project_id,action_id,actor_id,request_hash,brief_id,brief_hash,result_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(scope.tenant_id, scope.project_id, actionId, actorId, requestHash,
        briefId, canonicalHash(brief), canonicalSerialize(checkedPlan), this.timestamp());
      this.db.exec("COMMIT");
      return freezeReturned({ status: "saved", brief_hash: canonicalHash(brief), plan: checkedPlan });
    } catch (error) {
      this.rollback();
      if (error instanceof VersionStoreError) throw error;
      reject("unavailable", "brief_action", true);
    }
  }

  beginInvalidationAction({ scope: inputScope, actor_id, action_id, operation, request_hash, event_id }) {
    this.assertOpen();
    if (!isRecord(inputScope)) reject("scope_denied", "scope");
    const tenant_id = reference(inputScope.tenant_id, "scope.tenant_id");
    const project_id = reference(inputScope.project_id, "scope.project_id");
    const actorId = reference(actor_id, "actor_id");
    const actionId = reference(action_id, "action_id");
    const requestHash = hash(request_hash, "request_hash");
    const eventId = reference(event_id, "event_id");
    if (operation !== "brief.invalidate") reject("invalid_request", "operation");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db.prepare(`SELECT actor_id,operation,request_hash,event_id,status,result_json
        FROM creative_invalidation_actions WHERE tenant_id=? AND project_id=? AND action_id=?`)
        .get(tenant_id, project_id, actionId);
      if (prior) {
        this.db.exec("COMMIT");
        if (prior.actor_id !== actorId || prior.operation !== operation || prior.request_hash !== requestHash ||
          prior.event_id !== eventId) return freezeReturned({ status: "conflict" });
        if (prior.status === "completed") {
          return freezeReturned({ status: "replayed", result: snapshotJson(JSON.parse(prior.result_json), "integrity_error", "invalidation_action.result") });
        }
        return freezeReturned({ status: "pending" });
      }
      const timestamp = this.timestamp();
      this.db.prepare(`INSERT INTO creative_invalidation_actions
        (tenant_id,project_id,action_id,actor_id,operation,request_hash,event_id,status,result_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'pending',NULL,?,?)`).run(tenant_id, project_id, actionId, actorId,
        operation, requestHash, eventId, timestamp, timestamp);
      this.db.exec("COMMIT");
      return freezeReturned({ status: "started" });
    } catch (error) {
      this.rollback();
      if (error instanceof VersionStoreError) throw error;
      reject("unavailable", "invalidation_action", true);
    }
  }

  completeInvalidationAction({ scope: inputScope, actor_id, action_id, operation, request_hash, event_id, result }) {
    this.assertOpen();
    if (!isRecord(inputScope)) reject("scope_denied", "scope");
    const tenant_id = reference(inputScope.tenant_id, "scope.tenant_id");
    const project_id = reference(inputScope.project_id, "scope.project_id");
    const actorId = reference(actor_id, "actor_id");
    const actionId = reference(action_id, "action_id");
    const requestHash = hash(request_hash, "request_hash");
    const eventId = reference(event_id, "event_id");
    if (operation !== "brief.invalidate" || !isRecord(result) || result.event_id !== eventId) {
      reject("invalid_request", "invalidation_action.result");
    }
    const safeResult = snapshotJson(result, "invalid_request", "invalidation_action.result");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db.prepare(`SELECT actor_id,operation,request_hash,event_id,status,result_json
        FROM creative_invalidation_actions WHERE tenant_id=? AND project_id=? AND action_id=?`)
        .get(tenant_id, project_id, actionId);
      if (!prior || prior.actor_id !== actorId || prior.operation !== operation ||
        prior.request_hash !== requestHash || prior.event_id !== eventId) {
        this.db.exec("ROLLBACK");
        return freezeReturned({ status: "conflict" });
      }
      if (prior.status === "completed") {
        const stored = snapshotJson(JSON.parse(prior.result_json), "integrity_error", "invalidation_action.result");
        this.db.exec("COMMIT");
        if (canonicalSerialize(stored) !== canonicalSerialize(safeResult)) return freezeReturned({ status: "conflict" });
        return freezeReturned({ status: "replayed", result: stored });
      }
      if (safeResult.approval_staleness?.status !== "acknowledged" || !safeResult.producer_acknowledgment) {
        this.db.exec("COMMIT");
        return freezeReturned({ status: "pending", result: safeResult });
      }
      const updated = this.db.prepare(`UPDATE creative_invalidation_actions
        SET status='completed',result_json=?,updated_at=?
        WHERE tenant_id=? AND project_id=? AND action_id=? AND status='pending'`)
        .run(canonicalSerialize(safeResult), this.timestamp(), tenant_id, project_id, actionId);
      if (updated.changes !== 1) {
        this.db.exec("ROLLBACK");
        return freezeReturned({ status: "conflict" });
      }
      this.db.exec("COMMIT");
      return freezeReturned({ status: "completed", result: safeResult });
    } catch (error) {
      this.rollback();
      if (error instanceof VersionStoreError) throw error;
      reject("unavailable", "invalidation_action", true);
    }
  }

  recordAttemptEvidence(input) {
    this.assertOpen();
    if (!isRecord(input)) reject("invalid_request", "attempt_evidence");
    const scope = validScope(input.scope, input.scope?.brief_id);
    const actor_id = reference(input.actor_id, "actor_id");
    const job_id = reference(input.job_id, "job_id");
    const action_id = reference(input.action_id, "action_id");
    const lease_token = reference(input.lease_token, "lease_token");
    const evidence = attemptEvidence(input.creation);
    if (evidence.actor_id !== actor_id || evidence.job_id !== job_id || evidence.action_id !== action_id ||
      evidence.request_hash !== input.request_hash || evidence.billable_attempt_id === undefined ||
      !Array.isArray(evidence.transport_attempt_ids) || evidence.transport_attempt_ids.length === 0) {
      reject("invalid_request", "attempt_evidence.identity");
    }
    const request_hash = hash(input.request_hash, "request_hash");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`SELECT actor_id,action_id,request_hash,operation,status,lease_hash,attempt_evidence_json
        FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
        .get(scope.tenant_id, scope.project_id, job_id);
      if (!row || row.actor_id !== actor_id || row.action_id !== action_id || row.request_hash !== request_hash ||
        !["generate", "edit", "concepts.create"].includes(row.operation) || !["running", "cancelled", "failed"].includes(row.status) ||
        row.lease_hash !== createHash("sha256").update(lease_token).digest("hex")) {
        reject("cancelled", "job.lease_token");
      }
      for (const transportId of evidence.transport_attempt_ids) {
        const dispatch = this.db.prepare(`SELECT billable_attempt_id FROM creative_dispatch_intents
          WHERE tenant_id=? AND project_id=? AND job_id=? AND transport_attempt_id=?`)
          .get(scope.tenant_id, scope.project_id, job_id, transportId);
        if (!dispatch || dispatch.billable_attempt_id !== evidence.billable_attempt_id) {
          reject("integrity_error", "attempt_evidence.transport_attempt_ids");
        }
      }
      const serialized = canonicalSerialize(evidence);
      if (row.attempt_evidence_json !== null) {
        const existing = snapshotJson(JSON.parse(row.attempt_evidence_json), "integrity_error", "job.attempt_evidence");
        if (canonicalSerialize(existing) !== serialized) reject("conflict", "job.attempt_evidence");
        this.db.exec("COMMIT");
        return freezeReturned({ status: "replayed" });
      }
      this.db.prepare(`UPDATE creative_jobs SET attempt_evidence_json=?,updated_at=?
        WHERE tenant_id=? AND project_id=? AND job_id=? AND attempt_evidence_json IS NULL`)
        .run(serialized, this.timestamp(), scope.tenant_id, scope.project_id, job_id);
      this.db.exec("COMMIT");
      return freezeReturned({ status: "recorded" });
    } catch (error) {
      this.rollback();
      if (error instanceof VersionStoreError) throw error;
      reject("unavailable", "job.attempt_evidence", true);
    }
  }

  /** Persist raw provider request identity in a private append-only table after an authorized dispatch. */
  recordPrivateProviderAttribution(input) {
    this.assertOpen();
    if (!isRecord(input) || !isRecord(input.scope)) reject("invalid_request", "provider_attribution");
    const tenant_id = reference(input.scope.tenant_id, "scope.tenant_id");
    const project_id = reference(input.scope.project_id, "scope.project_id");
    const actor_id = reference(input.actor_id, "actor_id");
    const job_id = reference(input.job_id, "job_id");
    const action_id = reference(input.action_id, "action_id");
    const request_hash = hash(input.request_hash, "request_hash");
    if (!['generate', 'edit', 'concepts.create'].includes(input.operation) || !imageProviderRoute(input.provider)) {
      reject("invalid_request", "provider_attribution.operation");
    }
    const provider_model = modelReference(input.model, "provider_attribution.model", 256);
    const reservation_ref = reference(input.reservation_ref, "reservation_ref");
    const billable_attempt_id = reference(input.billable_attempt_id, "billable_attempt_id");
    const transport_attempt_id = reference(input.transport_attempt_id, "transport_attempt_id");
    const dispatch_intent_ref = reference(input.dispatch_intent_ref, "dispatch_intent_ref");
    const provider_request_id = input.provider_request_id;
    if (typeof provider_request_id !== "string" || provider_request_id.length < 1 ||
        Buffer.byteLength(provider_request_id, "utf8") > 512 || /[\u0000-\u001f\u007f]/.test(provider_request_id)) {
      reject("invalid_request", "provider_attribution.provider_request_id");
    }
    const provider_request_ref = reference(input.provider_request_ref, "provider_request_ref");
    const expectedProviderRequestRef = `provider-request-${createHash("sha256").update(provider_request_id, "utf8").digest("hex")}`;
    if (provider_request_ref !== expectedProviderRequestRef) reject("integrity_error", "provider_attribution.provider_request_ref");

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.db.prepare(`SELECT actor_id,action_id,request_hash,operation,status FROM creative_jobs
        WHERE tenant_id=? AND project_id=? AND job_id=?`).get(tenant_id, project_id, job_id);
      if (!job || job.actor_id !== actor_id || job.action_id !== action_id || job.request_hash !== request_hash ||
          job.operation !== input.operation || !["running", "cancelled", "failed", "completed"].includes(job.status)) {
        reject("scope_denied", "provider_attribution.job");
      }
      const dispatch = this.db.prepare(`SELECT billable_attempt_id,reservation_ref,dispatch_intent_ref,provider_name,provider_model
        FROM creative_dispatch_intents WHERE tenant_id=? AND project_id=? AND job_id=? AND transport_attempt_id=?`)
        .get(tenant_id, project_id, job_id, transport_attempt_id);
      if (!dispatch || dispatch.billable_attempt_id !== billable_attempt_id ||
          dispatch.reservation_ref !== reservation_ref || dispatch.dispatch_intent_ref !== dispatch_intent_ref ||
          dispatch.provider_name !== input.provider || dispatch.provider_model !== provider_model) {
        reject("integrity_error", "provider_attribution.dispatch");
      }
      const existing = this.db.prepare(`SELECT * FROM private_provider_attributions
        WHERE tenant_id=? AND project_id=? AND job_id=? AND transport_attempt_id=?`)
        .get(tenant_id, project_id, job_id, transport_attempt_id);
      if (existing) {
        const same = existing.action_id === action_id && existing.actor_id === actor_id &&
          existing.request_hash === request_hash && existing.operation === input.operation &&
          existing.provider_name === input.provider && existing.provider_model === provider_model &&
          existing.reservation_ref === reservation_ref && existing.billable_attempt_id === billable_attempt_id &&
          existing.dispatch_intent_ref === dispatch_intent_ref &&
          existing.provider_request_id === provider_request_id && existing.provider_request_ref === provider_request_ref;
        if (!same) reject("conflict", "provider_attribution.identity");
        this.db.exec("COMMIT");
        return freezeReturned({ status: "replayed", transport_attempt_id, provider_request_ref });
      }
      this.db.prepare(`INSERT INTO private_provider_attributions
        (tenant_id,project_id,job_id,action_id,actor_id,request_hash,operation,provider_name,provider_model,
          reservation_ref,billable_attempt_id,transport_attempt_id,dispatch_intent_ref,provider_request_id,
          provider_request_ref,captured_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(tenant_id, project_id, job_id, action_id, actor_id, request_hash, input.operation, input.provider,
          provider_model, reservation_ref, billable_attempt_id, transport_attempt_id, dispatch_intent_ref,
          provider_request_id, provider_request_ref, this.timestamp());
      this.db.exec("COMMIT");
      return freezeReturned({ status: "recorded", transport_attempt_id, provider_request_ref });
    } catch (error) {
      this.rollback();
      if (error instanceof VersionStoreError) throw error;
      reject("unavailable", "provider_attribution", true);
    }
  }

  /** Persist sanitized raw response counters separately from owner-normalized C03 units. */
  recordPrivateProviderUsageAttribution(input) {
    this.assertOpen();
    if (!isRecord(input) || !isRecord(input.scope) || !isRecord(input.usage)) reject("invalid_request", "provider_usage_attribution");
    const tenant_id = reference(input.scope.tenant_id, "scope.tenant_id");
    const project_id = reference(input.scope.project_id, "scope.project_id");
    const actor_id = reference(input.actor_id, "actor_id");
    const job_id = reference(input.job_id, "job_id");
    const action_id = reference(input.action_id, "action_id");
    const request_hash = hash(input.request_hash, "request_hash");
    if (!["generate", "edit", "concepts.create"].includes(input.operation) || !imageProviderRoute(input.provider)) {
      reject("invalid_request", "provider_usage_attribution.operation");
    }
    const provider_model = modelReference(input.model, "provider_usage_attribution.model", 256);
    const reservation_ref = reference(input.reservation_ref, "reservation_ref");
    const billable_attempt_id = reference(input.billable_attempt_id, "billable_attempt_id");
    const transport_attempt_id = reference(input.transport_attempt_id, "transport_attempt_id");
    const dispatch_intent_ref = reference(input.dispatch_intent_ref, "dispatch_intent_ref");
    const target_binding_sha256 = hash(input.target_binding_sha256, "target_binding_sha256");
    const usage = snapshotJson(input.usage, "invalid_request", "provider_usage_attribution.usage");
    const allowed = new Set(["completeness", "input_tokens", "output_tokens", "total_tokens",
      "input_tokens_details", "output_tokens_details", "provider_request_id", "transport_attempt_id", "missing_fields"]);
    // OpenRouter adds a provider-reported USD cost, labeled unsettled. Direct OpenAI usage keeps its exact allowlist.
    if (input.provider === "openrouter") for (const key of ["cost", "cost_details", "is_byok"]) allowed.add(key);
    if (Object.keys(usage).some((key) => !allowed.has(key)) ||
        !["complete", "partial", "incomplete", "unknown"].includes(usage.completeness) ||
        usage.transport_attempt_id !== transport_attempt_id) {
      reject("invalid_request", "provider_usage_attribution.usage");
    }
    for (const key of ["input_tokens", "output_tokens", "total_tokens"]) {
      if (usage[key] !== undefined && (!Number.isSafeInteger(usage[key]) || usage[key] < 0)) {
        reject("invalid_request", `provider_usage_attribution.usage.${key}`);
      }
    }
    const invalidDetail = invalidUsageDetail(usage, input.provider);
    if (invalidDetail) reject("invalid_request", `provider_usage_attribution.${invalidDetail}`);
    if (usage.provider_request_id !== undefined &&
        !/^provider-request-[a-f0-9]{64}$/.test(usage.provider_request_id)) {
      reject("invalid_request", "provider_usage_attribution.provider_request_id");
    }
    if (input.provider === "openrouter") {
      const invalid = invalidOpenRouterUsageField(usage);
      if (invalid) reject("invalid_request", `provider_usage_attribution.${invalid}`);
    }
    if (!Array.isArray(usage.missing_fields) || usage.missing_fields.length > 64 ||
        usage.missing_fields.some((field) => typeof field !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(field))) {
      reject("invalid_request", "provider_usage_attribution.missing_fields");
    }
    const usage_json = canonicalSerialize(usage);
    if (Buffer.byteLength(usage_json, "utf8") > 32 * 1024) reject("invalid_request", "provider_usage_attribution.usage_size");
    const usage_sha256 = canonicalHash(usage);
    if (input.usage_sha256 !== usage_sha256) reject("integrity_error", "provider_usage_attribution.usage_sha256");

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.db.prepare(`SELECT actor_id,action_id,request_hash,operation,status FROM creative_jobs
        WHERE tenant_id=? AND project_id=? AND job_id=?`).get(tenant_id, project_id, job_id);
      if (!job || job.actor_id !== actor_id || job.action_id !== action_id || job.request_hash !== request_hash ||
          job.operation !== input.operation || !["running", "cancelled", "failed", "completed"].includes(job.status)) {
        reject("scope_denied", "provider_usage_attribution.job");
      }
      const dispatch = this.db.prepare(`SELECT billable_attempt_id,reservation_ref,dispatch_intent_ref,provider_name,provider_model
        FROM creative_dispatch_intents WHERE tenant_id=? AND project_id=? AND job_id=? AND transport_attempt_id=?`)
        .get(tenant_id, project_id, job_id, transport_attempt_id);
      if (!dispatch || dispatch.billable_attempt_id !== billable_attempt_id ||
          dispatch.reservation_ref !== reservation_ref || dispatch.dispatch_intent_ref !== dispatch_intent_ref ||
          dispatch.provider_name !== input.provider || dispatch.provider_model !== provider_model) {
        reject("integrity_error", "provider_usage_attribution.dispatch");
      }
      const existing = this.db.prepare(`SELECT * FROM private_provider_usage_attributions
        WHERE tenant_id=? AND project_id=? AND job_id=? AND transport_attempt_id=?`)
        .get(tenant_id, project_id, job_id, transport_attempt_id);
      if (existing) {
        const same = existing.action_id === action_id && existing.actor_id === actor_id &&
          existing.request_hash === request_hash && existing.operation === input.operation &&
          existing.provider_name === input.provider && existing.provider_model === provider_model &&
          existing.reservation_ref === reservation_ref && existing.billable_attempt_id === billable_attempt_id &&
          existing.dispatch_intent_ref === dispatch_intent_ref && existing.target_binding_sha256 === target_binding_sha256 &&
          existing.usage_sha256 === usage_sha256 && existing.usage_json === usage_json;
        if (!same) reject("conflict", "provider_usage_attribution.identity");
        this.db.exec("COMMIT");
        return freezeReturned({ status: "replayed", transport_attempt_id, target_binding_sha256, usage_sha256 });
      }
      this.db.prepare(`INSERT INTO private_provider_usage_attributions
        (tenant_id,project_id,job_id,action_id,actor_id,request_hash,operation,provider_name,provider_model,
          reservation_ref,billable_attempt_id,transport_attempt_id,dispatch_intent_ref,target_binding_sha256,
          usage_sha256,usage_json,captured_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(tenant_id, project_id, job_id, action_id, actor_id, request_hash, input.operation, input.provider,
          provider_model, reservation_ref, billable_attempt_id, transport_attempt_id, dispatch_intent_ref,
          target_binding_sha256, usage_sha256, usage_json, this.timestamp());
      this.db.exec("COMMIT");
      return freezeReturned({ status: "recorded", transport_attempt_id, target_binding_sha256, usage_sha256 });
    } catch (error) {
      this.rollback();
      if (error instanceof VersionStoreError) throw error;
      reject("unavailable", "provider_usage_attribution", true);
    }
  }

  /** Stage bounded response attribution so transient append failures can be reconciled without redispatch. */
  stagePrivateProviderAttribution(input) {
    this.assertOpen();
    if (!isRecord(input) || !isRecord(input.scope) ||
        (input.provider_request_id === undefined) === (input.provider_request_ref !== undefined) ||
        input.provider_request_id === undefined && input.usage === undefined) {
      reject("invalid_request", "provider_attribution_pending");
    }
    const tenant_id = reference(input.scope.tenant_id, "scope.tenant_id");
    const project_id = reference(input.scope.project_id, "scope.project_id");
    const actor_id = reference(input.actor_id, "actor_id");
    const job_id = reference(input.job_id, "job_id");
    const action_id = reference(input.action_id, "action_id");
    const request_hash = hash(input.request_hash, "request_hash");
    if (!["generate", "edit", "concepts.create"].includes(input.operation) || !imageProviderRoute(input.provider)) {
      reject("invalid_request", "provider_attribution_pending.operation");
    }
    const provider_model = modelReference(input.model, "provider_attribution_pending.model", 256);
    const reservation_ref = reference(input.reservation_ref, "reservation_ref");
    const billable_attempt_id = reference(input.billable_attempt_id, "billable_attempt_id");
    const transport_attempt_id = reference(input.transport_attempt_id, "transport_attempt_id");
    const dispatch_intent_ref = reference(input.dispatch_intent_ref, "dispatch_intent_ref");
    const target_binding_sha256 = hash(input.target_binding_sha256, "target_binding_sha256");
    let provider_request_id;
    let provider_request_ref;
    if (input.provider_request_id !== undefined) {
      provider_request_id = input.provider_request_id;
      if (typeof provider_request_id !== "string" || provider_request_id.length < 1 ||
          Buffer.byteLength(provider_request_id, "utf8") > 512 || /[\u0000-\u001f\u007f]/.test(provider_request_id)) {
        reject("invalid_request", "provider_attribution_pending.provider_request_id");
      }
      provider_request_ref = reference(input.provider_request_ref, "provider_request_ref");
      const expectedProviderRequestRef = `provider-request-${createHash("sha256").update(provider_request_id, "utf8").digest("hex")}`;
      if (provider_request_ref !== expectedProviderRequestRef) reject("integrity_error", "provider_attribution_pending.provider_request_ref");
    }
    let usage;
    let usage_sha256;
    if (input.usage !== undefined) {
      usage = snapshotJson(input.usage, "invalid_request", "provider_attribution_pending.usage");
      const allowed = new Set(["completeness", "input_tokens", "output_tokens", "total_tokens",
        "input_tokens_details", "output_tokens_details", "provider_request_id", "transport_attempt_id", "missing_fields"]);
      // OpenRouter's reported cost fields are staged with the same shape as the direct record.
      if (input.provider === "openrouter") for (const key of ["cost", "cost_details", "is_byok"]) allowed.add(key);
      if (!hasOnlyKeys(usage, [...allowed]) || !["complete", "partial", "incomplete", "unknown"].includes(usage.completeness) ||
          usage.transport_attempt_id !== transport_attempt_id) {
        reject("invalid_request", "provider_attribution_pending.usage");
      }
      for (const key of ["input_tokens", "output_tokens", "total_tokens"]) {
        if (usage[key] !== undefined && (!Number.isSafeInteger(usage[key]) || usage[key] < 0)) {
          reject("invalid_request", `provider_attribution_pending.usage.${key}`);
        }
      }
      const invalidDetail = invalidUsageDetail(usage, input.provider);
      if (invalidDetail) reject("invalid_request", `provider_attribution_pending.usage.${invalidDetail}`);
      if (input.provider === "openrouter") {
        const invalid = invalidOpenRouterUsageField(usage);
        if (invalid) reject("invalid_request", `provider_attribution_pending.usage.${invalid}`);
      }
      if (usage.provider_request_id !== undefined && !/^provider-request-[a-f0-9]{64}$/.test(usage.provider_request_id)) {
        reject("invalid_request", "provider_attribution_pending.usage.provider_request_id");
      }
      if (!Array.isArray(usage.missing_fields) || usage.missing_fields.length > 64 ||
          usage.missing_fields.some((field) => typeof field !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(field))) {
        reject("invalid_request", "provider_attribution_pending.usage.missing_fields");
      }
      const usage_json = canonicalSerialize(usage);
      if (Buffer.byteLength(usage_json, "utf8") > 32 * 1024) reject("invalid_request", "provider_attribution_pending.usage_size");
      usage_sha256 = canonicalHash(usage);
    }
    const payload = snapshotJson({ tenant_id, project_id, actor_id, job_id, action_id, request_hash,
      operation: input.operation, provider: input.provider, model: provider_model, reservation_ref,
      billable_attempt_id, transport_attempt_id, dispatch_intent_ref, target_binding_sha256,
      ...(provider_request_id !== undefined ? { provider_request_id, provider_request_ref } : {}),
      ...(usage !== undefined ? { usage, usage_sha256 } : {}) }, "invalid_request", "provider_attribution_pending");
    const payload_json = canonicalSerialize(payload);
    const payload_sha256 = canonicalHash(payload);
    const pending_ref = `private-attribution:${payload_sha256.slice(7)}`;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.db.prepare(`SELECT actor_id,action_id,request_hash,operation,status FROM creative_jobs
        WHERE tenant_id=? AND project_id=? AND job_id=?`).get(tenant_id, project_id, job_id);
      if (!job || job.actor_id !== actor_id || job.action_id !== action_id || job.request_hash !== request_hash ||
          job.operation !== input.operation || !["running", "cancelled", "failed", "completed"].includes(job.status)) {
        reject("scope_denied", "provider_attribution_pending.job");
      }
      const dispatch = this.db.prepare(`SELECT billable_attempt_id,reservation_ref,dispatch_intent_ref,provider_name,provider_model
        FROM creative_dispatch_intents WHERE tenant_id=? AND project_id=? AND job_id=? AND transport_attempt_id=?`)
        .get(tenant_id, project_id, job_id, transport_attempt_id);
      if (!dispatch || dispatch.billable_attempt_id !== billable_attempt_id || dispatch.reservation_ref !== reservation_ref ||
          dispatch.dispatch_intent_ref !== dispatch_intent_ref || dispatch.provider_name !== input.provider ||
          dispatch.provider_model !== provider_model) reject("integrity_error", "provider_attribution_pending.dispatch");
      const existing = this.db.prepare(`SELECT payload_sha256 FROM private_provider_attribution_pending
        WHERE tenant_id=? AND project_id=? AND pending_ref=?`).get(tenant_id, project_id, pending_ref);
      if (existing) {
        if (existing.payload_sha256 !== payload_sha256) reject("conflict", "provider_attribution_pending.identity");
        this.db.exec("COMMIT");
        return freezeReturned({ status: "replayed", pending_ref, transport_attempt_id, payload_sha256 });
      }
      this.db.prepare(`INSERT INTO private_provider_attribution_pending
        (tenant_id,project_id,pending_ref,job_id,transport_attempt_id,payload_sha256,payload_json,created_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(tenant_id, project_id, pending_ref, job_id, transport_attempt_id,
          payload_sha256, payload_json, this.timestamp());
      this.db.exec("COMMIT");
      return freezeReturned({ status: "staged", pending_ref, transport_attempt_id, payload_sha256 });
    } catch (error) {
      this.rollback();
      if (error instanceof VersionStoreError) throw error;
      reject("unavailable", "provider_attribution_pending", true);
    }
  }

  /** Retry append-only private attribution writes from durable pending rows; never invokes a provider. */
  reconcilePrivateProviderAttributions(input) {
    this.assertOpen();
    if (!isRecord(input) || !isRecord(input.scope)) reject("invalid_request", "provider_attribution_reconciliation");
    const tenant_id = reference(input.scope.tenant_id, "scope.tenant_id");
    const project_id = reference(input.scope.project_id, "scope.project_id");
    const limit = input.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) reject("invalid_request", "provider_attribution_reconciliation.limit");
    const rows = this.db.prepare(`SELECT p.* FROM private_provider_attribution_pending p
      LEFT JOIN private_provider_attribution_reconciliations r
        ON r.tenant_id=p.tenant_id AND r.project_id=p.project_id AND r.pending_ref=p.pending_ref
      WHERE p.tenant_id=? AND p.project_id=? AND r.pending_ref IS NULL ORDER BY p.created_at,p.pending_ref LIMIT ?`)
      .all(tenant_id, project_id, limit);
    let reconciled = 0;
    for (const row of rows) {
      let payload;
      try { payload = JSON.parse(row.payload_json); } catch { reject("integrity_error", "provider_attribution_pending.payload"); }
      if (canonicalHash(payload) !== row.payload_sha256 || payload.pending_ref !== undefined ||
          payload.tenant_id !== tenant_id || payload.project_id !== project_id ||
          payload.job_id !== row.job_id || payload.transport_attempt_id !== row.transport_attempt_id) {
        reject("integrity_error", "provider_attribution_pending.payload");
      }
      const scope = Object.freeze({ tenant_id, project_id });
      if (payload.provider_request_id !== undefined) {
        const ack = this.recordPrivateProviderAttribution({ scope, actor_id: payload.actor_id, job_id: payload.job_id,
          action_id: payload.action_id, request_hash: payload.request_hash, operation: payload.operation,
          provider: payload.provider, model: payload.model, reservation_ref: payload.reservation_ref,
          billable_attempt_id: payload.billable_attempt_id, transport_attempt_id: payload.transport_attempt_id,
          dispatch_intent_ref: payload.dispatch_intent_ref, provider_request_id: payload.provider_request_id,
          provider_request_ref: payload.provider_request_ref });
        if (!["recorded", "replayed"].includes(ack.status) || ack.transport_attempt_id !== payload.transport_attempt_id ||
            ack.provider_request_ref !== payload.provider_request_ref) reject("unavailable", "provider_attribution_reconciliation", true);
      }
      if (payload.usage !== undefined) {
        const ack = this.recordPrivateProviderUsageAttribution({ scope, actor_id: payload.actor_id, job_id: payload.job_id,
          action_id: payload.action_id, request_hash: payload.request_hash, operation: payload.operation,
          provider: payload.provider, model: payload.model, reservation_ref: payload.reservation_ref,
          billable_attempt_id: payload.billable_attempt_id, transport_attempt_id: payload.transport_attempt_id,
          dispatch_intent_ref: payload.dispatch_intent_ref, target_binding_sha256: payload.target_binding_sha256,
          usage_sha256: payload.usage_sha256, usage: payload.usage });
        if (!["recorded", "replayed"].includes(ack.status) || ack.transport_attempt_id !== payload.transport_attempt_id ||
            ack.target_binding_sha256 !== payload.target_binding_sha256 || ack.usage_sha256 !== payload.usage_sha256) {
          reject("unavailable", "provider_attribution_reconciliation", true);
        }
      }
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const prior = this.db.prepare(`SELECT payload_sha256 FROM private_provider_attribution_reconciliations
          WHERE tenant_id=? AND project_id=? AND pending_ref=?`).get(tenant_id, project_id, row.pending_ref);
        if (prior) {
          if (prior.payload_sha256 !== row.payload_sha256) reject("integrity_error", "provider_attribution_reconciliation.identity");
        } else {
          this.db.prepare(`INSERT INTO private_provider_attribution_reconciliations
            (tenant_id,project_id,pending_ref,payload_sha256,reconciled_at) VALUES(?,?,?,?,?)`)
            .run(tenant_id, project_id, row.pending_ref, row.payload_sha256, this.timestamp());
          reconciled += 1;
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.rollback();
        if (error instanceof VersionStoreError) throw error;
        reject("unavailable", "provider_attribution_reconciliation", true);
      }
    }
    const remaining = this.db.prepare(`SELECT COUNT(*) AS count FROM private_provider_attribution_pending p
      LEFT JOIN private_provider_attribution_reconciliations r
        ON r.tenant_id=p.tenant_id AND r.project_id=p.project_id AND r.pending_ref=p.pending_ref
      WHERE p.tenant_id=? AND p.project_id=? AND r.pending_ref IS NULL`).get(tenant_id, project_id).count;
    return freezeReturned({ reconciled, remaining });
  }

  beginConceptBatch(input) {
    this.assertOpen();
    this.assertNoBorrowedTransaction("concept.batch.transaction");
    if (!isRecord(input) || !isRecord(input.batch)) reject("invalid_request", "concept.batch");
    const scope = validScope(input.scope, input.brief_id ?? input.batch.brief_id);
    const actor_id = reference(input.actor_id, "actor_id");
    const job_id = reference(input.job_id, "job_id");
    const action_id = reference(input.action_id, "action_id");
    const request_hash = hash(input.request_hash, "request_hash");
    const batch = snapshotJson(input.batch, "invalid_request", "concept.batch");
    if (batch.tenant_id !== scope.tenant_id || batch.project_id !== scope.project_id ||
        batch.brief_id !== scope.brief_id || batch.action_id !== action_id ||
        typeof batch.batch_id !== "string" || !Array.isArray(batch.slots) || batch.slots.length < 1 || batch.slots.length > 2) {
      reject("scope_denied", "concept.batch");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
        .get(scope.tenant_id, scope.project_id, job_id);
      if (!activeJobLease(job, scope, actor_id, input.lease_token, this.now()) ||
          job.operation !== "concepts.create" || job.action_id !== action_id || job.request_hash !== request_hash) {
        reject("cancelled", "concept.job");
      }
      const prior = this.db.prepare(`SELECT * FROM creative_concept_batches_v1
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, action_id);
      if (prior) {
        if (prior.job_id !== job_id || prior.actor_id !== actor_id || prior.request_hash !== request_hash ||
            prior.batch_id !== batch.batch_id || prior.batch_json !== canonicalSerialize(batch)) reject("conflict", "concept.action_id");
        this.db.exec("COMMIT");
        return freezeReturned({ status: "existing", batch: JSON.parse(prior.batch_json), batch_status: prior.status });
      }
      const now = this.timestamp();
      this.db.prepare(`INSERT INTO creative_concept_batches_v1
        (tenant_id,project_id,brief_id,action_id,job_id,actor_id,request_hash,batch_id,status,batch_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?, 'running',?,?,?)`)
        .run(scope.tenant_id, scope.project_id, scope.brief_id, action_id, job_id, actor_id, request_hash,
          batch.batch_id, canonicalSerialize(batch), now, now);
      this.db.exec("COMMIT");
      return freezeReturned({ status: "created", batch, batch_status: "running" });
    } catch (error) {
      this.rollback();
      if (error instanceof VersionStoreError) throw error;
      reject("unavailable", "concept.batch", true);
    }
  }

  appendConceptEvent(input) {
    this.assertOpen();
    this.assertNoBorrowedTransaction("concept.event.transaction");
    if (!isRecord(input) || !isRecord(input.event)) reject("invalid_request", "concept.event");
    const scope = validScope(input.scope, input.brief_id ?? input.scope?.brief_id);
    const action_id = reference(input.action_id, "action_id");
    const job_id = reference(input.job_id, "job_id");
    const actor_id = reference(input.actor_id, "actor_id");
    const request_hash = hash(input.request_hash, "request_hash");
    const event = snapshotJson(input.event, "invalid_request", "concept.event");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`SELECT * FROM creative_concept_batches_v1
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, action_id);
      const job = this.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
        .get(scope.tenant_id, scope.project_id, job_id);
      const active = activeJobLease(job, scope, actor_id, input.lease_token, this.now());
      let postFenceUnknown = false;
      if (!active && row && job && row.job_id === job_id && row.actor_id === actor_id &&
          row.request_hash === request_hash && job.actor_id === actor_id && job.action_id === action_id &&
          job.request_hash === request_hash && job.operation === "concepts.create" &&
          job.lease_hash === createHash("sha256").update(input.lease_token).digest("hex") &&
          (job.status === "cancelled" || job.status === "running" && Date.parse(job.lease_expires_at) <= this.now()) &&
          event.event_type === "provider_outcome" && event.outcome === "unknown" &&
          event.usage_completeness === "unknown" && event.provider_request_id === undefined &&
          event.artifact_sha256 === undefined && Object.keys(event).every((key) => [
            "tenant_id", "project_id", "action_id", "batch_id", "concept_id", "event_id", "event_type",
            "billable_attempt_id", "transport_attempt_id", "outcome", "outcome_evidence_ref",
            "usage_evidence_ref", "usage_completeness",
          ].includes(key))) {
        const currentBatch = snapshotJson(JSON.parse(row.batch_json), "integrity_error", "concept.batch");
        const slot = currentBatch.slots.find((item) => item.concept_id === event.concept_id);
        const attempt = slot?.attempts.find((item) => item.billable_attempt_id === event.billable_attempt_id);
        const dispatch = this.db.prepare(`SELECT billable_attempt_id,reservation_ref,dispatch_intent_ref,
          target_binding_sha256 FROM creative_dispatch_intents
          WHERE tenant_id=? AND project_id=? AND job_id=? AND transport_attempt_id=?`)
          .get(scope.tenant_id, scope.project_id, job_id, event.transport_attempt_id);
        const stage = this.db.prepare(`SELECT 1 AS present FROM creative_concept_response_stages_v1
          WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=? AND concept_id=?`)
          .get(scope.tenant_id, scope.project_id, scope.brief_id, action_id, event.concept_id);
        const expectedOutcomeRef = slot && attempt
          ? `concept-outcome:${canonicalHash({ batch_id: currentBatch.batch_id, concept_id: slot.concept_id,
            billable_attempt_id: attempt.billable_attempt_id, outcome: "unknown", artifact_sha256: null }).slice(7)}`
          : null;
        const expectedUsageRef = slot && attempt
          ? `concept-usage-unknown:${canonicalHash({ batch_id: currentBatch.batch_id, concept_id: slot.concept_id,
            billable_attempt_id: attempt.billable_attempt_id }).slice(7)}`
          : null;
        let safeUnknownUsageRef = event.usage_evidence_ref === expectedUsageRef;
        if (!safeUnknownUsageRef && slot && attempt && typeof event.usage_evidence_ref === "string") {
          try {
            const usageRecordRef = reference(event.usage_evidence_ref, "concept.usage_evidence_ref");
            const usageRow = this.db.prepare(`SELECT record_ref,tenant_id,project_id,budget_scope_id,logical_operation_id,
              billable_attempt_id,source_observation_id,payload_json,payload_sha256 FROM creative_telemetry_observations_v1
              WHERE record_ref=?`).get(usageRecordRef);
            const payload = usageRow ? JSON.parse(usageRow.payload_json) : null;
            const observedAttempt = payload?.attempt;
            const observation = payload?.observation;
            const meteringAttempt = attempt.metering_attempt;
            const usageChecks = {
              row: Boolean(usageRow), payload: isRecord(payload), attempt: isRecord(observedAttempt), observation: isRecord(observation),
              payload_canonical: Boolean(usageRow && canonicalSerialize(payload) === usageRow.payload_json),
              payload_hash: Boolean(usageRow && canonicalHash(payload).slice(7) === usageRow.payload_sha256),
              record_ref: usageRow?.record_ref === usageRecordRef, tenant: usageRow?.tenant_id === scope.tenant_id,
              project: usageRow?.project_id === scope.project_id, budget: usageRow?.budget_scope_id === meteringAttempt?.budget_scope_id,
              logical: usageRow?.logical_operation_id === slot.logical_operation_id,
              billable: usageRow?.billable_attempt_id === attempt.billable_attempt_id,
              source: usageRow?.source_observation_id === observation?.source_observation_id,
              attempt_tenant: observedAttempt?.tenant_id === scope.tenant_id,
              attempt_project: observedAttempt?.project_id === scope.project_id,
              attempt_budget: observedAttempt?.budget_scope_id === meteringAttempt?.budget_scope_id,
              attempt_logical: observedAttempt?.logical_operation_id === slot.logical_operation_id,
              attempt_billable: observedAttempt?.billable_attempt_id === attempt.billable_attempt_id,
              operation_kind: observedAttempt?.operation_kind === meteringAttempt?.operation_kind,
              attempt_provider: observedAttempt?.provider?.name === meteringAttempt?.provider?.name,
              attempt_model: observedAttempt?.provider?.model === meteringAttempt?.provider?.model,
              observation_tenant: observation?.tenant_id === scope.tenant_id,
              observation_project: observation?.project_id === scope.project_id,
              observation_budget: observation?.budget_scope_id === meteringAttempt?.budget_scope_id,
              observation_logical: observation?.logical_operation_id === slot.logical_operation_id,
              observation_billable: observation?.billable_attempt_id === attempt.billable_attempt_id,
              transport: observation?.transport_attempt_id === attempt.transport_attempt_id,
              observation_source: observation?.source_observation_id === usageRow?.source_observation_id,
              provider: observation?.provider_name === meteringAttempt?.provider?.name,
              model: observation?.model === meteringAttempt?.provider?.model,
            };
            safeUnknownUsageRef = Object.values(usageChecks).every(Boolean);
          } catch { safeUnknownUsageRef = false; }
        }
        postFenceUnknown = row.status === "running" && row.job_id === job_id && row.batch_id === event.batch_id &&
          currentBatch.action_id === action_id && currentBatch.batch_id === row.batch_id && slot?.status === "dispatching" &&
          slot.current_billable_attempt_id === event.billable_attempt_id && attempt?.status === "dispatching" &&
          attempt.transport_attempt_id === event.transport_attempt_id && attempt.dispatch_intent_ref !== null &&
          dispatch?.billable_attempt_id === attempt.billable_attempt_id &&
          dispatch.reservation_ref === attempt.reservation_ref && dispatch.dispatch_intent_ref === attempt.dispatch_intent_ref &&
          dispatch.target_binding_sha256 === attempt.provider_target_binding_sha256 && !stage &&
          event.outcome_evidence_ref === expectedOutcomeRef && safeUnknownUsageRef &&
          event.tenant_id === scope.tenant_id && event.project_id === scope.project_id &&
          event.action_id === action_id && event.batch_id === currentBatch.batch_id;
      }
      if (!row || row.job_id !== job_id || row.actor_id !== actor_id || row.request_hash !== request_hash ||
          !active && !postFenceUnknown) {
        reject("cancelled", "concept.job");
      }
      const batch = snapshotJson(JSON.parse(row.batch_json), "integrity_error", "concept.batch");
      let applied;
      try { applied = applyCreativeConceptEvent(batch, event); }
      catch { reject("conflict", "concept.event"); }
      if (applied.status === "duplicate") {
        this.db.exec("COMMIT");
        return freezeReturned({ status: "replayed", batch: applied.batch, batch_status: row.status });
      }
      const next = applied.batch;
      const hasUnknown = next.slots.some((slot) => slot.attempts.some((attempt) => attempt.unknown_financial_exposure));
      const allSucceeded = next.slots.every((slot) => slot.status === "succeeded");
      const hasSuccess = next.slots.some((slot) => slot.status === "succeeded");
      const hasTerminalPartial = next.slots.some((slot) => ["failed", "cancelled", "unknown"].includes(slot.status));
      const status = hasUnknown ? "unknown_hold" : allSucceeded ? "completed" :
        hasSuccess || hasTerminalPartial ? "partial" : "running";
      const eventHash = canonicalHash(event);
      const priorEvent = this.db.prepare(`SELECT event_hash,event_json FROM creative_concept_events_v1
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND event_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, event.event_id);
      if (priorEvent && (priorEvent.event_hash !== eventHash || priorEvent.event_json !== canonicalSerialize(event))) {
        reject("conflict", "concept.event_id");
      }
      if (!priorEvent) {
        const sequence = this.db.prepare(`SELECT COALESCE(MAX(sequence),0)+1 AS next FROM creative_concept_events_v1
          WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=?`)
          .get(scope.tenant_id, scope.project_id, scope.brief_id, action_id).next;
        this.db.prepare(`INSERT INTO creative_concept_events_v1
          (tenant_id,project_id,brief_id,action_id,sequence,event_id,event_type,event_hash,event_json,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).run(scope.tenant_id, scope.project_id, scope.brief_id, action_id,
          sequence, event.event_id, event.event_type, eventHash, canonicalSerialize(event), this.timestamp());
      }
      this.db.prepare(`UPDATE creative_concept_batches_v1 SET batch_json=?,status=?,updated_at=?
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=?`)
        .run(canonicalSerialize(next), status, this.timestamp(), scope.tenant_id, scope.project_id, scope.brief_id, action_id);
      this.db.exec("COMMIT");
      return freezeReturned({ status: "recorded", batch: next, batch_status: status });
    } catch (error) {
      this.rollback();
      if (error instanceof VersionStoreError) throw error;
      reject("unavailable", "concept.event", true);
    }
  }

  async stageConceptResponse(input) {
    this.assertOpen();
    this.assertNoBorrowedTransaction("concept.response.transaction");
    if (!isRecord(input) || !(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0 ||
        input.bytes.byteLength > this.maxArtifactBytes) reject("invalid_request", "concept.response");
    // Snapshot every mutable input before the first await. Image inspection is
    // asynchronous, so retaining a caller-owned view could otherwise hash and
    // inspect one buffer then persist different bytes or metadata.
    const bytes = Uint8Array.from(input.bytes);
    const scope = validScope(input.scope, input.brief_id ?? input.scope?.brief_id);
    const brief_id = scope.brief_id;
    const action_id = reference(input.action_id, "action_id");
    const job_id = reference(input.job_id, "job_id");
    const actor_id = reference(input.actor_id, "actor_id");
    const request_hash = hash(input.request_hash, "request_hash");
    const lease_token = reference(input.lease_token, "lease_token");
    const concept_id = reference(input.concept_id, "concept_id");
    const billable_attempt_id = reference(input.billable_attempt_id, "billable_attempt_id");
    const transport_attempt_id = reference(input.transport_attempt_id, "transport_attempt_id");
    const reservation_ref = reference(input.reservation_ref, "reservation_ref");
    const dispatch_intent_ref = reference(input.dispatch_intent_ref, "dispatch_intent_ref");
    const target_binding_sha256 = hash(input.target_binding_sha256, "target_binding_sha256");
    const expected_content_hash = hash(input.content_hash, "content_hash");
    const media_type = input.media_type;
    const width = input.width;
    const height = input.height;
    if (typeof media_type !== "string" || !["image/png", "image/jpeg", "image/webp"].includes(media_type) ||
        !Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
      reject("invalid_request", "concept.response.metadata");
    }
    const content_hash = hashArtifactBytes(bytes);
    if (content_hash !== expected_content_hash) reject("integrity_error", "concept.response_hash");
    let decoded;
    try {
      decoded = await inspectCreativeConceptImageBytes({ bytes,
        expected_media_type: media_type, maximum_bytes: this.maxArtifactBytes,
        expected_dimensions: { width, height } });
    } catch { reject("integrity_error", "concept.response_image"); }
    const stage_ref = `concept-stage:${canonicalHash({ action_id, concept_id, billable_attempt_id, transport_attempt_id, content_hash }).slice(7)}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
        .get(scope.tenant_id, scope.project_id, job_id);
      const batch = this.db.prepare(`SELECT * FROM creative_concept_batches_v1
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=?`)
        .get(scope.tenant_id, scope.project_id, brief_id, action_id);
      const dispatchBinding = this.db.prepare(`SELECT target_binding_sha256,target_binding_json,rendered_prompt_sha256
        FROM creative_concept_dispatch_bindings_v1
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=? AND job_id=? AND transport_attempt_id=?
          AND billable_attempt_id=? AND reservation_ref=? AND dispatch_intent_ref=?`)
        .get(scope.tenant_id, scope.project_id, brief_id, action_id, job_id, transport_attempt_id,
          billable_attempt_id, reservation_ref, dispatch_intent_ref);
      const dispatch = this.db.prepare(`SELECT billable_attempt_id,reservation_ref,dispatch_intent_ref,provider_name,target_binding_sha256,
        target_binding_json,rendered_prompt_sha256 FROM creative_dispatch_intents
        WHERE tenant_id=? AND project_id=? AND job_id=? AND transport_attempt_id=?`)
        .get(scope.tenant_id, scope.project_id, job_id, transport_attempt_id);
      if (!activeJobLease(job, scope, actor_id, lease_token, this.now()) ||
          !batch || batch.job_id !== job_id || batch.request_hash !== request_hash ||
          !dispatch || dispatch.billable_attempt_id !== billable_attempt_id || dispatch.reservation_ref !== reservation_ref ||
          dispatch.dispatch_intent_ref !== dispatch_intent_ref || !dispatchBinding ||
          dispatchBinding.target_binding_sha256 !== target_binding_sha256 || dispatch.target_binding_sha256 !== target_binding_sha256 ||
          dispatchBinding.target_binding_json !== dispatch.target_binding_json ||
          dispatchBinding.rendered_prompt_sha256 !== dispatch.rendered_prompt_sha256) reject("cancelled", "concept.response_authority");
      let durableTarget;
      try { durableTarget = JSON.parse(dispatch.target_binding_json); }
      catch { reject("integrity_error", "concept.dispatch_target"); }
      if (!isRecord(durableTarget) || providerTargetHash(durableTarget) !== target_binding_sha256 ||
          durableTarget.prompt_sha256 !== dispatch.rendered_prompt_sha256 ||
          durableTarget.billable_attempt_id !== billable_attempt_id ||
          durableTarget.tenant_id !== scope.tenant_id || durableTarget.project_id !== scope.project_id ||
          dispatch.provider_name !== durableTarget.service ||
          durableTarget.operation_kind !== imageProviderRoute(durableTarget.service)?.edit_binding_operation_kind ||
          durableTarget.endpoint !== imageProviderRoute(durableTarget.service)?.edit_endpoint) reject("integrity_error", "concept.dispatch_target");
      const prior = this.db.prepare(`SELECT * FROM creative_concept_response_stages_v1
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=? AND concept_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, action_id, concept_id);
      if (prior) {
        if (prior.billable_attempt_id !== billable_attempt_id || prior.transport_attempt_id !== transport_attempt_id ||
            prior.content_hash !== content_hash || prior.media_type !== media_type || prior.width !== decoded.width ||
            prior.height !== decoded.height || !Buffer.from(prior.response_bytes).equals(Buffer.from(bytes))) {
          reject("conflict", "concept.response_identity");
        }
        this.db.exec("COMMIT");
        return freezeReturned({ status: "replayed", stage_ref: prior.stage_ref, content_hash: prior.content_hash });
      }
      const now = this.timestamp();
      this.db.prepare(`INSERT INTO creative_concept_response_stages_v1
        (tenant_id,project_id,brief_id,action_id,concept_id,billable_attempt_id,transport_attempt_id,reservation_ref,
         dispatch_intent_ref,target_binding_sha256,content_hash,media_type,width,height,byte_length,response_bytes,stage_ref,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'response_received',?,?)`)
        .run(scope.tenant_id, scope.project_id, scope.brief_id, action_id, concept_id, billable_attempt_id,
          transport_attempt_id, reservation_ref, dispatch_intent_ref, target_binding_sha256, content_hash,
          media_type, decoded.width, decoded.height, bytes.byteLength, Buffer.from(bytes), stage_ref, now, now);
      this.db.exec("COMMIT");
      return freezeReturned({ status: "staged", stage_ref, content_hash });
    } catch (error) {
      this.rollback();
      if (error instanceof VersionStoreError) throw error;
      reject("unavailable", "concept.response_stage", true);
    }
  }

  recordConceptDispatchBinding(input) {
    this.assertOpen();
    this.assertNoBorrowedTransaction("concept.dispatch_binding.transaction");
    if (!isRecord(input) || !isRecord(input.scope)) reject("invalid_request", "concept.dispatch_binding");
    const scope = validScope(input.scope, input.brief_id ?? input.scope.brief_id);
    const actor_id = reference(input.actor_id, "actor_id");
    const job_id = reference(input.job_id, "job_id");
    const action_id = reference(input.action_id, "action_id");
    const request_hash = hash(input.request_hash, "request_hash");
    const lease_token = reference(input.lease_token, "lease_token");
    const billable_attempt_id = reference(input.billable_attempt_id, "billable_attempt_id");
    const transport_attempt_id = reference(input.transport_attempt_id, "transport_attempt_id");
    const reservation_ref = reference(input.reservation_ref, "reservation_ref");
    const dispatch_intent_ref = reference(input.dispatch_intent_ref, "dispatch_intent_ref");
    if (!isRecord(input.target_binding)) reject("invalid_request", "concept.target_binding");
    let target_binding_json;
    let target_binding;
    try {
      target_binding_json = JSON.stringify(input.target_binding);
      if (typeof target_binding_json !== "string" || Buffer.byteLength(target_binding_json, "utf8") > 32 * 1024) {
        reject("invalid_request", "concept.target_binding");
      }
      target_binding = JSON.parse(target_binding_json);
      if (JSON.stringify(target_binding) !== target_binding_json) reject("invalid_request", "concept.target_binding");
    } catch (error) {
      if (error instanceof VersionStoreError) throw error;
      reject("invalid_request", "concept.target_binding");
    }
    const target_binding_sha256 = hash(input.target_binding_sha256, "target_binding_sha256");
    const rendered_prompt_sha256 = hash(input.rendered_prompt_sha256, "rendered_prompt_sha256");
    const nativeRoute = isRecord(target_binding) ? imageProviderRoute(target_binding.service) : undefined;
    if (providerTargetHash(target_binding) !== target_binding_sha256 || !isRecord(target_binding) || !nativeRoute ||
        target_binding.endpoint !== nativeRoute.edit_endpoint ||
        target_binding.operation !== "edit" || target_binding.operation_kind !== nativeRoute.edit_binding_operation_kind ||
        target_binding.sdk_name !== "native-fetch" || target_binding.prompt_sha256 !== rendered_prompt_sha256 ||
        target_binding.tenant_id !== scope.tenant_id || target_binding.project_id !== scope.project_id ||
        target_binding.billable_attempt_id !== billable_attempt_id ||
        !isRecord(target_binding.transport_policy) || target_binding.transport_policy.maximum_transport_attempts !== 1 ||
        target_binding.transport_policy.automatic_retry !== false || !Array.isArray(target_binding.transport_policy.stop_on)) {
      reject("integrity_error", "concept.target_binding");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
        .get(scope.tenant_id, scope.project_id, job_id);
      const batch = this.db.prepare(`SELECT job_id,request_hash FROM creative_concept_batches_v1
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, action_id);
      const dispatch = this.db.prepare(`SELECT billable_attempt_id,reservation_ref,dispatch_intent_ref,provider_name,provider_model,
        target_binding_sha256,target_binding_json,rendered_prompt_sha256
        FROM creative_dispatch_intents WHERE tenant_id=? AND project_id=? AND job_id=? AND transport_attempt_id=?`)
        .get(scope.tenant_id, scope.project_id, job_id, transport_attempt_id);
      if (!activeJobLease(job, scope, actor_id, lease_token, this.now()) ||
          job.operation !== "concepts.create" || job.action_id !== action_id || job.request_hash !== request_hash ||
          !batch || batch.job_id !== job_id || batch.request_hash !== request_hash ||
          !dispatch || dispatch.billable_attempt_id !== billable_attempt_id || dispatch.reservation_ref !== reservation_ref ||
          dispatch.dispatch_intent_ref !== dispatch_intent_ref) reject("cancelled", "concept.dispatch_binding.authority");
      if (!dispatch || dispatch.billable_attempt_id !== billable_attempt_id || dispatch.reservation_ref !== reservation_ref ||
          dispatch.dispatch_intent_ref !== dispatch_intent_ref || dispatch.provider_name !== target_binding.service ||
          dispatch.provider_model !== target_binding.model) reject("integrity_error", "concept.dispatch_target");
      const prior = this.db.prepare(`SELECT target_binding_sha256,target_binding_json,rendered_prompt_sha256
        FROM creative_concept_dispatch_bindings_v1
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=? AND transport_attempt_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, action_id, transport_attempt_id);
      if (prior) {
        if (prior.target_binding_sha256 !== target_binding_sha256 || prior.target_binding_json !== target_binding_json ||
            prior.rendered_prompt_sha256 !== rendered_prompt_sha256) reject("conflict", "concept.dispatch_binding.identity");
        this.db.exec("COMMIT");
        return freezeReturned({ status: "replayed", transport_attempt_id, target_binding_sha256 });
      }
      if (dispatch.target_binding_sha256 !== null || dispatch.target_binding_json !== null ||
          dispatch.rendered_prompt_sha256 !== null) reject("conflict", "concept.dispatch_binding.identity");
      const boundDispatch = this.db.prepare(`UPDATE creative_dispatch_intents
        SET target_binding_sha256=?,target_binding_json=?,rendered_prompt_sha256=?
        WHERE tenant_id=? AND project_id=? AND job_id=? AND transport_attempt_id=?
          AND target_binding_sha256 IS NULL AND target_binding_json IS NULL AND rendered_prompt_sha256 IS NULL`)
        .run(target_binding_sha256, target_binding_json, rendered_prompt_sha256,
          scope.tenant_id, scope.project_id, job_id, transport_attempt_id).changes;
      if (boundDispatch !== 1) reject("conflict", "concept.dispatch_binding.identity");
      this.db.prepare(`INSERT INTO creative_concept_dispatch_bindings_v1
        (tenant_id,project_id,brief_id,action_id,job_id,billable_attempt_id,transport_attempt_id,reservation_ref,
         dispatch_intent_ref,target_binding_sha256,target_binding_json,rendered_prompt_sha256,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(scope.tenant_id, scope.project_id, scope.brief_id, action_id, job_id, billable_attempt_id,
          transport_attempt_id, reservation_ref, dispatch_intent_ref, target_binding_sha256, target_binding_json,
          rendered_prompt_sha256, this.timestamp());
      this.db.exec("COMMIT");
      return freezeReturned({ status: "recorded", transport_attempt_id, target_binding_sha256 });
    } catch (error) {
      this.rollback();
      if (error instanceof VersionStoreError) throw error;
      reject("unavailable", "concept.dispatch_binding", true);
    }
  }

  async prepareConceptArtifactObjects(input) {
    this.assertOpen();
    this.assertNoBorrowedTransaction("concept.artifact_prepare.transaction");
    if (!isRecord(input) || !Array.isArray(input.concept_ids) || input.concept_ids.length < 1 || input.concept_ids.length > 2) {
      reject("invalid_request", "concept.artifact_prepare");
    }
    const scope = validScope(input.scope, input.brief_id ?? input.scope?.brief_id);
    const action_id = reference(input.action_id, "action_id");
    const concept_ids = input.concept_ids.map((value, index) => reference(value, `concept_ids[${index}]`));
    if (new Set(concept_ids).size !== concept_ids.length) reject("invalid_request", "concept_ids");
    const results = [];
    for (const concept_id of concept_ids) {
      const stage = this.getConceptResponseStage({ scope, action_id, concept_id });
      if (!stage || !["response_received", "published"].includes(stage.status)) {
        reject("conflict", "concept.response_stage");
      }
      try {
        const written = await writeContentAddressedObject(this.objectRoot, stage.response_bytes, stage.content_hash);
        if (written?.content_hash !== stage.content_hash) reject("integrity_error", "concept.artifact_hash");
      } catch (error) {
        if (error instanceof VersionStoreError) throw error;
        if (error instanceof ContentAddressedStorageError && error.code === "hash_mismatch") {
          reject("integrity_error", "concept.artifact_hash");
        }
        reject("unavailable", "concept.artifact_storage", true);
      }
      results.push(Object.freeze({ concept_id, content_hash: stage.content_hash,
        byte_length: stage.byte_length, status: "object_durable" }));
    }
    return freezeReturned({ action_id, artifacts: results });
  }

  publishConceptBatch(input, transaction) {
    this.assertOpen();
    const publication = this.publicationTransactionData(transaction);
    if (!publication || this.db.isTransaction !== true || !isRecord(input) || !Array.isArray(input.publications) ||
        input.publications.length > 2) reject("scope_denied", "publication_transaction");
    const scope = validScope(input.scope, input.brief_id ?? input.scope?.brief_id);
    const actor_id = reference(input.actor_id, "actor_id");
    const job_id = reference(input.job_id, "job_id");
    const action_id = reference(input.action_id, "action_id");
    const request_hash = hash(input.request_hash, "request_hash");
    if (publication.actor_id !== actor_id || publication.job_id !== job_id || publication.action_id !== action_id ||
        publication.request_hash !== request_hash || publication.scope.tenant_id !== scope.tenant_id ||
        publication.scope.project_id !== scope.project_id || publication.scope.brief_id !== scope.brief_id) {
      reject("scope_denied", "publication_transaction");
    }
    const batchRow = this.db.prepare(`SELECT * FROM creative_concept_batches_v1
      WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=?`)
      .get(scope.tenant_id, scope.project_id, scope.brief_id, action_id);
    const job = this.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
      .get(scope.tenant_id, scope.project_id, job_id);
    if (!batchRow || batchRow.job_id !== job_id || batchRow.actor_id !== actor_id || batchRow.request_hash !== request_hash ||
        !activeJobLease(job, scope, actor_id, publication.lease_token, this.now())) reject("cancelled", "concept.publication_authority");
    let batch = snapshotJson(JSON.parse(batchRow.batch_json), "integrity_error", "concept.batch");
    const seen = new Set();
    const published = [];
    const genericWrites = [];
    let lastOrdinal = 0;
    for (const candidate of input.publications) {
      if (!isRecord(candidate) || Object.keys(candidate).some((key) => ![
        "concept_id", "ordinal", "design_version", "creation", "storage_commit_ref", "lineage_evidence_ref",
        "creative_concept_lineage", "event_id",
      ].includes(key))) reject("invalid_request", "concept.publication");
      const concept_id = reference(candidate.concept_id, "concept_id");
      if (seen.has(concept_id)) reject("invalid_request", "concept.publication.concept_id");
      seen.add(concept_id);
      const design = snapshotJson(candidate.design_version, "invalid_request", "concept.design_version");
      const design_version_id = reference(design.design_version_id, "design_version_id");
      const version = validateDesignVersion(design, {
        trustedScope: { ...scope, design_version_id },
        brief_hash: batch.brief_sha256,
        known_source_refs: batch.references.map((reference) => reference.source_ref),
      });
      const expectedSourceRefs = [...new Set(batch.references.map((reference) => reference.source_ref))];
      if (version.parent_version_id !== null || version.brief_id !== scope.brief_id ||
          version.source_refs.length !== expectedSourceRefs.length ||
          !expectedSourceRefs.every((sourceRef) => version.source_refs.includes(sourceRef))) {
        reject("integrity_error", "concept.design_version_lineage");
      }
      const stage = this.db.prepare(`SELECT * FROM creative_concept_response_stages_v1
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=? AND concept_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, action_id, concept_id);
      if (!stage || stage.status !== "response_received" || stage.content_hash !== version.artifact.content_hash ||
          stage.media_type !== version.artifact.media_type || stage.target_binding_sha256 === null ||
          candidate.storage_commit_ref !== `concept-store:${canonicalHash({ concept_id, design_hash: version.design_hash,
            artifact_hash: version.artifact.content_hash })}`) {
        reject("integrity_error", "concept.publication_stage");
      }
      const object = readStoredObjectSync(this.objectRoot, stage.content_hash);
      if (!object || object.byteLength !== stage.byte_length || hashArtifactBytes(object) !== stage.content_hash ||
          !Buffer.from(object).equals(Buffer.from(stage.response_bytes))) reject("integrity_error", "concept.artifact_object");
      const slot = batch.slots.find((item) => item.concept_id === concept_id);
      const attempt = slot?.attempts.find((item) => item.billable_attempt_id === stage.billable_attempt_id);
      if (!slot || !attempt || slot.status !== "staged" || slot.current_billable_attempt_id !== stage.billable_attempt_id ||
          attempt.transport_attempt_id !== stage.transport_attempt_id ||
          attempt.provider_target_binding_sha256 !== stage.target_binding_sha256) reject("conflict", "concept.publication_attempt");
      if (candidate.ordinal !== slot.ordinal || slot.ordinal <= lastOrdinal || !isRecord(candidate.creation)) {
        reject("integrity_error", "concept.publication_order");
      }
      lastOrdinal = slot.ordinal;
      const candidateActionId = slot.ordinal === 1
        ? action_id : `concept-version-${canonicalHash({ action_id, concept_id }).slice(7)}`;
      const creation = snapshotJson({ ...candidate.creation, job_id, actor_id, request_hash, action_id: candidateActionId },
        "invalid_request", "concept.version_creation");
      if (creation.billable_attempt_id !== stage.billable_attempt_id ||
          !Array.isArray(creation.transport_attempt_ids) || !creation.transport_attempt_ids.includes(stage.transport_attempt_id)) {
        reject("integrity_error", "concept.version_creation");
      }
      const brief = this.getBrief({ scope, brief_id: scope.brief_id });
      if (!brief || canonicalHash(brief) !== batch.brief_sha256) reject("stale_version", "concept.brief_hash");
      genericWrites.push({ scope, brief_id: scope.brief_id, actor_id, brief_snapshot: brief,
        design_version: version, artifact_bytes: Uint8Array.from(stage.response_bytes), selection: { mode: "concept" },
        creation, configuration_snapshot: batch.adapter_snapshot.configuration,
        concept_identity: { concept_id, ordinal: slot.ordinal } });
      const event = snapshotJson({
        tenant_id: batch.tenant_id, project_id: batch.project_id, action_id,
        batch_id: batch.batch_id, concept_id, event_id: candidate.event_id,
        event_type: "candidate_published", billable_attempt_id: stage.billable_attempt_id,
        transport_attempt_id: stage.transport_attempt_id, design_version: version,
        storage_commit_ref: candidate.storage_commit_ref, lineage_evidence_ref: candidate.lineage_evidence_ref,
      }, "invalid_request", "concept.publication_event");
      let applied;
      try { applied = applyCreativeConceptEvent(batch, event); }
      catch { reject("integrity_error", "concept.publication_event"); }
      if (applied.status !== "applied") reject("conflict", "concept.publication_event");
      batch = applied.batch;
      const publishedSlot = batch.slots.find((item) => item.concept_id === concept_id);
      const conceptLineage = creativeConceptLineage(batch, publishedSlot, version);
      if (!isRecord(candidate.creative_concept_lineage) ||
          canonicalSerialize(candidate.creative_concept_lineage) !== canonicalSerialize(conceptLineage) ||
          candidate.lineage_evidence_ref !== `concept-lineage:${canonicalHash(conceptLineage)}`) {
        reject("integrity_error", "concept.publication_lineage");
      }
      const eventHash = canonicalHash(event);
      const nextSequence = this.db.prepare(`SELECT COALESCE(MAX(sequence),0)+1 AS next FROM creative_concept_events_v1
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, action_id).next;
      this.db.prepare(`INSERT INTO creative_concept_events_v1
        (tenant_id,project_id,brief_id,action_id,sequence,event_id,event_type,event_hash,event_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(scope.tenant_id, scope.project_id, scope.brief_id, action_id,
        nextSequence, event.event_id, event.event_type, eventHash, canonicalSerialize(event), this.timestamp());
      this.db.prepare(`INSERT INTO creative_concept_versions_v1
        (tenant_id,project_id,brief_id,action_id,concept_id,ordinal,design_version_id,design_hash,artifact_id,
         artifact_hash,media_type,parent_version_id,lineage_json,design_version_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)`)
        .run(scope.tenant_id, scope.project_id, scope.brief_id, action_id, concept_id, slot.ordinal,
          version.design_version_id, version.design_hash, version.artifact.artifact_id, version.artifact.content_hash,
          version.artifact.media_type, canonicalSerialize({ output_lineage: publishedSlot.output_lineage,
            creative_concept_lineage: conceptLineage, storage_commit_ref: candidate.storage_commit_ref,
            lineage_evidence_ref: candidate.lineage_evidence_ref }),
          canonicalSerialize(version), this.timestamp());
      this.db.prepare(`UPDATE creative_concept_response_stages_v1 SET status='published',updated_at=?
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=? AND concept_id=? AND status='response_received'`)
        .run(this.timestamp(), scope.tenant_id, scope.project_id, scope.brief_id, action_id, concept_id);
      published.push({ concept_id, ordinal: slot.ordinal, design_version: version,
        creative_concept_lineage: conceptLineage, storage_commit_ref: candidate.storage_commit_ref,
        lineage_evidence_ref: candidate.lineage_evidence_ref });
    }
    const genericVersions = genericWrites.length ? this.commitConceptDesignVersions(genericWrites, transaction) : [];
    if (genericVersions.length !== published.length || genericVersions.some((value, index) =>
      canonicalSerialize(value.design_version) !== canonicalSerialize(published[index].design_version))) {
      reject("integrity_error", "concept.public_design_versions");
    }
    const hasUnknown = batch.slots.some((slot) => slot.attempts.some((attempt) => attempt.unknown_financial_exposure));
    const allSucceeded = batch.slots.every((slot) => slot.status === "succeeded");
    const hasSuccess = batch.slots.some((slot) => slot.status === "succeeded");
    const hasTerminalPartial = batch.slots.some((slot) => ["failed", "cancelled", "unknown"].includes(slot.status));
    const status = hasUnknown ? "unknown_hold" : allSucceeded ? "completed" :
      hasSuccess || hasTerminalPartial ? "partial" : "running";
    this.db.prepare(`UPDATE creative_concept_batches_v1 SET batch_json=?,status=?,updated_at=?
      WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=?`)
      .run(canonicalSerialize(batch), status, this.timestamp(), scope.tenant_id, scope.project_id, scope.brief_id, action_id);
    const allCandidates = this.getConceptVersions({ scope, action_id });
    const result = freezeReturned({ contract: "CreativeConceptBatchResult", schema_version: "1.1",
      batch_id: batch.batch_id, status, requested_count: batch.requested_count,
      progress: batch.slots.map((slot) => ({ concept_id: slot.concept_id, ordinal: slot.ordinal,
        status: slot.status, attempts: slot.attempts.length,
        billable_attempt_id: slot.current_billable_attempt_id })), candidates: allCandidates });
    if (canonicalSerialize(publication.result) !== canonicalSerialize(input.expected_result) ||
        canonicalSerialize(publication.result.candidate_batch) !== canonicalSerialize(result)) {
      reject("integrity_error", "concept.publication_result");
    }
    return result;
  }

  getConceptVersions(input) {
    this.assertOpen();
    const scope = validScope(input?.scope, input?.brief_id ?? input?.scope?.brief_id);
    const action_id = reference(input?.action_id, "action_id");
    const rows = this.db.prepare(`SELECT * FROM creative_concept_versions_v1
      WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=? ORDER BY ordinal`)
      .all(scope.tenant_id, scope.project_id, scope.brief_id, action_id);
    return freezeReturned(rows.map((row) => {
      const design_version = snapshotJson(JSON.parse(row.design_version_json), "integrity_error", "concept.design_version");
      const lineageRecord = snapshotJson(JSON.parse(row.lineage_json), "integrity_error", "concept.lineage");
      const output_lineage = lineageRecord.output_lineage;
      const creative_concept_lineage = lineageRecord.creative_concept_lineage;
      const generic = this.getDesignVersion({ scope, brief_id: scope.brief_id, design_version_id: row.design_version_id });
      if (row.parent_version_id !== null || design_version.parent_version_id !== null ||
          design_version.design_version_id !== row.design_version_id || design_version.design_hash !== row.design_hash ||
          design_version.artifact?.content_hash !== row.artifact_hash || output_lineage.design_version_id !== row.design_version_id ||
          output_lineage.design_sha256 !== row.design_hash || output_lineage.artifact_id !== row.artifact_id ||
          output_lineage.artifact_sha256 !== row.artifact_hash || output_lineage.artifact_media_type !== row.media_type ||
          !generic || canonicalSerialize(generic) !== canonicalSerialize(design_version)) reject("integrity_error", "concept.version");
      const batchRow = this.db.prepare(`SELECT batch_json,job_id FROM creative_concept_batches_v1
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, row.action_id);
      if (!batchRow) reject("integrity_error", "concept.batch");
      const batch = snapshotJson(JSON.parse(batchRow.batch_json), "integrity_error", "concept.batch");
      const slot = batch.slots.find((item) => item.concept_id === row.concept_id);
      const expectedActionId = row.ordinal === 1 ? action_id
        : `concept-version-${canonicalHash({ action_id, concept_id: row.concept_id }).slice(7)}`;
      const versionIdentity = this.db.prepare(`SELECT action_id,creation_job_id FROM design_versions
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND design_version_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, row.design_version_id);
      if (!slot || slot.ordinal !== row.ordinal || versionIdentity?.action_id !== expectedActionId ||
          versionIdentity.creation_job_id !== batchRow.job_id) reject("integrity_error", "concept.version_identity");
      const expectedLineage = creativeConceptLineage(batch, slot, design_version);
      if (!isRecord(lineageRecord) || canonicalSerialize(Object.keys(lineageRecord).sort()) !==
          canonicalSerialize(["creative_concept_lineage", "lineage_evidence_ref", "output_lineage", "storage_commit_ref"].sort()) ||
          canonicalSerialize(creative_concept_lineage) !== canonicalSerialize(expectedLineage) ||
          lineageRecord.storage_commit_ref !== `concept-store:${canonicalHash({ concept_id: row.concept_id,
            design_hash: design_version.design_hash, artifact_hash: design_version.artifact.content_hash })}` ||
          lineageRecord.lineage_evidence_ref !== `concept-lineage:${canonicalHash(expectedLineage)}`) reject("integrity_error", "concept.lineage");
      const object = readStoredObjectSync(this.objectRoot, row.artifact_hash);
      if (!object || hashArtifactBytes(object) !== row.artifact_hash) reject("integrity_error", "concept.artifact_object");
      return { concept_id: row.concept_id, ordinal: row.ordinal, design_version,
        creative_concept_lineage, storage_commit_ref: lineageRecord.storage_commit_ref,
        lineage_evidence_ref: lineageRecord.lineage_evidence_ref };
    }));
  }

  getConceptBatch(input) {
    this.assertOpen();
    const scope = validScope(input?.scope, input?.brief_id ?? input?.scope?.brief_id);
    const action_id = reference(input?.action_id, "action_id");
    const row = this.db.prepare(`SELECT * FROM creative_concept_batches_v1
      WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=?`)
      .get(scope.tenant_id, scope.project_id, scope.brief_id, action_id);
    if (!row) return null;
    const batch = snapshotJson(JSON.parse(row.batch_json), "integrity_error", "concept.batch");
    if (batch.batch_id !== row.batch_id || batch.action_id !== row.action_id || batch.tenant_id !== row.tenant_id ||
        batch.project_id !== row.project_id || batch.brief_id !== row.brief_id) reject("integrity_error", "concept.batch_identity");
    return freezeReturned({ batch, status: row.status, job_id: row.job_id, request_hash: row.request_hash,
      actor_id: row.actor_id, updated_at: row.updated_at });
  }

  getConceptResponseStage(input) {
    this.assertOpen();
    const scope = validScope(input?.scope, input?.brief_id ?? input?.scope?.brief_id);
    const action_id = reference(input?.action_id, "action_id");
    const concept_id = reference(input?.concept_id, "concept_id");
    const row = this.db.prepare(`SELECT * FROM creative_concept_response_stages_v1
      WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=? AND concept_id=?`)
      .get(scope.tenant_id, scope.project_id, scope.brief_id, action_id, concept_id);
    if (!row) return null;
    const bytes = Uint8Array.from(row.response_bytes);
    if (bytes.byteLength !== row.byte_length || hashArtifactBytes(bytes) !== row.content_hash) reject("integrity_error", "concept.response_bytes");
    return Object.freeze({ concept_id, billable_attempt_id: row.billable_attempt_id,
      transport_attempt_id: row.transport_attempt_id, reservation_ref: row.reservation_ref,
      dispatch_intent_ref: row.dispatch_intent_ref, target_binding_sha256: row.target_binding_sha256,
      content_hash: row.content_hash, media_type: row.media_type, width: row.width, height: row.height,
      byte_length: row.byte_length, response_bytes: bytes, stage_ref: row.stage_ref, status: row.status });
  }

  prepareWrite(input, { allowConcept = false } = {}) {
    this.assertOpen();
    if (!isRecord(input)) reject("invalid_request", "write");
    const designInput = snapshotJson(input.design_version, "invalid_request", "design_version");
    const briefInput = snapshotJson(input.brief_snapshot, "invalid_request", "brief_snapshot");
    const briefId = reference(input.brief_id ?? designInput.brief_id, "brief_id");
    const scope = validScope(input.scope, briefId);
    const actor_id = reference(input.actor_id ?? input.creation?.actor_id, "actor_id");
    if (!(input.artifact_bytes instanceof Uint8Array) || input.artifact_bytes.byteLength === 0 ||
      input.artifact_bytes.byteLength > this.maxArtifactBytes) reject("invalid_request", "artifact_bytes");
    const artifactBytes = Uint8Array.from(input.artifact_bytes);
    const contentHash = hashArtifactBytes(artifactBytes);
    if (contentHash !== designInput.artifact?.content_hash) reject("integrity_error", "artifact_bytes");
    const brief = validateCreativeBrief(briefInput, { trustedScope: scope });
    const briefHash = canonicalHash(brief);
    if (designInput.brief_hash !== briefHash) reject("stale_version", "brief_hash");
    this.#assertBriefNotInvalidated(scope, brief);
    const design = validateDesignVersion(designInput, {
      trustedScope: { ...scope, design_version_id: designInput.design_version_id },
      brief_hash: briefHash,
      known_source_refs: brief.source_identity.map((source) => source.source_id),
    });
    if (design.design_hash !== computeDesignVersionHash(design)) reject("integrity_error", "design_hash");
    const creation = attemptEvidence(input.creation);
    if (creation.actor_id !== actor_id) reject("scope_denied", "creation.actor_id");
    const selection = selectionRequest(input.selection, design);
    if (selection.mode === "concept" && allowConcept !== true) reject("invalid_request", "selection.mode");
    const parentDesignHash = design.parent_version_id === null
      ? null : getDesignHashAt(this.db, scope, design.parent_version_id);
    if (design.parent_version_id !== null && parentDesignHash === null) reject("not_found", "design_version.parent_version_id");
    if (design.parent_version_id === null && creation.parent_design_hash !== undefined) reject("invalid_request", "creation.parent_design_hash");
    if (design.parent_version_id !== null && creation.parent_design_hash !== parentDesignHash) {
      reject("stale_version", "creation.parent_design_hash");
    }
    if (selection.mode === "branch" && design.parent_version_id === null) reject("invalid_request", "selection.mode");
    if (selection.mode === "advance" && design.parent_version_id !== selection.expected_selected_design_version_id) {
      const prior = selection.expected_selected_design_version_id === null ? null : this.db.prepare(`SELECT brief_hash
        FROM design_versions WHERE tenant_id=? AND project_id=? AND brief_id=? AND design_version_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, selection.expected_selected_design_version_id);
      if (design.parent_version_id !== null || !prior || prior.brief_hash === briefHash) {
        reject("stale_version", "design_version.parent_version_id");
      }
    }
    const configuration = configurationSnapshot(input.configuration_snapshot);
    const now = this.timestamp();
    const context = deepFreeze({
      brief_snapshot: brief,
      brief_hash: briefHash,
      fact_hash: canonicalHash(brief.facts),
      permission_hash: canonicalHash(brief.permissions),
      lock_hash: canonicalHash(brief.locks),
      source_identity_hash: canonicalHash(brief.source_identity),
      configuration_snapshot: configuration,
      configuration_hash: configuration === null ? null : canonicalHash(configuration),
    });
    const evidence = deepFreeze({
      creation,
      usage_refs: creation.usage_refs ?? [],
      trace_refs: creation.trace_refs ?? [],
      attempt_identities: Object.freeze({
        ...(creation.logical_operation_id ? { logical_operation_id: creation.logical_operation_id } : {}),
        ...(creation.billable_attempt_id ? { billable_attempt_id: creation.billable_attempt_id } : {}),
        transport_attempt_ids: creation.transport_attempt_ids ?? [],
        provider_request_ids: creation.provider_request_ids ?? [],
      }),
    });
    const jobResult = input.job_result === undefined ? null
      : deepFreeze(snapshotJson(input.job_result, "invalid_request", "job_result"));
    if (jobResult !== null && (!isRecord(jobResult) || jobResult.design?.design_version_id !== design.design_version_id)) {
      reject("invalid_request", "job_result");
    }
    const publicationFence = input.publication_fence === undefined ? null
      : deepFreeze(snapshotJson(input.publication_fence, "invalid_request", "publication_fence"));
    if (jobResult !== null) {
      if (publicationFence === null) reject("invalid_request", "publication_fence");
      assertRecoveryFenceMatchesIntent(this, publicationFence, scope, {
        context: { brief_hash: briefHash }, evidence: { creation }, selection, design_version: design, job_result: jobResult,
      });
      if (!publicationFenceCurrent(this, scope, publicationFence)) reject("stale_version", "publication_fence");
    }
    const intent = deepFreeze({
      storage_contract: "CreativeVersionCommitIntent",
      schema_version: "1.0",
      scope, actor_id, brief_id: briefId, design_version: design,
      artifact: { content_hash: contentHash, byte_length: artifactBytes.byteLength },
      context, evidence, selection, created_at: now,
      job_result: jobResult,
      ...(publicationFence !== null ? { publication_fence: publicationFence } : {}),
    });
    const { created_at: _createdAt, ...stableIntent } = intent;
    const payload_hash = canonicalHash(stableIntent);
    return { scope, actor_id, brief_id: briefId, design, brief, artifactBytes, contentHash,
      creation, selection, context, evidence, intent, payload_hash, now };
  }

  async prepareDesignVersion(input, { faultInjector } = {}) {
    const prepared = this.prepareWrite(input);
    if (input.lease_token !== undefined) {
      const job = this.db.prepare(`SELECT actor_id,action_id,request_hash,status,lease_hash,lease_expires_at,attempt_evidence_json
        FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
        .get(prepared.scope.tenant_id, prepared.scope.project_id, prepared.creation.job_id);
      if (!job || job.actor_id !== prepared.actor_id || job.action_id !== prepared.creation.action_id ||
        job.request_hash !== prepared.creation.request_hash || job.status !== "running" ||
        job.lease_hash !== createHash("sha256").update(input.lease_token).digest("hex") ||
        Date.parse(job.lease_expires_at) <= this.now()) reject("cancelled", "job.lease_token");
      if (typeof job.attempt_evidence_json !== "string" ||
        job.attempt_evidence_json !== canonicalSerialize(prepared.creation)) {
        reject("integrity_error", "job.attempt_evidence");
      }
    }
    try {
      await writeContentAddressedObject(this.objectRoot, prepared.artifactBytes, prepared.contentHash);
    } catch (error) {
      if (error instanceof ContentAddressedStorageError && error.code === "hash_mismatch") {
        reject("integrity_error", "artifact_bytes");
      }
      reject("unavailable", "artifact_storage", true);
    }
    injectFault(faultInjector, "after_object_write");

    let prior;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (input.lease_token !== undefined) {
        const job = this.db.prepare(`SELECT actor_id,action_id,request_hash,status,lease_hash,lease_expires_at,attempt_evidence_json
          FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
          .get(prepared.scope.tenant_id, prepared.scope.project_id, prepared.creation.job_id);
        if (!job || job.actor_id !== prepared.actor_id || job.action_id !== prepared.creation.action_id ||
          job.request_hash !== prepared.creation.request_hash || job.status !== "running" ||
          job.lease_hash !== createHash("sha256").update(input.lease_token).digest("hex") ||
          Date.parse(job.lease_expires_at) <= this.now()) reject("cancelled", "job.lease_token");
        if (typeof job.attempt_evidence_json !== "string" ||
          job.attempt_evidence_json !== canonicalSerialize(prepared.creation)) {
          reject("integrity_error", "job.attempt_evidence");
        }
      }
      prior = this.db.prepare(`SELECT * FROM creation_actions
        WHERE tenant_id=? AND project_id=? AND action_id=?`)
        .get(prepared.scope.tenant_id, prepared.scope.project_id, prepared.creation.action_id);
      if (prior) {
        this.assertSameAction(prior, prepared);
      } else {
        this.db.prepare(`INSERT INTO creation_actions
          (tenant_id,project_id,brief_id,action_id,actor_id,job_id,request_hash,payload_hash,state,intent_json,result_json,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,'commit_intent',?,NULL,?,?)`)
          .run(prepared.scope.tenant_id, prepared.scope.project_id, prepared.scope.brief_id, prepared.creation.action_id,
            prepared.actor_id, prepared.creation.job_id, prepared.creation.request_hash,
            prepared.payload_hash, canonicalSerialize(prepared.intent), prepared.now, prepared.now);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.rollback();
      if (error instanceof VersionStoreError) throw error;
      reject("conflict", "creation.action_id");
    }
    if (prior?.state === "committed") return this.readActionResult(prior, true);
    if (prior?.state === "unknown") reject("unknown_completion", "creation.action_id");
    if (prior?.state === "cancelled") reject("cancelled", "creation.action_id");
    if (prior?.state === "conflict") {
      const priorResult = prior.result_json ? snapshotJson(JSON.parse(prior.result_json), "integrity_error", "creation.result") : null;
      if (priorResult?.status === "stale" && priorResult.code === "stale_version") return deepFreeze({ ...priorResult, replayed: true });
      reject("conflict", "creation.action_id");
    }
    injectFault(faultInjector, "after_commit_intent");
    return freezeReturned({ status: "prepared", action_id: prepared.creation.action_id,
      job_id: prepared.creation.job_id, payload_hash: prepared.payload_hash });
  }

  async saveDesignVersion(input, options = {}) {
    const result = await this.prepareDesignVersion(input, options);
    if (result.status === "saved" || result.status === "stale") return result;
    if (result.status !== "prepared") reject("unavailable", "creation.intent");
    const scope = validScope(input.scope, input.brief_id ?? input.design_version?.brief_id);
    const finalized = await this.finalizeAction(scope, result.action_id, options.faultInjector);
    if (finalized.status === "unknown") reject("unknown_completion", "creation.action_id");
    return finalized;
  }

  async commitPreparedDesignVersion(input, transaction) {
    const publication = this.publicationTransactionData(transaction);
    if (!publication || !isRecord(input)) reject("scope_denied", "publication_transaction");
    const briefId = reference(input.brief_id, "brief_id");
    const scope = validScope(input.scope, briefId);
    const actionId = reference(input.action_id, "action_id");
    const jobId = reference(input.job_id, "job_id");
    const payloadHash = hash(input.payload_hash, "payload_hash");
    if (publication.job_id !== jobId || publication.action_id !== actionId ||
      publication.scope.tenant_id !== scope.tenant_id || publication.scope.project_id !== scope.project_id ||
      publication.scope.brief_id !== scope.brief_id) reject("scope_denied", "publication_transaction");
    const row = this.db.prepare(`SELECT * FROM creation_actions WHERE tenant_id=? AND project_id=? AND action_id=?`)
      .get(scope.tenant_id, scope.project_id, actionId);
    if (!row || row.job_id !== jobId || row.payload_hash !== payloadHash || row.state !== "commit_intent") {
      reject("conflict", "creation.action_id");
    }
    const intent = validateCommitIntentRow(row, scope);
    if (intent.actor_id !== publication.actor_id || intent.evidence.creation.request_hash !== publication.request_hash ||
      canonicalSerialize(intent.job_result) !== canonicalSerialize(publication.result)) {
      reject("conflict", "creation.job_result");
    }
    return this.finalizeAction(scope, actionId, publication.faultInjector, transaction);
  }

  commitConceptDesignVersions(inputs, transaction) {
    this.assertOpen();
    const publication = this.publicationTransactionData(transaction);
    if (!publication || this.db.isTransaction !== true || !Array.isArray(inputs) || inputs.length < 1 || inputs.length > 2) {
      reject("scope_denied", "publication_transaction");
    }
    const conceptIdentities = [];
    const prepared = inputs.map((input, index) => {
      if (!isRecord(input)) reject("invalid_request", `concept.design_versions[${index}]`);
      const identity = snapshotJson(input.concept_identity, "invalid_request", `concept.design_versions[${index}].identity`);
      if (!isRecord(identity) || Object.keys(identity).some((key) => !["concept_id", "ordinal"].includes(key)) ||
          Object.keys(identity).length !== 2 || !Number.isSafeInteger(identity.ordinal) || ![1, 2].includes(identity.ordinal)) {
        reject("invalid_request", `concept.design_versions[${index}].identity`);
      }
      const { concept_identity: _conceptIdentity, ...writeInput } = input;
      const value = this.prepareWrite(writeInput, { allowConcept: true });
      conceptIdentities.push(identity);
      const expectedActionId = identity.ordinal === 1 ? publication.action_id
        : `concept-version-${canonicalHash({ action_id: publication.action_id, concept_id: identity.concept_id }).slice(7)}`;
      if (value.selection.mode !== "concept" || value.design.parent_version_id !== null ||
          value.creation.job_id !== publication.job_id || value.creation.actor_id !== publication.actor_id ||
          value.creation.request_hash !== publication.request_hash ||
          value.creation.action_id !== expectedActionId ||
          value.scope.tenant_id !== publication.scope.tenant_id || value.scope.project_id !== publication.scope.project_id ||
          value.scope.brief_id !== publication.scope.brief_id) reject("scope_denied", "concept.design_version_identity");
      return value;
    });
    if (new Set(conceptIdentities.map((identity) => identity.concept_id)).size !== conceptIdentities.length ||
        new Set(conceptIdentities.map((identity) => identity.ordinal)).size !== conceptIdentities.length ||
        conceptIdentities.some((identity, index) => index > 0 && identity.ordinal <= conceptIdentities[index - 1].ordinal)) {
      reject("integrity_error", "concept.design_version_identity");
    }
    const scope = prepared[0].scope;
    const job = this.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
      .get(scope.tenant_id, scope.project_id, publication.job_id);
    if (!activeJobLease(job, scope, publication.actor_id, publication.lease_token, this.now()) ||
        job.action_id !== publication.action_id || job.request_hash !== publication.request_hash || job.operation !== "concepts.create") {
      reject("cancelled", "concept.publication_authority");
    }
    const conceptBatchRow = this.db.prepare(`SELECT batch_json,job_id FROM creative_concept_batches_v1
      WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=?`)
      .get(scope.tenant_id, scope.project_id, scope.brief_id, publication.action_id);
    const conceptBatch = conceptBatchRow
      ? snapshotJson(JSON.parse(conceptBatchRow.batch_json), "integrity_error", "concept.batch") : null;
    if (!conceptBatch || conceptBatchRow.job_id !== publication.job_id || conceptBatch.action_id !== publication.action_id ||
        conceptIdentities.some((identity) => {
          const slot = conceptBatch.slots.find((item) => item.concept_id === identity.concept_id);
          return !slot || slot.ordinal !== identity.ordinal || slot.status !== "staged";
        })) reject("integrity_error", "concept.design_version_identity");
    const brief = this.getBrief({ scope, brief_id: scope.brief_id });
    if (!brief || canonicalHash(brief) !== prepared[0].design.brief_hash ||
        prepared.some((value) => canonicalSerialize(value.brief) !== canonicalSerialize(brief))) {
      reject("stale_version", "concept.brief_hash");
    }
    const priorAction = this.db.prepare(`SELECT 1 AS present FROM creation_actions
      WHERE tenant_id=? AND project_id=? AND action_id=?`).get(scope.tenant_id, scope.project_id, publication.action_id);
    const priorJob = this.db.prepare(`SELECT 1 AS present FROM creation_actions
      WHERE tenant_id=? AND project_id=? AND job_id=?`).get(scope.tenant_id, scope.project_id, publication.job_id);
    if (priorAction || priorJob) reject("conflict", "concept.creation_action");
    const uniqueActionIds = new Set();
    const uniqueVersionIds = new Set();
    for (const value of prepared) {
      if (uniqueActionIds.has(value.creation.action_id) || uniqueVersionIds.has(value.design.design_version_id)) {
        reject("invalid_request", "concept.design_version_identity");
      }
      uniqueActionIds.add(value.creation.action_id);
      uniqueVersionIds.add(value.design.design_version_id);
      const bytes = readStoredObjectSync(this.objectRoot, value.contentHash);
      if (!bytes || bytes.byteLength !== value.artifactBytes.byteLength || hashArtifactBytes(bytes) !== value.contentHash ||
          !Buffer.from(bytes).equals(Buffer.from(value.artifactBytes))) reject("integrity_error", "concept.artifact_object");
      const existing = this.db.prepare(`SELECT 1 AS present FROM design_versions
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND (design_version_id=? OR action_id=?)`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, value.design.design_version_id, value.creation.action_id);
      if (existing) reject("conflict", "concept.design_version_identity");
    }
    const primary = prepared[0];
    // The creation action is the immutable batch/job replay anchor. Its intent
    // can describe a successful later ordinal while the public version keeps
    // that candidate's own deterministic per-slot action identity.
    const { concept_identity: _primaryConceptIdentity, ...primaryWriteInput } = inputs[0];
    const anchor = primary.creation.action_id === publication.action_id ? primary : this.prepareWrite({
      ...primaryWriteInput, creation: { ...primaryWriteInput.creation, action_id: publication.action_id },
    }, { allowConcept: true });
    this.db.prepare(`INSERT INTO creation_actions
      (tenant_id,project_id,brief_id,action_id,actor_id,job_id,request_hash,payload_hash,state,intent_json,result_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,'commit_intent',?,NULL,?,?)`)
      .run(scope.tenant_id, scope.project_id, scope.brief_id, publication.action_id, anchor.actor_id,
        anchor.creation.job_id, anchor.creation.request_hash, anchor.payload_hash,
        canonicalSerialize(anchor.intent), anchor.now, anchor.now);
    const intentRow = this.db.prepare(`SELECT * FROM creation_actions WHERE tenant_id=? AND project_id=? AND action_id=?`)
      .get(scope.tenant_id, scope.project_id, publication.action_id);
    const intent = validateCommitIntentRow(intentRow, scope);
    if (intent.selection.mode !== "concept" || intent.job_result !== null ||
        intent.design_version.design_version_id !== primary.design.design_version_id) reject("integrity_error", "concept.creation_intent");
    const results = [];
    for (const value of prepared) {
      this.#assertBriefNotInvalidated(scope, value.brief);
      const createdAt = this.timestamp();
      const metadata = {
        design_version: value.design,
        artifact: { content_hash: value.contentHash, byte_length: value.artifactBytes.byteLength },
        creation: value.creation,
        context_hash: canonicalHash(value.context),
        evidence_hash: canonicalHash(value.evidence),
      };
      this.db.prepare(`INSERT INTO design_versions
        (tenant_id,project_id,brief_id,design_version_id,parent_version_id,parent_design_hash,brief_hash,design_hash,
         artifact_id,content_hash,media_type,occurred_at,metadata_json,creation_job_id,action_id,created_at)
        VALUES(?,?,?,?,NULL,NULL,?,?,?,?,?,?,?,?,?,?)`)
        .run(scope.tenant_id, scope.project_id, scope.brief_id, value.design.design_version_id,
          value.design.brief_hash, value.design.design_hash, value.design.artifact.artifact_id,
          value.design.artifact.content_hash, value.design.artifact.media_type, value.design.occurred_at,
          canonicalSerialize(metadata), value.creation.job_id, value.creation.action_id, createdAt);
      this.db.prepare(`INSERT INTO version_evidence
        (tenant_id,project_id,brief_id,design_version_id,context_json,context_hash,evidence_json,evidence_hash)
        VALUES(?,?,?,?,?,?,?,?)`)
        .run(scope.tenant_id, scope.project_id, scope.brief_id, value.design.design_version_id,
          canonicalSerialize(value.context), canonicalHash(value.context),
          canonicalSerialize(value.evidence), canonicalHash(value.evidence));
      results.push({ status: "saved", design_version: value.design, selection: null, created_at: createdAt });
    }
    const primaryResult = results[0];
    const update = this.db.prepare(`UPDATE creation_actions SET state='committed',result_json=?,updated_at=?
      WHERE tenant_id=? AND project_id=? AND action_id=? AND state='commit_intent'`)
      .run(canonicalSerialize(primaryResult), primaryResult.created_at,
        scope.tenant_id, scope.project_id, publication.action_id).changes;
    if (update !== 1) reject("conflict", "concept.creation_action");
    const durableRow = this.db.prepare(`SELECT * FROM creation_actions WHERE tenant_id=? AND project_id=? AND action_id=?`)
      .get(scope.tenant_id, scope.project_id, publication.action_id);
    const replay = this.readActionResult(durableRow, false);
    if (canonicalSerialize(replay.design_version) !== canonicalSerialize(primary.design) || replay.selection !== null) {
      reject("integrity_error", "concept.creation_result");
    }
    return freezeReturned(results);
  }

  assertSameAction(row, prepared) {
    if (row.actor_id !== prepared.actor_id) reject("scope_denied", "creation.actor_id");
    if (row.request_hash !== prepared.creation.request_hash || row.payload_hash !== prepared.payload_hash ||
      row.job_id !== prepared.creation.job_id) reject("conflict", "creation.action_id");
  }

  readActionResult(row, replayed = false) {
    if (row.state === "committed" && typeof row.result_json === "string") {
      const result = snapshotJson(JSON.parse(row.result_json), "integrity_error", "creation.result");
      if (!isRecord(result) || result.status !== "saved" || !isRecord(result.design_version) ||
        !isRecord(result.selection) && result.selection !== null || typeof result.created_at !== "string") {
        reject("integrity_error", "creation.result");
      }
      const scope = validScope({ tenant_id: row.tenant_id, project_id: row.project_id }, row.brief_id);
      const intent = validateCommitIntentRow(row, scope);
      if (intent.scope.tenant_id !== scope.tenant_id || intent.scope.project_id !== scope.project_id ||
        intent.actor_id !== row.actor_id ||
        intent.evidence.creation.action_id !== row.action_id || intent.evidence.creation.job_id !== row.job_id ||
        intent.evidence.creation.request_hash !== row.request_hash ||
        result.design_version.design_version_id !== intent.design_version.design_version_id ||
        canonicalSerialize(result.design_version) !== canonicalSerialize(intent.design_version)) {
        reject("integrity_error", "creation.intent");
      }
      const versionRow = this.db.prepare(`SELECT action_id,creation_job_id,created_at FROM design_versions
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND design_version_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, result.design_version.design_version_id);
      const conceptIdentity = intent.selection.mode === "concept"
        ? this.db.prepare(`SELECT concept_id,ordinal FROM creative_concept_versions_v1
            WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=? AND design_version_id=?`)
          .get(scope.tenant_id, scope.project_id, scope.brief_id, row.action_id, result.design_version.design_version_id)
        : null;
      const expectedVersionActionId = intent.selection.mode === "concept" && conceptIdentity
        ? conceptIdentity.ordinal === 1 ? row.action_id
          : `concept-version-${canonicalHash({ action_id: row.action_id, concept_id: conceptIdentity.concept_id }).slice(7)}`
        : row.action_id;
      if (!versionRow || versionRow.action_id !== expectedVersionActionId || versionRow.creation_job_id !== row.job_id ||
        result.created_at !== versionRow.created_at || result.created_at !== row.updated_at) {
        reject("integrity_error", "creation.result");
      }
      if (intent.selection.mode === "concept" && (!conceptIdentity || ![1, 2].includes(conceptIdentity.ordinal))) {
        reject("integrity_error", "creation.result.concept_identity");
      }
      const stored = this.getDesignVersion({ scope, brief_id: scope.brief_id,
        design_version_id: result.design_version.design_version_id });
      if (!stored || canonicalSerialize(stored) !== canonicalSerialize(result.design_version)) {
        reject("integrity_error", "creation.result.design_version");
      }
      const bytes = readStoredObjectSync(this.objectRoot, stored.artifact.content_hash);
      if (!bytes || bytes.byteLength !== intent.artifact.byte_length || hashArtifactBytes(bytes) !== stored.artifact.content_hash) {
        reject("integrity_error", "creation.result.artifact");
      }
      if (result.selection !== null) {
        const selection = result.selection;
        if (intent.selection.mode !== "advance" || selection.tenant_id !== scope.tenant_id ||
          selection.project_id !== scope.project_id || selection.brief_id !== scope.brief_id ||
          selection.design_version_id !== stored.design_version_id || selection.design_hash !== stored.design_hash ||
          selection.revision !== intent.selection.expected_revision + 1 ||
          Object.keys(selection).some((key) => !["tenant_id", "project_id", "brief_id", "design_version_id", "design_hash", "revision"].includes(key))) {
          reject("integrity_error", "creation.result.selection");
        }
      } else if (intent.selection.mode !== "branch" && intent.selection.mode !== "concept") reject("integrity_error", "creation.result.selection");
      return deepFreeze({ ...result, status: "saved", replayed });
    }
    reject(row.state === "unknown" ? "unknown_completion" : "conflict", "creation.action_id");
  }

  rollback() {
    try { this.db.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
  }

  markRecoveryUnknown(row, code, field) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const action = this.db.prepare(`SELECT state FROM creation_actions
        WHERE tenant_id=? AND project_id=? AND action_id=?`)
        .get(row.tenant_id, row.project_id, row.action_id);
      if (action?.state === "commit_intent") {
        this.db.prepare(`UPDATE creation_actions SET state='unknown',updated_at=?
          WHERE tenant_id=? AND project_id=? AND action_id=? AND state='commit_intent'`)
          .run(this.timestamp(), row.tenant_id, row.project_id, row.action_id);
      }
      const job = this.db.prepare(`SELECT job_id,operation,status FROM creative_jobs
        WHERE tenant_id=? AND project_id=? AND action_id=?`)
        .get(row.tenant_id, row.project_id, row.action_id);
      if (job?.status === "running") {
        const safeCode = ["integrity_error", "stale_version"].includes(code) ? code : "unavailable";
        const safeField = ["creation.intent", "creative_context", "job.lease_expired"].includes(field)
          ? field : "creation.intent";
        const operation = ["generate", "edit", "concepts.create", "composition.create", "composition.update", "composition.revalidate", "composition.get",
          "inspect", "list", "compare", "restore", "cancel", "handoff", "job.status"]
          .includes(job.operation) ? job.operation : "unknown";
        const error = {
          code: safeCode,
          module: "creative-engine.api",
          operation,
          field: safeField,
          retryable: safeCode === "unavailable",
          message: safeCode === "integrity_error"
            ? "Stored version or artifact integrity could not be verified."
            : safeCode === "stale_version"
              ? "The requested design version is no longer current."
              : "A required service is unavailable; no successful result was produced.",
          diagnostic_ref: safeCode === "integrity_error" ? "creative-engine:creation-intent-integrity"
            : safeCode === "stale_version" ? "creative-engine:stale-context" : "creative-engine:lease-expired",
        };
        this.db.prepare(`UPDATE creative_jobs SET status='failed',result_json=NULL,error_json=?,updated_at=?
          WHERE tenant_id=? AND project_id=? AND action_id=? AND status='running'`)
          .run(canonicalSerialize(error), this.timestamp(), row.tenant_id, row.project_id, row.action_id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.rollback();
      if (error instanceof VersionStoreError) throw error;
      reject("unavailable", "recovery", true);
    }
  }

  createPublicationTransaction(data) {
    if (!isRecord(data) || this.db.isTransaction !== true || typeof data.job_id !== "string" ||
      typeof data.lease_token !== "string" || !isRecord(data.scope) || !isRecord(data.publication_fence)) {
      reject("invalid_request", "publication_transaction");
    }
    const scope = validScope(data.scope, data.publication_fence.brief_id);
    const jobId = reference(data.job_id, "job_id");
    const actorId = reference(data.actor_id, "actor_id");
    const actionId = reference(data.action_id, "action_id");
    const requestHash = hash(data.request_hash, "request_hash");
    const job = this.db.prepare(`SELECT actor_id,action_id,request_hash,status,lease_hash,lease_expires_at
      FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
      .get(scope.tenant_id, scope.project_id, jobId);
    const recoveryToken = `recovery:${jobId}`;
    const recoveryMode = data.lease_token === recoveryToken;
    if (!job || job.actor_id !== actorId || job.action_id !== actionId || job.request_hash !== requestHash ||
      job.status !== "running" || Date.parse(job.lease_expires_at) <= this.now() ||
      (!recoveryMode && job.lease_hash !== createHash("sha256").update(data.lease_token).digest("hex")) ||
      !publicationFenceCurrent(this, scope, data.publication_fence)) {
      reject("scope_denied", "publication_transaction");
    }
    const transaction = Object.freeze({ job_id: data.job_id, lease_token: data.lease_token });
    const { faultInjector, ...plainData } = data;
    if (faultInjector !== undefined && typeof faultInjector !== "function") reject("invalid_request", "fault_injector");
    const publication = snapshotJson(plainData);
    publicationTransactionRegistries.get(this).set(transaction, deepFreeze({ ...publication,
      ...(faultInjector ? { faultInjector } : {}) }));
    return transaction;
  }

  publicationTransactionData(transaction) {
    return transaction && typeof transaction === "object"
      ? publicationTransactionRegistries.get(this)?.get(transaction) : undefined;
  }

  closePublicationTransaction(transaction) {
    if (transaction && typeof transaction === "object") publicationTransactionRegistries.get(this)?.delete(transaction);
  }

  async finalizeAction(scope, actionId, faultInjector, transaction) {
    this.assertOpen();
    const publication = this.publicationTransactionData(transaction);
    if (transaction !== undefined && faultInjector === undefined) faultInjector = publication?.faultInjector;
    const ownsTransaction = transaction === undefined;
    if (!ownsTransaction && (!publication || publication.scope.tenant_id !== scope.tenant_id ||
      publication.scope.project_id !== scope.project_id || publication.action_id !== actionId)) {
      reject("scope_denied", "publication_transaction");
    }
    if (ownsTransaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`SELECT * FROM creation_actions
        WHERE tenant_id=? AND project_id=? AND action_id=?`)
        .get(scope.tenant_id, scope.project_id, actionId);
      if (!row) reject("not_found", "creation.action_id");
      const intent = validateCommitIntentRow(row, scope);
      if (row.state === "committed") {
        if (ownsTransaction) this.db.exec("COMMIT");
        return this.readActionResult(row, true);
      }
      if (row.state === "unknown") {
        if (ownsTransaction) this.db.exec("COMMIT");
        return { status: "unknown", code: "unknown_completion" };
      }
      if (row.state !== "commit_intent") reject("conflict", "creation.action_id");
      const artifactBytes = readStoredObjectSync(this.objectRoot, intent.artifact.content_hash);
      if (!artifactBytes || artifactBytes.byteLength !== intent.artifact.byte_length) {
        this.db.prepare("UPDATE creation_actions SET state='unknown',updated_at=? WHERE tenant_id=? AND project_id=? AND action_id=?")
          .run(this.timestamp(), scope.tenant_id, scope.project_id, actionId);
        if (ownsTransaction) {
          this.db.exec("COMMIT");
          return { status: "unknown", code: "integrity_error" };
        }
        // A caller-owned publication transaction must never be committed here.
        // Roll back the outer job/version transaction and let recovery record
        // the unknown artifact outcome in its own bounded transaction.
        reject("integrity_error", "artifact.content_hash");
      }
      const design = intent.design_version;
      const selection = intent.selection;
      const currentBrief = this.db.prepare(`SELECT brief_hash FROM creative_briefs
        WHERE tenant_id=? AND project_id=? AND brief_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id);
      if (currentBrief && currentBrief.brief_hash !== intent.context.brief_hash) {
        const conflict = { status: "stale", code: "stale_version", current: null };
        this.db.prepare("UPDATE creation_actions SET state='conflict',result_json=?,updated_at=? WHERE tenant_id=? AND project_id=? AND action_id=?")
          .run(canonicalSerialize(conflict), this.timestamp(), scope.tenant_id, scope.project_id, actionId);
        if (ownsTransaction) this.db.exec("COMMIT");
        return conflict;
      }
      this.#assertBriefNotInvalidated(scope, intent.context.brief_snapshot);
      let parentDesignHash = null;
      if (design.parent_version_id !== null) {
        parentDesignHash = getDesignHashAt(this.db, scope, design.parent_version_id);
        if (!parentDesignHash) {
          this.db.prepare("UPDATE creation_actions SET state='conflict',result_json=?,updated_at=? WHERE tenant_id=? AND project_id=? AND action_id=?")
            .run(canonicalSerialize({ status: "not_found", code: "parent_version" }), this.timestamp(), scope.tenant_id, scope.project_id, actionId);
          if (ownsTransaction) this.db.exec("COMMIT");
          reject("not_found", "design_version.parent_version_id");
        }
        if (intent.evidence.creation.parent_design_hash !== parentDesignHash) {
          const conflict = { status: "stale", code: "stale_version", current: null };
          this.db.prepare("UPDATE creation_actions SET state='conflict',result_json=?,updated_at=? WHERE tenant_id=? AND project_id=? AND action_id=?")
            .run(canonicalSerialize(conflict), this.timestamp(), scope.tenant_id, scope.project_id, actionId);
          if (ownsTransaction) this.db.exec("COMMIT");
          return conflict;
        }
      } else if (intent.evidence.creation.parent_design_hash !== undefined) {
        reject("invalid_request", "creation.parent_design_hash");
      }
      const trustedScope = { tenant_id: scope.tenant_id, project_id: scope.project_id, brief_id: scope.brief_id,
        design_version_id: design.design_version_id };
      validateContextRecord(intent.context, trustedScope);
      validateDesignVersion(design, {
        trustedScope,
        brief_hash: intent.context.brief_hash,
        known_source_refs: intent.context.brief_snapshot.source_identity.map((source) => source.source_id),
        ...(design.parent_version_id !== null ? { design_version_ids: [design.parent_version_id] } : {}),
      });
      if (hashArtifactBytes(artifactBytes) !== design.artifact.content_hash) reject("integrity_error", "artifact.content_hash");
      const existingVersion = this.db.prepare(`SELECT design_hash FROM design_versions WHERE
        tenant_id=? AND project_id=? AND brief_id=? AND design_version_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, design.design_version_id);
      if (existingVersion) {
        if (existingVersion.design_hash !== design.design_hash) reject("conflict", "design_version.design_version_id");
        reject("conflict", "design_version.design_version_id");
      }
      let revision = null;
      if (selection.mode === "advance") {
        const current = this.db.prepare(`SELECT design_version_id,design_hash,revision FROM version_selections
          WHERE tenant_id=? AND project_id=? AND brief_id=?`)
          .get(scope.tenant_id, scope.project_id, scope.brief_id);
        const currentId = current?.design_version_id ?? null;
        const currentHash = current?.design_hash ?? null;
        const currentRevision = current?.revision ?? 0;
        if (currentId !== selection.expected_selected_design_version_id || currentHash !== selection.expected_selected_design_hash ||
          currentRevision !== selection.expected_revision) {
          const conflict = { status: "stale", code: "stale_version", current: current ? {
            design_version_id: current.design_version_id, design_hash: current.design_hash, revision: current.revision,
          } : { design_version_id: null, design_hash: null, revision: 0 } };
          this.db.prepare("UPDATE creation_actions SET state='conflict',result_json=?,updated_at=? WHERE tenant_id=? AND project_id=? AND action_id=?")
            .run(canonicalSerialize(conflict), this.timestamp(), scope.tenant_id, scope.project_id, actionId);
          if (ownsTransaction) this.db.exec("COMMIT");
          return conflict;
        }
        if (currentId !== null && getDesignHashAt(this.db, scope, currentId) !== currentHash) reject("integrity_error", "selection.design_hash");
        const resetFromOldBrief = design.parent_version_id === null && currentId !== null &&
          this.db.prepare(`SELECT brief_hash FROM design_versions WHERE tenant_id=? AND project_id=? AND brief_id=? AND design_version_id=?`)
            .get(scope.tenant_id, scope.project_id, scope.brief_id, currentId)?.brief_hash !== intent.context.brief_hash;
        if ((design.parent_version_id !== currentId && !resetFromOldBrief) ||
          (design.parent_version_id === currentId &&
            (currentId === null ? parentDesignHash !== null : parentDesignHash !== currentHash))) {
          reject("stale_version", "design_version.parent_version_id");
        }
        revision = currentRevision + 1;
      } else if (selection.mode !== "concept" && (design.parent_version_id === null || parentDesignHash === null)) {
        reject("invalid_request", "selection.mode");
      }
      const createdAt = this.timestamp();
      const metadata = {
        design_version: design,
        artifact: { content_hash: design.artifact.content_hash, byte_length: artifactBytes.byteLength },
        creation: intent.evidence.creation,
        context_hash: canonicalHash(intent.context),
        evidence_hash: canonicalHash(intent.evidence),
      };
      this.db.prepare(`INSERT INTO design_versions
        (tenant_id,project_id,brief_id,design_version_id,parent_version_id,parent_design_hash,brief_hash,design_hash,
         artifact_id,content_hash,media_type,occurred_at,metadata_json,creation_job_id,action_id,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(scope.tenant_id, scope.project_id, scope.brief_id, design.design_version_id,
          design.parent_version_id, parentDesignHash, design.brief_hash, design.design_hash,
          design.artifact.artifact_id, design.artifact.content_hash, design.artifact.media_type,
          design.occurred_at, canonicalSerialize(metadata), intent.evidence.creation.job_id,
          intent.evidence.creation.action_id, createdAt);
      this.db.prepare(`INSERT INTO version_evidence
        (tenant_id,project_id,brief_id,design_version_id,context_json,context_hash,evidence_json,evidence_hash)
        VALUES(?,?,?,?,?,?,?,?)`)
        .run(scope.tenant_id, scope.project_id, scope.brief_id, design.design_version_id,
          canonicalSerialize(intent.context), canonicalHash(intent.context),
          canonicalSerialize(intent.evidence), canonicalHash(intent.evidence));
      if (selection.mode === "advance") {
        this.db.prepare(`INSERT INTO version_selections
          (tenant_id,project_id,brief_id,design_version_id,design_hash,revision,updated_at)
          VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(tenant_id,project_id,brief_id) DO UPDATE SET
            design_version_id=excluded.design_version_id,design_hash=excluded.design_hash,
            revision=excluded.revision,updated_at=excluded.updated_at`)
          .run(scope.tenant_id, scope.project_id, scope.brief_id, design.design_version_id,
            design.design_hash, revision, createdAt);
      }
      const result = {
        status: "saved",
        design_version: design,
        selection: selection.mode === "advance" ? {
          tenant_id: scope.tenant_id, project_id: scope.project_id, brief_id: scope.brief_id,
          design_version_id: design.design_version_id, design_hash: design.design_hash, revision,
        } : null,
        created_at: createdAt,
      };
      this.db.prepare("UPDATE creation_actions SET state='committed',result_json=?,updated_at=? WHERE tenant_id=? AND project_id=? AND action_id=?")
        .run(canonicalSerialize(result), createdAt, scope.tenant_id, scope.project_id, actionId);
      injectFault(faultInjector, "after_metadata_write");
      if (ownsTransaction) {
        this.db.exec("COMMIT");
        injectFault(faultInjector, "after_commit");
      }
      return deepFreeze({ ...result, replayed: false });
    } catch (error) {
      if (ownsTransaction) this.rollback();
      if (error instanceof VersionStoreError) throw error;
      reject("unavailable", "database", true);
    }
  }

  async recover() {
    this.assertOpen();
    if (this.db.isTransaction) reject("unavailable", "database", true);
    const pending = this.db.prepare(`SELECT tenant_id,project_id,brief_id,action_id,job_id FROM creation_actions WHERE state='commit_intent'
      ORDER BY created_at,action_id`).all();
    const outcomes = [];
    for (const row of pending) {
      const scope = Object.freeze({ tenant_id: row.tenant_id, project_id: row.project_id, brief_id: row.brief_id });
      const action = this.db.prepare(`SELECT * FROM creation_actions
        WHERE tenant_id=? AND project_id=? AND action_id=?`)
        .get(row.tenant_id, row.project_id, row.action_id);
      if (!action || action.state !== "commit_intent") {
        outcomes.push({ status: "already_final" });
        continue;
      }
      let intent;
      try {
        intent = validateCommitIntentRow(action, scope);
      } catch {
        this.markRecoveryUnknown(row, "integrity_error", "creation.intent");
        outcomes.push({ status: "unknown", code: "integrity_error" });
        continue;
      }
      const job = this.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
        .get(row.tenant_id, row.project_id, row.job_id);
      if (job && (job.actor_id !== intent.actor_id || job.action_id !== row.action_id ||
        job.request_hash !== intent.evidence.creation.request_hash || job.brief_id !== scope.brief_id ||
        !["generate", "edit"].includes(job.operation) || intent.job_result === null) || !job && intent.job_result !== null) {
        this.markRecoveryUnknown(row, "integrity_error", "creation.intent");
        outcomes.push({ status: "unknown", code: "integrity_error" });
        continue;
      }
      if (job) {
        if (job.status === "cancelled") {
          this.db.prepare(`UPDATE creation_actions SET state='cancelled',updated_at=?
            WHERE tenant_id=? AND project_id=? AND action_id=? AND state='commit_intent'`)
            .run(this.timestamp(), row.tenant_id, row.project_id, row.action_id);
          outcomes.push({ status: "cancelled" });
          continue;
        }
        if (job.status !== "running" || Date.parse(job.lease_expires_at) <= this.now()) {
          this.markRecoveryUnknown(row, "unavailable", "job.lease_expired");
          outcomes.push({ status: "unknown" });
          continue;
        }
        let transaction;
        this.db.exec("BEGIN IMMEDIATE");
        try {
          const currentAction = this.db.prepare(`SELECT * FROM creation_actions
            WHERE tenant_id=? AND project_id=? AND action_id=?`)
            .get(row.tenant_id, row.project_id, row.action_id);
          if (!currentAction || currentAction.state !== "commit_intent") {
            this.db.exec("ROLLBACK");
            outcomes.push({ status: "already_final" });
            continue;
          }
          const currentIntent = validateCommitIntentRow(currentAction, scope);
          const freshJob = this.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
            .get(row.tenant_id, row.project_id, row.job_id);
          if (!freshJob || freshJob.status !== "running" || Date.parse(freshJob.lease_expires_at) <= this.now() ||
            freshJob.actor_id !== intent.actor_id || freshJob.action_id !== row.action_id ||
            freshJob.request_hash !== intent.evidence.creation.request_hash || freshJob.brief_id !== scope.brief_id) {
            this.db.exec("ROLLBACK");
            this.markRecoveryUnknown(row, "unavailable", "job.lease_expired");
            outcomes.push({ status: "unknown" });
            continue;
          }
          const recoveryFence = recoveryPublicationFence(this, scope, freshJob, currentIntent);
          const repairProof = recoveryFence.inspection_repair;
          if (!publicationFenceCurrent(this, scope, recoveryFence)) {
            reject("stale_version", "creative_context");
          }
          transaction = this.createPublicationTransaction({
            scope, actor_id: freshJob.actor_id, job_id: freshJob.job_id,
            lease_token: "recovery:" + freshJob.job_id, action_id: freshJob.action_id,
            request_hash: freshJob.request_hash, result: currentIntent.job_result,
            publication_fence: recoveryFence,
          });
          if (!publicationFenceCurrent(this, scope, recoveryFence)) {
            reject("stale_version", "creative_context");
          }
          const completed = await this.finalizeAction(scope, row.action_id, undefined, transaction);
          if (completed.status === "saved" && currentIntent.job_result !== null) {
            if (repairProof) {
              let outcome;
              try {
                const { result_hash: resultHash, ...unrecordedProof } = repairProof;
                outcome = createSqliteInspectionRepairController({ database: this.db, now: this.now })
                  .recordRepairOutcomeInPublication({
                    scope: { ...scope, design_version_id: repairProof.root_design_version_id },
                    inspection_id: repairProof.inspection_id, action_id: repairProof.action_id,
                    result_hash: resultHash, proof: unrecordedProof,
                  });
              } catch {
                reject("stale_version", "inspection_repair.outcome");
              }
              if (outcome?.status !== "recorded" || outcome.result_hash !== repairProof.result_hash) {
                reject("stale_version", "inspection_repair.outcome");
              }
            }
            const committedAuthorityIsCurrent = publicationFenceCurrent(this, scope, recoveryFence, {
              requireRecordedRepair: repairProof !== undefined, afterPublication: true,
            });
            const finalJob = this.db.prepare(`SELECT * FROM creative_jobs
              WHERE tenant_id=? AND project_id=? AND job_id=?`)
              .get(row.tenant_id, row.project_id, row.job_id);
            const updatedAt = this.timestamp();
            const finalNow = this.now();
            const activeLease = finalJob && finalJob.status === "running" &&
              finalJob.actor_id === freshJob.actor_id && finalJob.action_id === freshJob.action_id &&
              finalJob.request_hash === freshJob.request_hash && finalJob.lease_hash === freshJob.lease_hash &&
              Date.parse(finalJob.lease_expires_at) > Math.max(finalNow, Date.parse(updatedAt));
            let selectionIsCurrent = true;
            if (currentIntent.selection.mode === "advance") {
              const selection = this.db.prepare(`SELECT design_version_id,design_hash,revision FROM version_selections
                WHERE tenant_id=? AND project_id=? AND brief_id=?`)
                .get(scope.tenant_id, scope.project_id, scope.brief_id);
              selectionIsCurrent = selection?.design_version_id === completed.selection?.design_version_id &&
                selection?.design_hash === completed.selection?.design_hash &&
                selection?.revision === completed.selection?.revision;
            }
            if (!activeLease || !committedAuthorityIsCurrent || !selectionIsCurrent) {
              this.db.exec("ROLLBACK");
              this.markRecoveryUnknown(row, activeLease ? "stale_version" : "unavailable",
                activeLease ? "creative_context" : "job.lease_expired");
              outcomes.push({ status: "unknown" });
              continue;
            }
            const completedJob = this.db.prepare(`UPDATE creative_jobs SET status='completed',result_json=?,error_json=NULL,updated_at=?
              WHERE tenant_id=? AND project_id=? AND job_id=? AND status='running' AND actor_id=? AND action_id=?
                AND request_hash=? AND lease_hash=? AND lease_expires_at>?`)
              .run(canonicalSerialize(currentIntent.job_result), updatedAt, row.tenant_id, row.project_id, row.job_id,
                finalJob.actor_id, finalJob.action_id, finalJob.request_hash, finalJob.lease_hash,
                new Date(finalNow).toISOString()).changes;
            if (completedJob !== 1 || Date.parse(finalJob.lease_expires_at) <= this.now()) {
              this.db.exec("ROLLBACK");
              this.markRecoveryUnknown(row, "unavailable", "job.lease_expired");
              outcomes.push({ status: "unknown" });
              continue;
            }
            this.db.exec("COMMIT");
            outcomes.push(completed);
          } else {
            this.db.prepare(`UPDATE creation_actions SET state='unknown',updated_at=?
              WHERE tenant_id=? AND project_id=? AND action_id=? AND state='commit_intent'`)
              .run(this.timestamp(), row.tenant_id, row.project_id, row.action_id);
            this.db.prepare(`UPDATE creative_jobs SET status='failed',result_json=NULL,error_json=?,updated_at=?
              WHERE tenant_id=? AND project_id=? AND job_id=? AND status='running'`)
              .run(canonicalSerialize({ code: "stale_version", module: "creative-engine.api", operation: freshJob.operation,
                field: "creative_context", retryable: false, message: "The requested design version is no longer current.",
                diagnostic_ref: "creative-engine:stale-context" }), this.timestamp(), row.tenant_id, row.project_id, row.job_id);
            this.db.exec("COMMIT");
            outcomes.push(completed);
          }
        } catch (error) {
          this.rollback();
          const code = error instanceof VersionStoreError ? error.code : "unavailable";
          this.markRecoveryUnknown(row, code === "integrity_error" ? "integrity_error"
            : code === "stale_version" ? "stale_version" : "unavailable",
          code === "integrity_error" ? "creation.intent" : code === "stale_version" ? "creative_context" : "job.lease_expired");
          outcomes.push({ status: "unknown", code });
        } finally {
          this.closePublicationTransaction(transaction);
        }
        continue;
      }
      try {
        outcomes.push(await this.finalizeAction(scope, row.action_id));
      } catch (error) {
        const code = error instanceof VersionStoreError ? error.code : "unavailable";
        this.markRecoveryUnknown(row, code === "integrity_error" ? "integrity_error"
          : code === "stale_version" ? "stale_version" : "unavailable",
        code === "integrity_error" ? "creation.intent" : code === "stale_version" ? "creative_context" : "job.lease_expired");
        outcomes.push({ status: "unknown", code });
      }
    }
    const expiredJobs = this.db.prepare(`SELECT tenant_id,project_id,job_id,operation FROM creative_jobs
      WHERE status='running' AND lease_expires_at<=? ORDER BY created_at,job_id`).all(new Date(this.now()).toISOString());
    for (const job of expiredJobs) {
      const error = { code: "unavailable", module: "creative-engine.api", operation: job.operation,
        field: "job.lease_expired", retryable: true,
        message: "A required service is unavailable; no successful result was produced.",
        diagnostic_ref: "creative-engine:lease-expired" };
      this.db.prepare(`UPDATE creative_jobs SET status='failed',error_json=?,updated_at=?
        WHERE tenant_id=? AND project_id=? AND job_id=? AND status='running'`)
        .run(canonicalSerialize(error), this.timestamp(), job.tenant_id, job.project_id, job.job_id);
      outcomes.push({ status: "unknown" });
    }

    // Cancellation is committed by the jobs port before the composition
    // action is finalized. A process can stop in that small interval, so
    // reconcile the durable job/action pair without asking an owner port to
    // regenerate a preview or attempting publication. Staged bytes remain
    // immutable evidence on the cancelled action; pending actions stay empty.
    const interruptedCompositionActions = this.db.prepare(`SELECT a.tenant_id,a.project_id,a.brief_id,a.action_id
      FROM creative_composition_actions_v1 AS a
      JOIN creative_jobs AS j ON j.tenant_id=a.tenant_id AND j.project_id=a.project_id AND j.job_id=a.job_id
      WHERE a.status IN ('pending','staged') AND j.status IN ('cancelled','failed')
      ORDER BY a.created_at,a.action_id`).all();
    for (const candidate of interruptedCompositionActions) {
      const scope = Object.freeze({ tenant_id: candidate.tenant_id, project_id: candidate.project_id,
        brief_id: candidate.brief_id });
      const recovered = this.recoverCompositionAction({ scope, action_id: candidate.action_id });
      outcomes.push(recovered);
    }
    return deepFreeze({ examined: pending.length + expiredJobs.length + interruptedCompositionActions.length,
      committed: outcomes.filter((item) => item.status === "saved").length,
      conflicts: outcomes.filter((item) => item.status === "stale").length,
      unknown: outcomes.filter((item) => item.status === "unknown").length,
    });
  }

  beginCompositionAction(input) {
    this.assertOpen();
    this.assertNoBorrowedTransaction("composition.action.transaction");
    const safe = snapshotCompositionJson(input);
    const fields = ["scope", "actor_id", "job_id", "lease_token", "action_id", "operation", "request_hash", "intent",
      "expected_current", "expected_design_version_id", "expected_design_hash", "expected_selection_revision"];
    if (!isRecord(safe) || Object.keys(safe).length !== fields.length ||
        fields.some((field) => !Object.hasOwn(safe, field))) reject("invalid_request", "composition.action");
    const scope = validScope(safe.scope, safe.scope?.brief_id);
    const actor_id = reference(safe.actor_id, "actor_id");
    const job_id = reference(safe.job_id, "job_id");
    const lease_token = reference(safe.lease_token, "lease_token");
    const action_id = reference(safe.action_id, "action_id");
    const request_hash = hash(safe.request_hash, "request_hash");
    const operation = safe.operation;
    if (!(["composition.create", "composition.update", "composition.revalidate"].includes(operation))) reject("invalid_request", "operation");
    const expected_current = compositionExpectedCurrent(safe.expected_current);
    const expected_design_version_id = reference(safe.expected_design_version_id, "expected_design_version_id");
    const expected_design_hash = hash(safe.expected_design_hash, "expected_design_hash");
    const expected_selection_revision = safe.expected_selection_revision;
    if (!Number.isSafeInteger(expected_selection_revision) || expected_selection_revision < 1 ||
        operation === "composition.create" && expected_current !== null ||
        ["composition.update", "composition.revalidate"].includes(operation) && expected_current === null) reject("invalid_request", "composition.action.current");
    const intent = snapshotCompositionJson(safe.intent);
    const intentFields = ["contract", "schema_version", "operation", "composition_id", "candidate_revision_id",
      "source_revision_id", "source_revision_sha256", "plan"];
    const intentVersionMatches = operation === "composition.revalidate"
      ? intent?.schema_version === "1.1" : intent?.schema_version === "1.0";
    if (!isRecord(intent) || Object.keys(intent).length !== intentFields.length ||
        intentFields.some((field) => !Object.hasOwn(intent, field)) ||
        intent.contract !== "CreativeCompositionActionIntent" || !intentVersionMatches ||
        intent.operation !== operation ||
        (operation === "composition.create" && (intent.source_revision_id !== null || intent.source_revision_sha256 !== null || intent.plan !== null)) ||
        (["composition.update", "composition.revalidate"].includes(operation) &&
          (intent.source_revision_id !== expected_current.revision_id ||
          intent.source_revision_sha256 !== expected_current.revision_sha256 ||
          (operation === "composition.update" ? !isRecord(intent.plan) : intent.plan !== null)))) {
      reject("invalid_request", "composition.action.intent");
    }
    const composition_id = reference(intent.composition_id, "composition.action.intent.composition_id");
    const candidate_revision_id = reference(intent.candidate_revision_id, "composition.action.intent.candidate_revision_id");
    if (operation === "composition.revalidate" && candidate_revision_id === expected_current.revision_id) {
      reject("invalid_request", "composition.action.candidate_revision_id");
    }
    const intent_json = canonicalSerialize(intent);
    const intent_hash = canonicalHash(intent);
    const lease_hash = createHash("sha256").update(lease_token).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
        .get(scope.tenant_id, scope.project_id, job_id);
      if (!activeJobLease(job, scope, actor_id, lease_token, this.now()) || job.brief_id !== scope.brief_id ||
          job.action_id !== action_id || job.operation !== operation || job.request_hash !== request_hash) {
        reject("cancelled", "composition.job");
      }
      const prior = this.db.prepare(`SELECT * FROM creative_composition_actions_v1
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, action_id);
      const timestamp = this.timestamp();
      if (prior) {
        const same = prior.job_id === job_id && prior.actor_id === actor_id && prior.operation === operation &&
          prior.request_hash === request_hash && prior.intent_hash === intent_hash && prior.intent_json === intent_json &&
          prior.expected_current_revision_id === (expected_current?.revision_id ?? null) &&
          prior.expected_current_revision_sha256 === (expected_current?.revision_sha256 ?? null) &&
          prior.expected_design_version_id === expected_design_version_id && prior.expected_design_hash === expected_design_hash &&
          prior.expected_selection_revision === expected_selection_revision;
        if (!same) {
          this.db.exec("ROLLBACK");
          return freezeReturned({ status: "conflict" });
        }
        this.db.prepare(`INSERT OR IGNORE INTO creative_composition_action_leases_v1
          (tenant_id,project_id,brief_id,action_id,lease_hash,observed_at) VALUES(?,?,?,?,?,?)`)
          .run(scope.tenant_id, scope.project_id, scope.brief_id, action_id, lease_hash, timestamp);
        this.db.exec("COMMIT");
        return compositionActionRowValue(this, scope, prior);
      }
      const selection = this.getSelection({ scope, brief_id: scope.brief_id });
      const design = this.getDesignVersion({ scope, brief_id: scope.brief_id, design_version_id: expected_design_version_id });
      const brief = this.getBrief({ scope, brief_id: scope.brief_id });
      if (!selection || selection.design_version_id !== expected_design_version_id ||
          selection.design_hash !== expected_design_hash || selection.revision !== expected_selection_revision ||
          !design || design.design_hash !== expected_design_hash || !brief ||
          !this.isBriefUsable({ scope, brief_id: scope.brief_id, brief_hash: design.brief_hash })) {
        this.db.exec("ROLLBACK");
        return freezeReturned({ status: "stale" });
      }
      this.#assertBriefNotInvalidated(scope, brief);
      const current = this.db.prepare(`SELECT * FROM creative_composition_current_v1
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND composition_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, composition_id);
      if ((current?.revision_id ?? null) !== (expected_current?.revision_id ?? null) ||
          (current?.revision_sha256 ?? null) !== (expected_current?.revision_sha256 ?? null)) {
        this.db.exec("ROLLBACK");
        return freezeReturned({ status: "stale" });
      }
      if (current) {
        const revisionRow = this.db.prepare(`SELECT * FROM creative_composition_revisions_v1
          WHERE tenant_id=? AND project_id=? AND brief_id=? AND composition_id=? AND revision_id=?`)
          .get(scope.tenant_id, scope.project_id, scope.brief_id, composition_id, current.revision_id);
        const stored = compositionRevisionFromRow(this, scope, revisionRow);
        if (stored.revision.revision_sha256 !== current.revision_sha256 ||
            operation !== "composition.revalidate" && !compositionRevisionIsCurrent(this, scope, stored.revision, current)) {
          this.db.exec("ROLLBACK");
          return freezeReturned({ status: "stale" });
        }
      }
      const now = this.timestamp();
      this.db.prepare(`INSERT INTO creative_composition_actions_v1
        (tenant_id,project_id,brief_id,action_id,job_id,actor_id,operation,request_hash,intent_hash,intent_json,
         expected_current_revision_id,expected_current_revision_sha256,expected_design_version_id,expected_design_hash,
         expected_selection_revision,candidate_revision_json,preview_sha256,preview_bytes,status,result_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,'pending',NULL,?,?)`)
        .run(scope.tenant_id, scope.project_id, scope.brief_id, action_id, job_id, actor_id, operation, request_hash,
          intent_hash, intent_json, expected_current?.revision_id ?? null, expected_current?.revision_sha256 ?? null,
          expected_design_version_id, expected_design_hash, expected_selection_revision, now, now);
      this.db.prepare(`INSERT INTO creative_composition_action_leases_v1
        (tenant_id,project_id,brief_id,action_id,lease_hash,observed_at) VALUES(?,?,?,?,?,?)`)
        .run(scope.tenant_id, scope.project_id, scope.brief_id, action_id, lease_hash, now);
      const row = this.db.prepare(`SELECT * FROM creative_composition_actions_v1
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, action_id);
      this.db.exec("COMMIT");
      return compositionActionRowValue(this, scope, row);
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      if (error instanceof VersionStoreError) throw error;
      reject("unavailable", "composition.action", true);
    }
  }

  getCompositionAction({ scope: inputScope, brief_id, action_id }) {
    this.assertOpen();
    const scope = validScope(inputScope, brief_id ?? inputScope?.brief_id);
    reference(action_id, "action_id");
    const row = this.db.prepare(`SELECT * FROM creative_composition_actions_v1
      WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=?`)
      .get(scope.tenant_id, scope.project_id, scope.brief_id, action_id);
    return row ? compositionActionRowValue(this, scope, row) : null;
  }

  getCompositionActionIdentityByJob({ scope: inputScope, job_id }) {
    this.assertOpen();
    if (!isRecord(inputScope)) reject("scope_denied", "scope");
    const tenant_id = reference(inputScope.tenant_id, "scope.tenant_id");
    const project_id = reference(inputScope.project_id, "scope.project_id");
    const checkedJobId = reference(job_id, "job_id");
    const rows = this.db.prepare(`SELECT * FROM creative_composition_actions_v1
      WHERE tenant_id=? AND project_id=? AND job_id=?`).all(tenant_id, project_id, checkedJobId);
    if (rows.length > 1) reject("integrity_error", "composition.action.job");
    if (rows.length === 0) return null;
    const row = rows[0];
    const scope = validScope({ tenant_id, project_id }, row.brief_id);
    const action = compositionActionRowValue(this, scope, row);
    const job = this.db.prepare(`SELECT job_id,tenant_id,project_id,brief_id,actor_id,action_id,operation,request_hash
      FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
      .get(tenant_id, project_id, checkedJobId);
    if (!job || job.brief_id !== scope.brief_id || job.actor_id !== action.actor_id ||
        job.action_id !== action.action_id || job.operation !== action.operation ||
        job.request_hash !== action.request_hash) reject("integrity_error", "composition.action.job");
    return Object.freeze({ tenant_id, project_id, brief_id: scope.brief_id, job_id: checkedJobId,
      actor_id: action.actor_id, action_id: action.action_id, operation: action.operation,
      request_hash: action.request_hash });
  }

  stageCompositionRevision(input) {
    this.assertOpen();
    this.assertNoBorrowedTransaction("composition.stage.transaction");
    const copied = snapshotCompositionBytesRecord(input, "preview_bytes");
    const safe = copied.metadata;
    const fields = ["scope", "actor_id", "job_id", "lease_token", "action_id", "request_hash", "revision"];
    if (!isRecord(safe) || Object.keys(safe).length !== fields.length ||
        fields.some((field) => !Object.hasOwn(safe, field))) reject("invalid_request", "composition.stage");
    const scope = validScope(safe.scope, safe.scope?.brief_id);
    const actor_id = reference(safe.actor_id, "actor_id");
    const job_id = reference(safe.job_id, "job_id");
    const lease_token = reference(safe.lease_token, "lease_token");
    const action_id = reference(safe.action_id, "action_id");
    const request_hash = hash(safe.request_hash, "request_hash");
    const now = this.now();
    let revision;
    try {
      revision = validateCompositionRevision(safe.revision, { trustedScope: scope, previewBytes: copied.bytes, allowExpired: true });
    } catch (error) {
      if (error instanceof VersionStoreError) throw error;
      reject(error?.code === "scope_denied" ? "scope_denied" : "integrity_error", error?.field || "composition.revision");
    }
    const revision_json = canonicalSerialize(revision);
    const preview_sha256 = revision.preview.preview_sha256;
    const lease_hash = createHash("sha256").update(lease_token).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`SELECT * FROM creative_composition_actions_v1
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, action_id);
      if (!row || row.job_id !== job_id || row.actor_id !== actor_id || row.request_hash !== request_hash) {
        reject("scope_denied", "composition.action");
      }
      const lease = this.db.prepare(`SELECT 1 AS present FROM creative_composition_action_leases_v1
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=? AND lease_hash=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, action_id, lease_hash);
      if (!lease) reject("scope_denied", "composition.lease");
      const job = this.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
        .get(scope.tenant_id, scope.project_id, job_id);
      if (!job || job.actor_id !== actor_id || job.action_id !== action_id || job.request_hash !== request_hash ||
          job.operation !== row.operation || job.brief_id !== scope.brief_id) reject("integrity_error", "composition.job");
      const checkedRow = compositionActionRowValue(this, scope, row);
      if (revision.composition_id !== checkedRow.intent.composition_id ||
          revision.revision_id !== checkedRow.intent.candidate_revision_id ||
          revision.parent_revision_id !== row.expected_current_revision_id ||
          revision.parent_revision_sha256 !== row.expected_current_revision_sha256 ||
          revision.dependencies.design_version_id !== row.expected_design_version_id ||
          revision.dependencies.design_version_sha256 !== row.expected_design_hash ||
          revision.dependencies.selection_revision !== row.expected_selection_revision) {
        reject("integrity_error", "composition.action.stage_identity");
      }
      if (row.status !== "pending") {
        const same = row.candidate_revision_json === revision_json && row.preview_sha256 === preview_sha256 &&
          row.preview_bytes instanceof Uint8Array && Buffer.from(row.preview_bytes).equals(Buffer.from(copied.bytes));
        if (!same) {
          this.db.exec("ROLLBACK");
          return freezeReturned({ status: "conflict" });
        }
        this.db.exec("COMMIT");
        return compositionActionRowValue(this, scope, row);
      }
      const leaseIsCurrent = activeJobLease(job, scope, actor_id, lease_token, now);
      const status = leaseIsCurrent ? "staged" : job.status === "cancelled" ? "cancelled" : "unknown";
      const result_json = leaseIsCurrent ? null : canonicalSerialize({ status,
        reason: job.status === "cancelled" ? "job_cancelled_after_preview" : "lease_lost_after_preview",
        ...(status === "unknown" ? { code: "unavailable" } : {}) });
      const updated = this.db.prepare(`UPDATE creative_composition_actions_v1
        SET candidate_revision_json=?,preview_sha256=?,preview_bytes=?,status=?,result_json=?,updated_at=?
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=? AND status='pending'`)
        .run(revision_json, preview_sha256, Buffer.from(copied.bytes), status, result_json, this.timestamp(),
          scope.tenant_id, scope.project_id, scope.brief_id, action_id).changes;
      if (updated !== 1) reject("conflict", "composition.action");
      const fresh = this.db.prepare(`SELECT * FROM creative_composition_actions_v1
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, action_id);
      this.db.exec("COMMIT");
      return compositionActionRowValue(this, scope, fresh);
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      if (error instanceof VersionStoreError) throw error;
      reject("unavailable", "composition.stage", true);
    }
  }

  finishCompositionAction(input) {
    this.assertOpen();
    this.assertNoBorrowedTransaction("composition.finish.transaction");
    const safe = snapshotCompositionJson(input);
    const fields = ["scope", "actor_id", "job_id", "lease_token", "action_id", "request_hash", "status", "reason"];
    if (!isRecord(safe) || Object.keys(safe).length !== fields.length || fields.some((field) => !Object.hasOwn(safe, field)) ||
        !["abandoned", "cancelled", "stale", "unknown"].includes(safe.status) ||
        typeof safe.reason !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(safe.reason)) {
      reject("invalid_request", "composition.finish");
    }
    const scope = validScope(safe.scope, safe.scope?.brief_id);
    const actor_id = reference(safe.actor_id, "actor_id");
    const job_id = reference(safe.job_id, "job_id");
    const lease_token = reference(safe.lease_token, "lease_token");
    const action_id = reference(safe.action_id, "action_id");
    const request_hash = hash(safe.request_hash, "request_hash");
    const result_json = canonicalSerialize({ status: safe.status, reason: safe.reason });
    const lease_hash = createHash("sha256").update(lease_token).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`SELECT * FROM creative_composition_actions_v1
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, action_id);
      if (!row || row.job_id !== job_id || row.actor_id !== actor_id || row.request_hash !== request_hash) {
        reject("scope_denied", "composition.action");
      }
      const lease = this.db.prepare(`SELECT 1 AS present FROM creative_composition_action_leases_v1
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=? AND lease_hash=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, action_id, lease_hash);
      if (!lease) reject("scope_denied", "composition.lease");
      if (row.status === safe.status && row.result_json === result_json) {
        this.db.exec("COMMIT");
        return compositionActionRowValue(this, scope, row);
      }
      if (!["pending", "staged"].includes(row.status) || row.status === "pending" && safe.status === "stale" ||
          row.status === "staged" && safe.status === "abandoned") {
        this.db.exec("ROLLBACK");
        return freezeReturned({ status: "conflict" });
      }
      const updated = this.db.prepare(`UPDATE creative_composition_actions_v1
        SET status=?,result_json=?,updated_at=? WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=? AND status=?`)
        .run(safe.status, result_json, this.timestamp(), scope.tenant_id, scope.project_id, scope.brief_id, action_id, row.status).changes;
      if (updated !== 1) reject("conflict", "composition.action");
      const fresh = this.db.prepare(`SELECT * FROM creative_composition_actions_v1
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, action_id);
      this.db.exec("COMMIT");
      return compositionActionRowValue(this, scope, fresh);
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      if (error instanceof VersionStoreError) throw error;
      reject("unavailable", "composition.finish", true);
    }
  }

  recoverCompositionAction(input) {
    this.assertOpen();
    this.assertNoBorrowedTransaction("composition.recovery.transaction");
    const safe = snapshotCompositionJson(input);
    if (!isRecord(safe) || Object.keys(safe).length !== 2 ||
        !Object.hasOwn(safe, "scope") || !Object.hasOwn(safe, "action_id")) {
      reject("invalid_request", "composition.recovery");
    }
    const scope = validScope(safe.scope, safe.scope?.brief_id);
    const action_id = reference(safe.action_id, "action_id");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const action = this.db.prepare(`SELECT * FROM creative_composition_actions_v1
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, action_id);
      if (!action) {
        this.db.exec("COMMIT");
        return Object.freeze({ status: "not_found" });
      }
      if (!["pending", "staged"].includes(action.status)) {
        this.db.exec("COMMIT");
        return Object.freeze({ status: "already_final" });
      }
      const job = this.db.prepare(`SELECT * FROM creative_jobs
        WHERE tenant_id=? AND project_id=? AND job_id=?`)
        .get(scope.tenant_id, scope.project_id, action.job_id);
      if (!job || !["cancelled", "failed"].includes(job.status)) {
        this.db.exec("COMMIT");
        return Object.freeze({ status: "pending" });
      }
      const matchingLease = this.db.prepare(`SELECT 1 AS present FROM creative_composition_action_leases_v1
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=? AND lease_hash=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, action.action_id, job.lease_hash);
      const identityMatches = job.actor_id === action.actor_id && job.action_id === action.action_id &&
        job.request_hash === action.request_hash && job.operation === action.operation &&
        job.brief_id === action.brief_id && job.result_json === null && matchingLease !== undefined;
      let actionIsSound = false;
      if (identityMatches) {
        try {
          const checked = compositionActionRowValue(this, scope, action);
          actionIsSound = checked.result === null && (action.status === "pending"
            ? checked.revision === null && checked.preview_bytes === null
            : checked.revision !== null && checked.preview_bytes instanceof Uint8Array);
        } catch {
          actionIsSound = false;
        }
      }
      let status;
      let code;
      let reason;
      if (!identityMatches || !actionIsSound) {
        status = "unknown";
        code = "integrity_error";
        reason = job.status === "cancelled" ? "cancelled_action_integrity_error" : "failed_action_integrity_error";
      } else if (job.status === "cancelled") {
        status = "cancelled";
        reason = action.status === "pending" ? "job_cancelled_before_preview" : "job_cancelled_after_preview";
      } else {
        status = "unknown";
        code = "unavailable";
        reason = action.status === "pending" ? "job_failed_before_preview" : "job_failed_after_preview";
        try {
          const error = job.error_json === null ? null : snapshotCompositionJson(JSON.parse(job.error_json));
          if (typeof error?.code === "string" && /^[a-z][a-z0-9_.-]{0,63}$/.test(error.code)) code = error.code;
        } catch {
          status = "unknown";
          code = "integrity_error";
          reason = "interrupted_job_error_integrity_error";
        }
      }
      const resultJson = canonicalSerialize({ status, reason, ...(code ? { code } : {}) });
      const changed = this.db.prepare(`UPDATE creative_composition_actions_v1
        SET status=?,result_json=?,updated_at=?
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=? AND status=? AND result_json IS NULL`)
        .run(status, resultJson, this.timestamp(), scope.tenant_id, scope.project_id, scope.brief_id,
          action.action_id, action.status).changes;
      if (changed !== 1) {
        this.db.exec("ROLLBACK");
        return Object.freeze({ status: "already_final" });
      }
      this.db.exec("COMMIT");
      return Object.freeze({ status, ...(code ? { code } : {}), reason });
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      if (error instanceof VersionStoreError) throw error;
      reject("unavailable", "composition.recovery", true);
    }
  }

  getCurrentComposition({ scope: inputScope, brief_id, design_version_id }) {
    this.assertOpen();
    const scope = validScope(inputScope, brief_id ?? inputScope?.brief_id);
    reference(design_version_id, "design_version_id");
    const rows = this.db.prepare(`SELECT * FROM creative_composition_current_v1
      WHERE tenant_id=? AND project_id=? AND brief_id=? AND design_version_id=? ORDER BY composition_id LIMIT 2`)
      .all(scope.tenant_id, scope.project_id, scope.brief_id, design_version_id);
    if (rows.length === 0) return null;
    if (rows.length !== 1) reject("integrity_error", "composition.current_identity");
    const current = rows[0];
    const revisionRow = this.db.prepare(`SELECT * FROM creative_composition_revisions_v1
      WHERE tenant_id=? AND project_id=? AND brief_id=? AND composition_id=? AND revision_id=?`)
      .get(scope.tenant_id, scope.project_id, scope.brief_id, current.composition_id, current.revision_id);
    const stored = compositionRevisionFromRow(this, scope, revisionRow);
    if (stored.revision.revision_sha256 !== current.revision_sha256 ||
        !compositionRevisionIsCurrent(this, scope, stored.revision, current)) reject("stale_version", "composition.current");
    return Object.freeze({ revision: stored.revision, preview_bytes: Uint8Array.from(stored.preview_bytes) });
  }

  getCurrentCompositionIdentity({ scope: inputScope, brief_id, design_version_id }) {
    this.assertOpen();
    const scope = validScope(inputScope, brief_id ?? inputScope?.brief_id);
    reference(design_version_id, "design_version_id");
    const rows = this.db.prepare(`SELECT * FROM creative_composition_current_v1
      WHERE tenant_id=? AND project_id=? AND brief_id=? AND design_version_id=? ORDER BY composition_id LIMIT 2`)
      .all(scope.tenant_id, scope.project_id, scope.brief_id, design_version_id);
    if (rows.length === 0) return null;
    if (rows.length !== 1) reject("integrity_error", "composition.current_identity");
    const current = rows[0];
    const revisionRow = this.db.prepare(`SELECT * FROM creative_composition_revisions_v1
      WHERE tenant_id=? AND project_id=? AND brief_id=? AND composition_id=? AND revision_id=?`)
      .get(scope.tenant_id, scope.project_id, scope.brief_id, current.composition_id, current.revision_id);
    const stored = compositionRevisionFromRow(this, scope, revisionRow);
    if (stored.revision.revision_sha256 !== current.revision_sha256 ||
        stored.revision.dependencies.design_version_id !== current.design_version_id ||
        stored.revision.dependencies.design_version_sha256 !== current.design_hash ||
        stored.revision.dependencies.selection_revision !== current.selection_revision) {
      reject("integrity_error", "composition.current_identity");
    }
    return Object.freeze({ composition_id: current.composition_id, revision_id: current.revision_id,
      revision_sha256: current.revision_sha256, design_version_id: current.design_version_id,
      design_version_sha256: current.design_hash, selection_revision: current.selection_revision,
      updated_at: current.updated_at });
  }

  assertCurrentComposition({ scope: inputScope, brief_id, composition_id, design_version_id,
    revision_id, revision_sha256, selection_revision }) {
    this.assertOpen();
    const scope = validScope(inputScope, brief_id ?? inputScope?.brief_id);
    reference(composition_id, "composition_id");
    reference(design_version_id, "design_version_id");
    reference(revision_id, "revision_id");
    hash(revision_sha256, "revision_sha256");
    if (!Number.isSafeInteger(selection_revision) || selection_revision < 0) {
      reject("invalid_request", "selection_revision");
    }
    // Deliberately synchronous: callers use this as the final local CAS/freshness
    // fence after the last external await. getCurrentComposition re-reads the
    // same connection's brief, package, selection, design, current pointer,
    // retained bytes, and every time-bounded local proof.
    const current = this.getCurrentComposition({ scope, design_version_id });
    const revision = current?.revision;
    if (!revision || revision.composition_id !== composition_id || revision.revision_id !== revision_id ||
        revision.revision_sha256 !== revision_sha256 ||
        revision.dependencies.selection_revision !== selection_revision) {
      reject("stale_version", "composition.current");
    }
    return Object.freeze({ status: "current", composition_id: revision.composition_id,
      revision_id: revision.revision_id, revision_sha256: revision.revision_sha256,
      design_version_id: revision.dependencies.design_version_id,
      selection_revision: revision.dependencies.selection_revision });
  }

  getCompositionRevision({ scope: inputScope, brief_id, composition_id, revision_id }) {
    this.assertOpen();
    const scope = validScope(inputScope, brief_id ?? inputScope?.brief_id);
    reference(composition_id, "composition_id");
    reference(revision_id, "revision_id");
    const row = this.db.prepare(`SELECT * FROM creative_composition_revisions_v1
      WHERE tenant_id=? AND project_id=? AND brief_id=? AND composition_id=? AND revision_id=?`)
      .get(scope.tenant_id, scope.project_id, scope.brief_id, composition_id, revision_id);
    if (!row) return null;
    const stored = compositionRevisionFromRow(this, scope, row);
    return Object.freeze({ revision: stored.revision, preview_bytes: Uint8Array.from(stored.preview_bytes) });
  }

  listCompositionRevisions({ scope: inputScope, brief_id, composition_id, limit = 20, after_revision_id = null }) {
    this.assertOpen();
    const scope = validScope(inputScope, brief_id ?? inputScope?.brief_id);
    reference(composition_id, "composition_id");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) reject("invalid_request", "limit");
    let rows;
    if (after_revision_id === null) {
      rows = this.db.prepare(`SELECT * FROM creative_composition_revisions_v1
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND composition_id=?
        ORDER BY created_at DESC,revision_id ASC LIMIT ?`)
        .all(scope.tenant_id, scope.project_id, scope.brief_id, composition_id, limit + 1);
    } else {
      reference(after_revision_id, "after_revision_id");
      const after = this.db.prepare(`SELECT created_at,revision_id FROM creative_composition_revisions_v1
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND composition_id=? AND revision_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, composition_id, after_revision_id);
      if (!after) reject("not_found", "after_revision_id");
      rows = this.db.prepare(`SELECT * FROM creative_composition_revisions_v1
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND composition_id=?
          AND (created_at<? OR (created_at=? AND revision_id>?))
        ORDER BY created_at DESC,revision_id ASC LIMIT ?`)
        .all(scope.tenant_id, scope.project_id, scope.brief_id, composition_id,
          after.created_at, after.created_at, after.revision_id, limit + 1);
    }
    const has_more = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => compositionRevisionFromRow(this, scope, row).revision);
    return freezeReturned({ items, has_more });
  }

  commitCompositionRevision(input, transaction) {
    this.assertOpen();
    const publication = this.publicationTransactionData(transaction);
    if (!publication || this.db.isTransaction !== true || !isRecord(input)) {
      reject("scope_denied", "publication_transaction");
    }
    const fields = ["scope", "actor_id", "job_id", "action_id", "request_hash", "revision_sha256"];
    const safe = snapshotCompositionJson(input);
    if (Object.keys(safe).length !== fields.length || fields.some((field) => !Object.hasOwn(safe, field))) {
      reject("invalid_request", "composition.commit");
    }
    const scope = validScope(safe.scope, safe.scope?.brief_id);
    const actor_id = reference(safe.actor_id, "actor_id");
    const job_id = reference(safe.job_id, "job_id");
    const action_id = reference(safe.action_id, "action_id");
    const request_hash = hash(safe.request_hash, "request_hash");
    const revision_sha256 = hash(safe.revision_sha256, "revision_sha256");
    if (publication.actor_id !== actor_id || publication.job_id !== job_id || publication.action_id !== action_id ||
        publication.request_hash !== request_hash || publication.scope.tenant_id !== scope.tenant_id ||
        publication.scope.project_id !== scope.project_id || publication.scope.brief_id !== scope.brief_id) {
      reject("scope_denied", "publication_transaction");
    }
    const row = this.db.prepare(`SELECT * FROM creative_composition_actions_v1
      WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=?`)
      .get(scope.tenant_id, scope.project_id, scope.brief_id, action_id);
    if (!row || row.job_id !== job_id || row.actor_id !== actor_id || row.request_hash !== request_hash) {
      reject("conflict", "composition.action");
    }
    const action = compositionActionRowValue(this, scope, row);
    if (row.status === "published") {
      if (action.revision?.revision_sha256 !== revision_sha256) reject("conflict", "composition.revision_sha256");
      return freezeReturned({ status: "replayed", composition: action.revision });
    }
    if (row.status !== "staged" || !action.revision || !action.preview_bytes ||
        action.revision.revision_sha256 !== revision_sha256) reject("conflict", "composition.action.stage");
    const job = this.db.prepare(`SELECT * FROM creative_jobs WHERE tenant_id=? AND project_id=? AND job_id=?`)
      .get(scope.tenant_id, scope.project_id, job_id);
    if (!activeJobLease(job, scope, actor_id, publication.lease_token, this.now()) ||
        job.action_id !== action_id || job.request_hash !== request_hash || job.operation !== row.operation ||
        job.brief_id !== scope.brief_id) reject("cancelled", "composition.job");
    let revision;
    try {
      revision = validateCompositionRevision(action.revision, { trustedScope: scope,
        previewBytes: action.preview_bytes, allowExpired: true });
    } catch (error) {
      reject("integrity_error", error?.field || "composition.revision");
    }
    const expectedEnvelope = createCompositionProductionEnvelope(revision);
    let actualEnvelope;
    try {
      actualEnvelope = validateCompositionProductionEnvelope(publication.result?.composition, {
        trustedScope: scope, previewBytes: action.preview_bytes,
      });
    } catch (error) {
      reject("integrity_error", error?.field || "composition.result");
    }
    if (canonicalSerialize(actualEnvelope) !== canonicalSerialize(expectedEnvelope) ||
        publication.result.revision_sha256 !== revision.revision_sha256 ||
        publication.result.selection_revision !== revision.dependencies.selection_revision ||
        !["saved", "replayed"].includes(publication.result.status)) {
      reject("integrity_error", "composition.result");
    }
    const current = this.db.prepare(`SELECT * FROM creative_composition_current_v1
      WHERE tenant_id=? AND project_id=? AND brief_id=? AND composition_id=?`)
      .get(scope.tenant_id, scope.project_id, scope.brief_id, revision.composition_id);
    const otherCurrent = this.db.prepare(`SELECT composition_id FROM creative_composition_current_v1
      WHERE tenant_id=? AND project_id=? AND brief_id=? AND design_version_id=? AND composition_id<>? LIMIT 1`)
      .get(scope.tenant_id, scope.project_id, scope.brief_id, revision.dependencies.design_version_id,
        revision.composition_id);
    if (otherCurrent) reject("stale_version", "composition.current_design_identity");
    if ((current?.revision_id ?? null) !== row.expected_current_revision_id ||
        (current?.revision_sha256 ?? null) !== row.expected_current_revision_sha256) {
      reject("stale_version", "composition.current");
    }
    if (current) {
      const priorRow = this.db.prepare(`SELECT * FROM creative_composition_revisions_v1
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND composition_id=? AND revision_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id, revision.composition_id, current.revision_id);
      const prior = compositionRevisionFromRow(this, scope, priorRow);
      if (prior.revision.revision_sha256 !== current.revision_sha256 ||
          row.operation !== "composition.revalidate" && !compositionRevisionIsCurrent(this, scope, prior.revision, current)) {
        reject("stale_version", "composition.parent_current");
      }
    }
    if (!compositionRevisionIsCurrent(this, scope, revision)) reject("stale_version", "composition.dependencies");
    this.#assertBriefNotInvalidated(scope, this.getBrief({ scope, brief_id: scope.brief_id }));
    const existingRevision = this.db.prepare(`SELECT revision_sha256 FROM creative_composition_revisions_v1
      WHERE tenant_id=? AND project_id=? AND brief_id=? AND composition_id=? AND revision_id=?`)
      .get(scope.tenant_id, scope.project_id, scope.brief_id, revision.composition_id, revision.revision_id);
    if (existingRevision) reject(existingRevision.revision_sha256 === revision.revision_sha256 ? "conflict" : "integrity_error",
      "composition.revision_id");
    const inserted = this.db.prepare(`INSERT INTO creative_composition_revisions_v1
      (tenant_id,project_id,brief_id,composition_id,revision_id,parent_revision_id,design_version_id,design_hash,
       revision_sha256,state_sha256,preview_sha256,preview_byte_length,preview_bytes,revision_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(scope.tenant_id, scope.project_id, scope.brief_id, revision.composition_id, revision.revision_id,
        revision.parent_revision_id, revision.dependencies.design_version_id, revision.dependencies.design_version_sha256,
        revision.revision_sha256, revision.state_sha256, revision.preview.preview_sha256, revision.preview.byte_length,
        Buffer.from(action.preview_bytes), canonicalSerialize(revision), revision.created_at).changes;
    if (inserted !== 1) reject("unavailable", "composition.revision", true);
    injectFault(publication.faultInjector, "composition.after_revision_insert");
    const now = this.timestamp();
    if (current) {
      const changed = this.db.prepare(`UPDATE creative_composition_current_v1 SET revision_id=?,revision_sha256=?,
        design_version_id=?,design_hash=?,selection_revision=?,updated_at=?
        WHERE tenant_id=? AND project_id=? AND brief_id=? AND composition_id=? AND revision_id IS ? AND revision_sha256 IS ?`)
        .run(revision.revision_id, revision.revision_sha256, revision.dependencies.design_version_id,
          revision.dependencies.design_version_sha256, revision.dependencies.selection_revision, now,
          scope.tenant_id, scope.project_id, scope.brief_id, revision.composition_id,
          row.expected_current_revision_id, row.expected_current_revision_sha256).changes;
      if (changed !== 1) reject("stale_version", "composition.current");
    } else {
      this.db.prepare(`INSERT INTO creative_composition_current_v1
        (tenant_id,project_id,brief_id,composition_id,revision_id,revision_sha256,design_version_id,design_hash,
         selection_revision,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(scope.tenant_id, scope.project_id, scope.brief_id, revision.composition_id, revision.revision_id,
          revision.revision_sha256, revision.dependencies.design_version_id, revision.dependencies.design_version_sha256,
          revision.dependencies.selection_revision, now);
    }
    injectFault(publication.faultInjector, "composition.after_current_update");
    const committedCurrent = this.db.prepare(`SELECT * FROM creative_composition_current_v1
      WHERE tenant_id=? AND project_id=? AND brief_id=? AND composition_id=?`)
      .get(scope.tenant_id, scope.project_id, scope.brief_id, revision.composition_id);
    if (!compositionRevisionIsCurrent(this, scope, revision, committedCurrent)) reject("stale_version", "composition.current_after_publish");
    const result_json = canonicalSerialize({ status: "published", revision_id: revision.revision_id,
      revision_sha256: revision.revision_sha256 });
    const changedAction = this.db.prepare(`UPDATE creative_composition_actions_v1 SET status='published',result_json=?,updated_at=?
      WHERE tenant_id=? AND project_id=? AND brief_id=? AND action_id=? AND status='staged'
        AND candidate_revision_json=? AND preview_sha256=?`)
      .run(result_json, now, scope.tenant_id, scope.project_id, scope.brief_id, action_id,
        canonicalSerialize(revision), revision.preview.preview_sha256).changes;
    if (changedAction !== 1) reject("conflict", "composition.action");
    injectFault(publication.faultInjector, "composition.after_action_publish");
    return freezeReturned({ status: "saved", composition: revision });
  }

  getDesignVersion({ scope: inputScope, brief_id, design_version_id }) {
    this.assertOpen();
    const scope = validScope(inputScope, brief_id);
    reference(design_version_id, "design_version_id");
    const row = this.db.prepare(`SELECT * FROM design_versions WHERE tenant_id=? AND project_id=? AND brief_id=? AND design_version_id=?`)
      .get(scope.tenant_id, scope.project_id, scope.brief_id, design_version_id);
    if (!row || !rowScope(row, scope)) return null;
    const metadata = snapshotJson(JSON.parse(row.metadata_json), "integrity_error", "metadata");
    const evidence = this.readEvidence(scope, design_version_id);
    if (!evidence || canonicalHash(evidence.context) !== evidence.context_hash || canonicalHash(evidence.evidence) !== evidence.evidence_hash ||
      metadata.context_hash !== evidence.context_hash || metadata.evidence_hash !== evidence.evidence_hash ||
      evidence.evidence.creation?.action_id !== row.action_id || evidence.evidence.creation?.job_id !== row.creation_job_id) {
      reject("integrity_error", "version_evidence");
    }
    validateContextRecord(evidence.context, { ...scope, design_version_id }, "version_evidence.context");
    const design = validateDesignVersion(metadata.design_version, {
      trustedScope: { ...scope, design_version_id },
      brief_hash: evidence.context.brief_hash,
      known_source_refs: evidence.context.brief_snapshot.source_identity.map((source) => source.source_id),
      ...(row.parent_version_id !== null ? { design_version_ids: [row.parent_version_id] } : {}),
    });
    if (design.design_hash !== row.design_hash || design.artifact.content_hash !== row.content_hash ||
      design.artifact.artifact_id !== row.artifact_id || row.brief_hash !== design.brief_hash) reject("integrity_error", "design_version");
    if (design.occurred_at !== row.occurred_at) reject("integrity_error", "design_version.occurred_at");
    if (design.parent_version_id !== row.parent_version_id) reject("integrity_error", "design_version.parent_version_id");
    if (row.parent_version_id === null) {
      if (row.parent_design_hash !== null) reject("integrity_error", "design_version.parent_design_hash");
    } else {
      const parentHash = getDesignHashAt(this.db, scope, row.parent_version_id);
      if (!parentHash || parentHash !== row.parent_design_hash) reject("integrity_error", "design_version.parent_design_hash");
    }
    const storedBytes = readStoredObjectSync(this.objectRoot, design.artifact.content_hash);
    if (!storedBytes || storedBytes.byteLength !== metadata.artifact?.byte_length ||
      hashArtifactBytes(storedBytes) !== design.artifact.content_hash) reject("integrity_error", "artifact.content_hash");
    return freezeReturned(design);
  }

  readEvidence(scope, designVersionId) {
    const row = this.db.prepare(`SELECT context_json,context_hash,evidence_json,evidence_hash FROM version_evidence
      WHERE tenant_id=? AND project_id=? AND brief_id=? AND design_version_id=?`)
      .get(scope.tenant_id, scope.project_id, scope.brief_id, designVersionId);
    if (!row) return null;
    return {
      context: snapshotJson(JSON.parse(row.context_json), "integrity_error", "context"), context_hash: row.context_hash,
      evidence: snapshotJson(JSON.parse(row.evidence_json), "integrity_error", "evidence"), evidence_hash: row.evidence_hash,
    };
  }

  async getArtifactBytes({ scope: inputScope, brief_id, design_version_id }) {
    this.assertOpen();
    const scope = validScope(inputScope, brief_id);
    const design = this.getDesignVersion({ scope, brief_id: scope.brief_id, design_version_id });
    if (!design) return null;
    try { return await readContentAddressedObject(this.objectRoot, design.artifact.content_hash); }
    catch { reject("integrity_error", "artifact.content_hash"); }
  }

  getSelection({ scope: inputScope, brief_id }) {
    this.assertOpen();
    const scope = validScope(inputScope, brief_id);
    const row = this.db.prepare(`SELECT design_version_id,design_hash,revision FROM version_selections
      WHERE tenant_id=? AND project_id=? AND brief_id=?`)
      .get(scope.tenant_id, scope.project_id, scope.brief_id);
    if (!row) return null;
    if (!Number.isSafeInteger(row.revision) || row.revision < 1) reject("integrity_error", "selection.revision");
    const design = this.getDesignVersion({ scope, brief_id: scope.brief_id, design_version_id: row.design_version_id });
    if (!design || design.design_hash !== row.design_hash) reject("integrity_error", "selection.design_hash");
    return freezeReturned({ tenant_id: scope.tenant_id, project_id: scope.project_id, brief_id: scope.brief_id,
      design_version_id: row.design_version_id, design_hash: row.design_hash, revision: row.revision });
  }

  getCurrentDesignVersion({ scope: inputScope, brief_id }) {
    const selection = this.getSelection({ scope: inputScope, brief_id });
    if (!selection) return null;
    return this.getDesignVersion({ scope: inputScope, brief_id, design_version_id: selection.design_version_id });
  }

  listDesignVersions({ scope: inputScope, brief_id, limit = 20, after = null }) {
    this.assertOpen();
    const scope = validScope(inputScope, brief_id);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 101) reject("invalid_request", "limit");
    if (after !== null && (!isRecord(after) || typeof after.occurred_at !== "string" || !Number.isFinite(Date.parse(after.occurred_at)))) {
      reject("invalid_request", "after");
    }
    const rows = after === null
      ? this.db.prepare(`SELECT design_version_id FROM design_versions WHERE tenant_id=? AND project_id=? AND brief_id=?
          ORDER BY occurred_at DESC,design_version_id ASC LIMIT ?`).all(scope.tenant_id, scope.project_id, scope.brief_id, limit + 1)
      : this.db.prepare(`SELECT design_version_id FROM design_versions WHERE tenant_id=? AND project_id=? AND brief_id=?
          AND (occurred_at<? OR (occurred_at=? AND design_version_id>?))
          ORDER BY occurred_at DESC,design_version_id ASC LIMIT ?`).all(scope.tenant_id, scope.project_id, scope.brief_id,
        after.occurred_at, after.occurred_at, reference(after.design_version_id, "after.design_version_id"), limit + 1);
    const selected = rows.slice(0, limit);
    const items = selected.map((row) => this.getDesignVersion({ scope, brief_id: scope.brief_id, design_version_id: row.design_version_id }));
    return freezeReturned({ items, has_more: rows.length > limit });
  }

  compareDesignVersions({ scope, brief_id, left_design_version_id, right_design_version_id }) {
    const left = this.getDesignVersion({ scope, brief_id, design_version_id: left_design_version_id });
    const right = this.getDesignVersion({ scope, brief_id, design_version_id: right_design_version_id });
    if (!left || !right) reject("not_found", "design_version_id");
    return freezeReturned({ left, right, changed_fields: [
      ...(left.artifact.content_hash !== right.artifact.content_hash ? ["artifact.content_hash"] : []),
      ...(left.parent_version_id !== right.parent_version_id ? ["parent_version_id"] : []),
      ...(left.brief_hash !== right.brief_hash ? ["brief_hash"] : []),
    ] });
  }

  async selectDesignVersion(input, transaction) {
    this.assertOpen();
    if (!isRecord(input)) reject("invalid_request", "selection");
    const scope = validScope(input.scope, input.brief_id);
    const publication = this.publicationTransactionData(transaction);
    const ownsTransaction = transaction === undefined;
    if (!ownsTransaction && (!publication || publication.scope.tenant_id !== scope.tenant_id ||
      publication.scope.project_id !== scope.project_id || publication.scope.brief_id !== scope.brief_id)) {
      reject("scope_denied", "publication_transaction");
    }
    const target = this.getDesignVersion({ scope, brief_id: scope.brief_id, design_version_id: input.design_version_id });
    if (!target) reject("not_found", "design_version_id");
    if (target.design_hash !== input.expected_target_design_hash || target.brief_hash !== input.expected_brief_hash) reject("stale_version", "design_hash");
    // Restore is a selection move to an exact retained artifact, never a new version.
    // The paired adapter supplies its caller-owned transaction. In that path,
    // keep validation local and synchronous rather than holding SQLite's write
    // lock across an async filesystem operation.
    const retainedBytes = transaction === undefined
      ? await this.getArtifactBytes({ scope, brief_id: scope.brief_id, design_version_id: target.design_version_id })
      : readStoredObjectSync(this.objectRoot, target.artifact.content_hash);
    if (!retainedBytes || hashArtifactBytes(retainedBytes) !== target.artifact.content_hash) reject("integrity_error", "artifact.content_hash");
    if (!Number.isSafeInteger(input.expected_selection_revision) || input.expected_selection_revision < 0) reject("invalid_request", "expected_selection_revision");
    if (ownsTransaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      const currentBrief = this.getBrief({ scope, brief_id: scope.brief_id });
      if (!currentBrief || canonicalHash(currentBrief) !== input.expected_brief_hash) {
        if (ownsTransaction) this.db.exec("ROLLBACK");
        return Object.freeze({ status: "stale" });
      }
      this.#assertBriefNotInvalidated(scope, currentBrief);
      const current = this.db.prepare(`SELECT design_version_id,design_hash,revision FROM version_selections
        WHERE tenant_id=? AND project_id=? AND brief_id=?`)
        .get(scope.tenant_id, scope.project_id, scope.brief_id);
      const selectedId = current?.design_version_id ?? null;
      const selectedHash = current?.design_hash ?? null;
      if (selectedId !== input.expected_selected_design_version_id || selectedHash !== input.expected_selected_design_hash ||
        (current?.revision ?? 0) !== input.expected_selection_revision) {
        if (ownsTransaction) this.db.exec("ROLLBACK");
        return Object.freeze({ status: "stale" });
      }
      const nextRevision = (current?.revision ?? 0) + 1;
      const now = this.timestamp();
      this.db.prepare(`INSERT INTO version_selections
        (tenant_id,project_id,brief_id,design_version_id,design_hash,revision,updated_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant_id,project_id,brief_id) DO UPDATE SET
        design_version_id=excluded.design_version_id,design_hash=excluded.design_hash,
        revision=excluded.revision,updated_at=excluded.updated_at`)
        .run(scope.tenant_id, scope.project_id, scope.brief_id, target.design_version_id, target.design_hash, nextRevision, now);
      if (ownsTransaction) this.db.exec("COMMIT");
      return freezeReturned({ status: "selected", selection: {
        tenant_id: scope.tenant_id, project_id: scope.project_id, brief_id: scope.brief_id,
        design_version_id: target.design_version_id, design_hash: target.design_hash, revision: nextRevision,
      } });
    } catch (error) {
      if (ownsTransaction) this.rollback();
      if (error instanceof VersionStoreError) throw error;
      reject("unavailable", "selection", true);
    }
  }

}
