import { canonicalHash } from "../contracts/validation.mjs";
import { copyBoundedPlainArray, InspectionError, isInspectionHandle, canonicalInspectionSubjectHash,
  validateVisualObservation } from "./deterministic.mjs";
import { INSPECTION_POLICY_VERSION, INSPECTION_QUESTION_SCHEMA_VERSION, inspectionDecisionProvenance } from "./questions.mjs";
import { PINNED_JEV_MODEL_ID } from "../contracts/decision-port/v1.mjs";

const OUTCOMES = new Set(["acceptable_for_review", "bounded_repair_recommended", "needs_human_review", "refusal", "failure"]);
const DECISION_REASONS = new Set([
  "not_an_approval", "eligible_action_only", "decision_unavailable", "question_selected_review",
  "defect_probability_uncertain", "decision_conflicts_with_quality_evidence", "action_not_eligible",
  "repair_recommendation_not_supported",
]);
const UNCERTAINTY_CODES = new Set([
  "observer_unknown", "observer_not_measured", "low_confidence", "conflicting_observations",
  "source_not_current", "mask_unavailable", "question_abstained", "usage_incomplete", "unknown_cost",
]);

function safeVersion(value, field) {
  if (typeof value !== "string" || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value) ||
    /(?:bearer\s+\S+|basic\s+[A-Za-z0-9+/=]+|(?:sk|rk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{8,}|api[_-]?key|token|secret|@|https?:\/\/)/i.test(value)) {
    fail("invalid_policy_input", field, "Version or model identifier is not a safe bounded reference.");
  }
  return value;
}

function supportedVersion(value, expected, field) {
  const normalized = safeVersion(value, field);
  if (normalized !== expected) fail("unsupported_version", field, "Inspection report received an unsupported version or model reference.");
  return normalized;
}

function fail(code, field, message) {
  throw new InspectionError(code, field, message);
}

function safeEnum(value, allowed, field) {
  if (!allowed.includes(value)) fail("invalid_policy_input", field, "Policy input is outside the supported bounded vocabulary.");
  return value;
}

