import type {
  CreativeBrief,
  DesignVersion,
  EventIntelligencePackage,
  EditPlan,
  TrustedScope,
} from "../contracts/creative/v1.mjs";
import type { CreativeConceptBatchEvent, CreativeConceptBatchProposal } from "../generation/concepts.mjs";
import type {
  DecisionPortRequest,
  DecisionPortResult,
} from "../contracts/decision-port/v1.mjs";
import type {
  ApprovalBinding,
  ApprovalVerifier,
  ArtworkHandoff,
  ConsumptionReceipt,
  CompositionEditPlan,
  HandoffArtifact,
  HandoffLayer,
} from "../contracts/approval-handoff.mjs";
import type {
  CreativeCompositionAssetBytesInput,
  CreativeCompositionAssetBytesResult,
  CreativeCompositionAssetRight,
  CreativeCompositionEditPolicy,
  CreativeCompositionPreviewAccess,
  CreativeCompositionPreviewInput,
  CreativeCompositionPreviewResult,
  CreativeCompositionProductionEnvelope,
  CreativeCompositionRevision,
  CreativeCompositionSha256,
  CreativeCompositionSourceResult,
} from "../contracts/composition-authority.mjs";
import type {
  MeteredAttemptRequest,
  MeteredDispatchContext,
  MeteringPort,
} from "../contracts/metering.mjs";
import type { CreativeTelemetryConfiguration, CreativeTelemetryEvidence } from "../telemetry/index.mjs";
import type { CreativeInspectionReport, CreativeVisualObservation, DeterministicInspection } from "../inspection/index.mjs";
import type {
  ApprovalStalenessRequest,
  AssetPermissionEvidence,
  CreativeBriefPlan,
  InvalidationReceipt,
  NormalizedResearchInvalidation,
  PlanningScope,
  ProducerAcknowledgment,
  ResearchInvalidationEventInput,
  TrustedInvalidationEvidence,
} from "../planning/index.mjs";

export type CreativeOperation =
  | "generate" | "edit" | "concepts.create" | "inspect" | "list" | "compare" | "restore" | "cancel" | "handoff" | "job.status"
  | "brief.create" | "brief.invalidate" | "composition.create" | "composition.get" | "composition.update"
  | "composition.history" | "composition.revalidate";
/** API 1.2 admits only a non-empty composition plan. The older handoff plan
 * remains unchanged for consumers of that contract outside this API boundary. */
export type CreativeCompositionEditPlan = Omit<CompositionEditPlan, "operations"> & Readonly<{
  operations: readonly [CompositionEditPlan["operations"][number], ...CompositionEditPlan["operations"][number][]];
}>;
export type CreativeJobStatus = "queued" | "running" | "completed" | "cancelled" | "failed";
export type CreativeErrorCode =
  | "invalid_request" | "unsupported_version" | "unauthorized" | "permission_denied"
  | "scope_denied" | "not_found" | "conflict" | "stale_version" | "unavailable"
  | "cancelled" | "review_required" | "budget_unavailable" | "failed";

export interface DispatchAuthorizationInput {
  scope: TrustedScope;
  actor_id: string;
  job_id: string;
  lease_token: string;
  action_id: string;
  operation: CreativeOperation;
  billable_attempt_id?: string;
  /** Exact reservation returned by the C03 authority for this transport. */
  reservation_ref?: string;
  /** Trusted route identity captured with the dispatch intent for private response attribution. */
  provider_name?: string;
  provider_model?: string;
  transport_attempt_id: string;
  /** Atomically compared with authoritative creative records when inserting each transport intent. */
  context_fence: CreativeContextFence;
}

/** Synchronous owner re-read for the exact dispatch permit after external ACKs and immediately before transport. */
export interface DispatchCurrentInput extends DispatchAuthorizationInput {
  dispatch_intent_ref: string;
}

export interface CreativeImageReferenceManifest {
  readonly contract: "CreativeImageReferenceManifest";
  readonly schema_version: "1.0";
  readonly tenant_id: string;
  readonly project_id: string;
  readonly brief_id: string;
  readonly brief_hash: `sha256:${string}`;
  readonly research_package_id: string;
  readonly research_package_hash: `sha256:${string}`;
  readonly base_design_version_id: string;
  readonly base_design_hash: `sha256:${string}`;
  readonly references: readonly Readonly<{
    source_ref: string;
    asset_id: string;
    content_hash: `sha256:${string}`;
    media_type: "image/png" | "image/jpeg" | "image/webp";
    width: number;
    height: number;
  }>[];
}

/** Parentless initial-concept inputs. Unlike an edit manifest, this binds only the two
 * authorized source assets and never invents an artwork parent. */
export interface CreativeConceptReferenceManifest {
  readonly contract: "CreativeConceptReferenceManifest";
  readonly schema_version: "1.0";
  readonly tenant_id: string;
  readonly project_id: string;
  readonly brief_id: string;
  readonly brief_hash: `sha256:${string}`;
  readonly research_package_id: string;
  readonly research_package_hash: `sha256:${string}`;
  readonly mapping_ref: string;
  readonly mapping_version: string;
  readonly prompt_template_ref: string;
  readonly prompt_template_version: string;
  readonly prompt_template_sha256: `sha256:${string}`;
  readonly references: readonly Readonly<{
    source_ref: string;
    asset_id: string;
    content_hash: `sha256:${string}`;
    media_type: "image/png" | "image/jpeg" | "image/webp";
    width: number;
    height: number;
    role_ref: string;
  }>[];
}

/** Authorized concept identity before the provider has decoded its bytes. Dimensions are deliberately absent. */
export type CreativeConceptReferencePreflight = Readonly<Pick<
  CreativeConceptReferenceManifest["references"][number],
  "source_ref" | "asset_id" | "content_hash" | "media_type" | "role_ref"
>>;

/** Result of bounded native decoding; only this post-decode value carries raster dimensions. */
export interface CreativeConceptReferenceInspection extends CreativeConceptReferencePreflight {
  readonly width: number;
  readonly height: number;
  readonly byte_length: number;
}

export type CreativeConceptStorageScope = TrustedScope & { readonly brief_id: string };
export type CreativeConceptStoredBatchStatus = CreativeConceptBatchResult["status"];

export interface CreativeConceptBeginBatchInput {
  readonly scope: CreativeConceptStorageScope;
  readonly actor_id: string;
  readonly job_id: string;
  readonly action_id: string;
  readonly request_hash: string;
  readonly lease_token: string;
  readonly batch: CreativeConceptBatchProposal;
}

export interface CreativeConceptBeginBatchResult {
  readonly status: "created" | "existing";
  readonly batch: CreativeConceptBatchProposal;
  readonly batch_status: CreativeConceptStoredBatchStatus;
}

export interface CreativeConceptAppendEventInput {
  readonly scope: CreativeConceptStorageScope;
  readonly actor_id: string;
  readonly job_id: string;
  readonly action_id: string;
  readonly request_hash: string;
  readonly lease_token: string;
  readonly event: CreativeConceptBatchEvent;
}

export interface CreativeConceptAppendEventResult {
  readonly status: "recorded" | "replayed";
  readonly batch: CreativeConceptBatchProposal;
  readonly batch_status: CreativeConceptStoredBatchStatus;
}

interface CreativeConceptDispatchTargetBindingBase {
  readonly model: string;
  readonly sdk_name: "native-fetch";
  readonly sdk_version: string;
  readonly configuration_sha256: `sha256:${string}`;
  readonly operation: "edit";
  readonly input_sha256: `sha256:${string}`;
  readonly prompt_sha256: `sha256:${string}`;
  readonly plan_sha256: `sha256:${string}`;
  readonly image_reference_manifest_sha256: `sha256:${string}`;
  readonly deadline_at: string;
  readonly transport_policy: Readonly<{
    maximum_transport_attempts: 1;
    automatic_retry: false;
    stop_on: readonly string[];
  }>;
  readonly tenant_id: string;
  readonly project_id: string;
  readonly budget_scope_id: string;
  readonly billable_attempt_id: string;
}

/** The concept dispatch target for each allowlisted native image provider route. */
export type CreativeConceptDispatchTargetBinding = CreativeConceptDispatchTargetBindingBase & (
  | Readonly<{ service: "openai"; endpoint: "https://api.openai.com/v1/images/edits"; operation_kind: "image_edit" }>
  | Readonly<{
    service: "openrouter";
    endpoint: "https://openrouter.ai/api/v1/images";
    operation_kind: "image_reference_edit";
    provider_tag: string;
    provider_routing: Readonly<{ only: readonly [string]; allow_fallbacks: false }>;
    metered_operation_kind: string;
    edit_semantics: "reference_guided";
    max_input_references: number;
  }>
);

export interface CreativeConceptDispatchBindingInput {
  readonly scope: CreativeConceptStorageScope;
  readonly actor_id: string;
  readonly job_id: string;
  readonly action_id: string;
  readonly request_hash: string;
  readonly lease_token: string;
  readonly concept_batch_id: string;
  readonly concept_id: string;
  readonly billable_attempt_id: string;
  readonly transport_attempt_id: string;
  readonly reservation_ref: string;
  readonly dispatch_intent_ref: string;
  readonly target_binding: CreativeConceptDispatchTargetBinding;
  readonly target_binding_sha256: `sha256:${string}`;
  readonly rendered_prompt_sha256: `sha256:${string}`;
}

export interface CreativeConceptDispatchBindingResult {
  readonly status: "recorded" | "replayed";
  readonly transport_attempt_id: string;
  readonly target_binding_sha256: `sha256:${string}`;
}

export interface CreativeConceptStageResponseInput {
  readonly scope: CreativeConceptStorageScope;
  readonly actor_id: string;
  readonly job_id: string;
  readonly action_id: string;
  readonly request_hash: string;
  readonly lease_token: string;
  readonly concept_batch_id: string;
  readonly concept_id: string;
  readonly billable_attempt_id: string;
  readonly transport_attempt_id: string;
  readonly reservation_ref: string;
  readonly dispatch_intent_ref: string;
  readonly bytes: Uint8Array;
  readonly content_hash: `sha256:${string}`;
  readonly media_type: "image/png" | "image/jpeg" | "image/webp";
  readonly width: number;
  readonly height: number;
  readonly target_binding_sha256: `sha256:${string}`;
}

export interface CreativeConceptStageResponseResult {
  readonly status: "staged" | "replayed";
  readonly stage_ref: string;
  readonly content_hash: `sha256:${string}`;
}

