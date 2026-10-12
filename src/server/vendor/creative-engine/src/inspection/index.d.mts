import type { CreativeBrief, DesignVersion, TrustedScope } from "../contracts/creative/v1.mjs";
import type { DecisionPortRequest, DecisionPortResult, DecisionQuestion, UnreservedDecisionPortRequest } from "../contracts/decision-port/v1.mjs";

export interface InspectionErrorShape {
  code: string;
  contract: "CreativeDeterministicInspection";
  field: string;
}

export declare class InspectionError extends Error implements InspectionErrorShape {
  constructor(code: string, field: string, message: string);
  readonly code: string;
  readonly contract: "CreativeDeterministicInspection";
  readonly field: string;
}

export declare const INSPECTION_LIMITS: Readonly<{
  maxArtifactBytes: 20_971_520;
  maxDimension: 20_000;
  maxPixels: 40_000_000;
  maxPngInflatedBytes: 167_772_160;
  maxUsedAssets: 64;
}>;

export type InspectionCheck = Readonly<{
  id: string;
  status: "pass" | "fail" | "unknown";
  reason?: string;
}>;

export interface DeterministicInspection {
  readonly contract: "CreativeDeterministicInspection";
  readonly schema_version: "1.0";
  readonly tenant_id: string;
  readonly project_id: string;
  readonly brief_id: string;
  readonly brief_hash: string;
  readonly design_version_id: string;
  readonly design_hash: string;
  readonly parent_design_hash: string | null;
  readonly artifact_id: string;
  readonly artifact_hash: string;
  readonly actual_artifact_hash: string;
  readonly media_type: string;
  readonly dimensions: Readonly<{ width: number; height: number; format?: "png" | "jpeg" | "webp";
    decoded_scanlines?: number; has_alpha?: boolean; has_transparency?: boolean }> | null;
  readonly checks: readonly InspectionCheck[];
  readonly gate: "eligible" | "needs_human_review" | "failure";
  readonly eligible_repair_actions: readonly InspectionRepairAction[];
}

export type InspectionRepairAction = "image.edit" | "composition.update" | "correction.apply" | "concept.generate";
export type UsedAssetAction = "reproduce" | "modify" | "publish" | "display";

export interface InspectCreativeArtifactInput {
  trusted_scope: TrustedScope;
  brief: CreativeBrief | Record<string, unknown>;
  design_version: DesignVersion | Record<string, unknown>;
  parent_design?: DesignVersion | Record<string, unknown>;
  parent_design_hash?: string | null;
  artifact_bytes: Uint8Array;
  /** Complete trusted asset-use set for the inspected version, including an explicit empty list. */
  used_assets: readonly { asset_id: string; action: UsedAssetAction }[];
  /** Old versions without hash-bound asset-use evidence stay human-review-only. */
  asset_use_evidence_status?: "verified" | "unknown";
  /** Metadata from the shared native codec, bound by the runtime to the exact byte hash. */
  decoder_result?: Readonly<{ contract: "OpenAIBoundedImageDecode"; schema_version: "1.0";
    status: "pass" | "fail" | "unknown"; artifact_hash: string; format: "png" | "jpeg" | "webp"; width: number; height: number;
    has_alpha: boolean; has_transparency: boolean }>;
  /** Host-supplied eligible action intersection; this module never grants or dispatches actions. */
  eligible_repair_actions?: readonly InspectionRepairAction[];
}

export declare const INSPECTION_QUESTION_SCHEMA_VERSION: "1.0";
export declare const INSPECTION_POLICY_VERSION: "fixture-policy/1.0";
export type InspectionTrustedScope = TrustedScope & Readonly<{
  brief_id: string;
  design_version_id: string;
  artifact_id: string;
}>;

export interface CreativeVisualObservation {
  readonly contract: "CreativeVisualObservation";
  readonly schema_version: "1.0";
  readonly tenant_id: string;
  readonly project_id: string;
  readonly brief_id: string;
  readonly design_version_id: string;
  readonly artifact_id: string;
  readonly brief_hash: string;
  readonly parent_design_hash: string | null;
  readonly design_hash: string;
  readonly artifact_hash: string;
  readonly observation_id: string;
  readonly observed_at: string;
  readonly observer: Readonly<{ type: "human" | "model" | "system"; id: string; model_id?: string; config_ref?: string }>;
  readonly source: Readonly<{ kind: "vision_model" | "human_review" | "deterministic_check"; source_ref: string }>;
  readonly uncertainty: Readonly<{ status: "measured" | "not_measured" | "unknown"; note?: string }>;
  readonly findings: readonly Readonly<{
    code: "wrong_subject" | "mask_drift" | "text_mismatch" | "crop_issue" | "layout_issue" | "brand_mark" | "other_visual_defect";
    status: "present" | "absent" | "uncertain";
    severity: "info" | "low" | "moderate" | "high" | "critical";
    confidence?: number;
    region?: Readonly<{ x: number; y: number; width: number; height: number }>;
  }>[];
  readonly usage: Readonly<{
    completeness: "complete" | "partial" | "unknown";
    usage_ref?: string;
    input_tokens?: number;
    output_tokens?: number;
  }>;
}