/** Return a versioned report whose only favorable outcome is for human review. */
export function createInspectionReport(input) {
  const deterministic = input?.deterministic;
  if (!isInspectionHandle(deterministic) || deterministic.contract !== "CreativeDeterministicInspection" || deterministic.schema_version !== "1.0") {
    fail("invalid_request", "deterministic", "A version 1.0 deterministic inspection is required.");
  }
  const providerStatus = input.provider_status ?? "not_requested";
  safeEnum(providerStatus, ["not_requested", "complete", "refused", "unavailable", "timeout", "cancelled"], "provider_status");
  const observationsInput = copyBoundedPlainArray(input.observations ?? [], "observations", 16);
  const observations = observationsInput.map((observation) => {
    try { return validateVisualObservation(observation, deterministic); }
    catch { fail("invalid_policy_input", "observations", "Report observations must be validated against this inspection handle."); }
  });
  const actualSubjectHash = canonicalInspectionSubjectHash(deterministic);
  if (input.subject_hash !== undefined && input.subject_hash !== actualSubjectHash) {
    fail("stale_observation", "subject_hash", "Report subject hash must match the exact inspected design and artifact.");
  }
  const policyVersion = supportedVersion(input.policy_version ?? INSPECTION_POLICY_VERSION, INSPECTION_POLICY_VERSION, "policy_version");
  const evidenceMode = safeEnum(input.evidence_mode ?? "fixture", ["fixture", "recorded", "sandbox", "live"], "evidence_mode");
  const suppliedQuestionSchema = input.question_schema_version === undefined || input.question_schema_version === null
    ? undefined : supportedVersion(input.question_schema_version, INSPECTION_QUESTION_SCHEMA_VERSION, "question_schema_version");
  const suppliedModelId = input.model_id === undefined || input.model_id === null
    ? undefined : supportedVersion(input.model_id, PINNED_JEV_MODEL_ID, "model_id");
  const suppliedDecisionPolicy = input.decision_policy_version === undefined || input.decision_policy_version === null
    ? undefined : supportedVersion(input.decision_policy_version, INSPECTION_POLICY_VERSION, "decision_policy_version");
  const decisionMetadata = inspectionDecisionProvenance(input.decision);
  const decisionObservationRef = decisionMetadata?.observationRef;
  const matchingObservation = decisionObservationRef !== undefined && observations.some((observation) =>
    canonicalHash(observation) === decisionObservationRef);
  const decisionBound = decisionMetadata !== undefined && decisionMetadata.subjectHash === actualSubjectHash &&
    decisionMetadata.scope.tenant_id === deterministic.tenant_id && decisionMetadata.scope.project_id === deterministic.project_id &&
    decisionMetadata.scope.design_version_id === deterministic.design_version_id && decisionMetadata.scope.artifact_id === deterministic.artifact_id &&
    decisionMetadata.policyVersion === INSPECTION_POLICY_VERSION &&
    decisionMetadata.questionSchemaVersion === INSPECTION_QUESTION_SCHEMA_VERSION &&
    decisionMetadata.modelId === PINNED_JEV_MODEL_ID && matchingObservation &&
    (suppliedQuestionSchema === undefined || suppliedQuestionSchema === decisionMetadata.questionSchemaVersion) &&
    (suppliedModelId === undefined || suppliedModelId === decisionMetadata.modelId) &&
    (suppliedDecisionPolicy === undefined || suppliedDecisionPolicy === decisionMetadata.policyVersion);
  let outcome;
  let reason;
  let recommendation = "human_review";
  if (deterministic.gate === "failure") {
    outcome = "failure";
    reason = "deterministic_gate_failed";
  } else if (deterministic.gate !== "eligible") {
    outcome = "needs_human_review";
    reason = "deterministic_gate_uncertain";
  } else if (providerStatus === "refused") {
    outcome = "refusal";
    reason = "observer_refused";
  } else if (["unavailable", "timeout", "cancelled", "not_requested"].includes(providerStatus)) {
    outcome = "needs_human_review";
    reason = providerStatus === "not_requested" ? "visual_observation_not_available" : `observer_${providerStatus}`;
  } else if (!decisionBound || !input.decision || !OUTCOMES.has(input.decision.outcome)) {
    outcome = "needs_human_review";
    reason = "decision_provenance_unverified";
  } else {
    outcome = input.decision.outcome;
    reason = DECISION_REASONS.has(input.decision.reason) ? input.decision.reason : "decision_unavailable";
    recommendation = input.decision.action ?? "human_review";
  }
  if (outcome === "bounded_repair_recommended") {
    if (!deterministic.eligible_repair_actions.includes(recommendation)) {
      outcome = "needs_human_review";
      reason = "repair_action_not_in_trusted_allowlist";
      recommendation = "human_review";
    }
    if (recommendation === "human_review") {
      outcome = "needs_human_review";
      reason = "repair_action_not_in_trusted_allowlist";
    }
  } else {
    recommendation = outcome === "acceptable_for_review" ? "no_repair_recommended" : "human_review";
  }
  if (outcome === "acceptable_for_review" && observations.length === 0) {
    outcome = "needs_human_review";
    reason = "observation_not_available";
    recommendation = "human_review";
  }
  if (outcome === "bounded_repair_recommended" && observations.length === 0) {
    outcome = "needs_human_review";
    reason = "observation_not_available";
    recommendation = "human_review";
  }
  const questionSchemaVersion = decisionBound ? decisionMetadata.questionSchemaVersion : suppliedQuestionSchema ?? null;
  const modelId = decisionBound ? decisionMetadata.modelId : suppliedModelId ?? null;
  const decisionPolicyVersion = decisionBound ? decisionMetadata.policyVersion : suppliedDecisionPolicy ?? null;
  const uncertainty = copyBoundedPlainArray(input.uncertainty ?? [], "uncertainty", 32);
  if (uncertainty.some((item) => !UNCERTAINTY_CODES.has(item))) {
    fail("invalid_policy_input", "uncertainty", "Uncertainty codes must use the bounded report vocabulary.");
  }
  const limitsInput = input.limits ?? {};
  const remainingRepairs = limitsInput.remaining_repairs ?? 2;
  const remainingElapsed = limitsInput.remaining_elapsed_ms ?? 60_000;
  const remainingUnits = limitsInput.remaining_simulated_units ?? 3;
  const usageCompleteness = limitsInput.usage_completeness ?? "unknown";
  if (!Number.isSafeInteger(remainingRepairs) || remainingRepairs < 0 || remainingRepairs > 2 ||
    !Number.isSafeInteger(remainingElapsed) || remainingElapsed < 0 || remainingElapsed > 60_000 ||
    typeof remainingUnits !== "number" || !Number.isFinite(remainingUnits) || remainingUnits < 0 || remainingUnits > 3 ||
    !["complete", "partial", "unknown"].includes(usageCompleteness)) {
    fail("invalid_policy_input", "limits", "Repair limits or usage completeness are invalid.");
  }
  const report = {
    contract: "CreativeInspectionReport",
    schema_version: "1.0",
    policy_version: policyVersion,
    evidence_mode: evidenceMode,
    tenant_id: deterministic.tenant_id,
    project_id: deterministic.project_id,
    brief_id: deterministic.brief_id,
    brief_hash: deterministic.brief_hash,
    design_version_id: deterministic.design_version_id,
    parent_design_hash: deterministic.parent_design_hash,
    design_hash: deterministic.design_hash,
    artifact_id: deterministic.artifact_id,
    artifact_hash: deterministic.artifact_hash,
    subject_hash: actualSubjectHash,
    plan_ref: decisionBound ? decisionMetadata.planRef : null,
    first_request_ref: decisionBound ? decisionMetadata.firstRequestRef : null,
    route_request_ref: decisionBound ? decisionMetadata.routeRequestRef : null,
    decision_ref: decisionBound ? decisionMetadata.decisionRef : null,
    decision_context_ref: decisionBound ? decisionMetadata.decisionContextRef : null,
    deterministic: Object.freeze({ gate: deterministic.gate, checks: deterministic.checks }),
    observations: Object.freeze([...observations]),
    question_schema_version: questionSchemaVersion,
    model_id: modelId,
    decision_policy_version: decisionPolicyVersion,
    eligible_repair_actions: Object.freeze([...deterministic.eligible_repair_actions]),
    outcome,
    recommendation,
    reason,
    uncertainty: Object.freeze([...uncertainty]),
    limits: Object.freeze({
      max_repairs: 2,
      max_elapsed_ms: 60_000,
      max_simulated_units: 3,
      remaining_repairs: remainingRepairs,
      remaining_elapsed_ms: remainingElapsed,
      remaining_simulated_units: remainingUnits,
      usage_completeness: usageCompleteness,
    }),
    limitations: Object.freeze([
      "This report can recommend a bounded repair or human review only.",
      "It is not customer approval, legal clearance, or print certification.",
      input.evidence_mode === "fixture" ? "Fixture policy is not promoted or accepted policy." : "Live provider acceptance remains separately gated.",
    ]),
  };
  return Object.freeze(report);
}