export interface CreativeConceptStoredBatch {
  readonly batch: CreativeConceptBatchProposal;
  readonly status: CreativeConceptStoredBatchStatus;
  readonly job_id: string;
  readonly request_hash: string;
  readonly actor_id: string;
  readonly updated_at: string;
}

export interface CreativeConceptResponseStage {
  readonly concept_id: string;
  readonly billable_attempt_id: string;
  readonly transport_attempt_id: string;
  readonly reservation_ref: string;
  readonly dispatch_intent_ref: string;
  readonly target_binding_sha256: `sha256:${string}`;
  readonly content_hash: `sha256:${string}`;
  readonly media_type: "image/png" | "image/jpeg" | "image/webp";
  readonly width: number;
  readonly height: number;
  readonly byte_length: number;
  readonly response_bytes: Uint8Array;
  readonly stage_ref: string;
  readonly status: "response_received" | "published";
}

export interface CreativeConceptArtifactObjectPreparationInput {
  readonly scope: CreativeConceptStorageScope;
  readonly action_id: string;
  readonly concept_ids: readonly string[];
}

export interface CreativeConceptArtifactObjectPreparationResult {
  readonly action_id: string;
  readonly artifacts: readonly Readonly<{
    concept_id: string;
    content_hash: `sha256:${string}`;
    byte_length: number;
    status: "object_durable";
  }>[];
}

export interface CreativeConceptPublication {
  readonly concept_id: string;
  readonly ordinal: number;
  readonly design_version: DesignVersion;
  readonly creation: CreativeVersionCreationEvidence;
  readonly storage_commit_ref: string;
  readonly lineage_evidence_ref: string;
  readonly creative_concept_lineage: CreativeConceptLineage;
  readonly event_id: string;
}

export interface CreativeConceptPublishBatchInput {
  readonly scope: CreativeConceptStorageScope;
  readonly actor_id: string;
  readonly job_id: string;
  readonly action_id: string;
  readonly request_hash: string;
  readonly expected_result: Readonly<{ candidate_batch: CreativeConceptBatchResult }>;
  readonly publications: readonly CreativeConceptPublication[];
}

export interface CreativeConceptPublishedVersion {
  readonly concept_id: string;
  readonly ordinal: number;
  readonly design_version: DesignVersion;
  readonly creative_concept_lineage: CreativeConceptLineage;
  readonly storage_commit_ref: string;
  readonly lineage_evidence_ref: string;
}

/** Nine hooks for adapters that support the local concepts.create operation. */
export interface CreativeConceptStoragePort {
  beginConceptBatch(input: CreativeConceptBeginBatchInput): CreativeConceptBeginBatchResult |
    Promise<CreativeConceptBeginBatchResult>;
  appendConceptEvent(input: CreativeConceptAppendEventInput): CreativeConceptAppendEventResult |
    Promise<CreativeConceptAppendEventResult>;
  recordConceptDispatchBinding(input: CreativeConceptDispatchBindingInput): CreativeConceptDispatchBindingResult |
    Promise<CreativeConceptDispatchBindingResult>;
  stageConceptResponse(input: CreativeConceptStageResponseInput): CreativeConceptStageResponseResult |
    Promise<CreativeConceptStageResponseResult>;
  getConceptBatch(input: Readonly<{ scope: CreativeConceptStorageScope; action_id: string }>):
    CreativeConceptStoredBatch | null | Promise<CreativeConceptStoredBatch | null>;
  getConceptResponseStage(input: Readonly<{ scope: CreativeConceptStorageScope; action_id: string; concept_id: string }>):
    CreativeConceptResponseStage | null | Promise<CreativeConceptResponseStage | null>;
  prepareConceptArtifactObjects(input: CreativeConceptArtifactObjectPreparationInput):
    CreativeConceptArtifactObjectPreparationResult | Promise<CreativeConceptArtifactObjectPreparationResult>;
  publishConceptBatch(input: CreativeConceptPublishBatchInput, transaction: CreativePublicationTransaction):
    CreativeConceptBatchResult | Promise<CreativeConceptBatchResult>;
  getConceptVersions(input: Readonly<{ scope: CreativeConceptStorageScope; action_id: string }>):
    readonly CreativeConceptPublishedVersion[] | Promise<readonly CreativeConceptPublishedVersion[]>;
}

export interface CreativeCompositionStoredPage {
  readonly items: readonly CreativeCompositionRevision[];
  readonly has_more: boolean;
}
export interface CreativeCompositionCurrentIdentity {
  readonly composition_id: string;
  readonly revision_id: string;
  readonly revision_sha256: CreativeCompositionSha256;
  readonly design_version_id: string;
  readonly design_version_sha256: CreativeCompositionSha256;
  readonly selection_revision: number;
  readonly updated_at: string;
}
export interface CreativeCompositionActionIntentV1_0 {
  readonly contract: "CreativeCompositionActionIntent";
  readonly schema_version: "1.0";
  readonly operation: "composition.create" | "composition.update";
  readonly composition_id: string;
  readonly candidate_revision_id: string;
  readonly source_revision_id: string | null;
  readonly source_revision_sha256: CreativeCompositionSha256 | null;
  readonly plan: CreativeCompositionEditPlan | null;
}
export interface CreativeCompositionActionIntentV1_1 extends Omit<CreativeCompositionActionIntentV1_0,
  "schema_version" | "operation"> {
  readonly schema_version: "1.1";
  readonly operation: "composition.revalidate";
  readonly plan: null;
}
export type CreativeCompositionActionIntent = CreativeCompositionActionIntentV1_0 | CreativeCompositionActionIntentV1_1;
export interface CreativeCompositionActionRecord {
  readonly status: "pending" | "staged" | "published" | "stale" | "cancelled" | "unknown" | "abandoned";
  readonly scope: TrustedScope & { readonly brief_id: string };
  readonly actor_id: string;
  readonly job_id: string;
  readonly action_id: string;
  readonly operation: "composition.create" | "composition.update" | "composition.revalidate";
  readonly request_hash: `sha256:${string}`;
  readonly intent: CreativeCompositionActionIntent;
  readonly expected_current: Readonly<{ revision_id: string; revision_sha256: `sha256:${string}` }> | null;
  readonly expected_design_version_id: string;
  readonly expected_design_hash: `sha256:${string}`;
  readonly expected_selection_revision: number;
  readonly revision: CreativeCompositionRevision | null;
  readonly preview_bytes: Uint8Array | null;
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly created_at: string;
  readonly updated_at: string;
}
export interface CreativeCompositionBeginActionInput {
  readonly scope: TrustedScope & { readonly brief_id: string };
  readonly actor_id: string;
  readonly job_id: string;
  readonly lease_token: string;
  readonly action_id: string;
  readonly operation: "composition.create" | "composition.update" | "composition.revalidate";
  readonly request_hash: `sha256:${string}`;
  readonly intent: CreativeCompositionActionIntent;
  readonly expected_current: CreativeCompositionActionRecord["expected_current"];
  readonly expected_design_version_id: string;
  readonly expected_design_hash: `sha256:${string}`;
  readonly expected_selection_revision: number;
}
export interface CreativeCompositionStageInput {
  readonly scope: TrustedScope & { readonly brief_id: string };
  readonly actor_id: string;
  readonly job_id: string;
  readonly lease_token: string;
  readonly action_id: string;
  readonly request_hash: `sha256:${string}`;
  readonly revision: CreativeCompositionRevision;
  readonly preview_bytes: Uint8Array;
}
export interface CreativeCompositionFinishInput {
  readonly scope: TrustedScope & { readonly brief_id: string };
  readonly actor_id: string;
  readonly job_id: string;
  readonly lease_token: string;
  readonly action_id: string;
  readonly request_hash: `sha256:${string}`;
  readonly status: "abandoned" | "cancelled" | "stale" | "unknown";
  readonly reason: string;
}
export interface CreativeCompositionCommitInput {
  readonly scope: TrustedScope & { readonly brief_id: string };
  readonly actor_id: string;
  readonly action_id: string;
  readonly job_id: string;
  readonly request_hash: `sha256:${string}`;
  readonly revision_sha256: CreativeCompositionSha256;
}
export interface CreativeCompositionPublicationFence {
  readonly composition_id: string;
  readonly action_id: string;
  readonly job_id: string;
  readonly target_revision_id: string;
  readonly target_revision_sha256: CreativeCompositionSha256;
  readonly expected_current_revision_id: string | null;
  readonly expected_current_revision_sha256: CreativeCompositionSha256 | null;
}
export type CreativeCompositionActionChange = CreativeCompositionActionRecord |
  Readonly<{ status: "stale" | "conflict" }>;