export declare function inspectCreativeArtifact(input: InspectCreativeArtifactInput): DeterministicInspection;
/** Copy bytes from a genuine inspection handle for a trusted injected decoder/observer. */
export declare function copyInspectionArtifactBytes(deterministic: DeterministicInspection): Uint8Array;
export declare function validateVisualObservation(value: unknown, deterministic: DeterministicInspection): CreativeVisualObservation;
export declare function deterministicDecisionObservation(observation: CreativeVisualObservation): DecisionObservation;
export declare function canonicalInspectionSubjectHash(deterministic: DeterministicInspection): string;

export interface DecisionObservation {
  readonly observer: Readonly<{ type: "human" | "model" | "system"; id: string }>;
  readonly content_hash: string;
  readonly uncertainty: Readonly<{ status: "measured" | "not_measured" | "unknown"; note?: string }>;
  readonly summary: string;
  readonly source_ref: string;
}

export interface InspectionQuestionPlan {
  readonly status: "ready";
  readonly contract: "CreativeInspectionQuestionPlan";
  readonly schema_version: "1.0";
  readonly policy_version: string;
  readonly question_schema_version: "1.0";
  readonly inspection_subject_hash: string;
  readonly decision_context_ref: string;
  readonly plan_ref: string;
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
  readonly batches: readonly (readonly string[])[];
  readonly first_stage_question_ids: readonly string[];
  readonly dependent_question_id: "next_step";
  readonly eligible_candidates: readonly string[];
  readonly decision_observation: DecisionObservation;
}

export type InspectionDecisionContext = Pick<DecisionPortRequest,
  "event_id" | "correlation_id" | "producer" | "occurred_at" | "ingested_at" | "environment" | "billing_mode" |
  "request_id" | "logical_operation_id" | "billable_attempt_id" | "attempt_number" | "attempt_limit" | "budget_ref" |
  "deadline_at" | "cancellation_ref" | "model_policy"> & Partial<Pick<DecisionPortRequest,
  "workflow_id" | "run_id" | "order_id" | "job_id" | "transport_attempt_id" | "provider_request_id">>;

export type InspectionQuestionPlanResult = InspectionQuestionPlan | Readonly<{
  status: "unavailable" | "refusal";
  reason: string;
}>;

export declare function createInspectionDecisionPlan(input: {
  deterministic: DeterministicInspection;
  observation: CreativeVisualObservation;
  /** Trusted host/C03 operation context; no fixture reservation or attempt identifiers are synthesized. */
  decision_context: InspectionDecisionContext;
  provider_status?: "complete" | "refused" | "unavailable" | "timeout" | "cancelled";
  inspection_subject_hash?: string;
}): InspectionQuestionPlanResult;
export type UnreservedInspectionDecisionContext = Omit<InspectionDecisionContext, "budget_ref"> & {
  budget_ref: UnreservedDecisionPortRequest["budget_ref"];
};
export declare function prepareInspectionDecisionPlan(input: Omit<Parameters<typeof createInspectionDecisionPlan>[0], "decision_context"> & {
  decision_context: UnreservedInspectionDecisionContext;
}): InspectionQuestionPlanResult;
export declare function prepareInspectionEvidenceBatch(plan: InspectionQuestionPlan,
  observation: CreativeVisualObservation): UnreservedDecisionPortRequest;
export declare function bindInspectionDecisionReservation(plan: InspectionQuestionPlan,
  preparedRequest: UnreservedDecisionPortRequest, reservationRef: string): DecisionPortRequest;
export declare function createInspectionRoutingInput(input: {
  deterministic: DeterministicInspection;
  observation: CreativeVisualObservation;
}): Readonly<{ status: "ready"; execution_mode: "sequential"; state: Readonly<{ observations: readonly DecisionObservation[] }>;
  questions: Readonly<Record<string, DecisionQuestion>> }> | Readonly<{ status: "unavailable"; reason: string }>;