/**
 * Fixture-only held-out metrics. Unknown downstream cost remains unknown; no
 * classifier promotion or confidence claim is emitted by this function.
 */
export function evaluateHeldOutFixtures(input) {
  if (!input || input.schema_version !== "1.0") {
    fail("invalid_evaluation", "cases", "A bounded non-empty held-out fixture set is required.");
  }
  const cases = copyBoundedPlainArray(input.cases, "cases", 10_000);
  if (cases.length === 0) fail("invalid_evaluation", "cases", "A bounded non-empty held-out fixture set is required.");
  const corpusHash = input.corpus_hash;
  if (typeof corpusHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(corpusHash)) {
    fail("invalid_evaluation", "corpus_hash", "Held-out corpus must have a content hash.");
  }
  let defectFalseNegatives = 0;
  let defectCount = 0;
  let validFalseRepairs = 0;
  let validOutputCount = 0;
  let unknownLabelCount = 0;
  let abstentions = 0;
  let knownCosts = 0;
  let totalKnownCost = 0;
  const latencies = [];
  for (const entry of cases) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !entry.report ||
      entry.report.contract !== "CreativeInspectionReport" || !OUTCOMES.has(entry.report.outcome)) {
      fail("invalid_evaluation", "cases", "Held-out case shape is invalid.");
    }
    const expected = safeEnum(entry.expected_defect, [true, false, null], "expected_defect");
    if (![true, false, null].includes(entry.predicted_defect)) fail("invalid_evaluation", "predicted_defect", "Predicted defect must be true, false, or unknown.");
    if (expected === true) {
      defectCount += 1;
      if (entry.predicted_defect === false) defectFalseNegatives += 1;
    } else if (expected === false) {
      validOutputCount += 1;
      if (entry.report.outcome === "bounded_repair_recommended") validFalseRepairs += 1;
    } else {
      unknownLabelCount += 1;
    }
    if (["needs_human_review", "refusal", "failure"].includes(entry.report.outcome)) abstentions += 1;
    if (!Number.isFinite(entry.latency_ms) || entry.latency_ms < 0) fail("invalid_evaluation", "latency_ms", "Latency must be a finite non-negative measurement.");
    latencies.push(entry.latency_ms);
    const cost = entry.downstream_cost;
    if (cost?.status === "known" && typeof cost.amount === "number" && Number.isFinite(cost.amount) && cost.amount >= 0) {
      knownCosts += 1;
      totalKnownCost += cost.amount;
    } else if (cost?.status !== "unknown") {
      fail("invalid_evaluation", "downstream_cost", "Cost must be explicitly known or unknown.");
    }
  }
  latencies.sort((left, right) => left - right);
  const percentile = (ratio) => latencies[Math.min(latencies.length - 1, Math.ceil(ratio * latencies.length) - 1)];
  return Object.freeze({
    contract: "CreativeInspectionFixtureMetrics",
    schema_version: "1.0",
    evidence_mode: "fixture",
    policy_version: supportedVersion(input.policy_version ?? INSPECTION_POLICY_VERSION, INSPECTION_POLICY_VERSION, "policy_version"),
    corpus_hash: corpusHash,
    sample_count: cases.length,
    defect_count: defectCount,
    defect_false_negatives: defectFalseNegatives,
    defect_false_negative_rate: defectCount === 0 ? null : defectFalseNegatives / defectCount,
    valid_output_count: validOutputCount,
    valid_output_false_repairs: validFalseRepairs,
    valid_output_false_repair_rate: validOutputCount === 0 ? null : validFalseRepairs / validOutputCount,
    unknown_label_count: unknownLabelCount,
    unknown_label_rate: unknownLabelCount / cases.length,
    human_review_or_failure_count: abstentions,
    human_review_or_failure_rate: abstentions / cases.length,
    latency_ms: Object.freeze({ p50: percentile(0.5), p95: percentile(0.95), max: latencies.at(-1) }),
    downstream_cost: knownCosts === cases.length
      ? Object.freeze({ status: "known", total: totalKnownCost, currency: safeVersion(input.currency ?? "fixture-unit", "currency") })
      : Object.freeze({ status: "unknown", known_case_count: knownCosts, total_known_only: totalKnownCost }),
    promotion_status: "not_promoted",
    note: "Fixture metrics do not establish classifier calibration, live provider execution, accepted Q01 thresholds, or customer approval.",
    metrics_hash: canonicalHash({ corpus_hash: corpusHash, sample_count: cases.length,
      defect_count: defectCount, defect_false_negatives: defectFalseNegatives,
      valid_output_count: validOutputCount, valid_output_false_repairs: validFalseRepairs,
      unknown_label_count: unknownLabelCount, unknown_label_rate: unknownLabelCount / cases.length,
      abstentions, human_review_or_failure_rate: abstentions / cases.length,
      latency_ms: latencies, knownCosts, totalKnownCost }),
  });
}