export type CreativeCompositionActionIdentity = Readonly<{
  tenant_id: string;
  project_id: string;
  brief_id: string;
  job_id: string;
  actor_id: string;
  action_id: string;
  operation: "composition.create" | "composition.update" | "composition.revalidate";
  request_hash: CreativeCompositionSha256;
}>;
export type CreativeCompositionRecoveryResult = Readonly<{
  status: "cancelled" | "unknown" | "pending" | "already_final" | "not_found";
  code?: string;
  reason?: string;
}>;
export type CreativeCompositionCommitResult = Readonly<{
  status: "saved" | "replayed";
  composition: CreativeCompositionRevision;
}>;
export interface CreativeCompositionStoragePort {
  beginCompositionAction(input: CreativeCompositionBeginActionInput): CreativeCompositionActionChange |
    Promise<CreativeCompositionActionChange>;
  getCompositionAction(input: Readonly<{ scope: TrustedScope & { brief_id: string }; action_id: string }>):
    CreativeCompositionActionRecord | null | Promise<CreativeCompositionActionRecord | null>;
  /** Local immutable action/job identity used to verify composition cancellation scope before mutation. */
  getCompositionActionIdentityByJob?(input: Readonly<{ scope: TrustedScope; job_id: string }>):
    CreativeCompositionActionIdentity | null | Promise<CreativeCompositionActionIdentity | null>;
  stageCompositionRevision(input: CreativeCompositionStageInput): CreativeCompositionActionRecord |
    Readonly<{ status: "conflict" }> | Promise<CreativeCompositionActionRecord | Readonly<{ status: "conflict" }>>;
  finishCompositionAction(input: CreativeCompositionFinishInput): CreativeCompositionActionRecord |
    Readonly<{ status: "conflict" }> | Promise<CreativeCompositionActionRecord | Readonly<{ status: "conflict" }>>;
  recoverCompositionAction(input: Readonly<{ scope: TrustedScope & { brief_id: string }; action_id: string }>):
    CreativeCompositionRecoveryResult | Promise<CreativeCompositionRecoveryResult>;
  getCurrentComposition(input: Readonly<{ scope: TrustedScope & { brief_id: string };
    design_version_id: string }>): Readonly<{ revision: CreativeCompositionRevision; preview_bytes: Uint8Array }> | null |
    Promise<Readonly<{ revision: CreativeCompositionRevision; preview_bytes: Uint8Array }> | null>;
  /** Additive API 1.3 capability. API 1.2 consumers may omit it; API 1.3
   * history/revalidation operations fail closed when this capability is absent. */
  getCurrentCompositionIdentity?(input: Readonly<{ scope: TrustedScope & { brief_id: string };
    design_version_id: string }>): CreativeCompositionCurrentIdentity | null |
    Promise<CreativeCompositionCurrentIdentity | null>;
  assertCurrentComposition(input: Readonly<{ scope: TrustedScope & { brief_id: string };
    composition_id: string; design_version_id: string; revision_id: string;
    revision_sha256: CreativeCompositionSha256; selection_revision: number }>): Readonly<{
      status: "current"; composition_id: string; revision_id: string;
      revision_sha256: CreativeCompositionSha256; design_version_id: string; selection_revision: number }>;
  getCompositionRevision(input: Readonly<{ scope: TrustedScope & { brief_id: string };
    composition_id: string; revision_id: string }>): Readonly<{ revision: CreativeCompositionRevision; preview_bytes: Uint8Array }> | null |
    Promise<Readonly<{ revision: CreativeCompositionRevision; preview_bytes: Uint8Array }> | null>;
  listCompositionRevisions(input: Readonly<{ scope: TrustedScope & { brief_id: string };
    composition_id: string; limit: number; after_revision_id?: string }>): CreativeCompositionStoredPage |
    Promise<CreativeCompositionStoredPage>;
  commitCompositionRevision(input: CreativeCompositionCommitInput,
    transaction: CreativePublicationTransaction): CreativeCompositionCommitResult;
}
export interface CreativeCompositionVersionStoreMethods extends CreativeCompositionStoragePort {}

export interface CreativeCompositionCurrentInput {
  readonly scope: TrustedScope & { readonly brief_id: string };
  readonly actor_id: string;
  readonly action_id: string;
  readonly request_hash: `sha256:${string}`;
  readonly brief: CreativeBrief;
  readonly brief_hash: CreativeCompositionSha256;
  readonly selected_design: DesignVersion;
  readonly selection_revision: number;
  readonly research_package: EventIntelligencePackage;
  readonly package_hash: CreativeCompositionSha256;
}
export interface CreativeCompositionRevalidationRequest {
  readonly contract: "CreativeCompositionRevalidationRequest";
  readonly schema_version: "1.0";
  readonly scope: TrustedScope & { readonly brief_id: string };
  readonly actor_id: string;
  readonly action_id: string;
  readonly request_hash: CreativeCompositionSha256;
  readonly composition_id: string;
  readonly expected_current: Readonly<{ revision_id: string; revision_sha256: CreativeCompositionSha256 }>;
  readonly candidate_revision_id: string;
  readonly base_revision: CreativeCompositionRevision;
  readonly brief: CreativeBrief;
  readonly brief_hash: CreativeCompositionSha256;
  readonly selected_design: DesignVersion;
  readonly selection_revision: number;
  readonly research_package: EventIntelligencePackage;
  readonly package_hash: CreativeCompositionSha256;
}
export interface CreativeCompositionRevalidationEvidence {
  readonly contract: "CreativeCompositionRevalidationEvidence";
  readonly schema_version: "1.0";
  readonly scope: TrustedScope & { readonly brief_id: string };
  readonly composition_id: string;
  readonly expected_current: Readonly<{ revision_id: string; revision_sha256: CreativeCompositionSha256 }>;
  readonly candidate_revision_id: string;
  readonly brief_hash: CreativeCompositionSha256;
  readonly facts_revision_id: string;
  readonly facts_sha256: CreativeCompositionSha256;
  readonly package_id: string;
  readonly package_sha256: CreativeCompositionSha256;
  readonly design_version_id: string;
  readonly design_version_sha256: CreativeCompositionSha256;
  readonly selection_revision: number;
  readonly asset_rights: readonly CreativeCompositionAssetRight[];
  readonly edit_policy: CreativeCompositionEditPolicy;
}
export interface CreativeCompositionCurrentAssertionInput {
  readonly contract: "CreativeCompositionCurrentAssertion";
  readonly schema_version: "1.1";
  readonly scope: TrustedScope & { readonly brief_id: string };
  readonly actor_id: string;
  readonly action_id: string;
  readonly request_hash: CreativeCompositionSha256;
  readonly composition_id: string;
  readonly expected_current_revision_id: string | null;
  readonly expected_current_revision_sha256: CreativeCompositionSha256 | null;
  readonly target_revision_id: string;
  readonly target_revision_sha256: CreativeCompositionSha256;
  readonly target_state_sha256: CreativeCompositionSha256;
  readonly design_version_id: string;
  readonly design_version_sha256: CreativeCompositionSha256;
  readonly selection_revision: number;
  readonly facts_revision_id: string;
  readonly facts_sha256: CreativeCompositionSha256;
  readonly package_id: string;
  readonly package_sha256: CreativeCompositionSha256;
  readonly checked_at: number;
}
export interface CreativeCompositionCurrentAssertionResult {
  readonly contract: "CreativeCompositionCurrentAssertionResult";
  readonly schema_version: "1.1";
  readonly status: "current" | "stale";
  readonly scope: TrustedScope & { readonly brief_id: string };
  readonly composition_id: string;
  readonly current_revision_id: string | null;
  readonly current_revision_sha256: CreativeCompositionSha256 | null;
  readonly selection_revision: number;
  readonly design_version_id: string;
  readonly design_version_sha256: CreativeCompositionSha256;
  readonly facts_revision_id: string;
  readonly facts_sha256: CreativeCompositionSha256;
  readonly package_id: string;
  readonly package_sha256: CreativeCompositionSha256;
  readonly proof_ref: string;
  readonly checked_at: number;
  readonly expires_at: number;
}
export interface CreativeCompositionAuthorityPorts {
  /** Trusted C04/current-composition owner read. Its exact returned data is still
   * scope/currentness/hash/rights checked by the runtime before use. */
  resolveCurrent(input: CreativeCompositionCurrentInput): CreativeCompositionSourceResult |
    Promise<CreativeCompositionSourceResult>;
  /** Additive API 1.3 capability. Existing API 1.2 authority providers remain valid. */
  resolveRevalidation?(input: CreativeCompositionRevalidationRequest): CreativeCompositionRevalidationEvidence |
    Promise<CreativeCompositionRevalidationEvidence>;
  /** Idempotent by the supplied action key; returns exact preview bytes and a proof
   * bound to the full candidate state digest. It must not issue approval or render artwork. */
  preparePreview(input: CreativeCompositionPreviewInput): CreativeCompositionPreviewResult |
    Promise<CreativeCompositionPreviewResult>;
  /** Reads exact approved source bytes after current scoped rights have been resolved. */
  readApprovedAssetBytes(input: CreativeCompositionAssetBytesInput): CreativeCompositionAssetBytesResult |
    Promise<CreativeCompositionAssetBytesResult>;
  /** Synchronous owner-backed final read after the last awaited preview operation. */
  assertCurrent(input: CreativeCompositionCurrentAssertionInput): CreativeCompositionCurrentAssertionResult;
}

/** Exact synchronous/asynchronous behavior of the corresponding CreativeVersionStore methods. */
export interface CreativeConceptVersionStoreMethods {
  beginConceptBatch(input: CreativeConceptBeginBatchInput): CreativeConceptBeginBatchResult;
  appendConceptEvent(input: CreativeConceptAppendEventInput): CreativeConceptAppendEventResult;
  recordConceptDispatchBinding(input: CreativeConceptDispatchBindingInput): CreativeConceptDispatchBindingResult;
  stageConceptResponse(input: CreativeConceptStageResponseInput): Promise<CreativeConceptStageResponseResult>;
  getConceptBatch(input: Readonly<{ scope: CreativeConceptStorageScope; action_id: string }>): CreativeConceptStoredBatch | null;
  getConceptResponseStage(input: Readonly<{ scope: CreativeConceptStorageScope; action_id: string; concept_id: string }>):
    CreativeConceptResponseStage | null;
  prepareConceptArtifactObjects(input: CreativeConceptArtifactObjectPreparationInput):
    Promise<CreativeConceptArtifactObjectPreparationResult>;
  publishConceptBatch(input: CreativeConceptPublishBatchInput, transaction: CreativePublicationTransaction): CreativeConceptBatchResult;
  getConceptVersions(input: Readonly<{ scope: CreativeConceptStorageScope; action_id: string }>):
    readonly CreativeConceptPublishedVersion[];
}

/** Private backend-only attribution. The raw provider ID must never be copied to public API records. */
export interface PrivateProviderRequestAttribution {
  readonly scope: TrustedScope;
  readonly actor_id: string;
  readonly job_id: string;
  readonly action_id: string;
  readonly request_hash: `sha256:${string}`;
  readonly operation: "generate" | "edit";
  readonly provider: "openai" | "openrouter";
  readonly model: string;
  readonly reservation_ref: string;
  readonly billable_attempt_id: string;
  readonly transport_attempt_id: string;
  readonly dispatch_intent_ref: string;
  readonly provider_request_id: string;
  readonly provider_request_ref: string;
}

export interface PrivateProviderRequestAttributionResult {
  readonly status: "recorded" | "replayed";
  readonly transport_attempt_id: string;
  readonly provider_request_ref: string;
}

export interface PrivateProviderUsageAttribution {
  readonly scope: TrustedScope;
  readonly actor_id: string;
  readonly job_id: string;
  readonly action_id: string;
  readonly request_hash: string;
  readonly operation: "generate" | "edit";
  readonly provider: "openai" | "openrouter";
  readonly model: string;
  readonly reservation_ref: string;
  readonly billable_attempt_id: string;
  readonly transport_attempt_id: string;
  readonly dispatch_intent_ref: string;
  readonly target_binding_sha256: `sha256:${string}`;
  readonly usage_sha256: `sha256:${string}`;
  readonly usage: ProviderUsageRecord;
}

export interface PrivateProviderUsageAttributionResult {
  readonly status: "recorded" | "replayed";
  readonly transport_attempt_id: string;
  readonly target_binding_sha256: `sha256:${string}`;
  readonly usage_sha256: `sha256:${string}`;
}