export type InspectionRouteDecisionContext = InspectionDecisionContext & Readonly<{
  linked_request_id: string;
  linked_billable_attempt_id: string;
  plan_ref: string;
  inspection_subject_hash: string;
}>;

export declare function createInspectionEvidenceBatch(plan: InspectionQuestionPlan, observation: CreativeVisualObservation): DecisionPortRequest;
export declare function createInspectionRouteBatch(
  plan: InspectionQuestionPlan,
  firstRequest: DecisionPortRequest,
  firstResult: DecisionPortResult,
  trustedScope: InspectionTrustedScope,
  routeDecisionContext: InspectionRouteDecisionContext,
): DecisionPortRequest |
  Readonly<{ status: "review_required"; reason: string }>;
export declare function prepareInspectionRouteBatch(plan: InspectionQuestionPlan, firstRequest: DecisionPortRequest,
  firstResult: DecisionPortResult, trustedScope: InspectionTrustedScope,
  routeDecisionContext: UnreservedInspectionDecisionContext & Pick<InspectionRouteDecisionContext,
    "linked_request_id" | "linked_billable_attempt_id" | "plan_ref" | "inspection_subject_hash">):
  UnreservedDecisionPortRequest | Readonly<{ status: "review_required"; reason: string }>;
export interface InspectionDecision {
  readonly status: "complete" | "review_required";
  readonly outcome: "acceptable_for_review" | "bounded_repair_recommended" | "needs_human_review";
  readonly action?: InspectionRepairAction;
  readonly reason: string;
  readonly inspection_subject_hash: string;
  readonly question_schema_version: "1.0";
  readonly model_id: string;
  readonly decision_policy_version: string;
  readonly plan_ref: string;
  readonly first_request_ref: string;
  readonly route_request_ref: string;
  readonly decision_context_ref: string;
  readonly decision_ref: string;
}
export declare function evaluateInspectionDecision(
  plan: InspectionQuestionPlan,
  firstRequest: DecisionPortRequest,
  firstResult: DecisionPortResult,
  routeRequest: DecisionPortRequest,
  routeResult: DecisionPortResult,
  trustedScope: InspectionTrustedScope,
): InspectionDecision;
export declare function validateInspectionDecisionRequest(request: DecisionPortRequest | Record<string, unknown>, trustedScope: InspectionTrustedScope): DecisionPortRequest;

export type InspectionOutcome = "acceptable_for_review" | "bounded_repair_recommended" | "needs_human_review" | "refusal" | "failure";
export interface CreativeInspectionReport {
  readonly contract: "CreativeInspectionReport";
  readonly schema_version: "1.0";
  readonly policy_version: string;
  readonly evidence_mode: "fixture" | "recorded" | "sandbox" | "live";
  readonly tenant_id: string;
  readonly project_id: string;
  readonly brief_id: string;
  readonly brief_hash: string;
  readonly design_version_id: string;
  readonly parent_design_hash: string | null;
  readonly design_hash: string;
  readonly artifact_id: string;
  readonly artifact_hash: string;
  readonly subject_hash: string;
  readonly plan_ref: string | null;
  readonly first_request_ref: string | null;
  readonly route_request_ref: string | null;
  readonly decision_ref: string | null;
  readonly decision_context_ref: string | null;
  readonly deterministic: Readonly<{ gate: DeterministicInspection["gate"]; checks: readonly InspectionCheck[] }>;
  readonly observations: readonly CreativeVisualObservation[];
  readonly question_schema_version: string | null;
  readonly model_id: string | null;
  readonly decision_policy_version: string | null;
  readonly eligible_repair_actions: readonly InspectionRepairAction[];
  readonly outcome: InspectionOutcome;
  readonly recommendation: string;
  readonly reason: string;
  readonly uncertainty: readonly string[];
  readonly limits: Readonly<{ max_repairs: 2; max_elapsed_ms: 60_000; max_simulated_units: 3;
    remaining_repairs: number; remaining_elapsed_ms: number; remaining_simulated_units: number;
    usage_completeness: "complete" | "partial" | "unknown" }>;
  readonly limitations: readonly string[];
}

export declare function createInspectionReport(input: {
  deterministic: DeterministicInspection;
  provider_status?: "not_requested" | "complete" | "refused" | "unavailable" | "timeout" | "cancelled";
  decision?: InspectionDecision;
  observations?: readonly CreativeVisualObservation[];
  policy_version?: string;
  evidence_mode?: "fixture" | "recorded" | "sandbox" | "live";
  subject_hash?: string;
  question_schema_version?: string | null;
  model_id?: string | null;
  decision_policy_version?: string | null;
  uncertainty?: readonly string[];
  limits?: Partial<CreativeInspectionReport["limits"]>;
}): CreativeInspectionReport;