/** Durable same-attempt fallback when one private attribution write is temporarily unavailable. */
export interface PrivateProviderAttributionPending {
  readonly scope: TrustedScope;
  readonly actor_id: string;
  readonly job_id: string;
  readonly action_id: string;
  readonly request_hash: `sha256:${string}`;
  readonly operation: "generate" | "edit";
  readonly provider: "openai" | "openrouter";
  readonly model: string;
  readonly reservation_ref: string;
  readonly billable_attempt_id: string;
  readonly transport_attempt_id: string;
  readonly dispatch_intent_ref: string;
  readonly target_binding_sha256: `sha256:${string}`;
  readonly provider_request_id?: string;
  readonly provider_request_ref?: string;
  readonly usage?: ProviderUsageRecord;
}

export interface PrivateProviderAttributionPendingResult {
  readonly status: "staged" | "replayed";
  readonly pending_ref: string;
  readonly transport_attempt_id: string;
  readonly payload_sha256: `sha256:${string}`;
}

export type DispatchAuthorizationResult =
  | { status: "authorized"; dispatch_intent_ref: string }
  | { status: "cancelled" | "lease_lost" | "stale_context" };

export interface CreativeInspectionRepairFence {
  inspection_id: string;
  action_id: string;
  request_hash: `sha256:${string}`;
  claim_ref: `sha256:${string}`;
  root_brief_hash: `sha256:${string}`;
  root_design_hash: `sha256:${string}`;
  root_design_version_id: string;
  started_at_ms: number;
  deadline_at_ms: number;
  simulated_units_milli: number;
  result_hash?: `sha256:${string}`;
}

export interface CreativeAssetPermissionFence {
  proofs: readonly Readonly<{
    asset_id: string;
    action: "reproduce" | "modify" | "publish" | "display";
    source_ref: string;
    content_hash: `sha256:${string}`;
    package_id: string;
    package_hash: `sha256:${string}`;
    checked_at?: number;
    expires_at: number;
  }>[];
}

export interface CreativeContextFence {
  brief_id: string;
  brief_hash: string;
  design_version_id?: string;
  design_hash?: string;
  expected_current_design_version_id?: string | null;
  expected_current_design_hash?: string | null;
  /** Current asset proofs rechecked under dispatch/publication SQLite fences. */
  inspection_rights?: CreativeAssetPermissionFence;
  /** Root inspection repair claim and its cumulative deadline. */
  inspection_repair?: CreativeInspectionRepairFence;
  /** Versioned composition action/current-pointer compare-and-swap fence. */
  composition?: CreativeCompositionPublicationFence;
}

/** A transaction capability owned by a durable jobs/storage adapter. Runtime
 * callers may forward it only to the matching version adapter port. */
export interface CreativePublicationTransaction {
  readonly job_id: string;
  readonly lease_token: string;
}

/** A final publication check is synchronous and returns the literal sentinel.
 * The sentinel keeps Promise-returning `async` callbacks out of the type
 * surface while still distinguishing this fence from ordinary void callbacks. */
export type CreativeSynchronousBeforeCommit = (transaction?: CreativePublicationTransaction) => true;

export interface CreativeVersionCreationEvidence {
  job_id: string;
  action_id: string;
  actor_id: string;
  request_hash: string;
  logical_operation_id?: string;
  billable_attempt_id: string;
  parent_design_hash?: string;
  transport_attempt_ids?: string[];
  provider_request_ids?: string[];
  usage_refs?: string[];
  trace_refs?: string[];
}

export interface PreparedDesignVersion {
  status: "prepared";
  action_id: string;
  job_id: string;
  payload_hash: string;
}

export interface CreativeApiRequestEnvelope {
  contract: "CreativeApiRequest";
  schema_version: "1.0";
  event_id: string;
  request_id: string;
  tenant_id: string;
  project_id: string;
  correlation_id: string;
  producer: string;
  occurred_at: string;
  ingested_at: string;
  environment: "development" | "test" | "production";
  billing_mode: "live" | "sandbox" | "simulated";
  source_refs: string[];
}

/** Concepts uses a separate, exact request envelope. Existing operations remain on 1.0. */
export interface CreativeApiRequestV1_1Envelope extends Omit<CreativeApiRequestEnvelope, "schema_version"> {
  schema_version: "1.1";
}

/** Composition authority has an independent, additive request envelope. Legacy 1.0
 * and concepts 1.1 request shapes remain closed and unchanged. */
export interface CreativeApiRequestV1_2Envelope extends Omit<CreativeApiRequestEnvelope, "schema_version"> {
  schema_version: "1.2";
}
/** API 1.3 adds metadata-only stale history and immutable proof renewal. */
export interface CreativeApiRequestV1_3Envelope extends Omit<CreativeApiRequestEnvelope, "schema_version"> {
  schema_version: "1.3";
}

export type CreativeDecisionInput = Pick<DecisionPortRequest, "execution_mode" | "state" | "questions">;
export interface InspectionRepairRequest {
  readonly contract: "CreativeInspectionRepairRequest";
  readonly schema_version: "1.0";
  /** Completed, scoped inspect action whose report explicitly recommended this exact action. */
  readonly inspection_action_id: string;
  readonly report_hash: `sha256:${string}`;
  readonly repair_action: "image.edit";
}
export interface InspectionRepairExecutionEvidence {
  readonly contract: "CreativeInspectionRepairExecution";
  readonly schema_version: "1.0";
  readonly inspection_id: string;
  readonly inspection_action_id: string;
  readonly source_report_hash: `sha256:${string}`;
  readonly repair_action: "image.edit";
  readonly claim_ref: string;
  readonly root_design_version_id: string;
  readonly root_design_hash: `sha256:${string}`;
  readonly output_design_version_id: string;
  readonly output_design_hash: `sha256:${string}`;
  readonly billable_attempt_id: string;
}
export type CreativeApiRequestV1_0 =
  | (CreativeApiRequestEnvelope & { operation: "generate"; action_id: string;
      payload: { brief_id: string; plan: EditPlan; decision_request?: CreativeDecisionInput } })
  | (CreativeApiRequestEnvelope & { operation: "edit"; action_id: string;
      payload: { brief_id: string; design_version_id: string; plan: EditPlan;
        selection_mode?: "advance" | "branch"; decision_request?: CreativeDecisionInput;
        image_reference_manifest?: CreativeImageReferenceManifest;
        inspection_repair?: InspectionRepairRequest } })
  | (CreativeApiRequestEnvelope & { operation: "inspect"; action_id: string;
      payload: { brief_id: string; design_version_id: string } })
  | (CreativeApiRequestEnvelope & { operation: "list"; action_id?: string;
      payload: { brief_id: string; limit?: number; cursor?: string } })
  | (CreativeApiRequestEnvelope & { operation: "compare"; action_id?: string;
      payload: { brief_id: string; left_design_version_id: string; right_design_version_id: string } })
  | (CreativeApiRequestEnvelope & { operation: "restore"; action_id: string;
      payload: { brief_id: string; target_design_version_id: string; expected_selection_revision: number } })
  | (CreativeApiRequestEnvelope & { operation: "cancel"; action_id: string;
      payload: { job_id: string } })
  | (CreativeApiRequestEnvelope & { operation: "handoff"; action_id: string;
      payload: { brief_id: string; design_version_id: string; approval_ref: string; destination_ref: string } })
  | (CreativeApiRequestEnvelope & { operation: "job.status"; action_id?: string;
      payload: { job_id: string } })
  | (CreativeApiRequestEnvelope & { operation: "brief.create"; action_id: string;
      payload: {
        customer_preferences?: Array<{ preference_id: string; value: string }>;
        artistic_intent?: Array<{ interpretation_id: string; text: string }>;
        additional_required_fact_keys?: string[];
        fact_corrections?: Array<{ fact_id: string; proposed_value: unknown }>;
        locked_fields?: Array<{ field: string; reason: string }>;
        expected_brief_hash?: string;
      } })
  | (CreativeApiRequestEnvelope & { operation: "brief.invalidate"; action_id: string;
      payload: { event_id: string } });

export type CreativeApiRequestV1_1 = CreativeApiRequestV1_1Envelope & {
  operation: "concepts.create";
  action_id: string;
  payload: { brief_id: string; plan_id: string; requested_count: number;
    references: readonly Readonly<{ asset_id: string; role_ref: string }>[] };
};

export type CreativeApiRequestV1_2 =
  | (CreativeApiRequestV1_2Envelope & { operation: "composition.create"; action_id: string;
      payload: { brief_id: string; design_version_id: string } })
  | (CreativeApiRequestV1_2Envelope & { operation: "composition.get"; action_id?: string;
      payload: { brief_id: string; design_version_id: string } })
  | (CreativeApiRequestV1_2Envelope & { operation: "composition.update"; action_id: string;
      payload: { brief_id: string; design_version_id: string; plan: CreativeCompositionEditPlan } });

export type CreativeApiRequestV1_3 =
  | (CreativeApiRequestV1_3Envelope & { operation: "composition.history"; action_id?: string;
      payload: { brief_id: string; design_version_id: string; limit?: number; after_revision_id?: string } })
  | (CreativeApiRequestV1_3Envelope & { operation: "composition.revalidate"; action_id: string;
      payload: { brief_id: string; design_version_id: string; expected_current_revision_id: string;
        expected_current_revision_sha256: CreativeCompositionSha256; candidate_revision_id: string } });

export type CreativeApiRequest = CreativeApiRequestV1_0 | CreativeApiRequestV1_1 | CreativeApiRequestV1_2 | CreativeApiRequestV1_3;

export interface TrustedCreativeActor extends TrustedScope {
  actor_id: string;
  expires_at: string;
  permissions: string[];
  budget_scope_id: string;
  budget_policy_version: string;
}

export interface CreativeApiErrorShape {
  code: CreativeErrorCode;
  operation: CreativeOperation | "unknown";
  module: "creative-engine.api";
  field: string;
  retryable: boolean;
  message: string;
  diagnostic_ref: string;
}

export interface CreativeJob {
  contract: "CreativeJob";
  schema_version: "1.0";
  operation_id: string;
  job_id: string;
  status: CreativeJobStatus;
  result_ref?: string;
  error?: CreativeApiErrorShape;
}

export interface CreativeJobRecord {
  tenant_id: string;
  project_id: string;
  brief_id?: string;
  actor_id: string;
  action_id: string;
  operation: CreativeOperation;
  job_id: string;
  status: CreativeJobStatus;
  request_hash: string;
  result?: unknown;
  result_ref?: string;
  error?: CreativeApiErrorShape;
}

export interface StartedJob { kind: "started"; job_id: string; lease_token: string }
export interface ExistingJob { kind: "existing"; job: CreativeJobRecord }
export interface ConflictingJob { kind: "conflict" }
export interface CompletedJob { status: "completed"; job: CreativeJobRecord; result?: unknown }
export interface CancelledJob { status: "cancelled"; job?: CreativeJobRecord }
export interface StaleContextJob { status: "stale_context"; job?: CreativeJobRecord }
export type CancelJobResult =
  | { kind: "cancelled" | "replayed"; job: CreativeJobRecord }
  | { kind: "not_found" | "conflict" };
export type FailedJobResult =
  | { status: "failed"; job: CreativeJobRecord }
  | { status: "cancelled"; job: CreativeJobRecord };

export interface UsageRecord {
  completeness: "complete" | "partial" | "incomplete" | "unknown";
  input_tokens?: number;
  output_tokens?: number;
  provider_request_id?: string;
  transport_attempt_id?: string;
  reason?: "usage_unavailable" | "usage_malformed";
}

/** Raw provider counters supplied to the runtime before profile-based normalization. */
export interface ProviderUsageRecord {
  completeness?: "complete" | "partial" | "incomplete" | "unknown";
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: Readonly<Record<string, number | undefined>>;
  output_tokens_details?: Readonly<Record<string, number | undefined>>;
  provider_request_id?: string;
  transport_attempt_id?: string;
  missing_fields?: readonly string[];
  readonly [providerField: string]: unknown;
}

export interface CreativeRuntimePorts {
  storage?: {
    getBrief(input: { scope: TrustedScope; brief_id: string }): Promise<CreativeBrief | null> | CreativeBrief | null;
    getBriefVersionByHash?(input: { scope: TrustedScope; brief_id: string; brief_hash: string }):
      Promise<CreativeBrief | null> | CreativeBrief | null;
    isBriefUsable?(input: { scope: TrustedScope; brief_id: string; brief_hash: string }):
      Promise<boolean> | boolean;
    isAssetFenced?(input: { scope: TrustedScope; asset_id: string; content_hash: string }):
      Promise<boolean> | boolean;
    getDesignVersion(input: { scope: TrustedScope; brief_id: string; design_version_id: string }): Promise<DesignVersion | null> | DesignVersion | null;
    /** Read exact immutable content-addressed bytes; the runtime snapshots and verifies the hash before decode. */
    getArtifactBytes(input: { scope: TrustedScope; brief_id: string; design_version_id: string }): Promise<Uint8Array | null> | Uint8Array | null;
    getCurrentDesignVersion(input: { scope: TrustedScope; brief_id: string }): Promise<DesignVersion | null> | DesignVersion | null;
    getSelection(input: { scope: TrustedScope; brief_id: string }): Promise<DesignSelection | null> | DesignSelection | null;
    listDesignVersions(input: { scope: TrustedScope; brief_id: string; limit: number;
      after?: { occurred_at: string; design_version_id: string } }): Promise<{ items: DesignVersion[]; has_more: boolean }>;
    /** Atomically compare brief hash and current design ID/hash before storing a new immutable version. */
    saveDesignVersion(input: { scope: TrustedScope; brief_id: string; design_version: DesignVersion;
      artifact_bytes: Uint8Array; selection_mode: "advance" | "branch";
      creation: CreativeVersionCreationEvidence; lease_token: string; job_result: unknown;
      expected_brief_hash: string; expected_current_design_version_id: string | null;
      expected_current_design_hash: string | null; expected_parent_design_version_id: string | null;
      expected_parent_design_hash: string | null }, transaction?: CreativePublicationTransaction):
      Promise<{ status: "saved" | "stale" }> | { status: "saved" | "stale" };
    prepareDesignVersion?(input: { scope: TrustedScope; brief_id: string; design_version: DesignVersion;
      artifact_bytes: Uint8Array; selection_mode: "advance" | "branch";
      creation: CreativeVersionCreationEvidence; lease_token: string; job_result: unknown;
      /** Complete current authority persisted with the intent for safe crash recovery. */
      publication_fence: CreativeContextFence;
      expected_brief_hash: string; expected_current_design_version_id: string | null;
      expected_current_design_hash: string | null; expected_parent_design_version_id: string | null;
      expected_parent_design_hash: string | null }): Promise<PreparedDesignVersion> | PreparedDesignVersion;
    commitPreparedDesignVersion?(input: { scope: TrustedScope; brief_id: string; action_id: string;
      job_id: string; payload_hash: string }, transaction: CreativePublicationTransaction):
      Promise<{ status: "saved" | "stale" }> | { status: "saved" | "stale" };
    /** Atomically compare brief, target, current selection identity/hash, and selection revision. */
    selectDesignVersion(input: { scope: TrustedScope; brief_id: string; design_version_id: string;
      expected_brief_hash: string; expected_target_design_hash: string;
      expected_selected_design_version_id: string; expected_selected_design_hash: string;
      expected_selection_revision: number }, transaction?: CreativePublicationTransaction): Promise<{ status: "selected"; selection: DesignSelection } | { status: "stale" }> |
      { status: "selected"; selection: DesignSelection } | { status: "stale" };
    getHandoffContext(input: { scope: TrustedScope; brief_id: string; design_version_id: string }): Promise<{
      binding: ApprovalBinding;
      artifact: HandoffArtifact;
      layer_manifest: HandoffLayer[];
    } | null> | { binding: ApprovalBinding; artifact: HandoffArtifact; layer_manifest: HandoffLayer[] } | null;
    /** Durable CE09 staged state on the same CE08 SQLite connection as jobs, versions, and telemetry. */
    beginInspectionSession?(input: InspectionSessionIdentity & { lease_token: string }): Promise<InspectionSessionRecord> | InspectionSessionRecord;
    getInspectionSession?(input: { scope: TrustedScope & { brief_id: string }; action_id: string }):
      Promise<InspectionSessionRecord | null> | InspectionSessionRecord | null;
    stageInspectionStage?(input: InspectionStageIdentity & { lease_token: string; stage: InspectionStageName;
      attempt_id: string; intent: unknown }): Promise<InspectionSessionRecord> | InspectionSessionRecord;
    completeInspectionStage?(input: InspectionStageIdentity & { lease_token: string; stage: InspectionStageName;
      attempt_id: string; result: unknown }): Promise<{ status: "recorded" | "replayed"; result_hash: string }> |
      { status: "recorded" | "replayed"; result_hash: string };
    completeInspectionSession?(input: InspectionStageIdentity & { result: unknown },
      transaction?: CreativePublicationTransaction): Promise<{ status: "completed" | "replayed"; result_hash: string }> |
      { status: "completed" | "replayed"; result_hash: string };
    inspectionRepair?: InspectionRepairPort;
  } & Partial<CreativeConceptStoragePort> & Partial<CreativeCompositionStoragePort>;
  jobs?: {
    /** Fail closed before job creation or any operation-specific external port calls. */
    assertOperationAvailable?(input: { operation: CreativeOperation }):
      Promise<{ status: "available" }> | { status: "available" };
    begin(input: { scope: TrustedScope; actor_id: string; action_id: string; request_hash: string; operation: CreativeOperation }):
      Promise<StartedJob | ExistingJob | ConflictingJob> | StartedJob | ExistingJob | ConflictingJob;
    /** The adapter must compare this fence in the same transaction that publishes the completed result. */
    completeIfActive(input: { scope: TrustedScope; actor_id: string; job_id: string; lease_token: string;
      action_id: string; operation: CreativeOperation; result: unknown; publication_fence: CreativeContextFence },
      publish: (transaction?: CreativePublicationTransaction) => Promise<unknown> | unknown,
      beforeCommit?: CreativeSynchronousBeforeCommit):
      Promise<CompletedJob | CancelledJob | StaleContextJob> | CompletedJob | CancelledJob | StaleContextJob;
    failIfActive(input: { scope: TrustedScope; actor_id: string; job_id: string; lease_token: string;
      error: CreativeApiErrorShape }): Promise<FailedJobResult> | FailedJobResult;
    get(input: { scope: TrustedScope; job_id: string }): Promise<CreativeJobRecord | null> | CreativeJobRecord | null;
    cancel(input: { scope: TrustedScope; actor_id: string; job_id: string; target_action_id: string; action_id: string; request_hash: string }):
      Promise<CancelJobResult> | CancelJobResult;
    /** Claim an expired inspect job with a fresh lease; active workers are never displaced. */
    resumeExpired?(input: { scope: TrustedScope & { brief_id: string }; actor_id: string; job_id: string;
      action_id: string; request_hash: string }): Promise<StartedJob | ExistingJob | ConflictingJob> | StartedJob | ExistingJob | ConflictingJob;
    /** Atomically compare context_fence and linearize each dispatch intent with cancellation and lease ownership. */
    authorizeDispatch(input: DispatchAuthorizationInput): Promise<DispatchAuthorizationResult> | DispatchAuthorizationResult;
    /** Synchronously re-read the same owner rows; implementations must not await or use caller-supplied status. */
    assertDispatchCurrent(input: DispatchCurrentInput): DispatchAuthorizationResult;
    /** Persist transport, provider, and usage identity references before artifact bytes are staged. */
    recordAttemptEvidence?(input: { scope: TrustedScope; actor_id: string; job_id: string; lease_token: string;
      action_id: string; request_hash: string; creation: CreativeVersionCreationEvidence }):
      Promise<{ status: "recorded" | "replayed" }> | { status: "recorded" | "replayed" };
    /** Persist an exact raw provider request ID in private local storage before result parsing/publication. */
    recordPrivateProviderAttribution?(input: PrivateProviderRequestAttribution):
      Promise<PrivateProviderRequestAttributionResult> | PrivateProviderRequestAttributionResult;
    /** Retain sanitized raw provider counters privately for later owner-reviewed mapping/reconciliation. */
    recordPrivateProviderUsageAttribution?(input: PrivateProviderUsageAttribution):
      Promise<PrivateProviderUsageAttributionResult> | PrivateProviderUsageAttributionResult;
    stagePrivateProviderAttribution?(input: PrivateProviderAttributionPending):
      Promise<PrivateProviderAttributionPendingResult> | PrivateProviderAttributionPendingResult;
    reconcilePrivateProviderAttributions?(input: { scope: TrustedScope; limit?: number }):
      Promise<Readonly<{ reconciled: number; remaining: number }>> | Readonly<{ reconciled: number; remaining: number }>;
  };
  provider?: {
    /** Optional for legacy providers; native adapters prepare the exact immutable target before C03 admission. */
    prepareAttempt?(input: ImagePreparationInput): Promise<PreparedImageAttempt> | PreparedImageAttempt;
    resolveRoute(input: CreativeProviderRouteInput):
      Promise<CreativeProviderRoute> | CreativeProviderRoute;
    generate(input: ProviderInput): Promise<ProviderOutput>;
    edit(input: ProviderInput | CreativeConceptProviderInput): Promise<ProviderOutput>;
    getConceptConfiguration?(): Readonly<{ model_id: string; configuration: OpenAIConceptConfiguration }> |
      Readonly<{ model_id: string; provider_tag: string; capabilities: OpenRouterConceptCapabilities;
        configuration: OpenRouterConceptConfiguration }>;
    /** Decode and hash the exact two authorized inputs before C03; the native edit rereads and verifies them. */
    inspectConceptReferences?(input: { scope: TrustedScope;
      references: readonly CreativeConceptReferencePreflight[];
      maximum_single_reference_bytes: number; maximum_aggregate_reference_bytes: number }):
      Promise<readonly CreativeConceptReferenceInspection[]>;
  };
  /** Owner supplied policy and versioned offline native-edit adapter snapshots. */
  concepts?: {
    resolveTrustedSnapshots(input: { scope: TrustedScope & { brief_id: string }; actor_id: string;
      brief: CreativeBrief; brief_hash: `sha256:${string}`; research_package: EventIntelligencePackage;
      request: Readonly<{ action_id: string; brief_id: string; plan_id: string; requested_count: number;
        references: readonly Readonly<{ asset_id: string; role_ref: string }>[] }>;
      now: string }): Promise<Readonly<{ policy_snapshot: Readonly<Record<string, unknown>>;
        adapter_snapshot: Readonly<Record<string, unknown>> }>> |
      Readonly<{ policy_snapshot: Readonly<Record<string, unknown>>; adapter_snapshot: Readonly<Record<string, unknown>> }>;
  };
  composition?: CreativeCompositionAuthorityPorts;
  metering?: MeteringPort;
  /** Required by generate/edit/inspect and JEV-backed operations. The outbox shares durable API SQLite state. */
  telemetry?: CreativeTelemetryConfiguration;
  decisionPort?: {
    resolveRoute(input: { scope: TrustedScope; actor_id: string; decision: Pick<DecisionPortRequest, "execution_mode" | "state" | "questions"> }):
      Promise<CreativeProviderRoute> | CreativeProviderRoute;
    execute(input: DecisionDispatchInput): Promise<DecisionPortResult>;
  };
  inspection?: {
    resolveRoute(input: { scope: TrustedScope; actor_id: string; design_version: DesignVersion;
      artifact: Readonly<{ artifact_id: string; content_hash: string; media_type: string;
        width: number; height: number; format: "png" | "jpeg" | "webp" }> }):
      Promise<CreativeProviderRoute> | CreativeProviderRoute;
    inspect(input: InspectionInput): Promise<InspectionPortOutput>;
    /** Offline fixture-only estimate for the local 3-unit repair bound; never a Finance quote or grant. */
    estimateFixtureRepairCost?(input: { scope: TrustedScope; actor_id: string; repair_action: "image.edit";
      source_report_hash: string; source_design_hash: string; plan_hash: string }):
      Promise<Readonly<{ contract: "CreativeFixtureRepairEstimate"; schema_version: "1.0"; evidence_mode: "fixture";
        policy_version: "fixture-repair-estimate/1"; simulated_units: number }> |
        Readonly<{ status: "unknown" }>> |
      Readonly<{ contract: "CreativeFixtureRepairEstimate"; schema_version: "1.0"; evidence_mode: "fixture";
        policy_version: "fixture-repair-estimate/1"; simulated_units: number }> |
      Readonly<{ status: "unknown" }>;
  };
  approval?: {
    verifyApproval: ApprovalVerifier["verifyApproval"];
  };
  handoff?: {
    resolveDestination(input: { scope: TrustedScope; actor_id: string; destination_ref: string }):
      Promise<{ expected_audience: string }>;
    submit(input: { scope: TrustedScope; actor_id: string; job_id: string; destination_ref: string;
      handoff: ArtworkHandoff; transport_attempt_id: string; dispatch_intent_ref: string }): Promise<ConsumptionReceipt>;
  };
  trace?: { record(event: Record<string, unknown>): Promise<void> | void };
  /** Trusted Research and rights adapters. Request JSON can identify a package/event,
   * but never supplies verified facts, permission evidence, or invalidation authority. */
  planning?: {
    getCurrentResearchPackage?(input: { scope: PlanningScope }):
      Promise<EventIntelligencePackage | Record<string, unknown>> | EventIntelligencePackage | Record<string, unknown>;
    getBriefAction?(input: { scope: PlanningScope; actor_id: string; action_id: string; request_hash: string }):
      Promise<Readonly<{ status: "conflict" }> |
        Readonly<{ status: "replayed"; brief_hash: string; plan: CreativeBriefPlan }> | null> |
      Readonly<{ status: "conflict" }> |
      Readonly<{ status: "replayed"; brief_hash: string; plan: CreativeBriefPlan }> | null;
    saveBriefAction?(input: { scope: PlanningScope; actor_id: string; action_id: string; request_hash: string;
      plan: CreativeBriefPlan; expected_brief_hash: string | null }):
      Promise<{ status: "saved" | "replayed"; brief_hash: string; plan: CreativeBriefPlan } |
        { status: "stale"; brief_hash: string | null } | { status: "conflict" }> |
      { status: "saved" | "replayed"; brief_hash: string; plan: CreativeBriefPlan } |
        { status: "stale"; brief_hash: string | null } | { status: "conflict" };
    getBriefVersionByHash?(input: { scope: PlanningScope; brief_id: string; brief_hash: string }):
      Promise<CreativeBrief | null> | CreativeBrief | null;
    isBriefUsable?(input: { scope: PlanningScope; brief_id: string; brief_hash: string }): Promise<boolean> | boolean;
    getInvalidationEvent?(input: { scope: PlanningScope; event_id: string }):
      Promise<ResearchInvalidationEventInput> | ResearchInvalidationEventInput;
    invalidationVerifier?: {
      verifyInvalidation(input: { event: NormalizedResearchInvalidation; trusted_scope: PlanningScope; now: string }):
        Promise<TrustedInvalidationEvidence>;
    };
    approvalStaleness?: {
      markBriefStale(input: ApprovalStalenessRequest):
        Promise<ApprovalStalenessRequest & { status: "acknowledged" }>;
    };
    producerAcknowledgment?: {
      acknowledgeInvalidation(input: { event_id: string; idempotency_key: string; event_hash: string;
        durable_receipt_id: string; tenant_id: string; project_id: string }): Promise<ProducerAcknowledgment>;
    };
    assetPermissionVerifier?: {
      verifyAssetUse(input: { tenant_id: string; project_id: string; asset_id: string; content_hash: string;
        action: "reproduce" | "modify"; package_id: string; package_hash: string; now: string }):
        Promise<AssetPermissionEvidence>;
    };
    applyInvalidation?(input: { trusted_scope: PlanningScope; actor_id: string; action_id: string;
      operation: "brief.invalidate"; request_hash: string; event_id: string }):
      Promise<Readonly<{ public_action_status: "conflict" }> |
        Readonly<{ public_action_status: "completed" | "pending" | "replayed";
          invalidation: CreativeInvalidationResult }>> |
      Readonly<{ public_action_status: "conflict" }> |
      Readonly<{ public_action_status: "completed" | "pending" | "replayed";
        invalidation: CreativeInvalidationResult }>;
  };
}