export interface InspectionFixtureMetrics {
  readonly contract: "CreativeInspectionFixtureMetrics";
  readonly schema_version: "1.0";
  readonly evidence_mode: "fixture";
  readonly policy_version: string;
  readonly corpus_hash: string;
  readonly sample_count: number;
  readonly defect_count: number;
  readonly defect_false_negatives: number;
  readonly defect_false_negative_rate: number | null;
  readonly valid_output_count: number;
  readonly valid_output_false_repairs: number;
  readonly valid_output_false_repair_rate: number | null;
  readonly unknown_label_count: number;
  readonly unknown_label_rate: number;
  readonly human_review_or_failure_count: number;
  readonly human_review_or_failure_rate: number;
  readonly latency_ms: Readonly<{ p50: number; p95: number; max: number }>;
  readonly downstream_cost: Readonly<{ status: "known"; total: number; currency: string }> |
    Readonly<{ status: "unknown"; known_case_count: number; total_known_only: number }>;
  readonly promotion_status: "not_promoted";
  readonly note: string;
  readonly metrics_hash: string;
}
export declare function evaluateHeldOutFixtures(input: {
  schema_version: "1.0";
  corpus_hash: string;
  policy_version?: string;
  currency?: string;
  cases: readonly {
    expected_defect: boolean | null;
    predicted_defect: boolean | null;
    report: Pick<CreativeInspectionReport, "contract" | "outcome">;
    latency_ms: number;
    downstream_cost: { status: "known"; amount: number } | { status: "unknown" };
  }[];
}): InspectionFixtureMetrics;

export declare const REPAIR_LIMITS: Readonly<{ maxRepairs: 2; maxElapsedMs: 60_000; maxSimulatedUnits: 3 }>;
export interface InspectionRepairController {
  readonly limits: typeof REPAIR_LIMITS;
  startInspection(input: { scope: TrustedScope & { brief_id: string; design_version_id: string }; inspection_id: string;
    brief_hash: string; design_hash: string }): Readonly<{ status: "active" | "cancelled"; inspection_id: string;
    started_at_ms: number; elapsed_ms: number; replayed: boolean }>;
  recordRepairClaim(input: { scope: TrustedScope & { brief_id: string; design_version_id: string }; inspection_id: string;
    action_id: string; request_hash: string; repair_action: InspectionRepairAction; simulated_units?: number | null }):
    Readonly<{ status: "recorded" | "replayed" | "cancelled" | "conflict" | "not_found" | "expired" | "limit_reached" | "unknown_cost";
      local_limit_status?: "within_limits"; claim_ref?: string; reason?: string; action_id?: string; repair_action?: InspectionRepairAction;
      simulated_units?: number; started_at_ms?: number; root_brief_hash?: string; root_design_hash?: string }>;
  recordRepairOutcome(input: { scope: TrustedScope & { brief_id: string; design_version_id: string }; inspection_id: string;
    action_id: string; result_hash: string }):
    Readonly<{ status: "recorded" | "replayed" | "cancelled" | "conflict" | "not_found"; result_hash?: string }>;
  recordRepairOutcomeInPublication(input: { scope: TrustedScope & { brief_id: string; design_version_id: string }; inspection_id: string;
    action_id: string; result_hash: string; proof: import("../api/v1.mjs").CreativeInspectionRepairFence }):
    Readonly<{ status: "recorded" | "cancelled"; result_hash?: string }>;
  isClaimCurrent(input: { scope: TrustedScope & { brief_id: string; design_version_id: string };
    proof: import("../api/v1.mjs").CreativeInspectionRepairFence }): boolean;
  cancelInspection(input: { scope: TrustedScope & { brief_id: string; design_version_id: string }; inspection_id: string }):
    Readonly<{ status: "cancelled" | "replayed" | "not_found" }>;
  getState(input: { scope: TrustedScope & { brief_id: string; design_version_id: string }; inspection_id: string }): Readonly<{
    inspection_id: string; brief_hash: string; design_hash: string; started_at_ms: number; elapsed_ms: number;
    status: "active" | "cancelled"; repairs_used: number; simulated_units_used: number; remaining_repairs: number;
    remaining_elapsed_ms: number; remaining_simulated_units: number; actions: readonly Readonly<Record<string, unknown>>[] }> | null;
}
export declare function createSqliteInspectionRepairController(options: { database: unknown; now?: () => number }): InspectionRepairController;