export interface DesignSelection {
  tenant_id: string;
  project_id: string;
  brief_id: string;
  design_version_id: string;
  design_hash: string;
  revision: number;
}

export interface ProviderInput {
  scope: TrustedScope;
  actor_id: string;
  job_id: string;
  attempt: MeteredAttemptRequest;
  brief: CreativeBrief;
  base_design: DesignVersion | null;
  plan: EditPlan;
  /** Versioned edit-only list of immutable, already permission-checked research image references. */
  readonly image_reference_manifest?: CreativeImageReferenceManifest;
  /** Exactly two authorized input asset references for a parentless initial concept native edit. */
  readonly concept_reference_manifest?: CreativeConceptReferenceManifest;
  /** Stable identities are created before dispatch and reused during exact response recovery. */
  readonly concept_batch_id?: string;
  readonly concept_id?: string;
  decision_result?: DecisionPortResult;
  /** Provider-minted single-use preparation; never caller-authored admission data. */
  readonly prepared_attempt?: PreparedImageAttempt;
  /** Exact reservation reference validated and returned by the trusted C03 authority. */
  readonly reservation_ref: string;
  transport_attempt_id: string;
  dispatch_intent_ref: string;
  recordTransportAttempt(transport_attempt_id: string): Promise<string>;
  /** Last current job, lease, creative-context, deadline, and rights fence after all provider-side async revalidation. */
  revalidateDispatch(input: Readonly<{
    reservation_ref: string;
    billable_attempt_id: string;
    transport_attempt_id: string;
    dispatch_intent_ref: string;
    target_binding_sha256: `sha256:${string}`;
    signal: AbortSignal;
  }>): Promise<string>;
  /** Synchronous same-connection job, lease, context, and dispatch-intent fence immediately before POST. */
  assertDispatchCurrent?(): string;
  /** Called as soon as an HTTP response exposes x-request-id; raw value is private and never public JSON. */
  recordPrivateProviderRequestId?(input: Readonly<{
    provider_request_id: string;
    provider_request_ref: string;
  }>): Promise<PrivateProviderRequestAttributionResult>;
  /** Called after bounded normalization when the response actually contains a usage object. */
  recordPrivateProviderUsage?(input: Readonly<{
    target_binding_sha256: `sha256:${string}`;
    usage: ProviderUsageRecord;
  }>): Promise<PrivateProviderUsageAttributionResult>;
  /** Stages exact private response attribution for retry without another provider transport. */
  stagePrivateProviderAttribution?(input: Readonly<{
    target_binding_sha256: `sha256:${string}`;
    provider_request_id?: string;
    provider_request_ref?: string;
    usage?: ProviderUsageRecord;
  }>): Promise<Readonly<{ status: "staged" | "replayed"; pending_ref: string;
    transport_attempt_id: string; payload_sha256: `sha256:${string}` }>>;
  /** Durable exact response bytes are staged by the host before the provider call resolves. */
  stageConceptResponse?(input: Readonly<{
    concept_batch_id: string;
    concept_id: string;
    bytes: Uint8Array;
    content_hash: `sha256:${string}`;
    media_type: "image/png" | "image/jpeg" | "image/webp";
    width: number;
    height: number;
    target_binding_sha256: `sha256:${string}`;
  }>): Promise<Readonly<{ status: "staged" | "replayed"; stage_ref: string; content_hash: string }>>;
  /** Persist the exact provider target hash before the final synchronous dispatch-owner fence. */
  recordConceptDispatchBinding?(input: Readonly<{
    concept_batch_id: string;
    concept_id: string;
    target_binding: Readonly<Record<string, unknown>>;
    target_binding_sha256: `sha256:${string}`;
    rendered_prompt_sha256: `sha256:${string}`;
  }>): Promise<Readonly<{ status: "recorded" | "replayed"; transport_attempt_id: string;
    target_binding_sha256: `sha256:${string}` }>>;
  signal: AbortSignal;
  deadline_at: string;
}

export interface PreparedImageAttempt {
  readonly token: object;
  readonly target_binding: Readonly<Record<string, unknown>>;
  readonly target_binding_sha256: `sha256:${string}`;
  readonly deadline_at: string;
}
export type ImagePreparationInput = Readonly<Pick<ProviderInput,
  "scope" | "actor_id" | "job_id" | "attempt" | "brief" | "base_design" | "image_reference_manifest" |
  "concept_reference_manifest" | "concept_batch_id" | "concept_id" | "decision_result" | "signal" | "deadline_at"> & {
    operation: "generate" | "edit";
    plan: EditPlan | CreativeConceptNativePlan;
  }>;

/** Minimal internal plan passed to native Images edit for a parentless concept candidate. */
export interface CreativeConceptNativePlan {
  readonly operation: "concept.generate";
  readonly brief_id: string;
  /** Distinct source-page IDs derived from the two authorized input assets; the pages may be shared. */
  readonly source_refs: readonly [string] | readonly [string, string];
  readonly steps: readonly [Readonly<{
    action: "concept.generate";
    source_refs: readonly [string] | readonly [string, string];
    parameters: Readonly<{ variant_count: 1 }>;
  }>];
}

/** The route resolver receives either a legacy full plan or the exact parentless concept plan. */
export type CreativeProviderRouteInput =
  | Readonly<{ scope: TrustedScope; actor_id: string; operation: "generate"; plan: EditPlan }>
  | Readonly<{ scope: TrustedScope; actor_id: string; operation: "edit"; plan: EditPlan | CreativeConceptNativePlan }>;

/** Native edit dispatch for concepts carries its own minimal plan and durable staging callbacks. */
export type CreativeConceptProviderInput = Omit<ProviderInput,
  "plan" | "image_reference_manifest" | "concept_reference_manifest" | "concept_batch_id" | "concept_id" |
  "assertDispatchCurrent" | "stageConceptResponse" | "recordConceptDispatchBinding"> & Readonly<{
    plan: CreativeConceptNativePlan;
    image_reference_manifest?: never;
    concept_reference_manifest: CreativeConceptReferenceManifest;
    concept_batch_id: string;
    concept_id: string;
    assertDispatchCurrent(): string;
    stageConceptResponse: NonNullable<ProviderInput["stageConceptResponse"]>;
    recordConceptDispatchBinding: NonNullable<ProviderInput["recordConceptDispatchBinding"]>;
  }>;

export interface CreativeProviderRoute {
  retry_mapping_ref: string;
  provider: MeteredAttemptRequest["provider"];
}

export interface DecisionDispatchInput extends Omit<MeteredDispatchContext, "recordTransportAttempt"> {
  scope: TrustedScope;
  actor_id: string;
  request: DecisionPortRequest;
  transport_attempt_id: string;
  deadline_at: string;
  dispatch_intent_ref: string;
  target_binding_sha256: `sha256:${string}`;
  /** Synchronous final owner read immediately before the real JEV transport write. */
  assertDispatchCurrent(): string;
  recordTransportAttempt(transport_attempt_id: string): Promise<string>;
  revalidateDispatch(input: Readonly<{ reservation_ref: string; billable_attempt_id: string; transport_attempt_id: string;
    dispatch_intent_ref: string; target_binding_sha256: `sha256:${string}`; signal: AbortSignal }>): Promise<string>;
}

export interface ProviderOutput {
  design_version_id?: string;
  artifact: { artifact_id: string; content_hash: string; media_type: string };
  /** Exact bytes for the declared artifact hash; runtime snapshots and verifies them before publication. */
  artifact_bytes: Uint8Array;
  provider: string;
  model: string;
  /** Safe, hashed native provider request reference; raw request IDs remain in the private attribution store. */
  provider_request_ref?: string;
  /** Exact target binding used for this response, when supplied by a typed provider adapter. */
  target_binding_sha256?: `sha256:${string}`;
  usage?: ProviderUsageRecord;
}

export type InspectionStageName = "observer" | "decision_evidence" | "decision_route";
export interface InspectionSessionIdentity {
  scope: TrustedScope & { brief_id: string };
  actor_id: string;
  job_id: string;
  action_id: string;
  request_hash: string;
  brief_id: string;
  brief_hash: string;
  design_version_id: string;
  design_hash: string;
  parent_version_id: string | null;
  parent_design_hash: string | null;
  artifact_id: string;
  artifact_hash: string;
  root_design_version_id: string;
  root_design_hash: string;
}
export interface InspectionStageIdentity {
  scope: TrustedScope & { brief_id: string };
  actor_id: string;
  job_id: string;
  action_id: string;
  request_hash: string;
  brief_id: string;
}
export interface InspectionSessionStageRecord {
  readonly stage: InspectionStageName;
  readonly attempt_id: string;
  readonly intent: unknown;
  readonly status: "dispatching" | "completed" | "unknown";
  readonly result?: unknown;
}
export interface InspectionSessionRecord extends Readonly<Omit<InspectionSessionIdentity, "scope">> {
  /** Authoritative stored session identity; both the record and this scope are immutable. */
  readonly scope: Readonly<TrustedScope & { brief_id: string }>;
  readonly status: "active" | "completed" | "failed" | "unknown";
  readonly result?: unknown;
  readonly stages: readonly InspectionSessionStageRecord[];
}
export interface InspectionRepairPort {
  startInspection(input: { scope: TrustedScope & { brief_id: string; design_version_id: string };
    inspection_id: string; brief_hash: string; design_hash: string }): Readonly<Record<string, unknown>>;
  recordRepairClaim(input: { scope: TrustedScope & { brief_id: string; design_version_id: string };
    inspection_id: string; action_id: string; request_hash: string; repair_action: string; simulated_units?: number | null }):
    Readonly<Record<string, unknown>>;
  recordRepairOutcome(input: { scope: TrustedScope & { brief_id: string; design_version_id: string };
    inspection_id: string; action_id: string; result_hash: string }): Readonly<Record<string, unknown>>;
  recordRepairOutcomeInPublication(input: { scope: TrustedScope & { brief_id: string; design_version_id: string };
    inspection_id: string; action_id: string; result_hash: string; proof: CreativeInspectionRepairFence }):
    Readonly<{ status: "recorded" | "cancelled"; result_hash?: string }>;
  isClaimCurrent(input: { scope: TrustedScope & { brief_id: string; design_version_id: string };
    proof: CreativeInspectionRepairFence }): boolean;
  cancelInspection(input: { scope: TrustedScope & { brief_id: string; design_version_id: string };
    inspection_id: string }): Readonly<Record<string, unknown>>;
  getState(input: { scope: TrustedScope & { brief_id: string; design_version_id: string }; inspection_id: string }):
    Readonly<Record<string, unknown>> | null;
}

export interface InspectionInput {
  scope: TrustedScope;
  actor_id: string;
  job_id: string;
  attempt: MeteredAttemptRequest;
  brief: CreativeBrief;
  design_version: DesignVersion;
  parent_design: DesignVersion | null;
  deterministic: DeterministicInspection;
  /** Private exact artifact bytes are passed only to the configured visual observer, never to DecisionPort. */
  artifact_bytes: Uint8Array;
  used_assets: readonly Readonly<{ asset_id: string; action: "reproduce" | "modify" | "publish" | "display" }>[];
  /** Exact reservation reference validated and returned by the trusted C03 authority. */
  readonly reservation_ref: string;
  transport_attempt_id: string;
  dispatch_intent_ref: string;
  recordTransportAttempt(transport_attempt_id: string): Promise<string>;
  revalidateDispatch(input: Readonly<{ reservation_ref: string; billable_attempt_id: string; transport_attempt_id: string;
    dispatch_intent_ref: string; target_binding_sha256: `sha256:${string}`; signal: AbortSignal }>): Promise<string>;
  signal: AbortSignal;
  deadline_at: string;
}

export interface StructuredObservation {
  observer: { type: "human" | "model" | "system"; id: string };
  content_hash: string;
  uncertainty: { status: "measured" | "not_measured" | "unknown"; note?: string };
  summary: string;
  source_ref?: string;
}

export interface CreativeTelemetryEvidenceStatus {
  readonly local_status: "recorded" | "duplicate" | "pending" | "unknown";
  readonly pending_event_id?: string;
  readonly pending_event_staged?: boolean;
  /** Present only when the durable outbox retry path was unavailable. */
  readonly pending_event?: CreativeTelemetryEvidence;
  readonly pending_event_hash?: string;
}

/** Raw result returned by the injected inspection capability before the API
 * attaches its own durable telemetry delivery status. */
export type InspectionPortOutput = Readonly<{
  status: "complete";
  observer: CreativeVisualObservation["observer"];
  uncertainty: CreativeVisualObservation["uncertainty"];
  findings: CreativeVisualObservation["findings"];
  usage: ProviderUsageRecord;
}> | Readonly<{ status: "refused" | "unavailable" | "timeout" | "cancelled"; usage?: ProviderUsageRecord }>;

export interface InspectionOutput {
  readonly report: CreativeInspectionReport;
  readonly inspection_id: string;
  readonly attempt_ids: readonly string[];
  readonly telemetry_evidence: readonly CreativeTelemetryEvidenceStatus[];
}

export type CreativeApiResultV1_0 =
  | { design_version: DesignVersion; usage: UsageRecord; telemetry_evidence: CreativeTelemetryEvidenceStatus;
      inspection_repair?: InspectionRepairExecutionEvidence }
  | InspectionOutput
  | { items: DesignVersion[]; next_cursor: string | null }
  | { left: DesignVersion; right: DesignVersion; changed_fields: readonly string[] }
  | { selection: DesignSelection }
  | { handoff: ArtworkHandoff; receipt: ConsumptionReceipt | null }
  | CreativeBriefPlan
  | { invalidation: CreativeInvalidationResult;
      local_status: "pending" | "acknowledged" };

type DeepReadonly<T> = T extends readonly (infer Value)[] ? readonly DeepReadonly<Value>[]
  : T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> } : T;

export interface CreativeConceptLineage {
  readonly contract: "CreativeConceptLineage";
  readonly schema_version: "1.1";
  readonly mapping_status: "local_mapping_external_acceptance_pending";
  readonly concept_id: string;
  readonly ordinal: number;
  readonly parent_version_id: null;
  readonly brief_sha256: `sha256:${string}`;
  readonly package_id: string;
  readonly package_sha256: `sha256:${string}`;
  readonly plan_id: string;
  readonly plan_sha256: `sha256:${string}`;
  readonly policy_snapshot: DeepReadonly<Readonly<{
    tenant_id: string; project_id: string; brief_id: string; policy_ref: string; policy_version: string;
    evidence_ref: string; observed_at: string; expires_at: string; deadline_at: string;
    maximum_concept_count: number; maximum_reference_count: number; maximum_elapsed_ms: number;
    maximum_single_reference_bytes: number; maximum_aggregate_reference_bytes: number;
    budget_scope_id: string; budget_snapshot_ref: string; budget_expires_at: string;
  }>>;
  readonly adapter_snapshot: CreativeConceptAdapterSnapshot;
  readonly source_assets: readonly DeepReadonly<Readonly<{
    asset_id: string; source_ref: string; content_hash: `sha256:${string}`; media_type: string;
    role_ref: string; package_id: string; package_sha256: `sha256:${string}`;
    permission_evidence_ref: string; permission_checked_at: string; permission_expires_at: string;
    width: number; height: number; byte_length: number;
  }>>[];
  readonly attempt: DeepReadonly<MeteredAttemptRequest>;
  readonly logical_operation_id: string;
  readonly billable_attempt_id: string;
  readonly transport_attempt_id: string;
  readonly provider_request_ref: string | null;
  readonly dispatch_intent_ref: string;
  readonly provider_target_binding_sha256: `sha256:${string}`;
  readonly rendered_prompt_sha256: `sha256:${string}`;
  readonly usage_evidence_refs: readonly string[];
  readonly usage_completeness: "complete" | "partial" | "unknown";
  readonly unknown_financial_exposure: boolean;
  readonly design_version_id: string;
  readonly design_sha256: `sha256:${string}`;
  readonly artifact_id: string;
  readonly artifact_sha256: `sha256:${string}`;
  readonly artifact_media_type: "image/png" | "image/jpeg" | "image/webp";
}

export interface CreativeConceptBatchResult {
  readonly contract: "CreativeConceptBatchResult";
  readonly schema_version: "1.1";
  readonly batch_id: string;
  readonly status: "completed" | "partial" | "running" | "unknown_hold" | "cancelled";
  readonly requested_count: number;
  readonly candidates: readonly Readonly<{
    concept_id: string;
    ordinal: number;
    design_version: DesignVersion;
    creative_concept_lineage: CreativeConceptLineage;
    storage_commit_ref: string;
    lineage_evidence_ref: string;
  }>[];
  readonly progress: readonly Readonly<{
    concept_id: string;
    ordinal: number;
    status: string;
    attempts: number;
    billable_attempt_id: string | null;
  }>[];
}

export type CreativeApiResultV1_2 =
  | Readonly<{ composition: null; status: "not_initialized" }>
  | Readonly<{ composition: CreativeCompositionProductionEnvelope; status: "current";
      preview_access: CreativeCompositionPreviewAccess }>
  | Readonly<{ composition: CreativeCompositionProductionEnvelope;
      status: "saved"; revision_sha256: CreativeCompositionSha256; selection_revision: number;
      preview_access: CreativeCompositionPreviewAccess }>;

export type CreativeApiResult = CreativeApiResultV1_0 | CreativeConceptBatchResult | CreativeApiResultV1_2;

export interface CreativeInvalidationResult {
  event_id: string;
  event_hash: string;
  durable_receipt: InvalidationReceipt;
  approval_staleness: {
    requested: number;
    acknowledged: number;
    status: "acknowledged" | "pending";
    receipts: readonly (ApprovalStalenessRequest & { status: "acknowledged" })[];
  };
  producer_acknowledgment: ProducerAcknowledgment | null;
  verification_classification: "owner_verified" | "synthetic_test";
}

export interface CreativeApiErrorResponse {
  ok: false;
  contract: "CreativeApiResponse";
  schema_version: "1.0";
  error: CreativeApiErrorShape;
}

export interface CreativeApiV1_1ErrorResponse extends Omit<CreativeApiErrorResponse, "schema_version"> {
  schema_version: "1.1";
}
export interface CreativeApiV1_2ErrorResponse extends Omit<CreativeApiErrorResponse, "schema_version"> {
  schema_version: "1.2";
}
export interface CreativeApiV1_3ErrorResponse extends Omit<CreativeApiErrorResponse, "schema_version"> {
  schema_version: "1.3";
}

export interface CreativeApiSuccessResponse {
  ok: true;
  contract: "CreativeApiResponse";
  schema_version: "1.0";
  operation_id?: string;
  replayed?: boolean;
  job?: CreativeJob;
  result?: CreativeApiResultV1_0;
}

export interface CreativeApiV1_1SuccessResponse extends Omit<CreativeApiSuccessResponse, "schema_version" | "result"> {
  schema_version: "1.1";
  result?: CreativeConceptBatchResult;
}
export interface CreativeApiV1_2SuccessResponse extends Omit<CreativeApiSuccessResponse, "schema_version" | "result"> {
  schema_version: "1.2";
  result?: CreativeApiResultV1_2;
}
export interface CreativeCompositionHistoryRevisionIdentity {
  readonly revision_id: string;
  readonly revision_sha256: CreativeCompositionSha256;
  readonly parent_revision_id: string | null;
  readonly parent_revision_sha256: CreativeCompositionSha256 | null;
  readonly design_version_id: string;
  readonly design_version_sha256: CreativeCompositionSha256;
  readonly created_at: string;
}
export interface CreativeCompositionHistoryResult {
  readonly contract: "CreativeCompositionHistoryIdentity";
  readonly schema_version: "1.0";
  readonly status: "identity_only" | "not_initialized";
  readonly current: CreativeCompositionCurrentIdentity | null;
  readonly selection_compatibility: "current" | "changed" | "different_design" | "unavailable";
  readonly revisions: readonly CreativeCompositionHistoryRevisionIdentity[];
  readonly has_more: boolean;
  readonly next_after_revision_id: string | null;
}
export interface CreativeCompositionRevalidationResult {
  readonly contract: "CreativeCompositionRevalidationResult";
  readonly schema_version: "1.0";
  readonly status: "saved";
  readonly composition: CreativeCompositionProductionEnvelope;
  readonly revision_sha256: CreativeCompositionSha256;
  readonly selection_revision: number;
  readonly preview_access: CreativeCompositionPreviewAccess;
}
export interface CreativeApiV1_3SuccessResponse extends Omit<CreativeApiSuccessResponse, "schema_version" | "result"> {
  schema_version: "1.3";
  result?: CreativeCompositionHistoryResult | CreativeCompositionRevalidationResult;
}

export type CreativeApiResponse = CreativeApiSuccessResponse | CreativeApiErrorResponse |
  CreativeApiV1_1SuccessResponse | CreativeApiV1_1ErrorResponse |
  CreativeApiV1_2SuccessResponse | CreativeApiV1_2ErrorResponse |
  CreativeApiV1_3SuccessResponse | CreativeApiV1_3ErrorResponse;

export declare class CreativeApiError extends Error {
  constructor(code: CreativeErrorCode, operation?: CreativeOperation | "unknown", field?: string,
    options?: { retryable?: boolean; diagnostic_ref?: string });
  code: CreativeErrorCode;
  operation: CreativeOperation | "unknown";
  readonly module: "creative-engine.api";
  field: string;
  retryable: boolean;
  diagnostic_ref?: string;
}

export declare const CREATIVE_API_VERSION: "1.0";
export declare const CREATIVE_API_VERSIONS: readonly ["1.0", "1.1", "1.2", "1.3"];
export declare const CREATIVE_API_OPERATIONS: readonly CreativeOperation[];
export declare function createCreativeApi(options?: {
  ports?: CreativeRuntimePorts;
  now?: () => number;
  idFactory?: () => string;
}): { invoke(principal: TrustedCreativeActor, request: CreativeApiRequest): Promise<CreativeApiResponse> };
export declare const createCreativeRuntime: typeof createCreativeApi;

/** Direct OpenAI concept configuration (all five fields are required). */
export type OpenAIConceptConfiguration = Readonly<{
  quality: string; size: string; output_format: string; background: string; moderation: string;
}>;
/** OpenRouter concept configuration: the declared subset only. */
export type OpenRouterConceptConfiguration = Readonly<{
  aspect_ratio?: string; quality?: string; background?: string; output_format?: string;
  resolution?: string; output_compression?: number;
}>;
export type OpenRouterConceptCapabilities = Readonly<{
  generation: boolean; edit: false | Readonly<{ max_input_references: number }>;
}>;

type CreativeConceptAdapterSnapshotBase = Readonly<{
  capability_ref: string; capability_schema_version: string; model: string;
  endpoint: string; provider_operation: "edit"; operation_mapping_ref: string; operation_kind: string;
  target_ref: string; sdk_name: string; sdk_version: string; configuration_ref: string;
  configuration_sha256: `sha256:${string}`;
  prompt_template_ref: string; prompt_template_version: string; prompt_template_sha256: `sha256:${string}`;
}>;

/** Provider-discriminated lineage keeps direct OpenAI guarantees and the narrower OpenRouter profile truthful. */
export type CreativeConceptAdapterSnapshot = DeepReadonly<
  | (CreativeConceptAdapterSnapshotBase & Readonly<{
      provider_name: "openai";
      configuration: OpenAIConceptConfiguration;
      provider_tag?: never;
      capabilities?: never;
    }>)
  | (CreativeConceptAdapterSnapshotBase & Readonly<{
      provider_name: "openrouter";
      provider_tag: string;
      capabilities: OpenRouterConceptCapabilities;
      configuration: OpenRouterConceptConfiguration;
    }>)
>;
