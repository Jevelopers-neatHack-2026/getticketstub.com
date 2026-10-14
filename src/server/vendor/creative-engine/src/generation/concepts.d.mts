import type {
  CreativeBrief,
  DesignVersion,
  EventIntelligencePackage,
  TrustedScope,
} from "../contracts/creative/v1.mjs";
import type {
  MeteredAttemptRequest,
  MeteredOperationKind,
  ReservedAttempt,
} from "../contracts/metering.mjs";
import type { AssetPermissionEvidence } from "../planning/index.mjs";
import type { OpenAIImageConfiguration } from "../models/index.mjs";

type DeepReadonly<T> = T extends readonly (infer Value)[]
  ? readonly DeepReadonly<Value>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export declare const CREATIVE_CONCEPT_PROPOSAL: Readonly<{
  contract: "CreativeConceptBatchProposal";
  schema_version: "0.3.0";
  acceptance_status: "unaccepted_local_proposal";
}>;

export declare class CreativeConceptProposalError extends Error {
  constructor(code: string, field: string, message: string);
  readonly code: string;
  readonly field: string;
}

export interface ConceptRequestReferenceProposal {
  readonly asset_id: string;
  /** Opaque role reference; it is not permission and has no locally invented role taxonomy. */
  readonly role_ref: string;
}

export interface ConceptRequestProposal {
  readonly action_id: string;
  readonly brief_id: string;
  readonly plan_id: string;
  readonly requested_count: number;
  readonly references: readonly ConceptRequestReferenceProposal[];
}

export interface ConceptPolicySnapshotProposal {
  readonly tenant_id: string;
  readonly project_id: string;
  readonly brief_id: string;
  readonly policy_ref: string;
  readonly policy_version: string;
  readonly evidence_ref: string;
  readonly observed_at: string;
  readonly expires_at: string;
  readonly deadline_at: string;
  readonly maximum_concept_count: number;
  readonly maximum_reference_count: number;
  readonly maximum_elapsed_ms: number;
  readonly maximum_single_reference_bytes: number;
  readonly maximum_aggregate_reference_bytes: number;
  readonly budget_scope_id: string;
  readonly budget_snapshot_ref: string;
  readonly budget_expires_at: string;
}

export interface ConceptAdapterSnapshotProposal {
  readonly capability_ref: string;
  readonly capability_schema_version: string;
  readonly provider_name: string;
  readonly model: string;
  readonly endpoint: "https://api.openai.com/v1/images/edits";
  readonly provider_operation: "edit";
  /** Explicit host mapping reference. Its acceptance is outside this local proposal. */
  readonly operation_mapping_ref: string;
  readonly operation_kind: MeteredOperationKind;
  readonly target_ref: string;
  readonly sdk_name: string;
  readonly sdk_version: string;
  readonly configuration_ref: string;
  readonly configuration_sha256: `sha256:${string}`;
  readonly configuration: OpenAIImageConfiguration;
  readonly prompt_template_ref: string;
  readonly prompt_template_version: string;
  readonly prompt_template_sha256: `sha256:${string}`;
}

export interface CreativeConceptBatchProposalInput {
  readonly trusted_scope: TrustedScope & { readonly brief_id: string };
  readonly now: string;
  readonly brief: CreativeBrief | Record<string, unknown>;
  readonly brief_sha256: `sha256:${string}`;
  readonly research_package: EventIntelligencePackage | Record<string, unknown>;
  readonly request: ConceptRequestProposal;
  readonly permission_evidence: readonly AssetPermissionEvidence[];
  readonly policy_snapshot: ConceptPolicySnapshotProposal;
  readonly adapter_snapshot: ConceptAdapterSnapshotProposal;
}

export type ConceptSlotStatus =
  | "pending"
  | "reserved"
  | "dispatching"
  | "response_received"
  | "staged"
  | "succeeded"
  | "failed"
  | "unknown"
  | "cancelled";

export interface ConceptReferenceLineageProposal {
  readonly asset_id: string;
  readonly source_ref: string;
  readonly content_hash: `sha256:${string}`;
  readonly media_type: string;
  readonly role_ref: string;
  readonly package_id: string;
  readonly package_sha256: `sha256:${string}`;
  readonly permission_evidence_ref: string;
  readonly permission_checked_at: string;
  readonly permission_expires_at: string;
}

export interface ConceptProviderObservationProposal {
  readonly event_id: string;
  readonly outcome: "succeeded" | "failed" | "unknown";
  readonly outcome_evidence_ref: string;
  readonly provider_request_id: string | null;
  readonly artifact_sha256: `sha256:${string}` | null;
  readonly usage_evidence_ref: string;
  readonly usage_completeness: "complete" | "partial" | "unknown";
  readonly retry_disposition?: "eligible_retry" | "hard_stop";
  readonly financial_exposure_status?: "settled";
  readonly financial_settlement_evidence?: Readonly<{
    status: "settled";
    reservation_id: string;
    source_observation_id: string;
    effective_billable_attempt_id: string;
  }>;
  readonly publication_suppressed?: true;
}

export interface ConceptAttemptProposal {
  readonly logical_operation_id: string;
  readonly billable_attempt_id: string;
  readonly transport_attempt_id: string;
  readonly reservation_ref: string;
  readonly lease_ref: string;
  readonly metering_attempt: DeepReadonly<MeteredAttemptRequest>;
  readonly status: string;
  readonly financial_exposure_status: "reservation_active" | "in_flight" | "awaiting_c03_reconciliation" | "unknown_hold" | "settled";
  readonly unknown_financial_exposure: boolean;
  readonly provider_observations: readonly ConceptProviderObservationProposal[];
  readonly latest_provider_outcome: "succeeded" | "failed" | "unknown" | null;
  readonly latest_retry_disposition?: "eligible_retry" | "hard_stop" | "legacy_unclassified" | null;
  readonly latest_provider_request_id: string | null;
  readonly usage_evidence_ref: string | null;
  readonly usage_evidence_refs: readonly string[];
  readonly usage_completeness: "complete" | "partial" | "unknown" | null;
  readonly dispatch_intent_ref: string | null;
  readonly provider_target_binding_sha256: `sha256:${string}` | null;
  readonly rendered_prompt_sha256: `sha256:${string}` | null;
  readonly provider_artifact_sha256: `sha256:${string}` | null;
  readonly artifact_validation_failure?: Readonly<{
    artifact_sha256: `sha256:${string}`;
    failure_code: string;
    inspection_evidence_ref: string;
  }>;
  readonly storage_stage_ref: string | null;
  readonly inspection_evidence_ref: string | null;
  readonly staged_artifact?: Readonly<{
    content_hash: `sha256:${string}`;
    media_type: string;
    width: number;
    height: number;
    format: "png" | "jpeg" | "webp";
  }>;
  readonly storage_metadata_evidence_refs: readonly string[];
  readonly publication: Readonly<{
    design_version_id: string;
    design_sha256: `sha256:${string}`;
    storage_commit_ref: string;
    lineage_evidence_ref: string;
  }> | null;
}

export interface ConceptSlotProposal {
  readonly concept_id: string;
  readonly ordinal: number;
  readonly logical_operation_id: string;
  readonly status: ConceptSlotStatus;
  readonly parent_version_id: null;
  readonly attempts: readonly ConceptAttemptProposal[];
  readonly current_billable_attempt_id: string | null;
  readonly output_lineage: Readonly<Record<string, unknown> & {
    design_version_id: string;
    design_sha256: `sha256:${string}`;
    artifact_id: string;
    artifact_sha256: `sha256:${string}`;
    artifact_media_type: "image/png" | "image/jpeg" | "image/webp";
  }> | null;
  readonly metadata_reconciliations: readonly string[];
  readonly late_evidence: readonly Readonly<Record<string, unknown>>[];
  readonly cancellation_event_id?: string;
  readonly cancellation_evidence_ref?: string;
}

export interface CreativeConceptBatchProposal {
  readonly contract: "CreativeConceptBatchProposal";
  readonly schema_version: "0.1.0" | "0.2.0" | "0.3.0";
  readonly acceptance_status: "unaccepted_local_proposal";
  readonly batch_id: string;
  readonly tenant_id: string;
  readonly project_id: string;
  readonly brief_id: string;
  readonly brief_sha256: `sha256:${string}`;
  readonly package_id: string;
  readonly package_sha256: `sha256:${string}`;
  readonly action_id: string;
  readonly request_sha256: `sha256:${string}`;
  readonly plan_id: string;
  readonly plan_sha256: `sha256:${string}`;
  readonly requested_count: number;
  readonly policy_snapshot: ConceptPolicySnapshotProposal;
  readonly adapter_snapshot: ConceptAdapterSnapshotProposal;
  readonly references: readonly ConceptReferenceLineageProposal[];
  readonly slots: readonly ConceptSlotProposal[];
  readonly events: readonly Readonly<{
    event_id: string;
    event_hash: `sha256:${string}`;
    event_type: string;
    concept_id: string | null;
    billable_attempt_id: string | null;
    reservation_ref: string | null;
  }>[];
}

export interface CreativeConceptEventContext {
  readonly tenant_id: string;
  readonly project_id: string;
  readonly action_id: string;
  readonly batch_id: string;
  readonly concept_id: string;
  readonly event_id: string;
}

export type CreativeConceptBatchEvent =
  | (Omit<CreativeConceptEventContext, "concept_id"> & {
      readonly concept_id: null;
      readonly event_type: "upgrade_retry_disposition";
      readonly from_schema_version: "0.1.0" | "0.2.0";
      readonly to_schema_version: "0.3.0";
    })
  | (CreativeConceptEventContext & {
      readonly event_type: "reserve_attempt";
      readonly billable_attempt_id: string;
      readonly transport_attempt_id: string;
      readonly metered_attempt: MeteredAttemptRequest;
      readonly reservation: ReservedAttempt;
    })
  | (CreativeConceptEventContext & {
      readonly event_type: "dispatch_started";
      readonly billable_attempt_id: string;
      readonly transport_attempt_id: string;
      readonly dispatch_intent_ref: string;
      readonly provider_target_binding_sha256: `sha256:${string}`;
      readonly rendered_prompt_sha256: `sha256:${string}`;
    })
  | (CreativeConceptEventContext & {
      readonly event_type: "provider_outcome";
      readonly billable_attempt_id: string;
      readonly transport_attempt_id: string;
      readonly outcome: "succeeded" | "failed" | "unknown";
      readonly outcome_evidence_ref: string;
      readonly provider_request_id?: string;
      readonly artifact_sha256?: `sha256:${string}`;
      readonly usage_evidence_ref: string;
      readonly usage_completeness: "complete" | "partial" | "unknown";
      readonly retry_disposition?: "eligible_retry" | "hard_stop";
      readonly financial_exposure_status?: "settled";
      readonly financial_settlement_evidence?: Readonly<{
        status: "settled";
        reservation_id: string;
        source_observation_id: string;
        effective_billable_attempt_id: string;
      }>;
    })
  | (CreativeConceptEventContext & {
      readonly event_type: "reconcile_unknown_attempt";
      readonly billable_attempt_id: string;
      readonly transport_attempt_id: string;
      readonly outcome: "succeeded" | "failed" | "unknown";
      readonly outcome_evidence_ref: string;
      readonly provider_request_id?: string;
      readonly artifact_sha256?: `sha256:${string}`;
      readonly usage_evidence_ref: string;
      readonly usage_completeness: "complete" | "partial" | "unknown";
      readonly financial_exposure_status?: "settled";
      readonly financial_settlement_evidence?: Readonly<{
        status: "settled";
        reservation_id: string;
        source_observation_id: string;
        effective_billable_attempt_id: string;
      }>;
    })
  | (CreativeConceptEventContext & {
      readonly event_type: "artifact_rejected";
      readonly billable_attempt_id: string;
      readonly transport_attempt_id: string;
      readonly artifact_sha256: `sha256:${string}`;
      readonly failure_code: string;
      readonly inspection_evidence_ref: string;
    })
  | (CreativeConceptEventContext & {
      readonly event_type: "candidate_staged";
      readonly billable_attempt_id: string;
      readonly transport_attempt_id: string;
      readonly artifact_sha256: `sha256:${string}`;
      readonly media_type: "image/png" | "image/jpeg" | "image/webp";
      readonly width: number;
      readonly height: number;
      readonly storage_stage_ref: string;
      readonly inspection_evidence_ref: string;
    })
  | (CreativeConceptEventContext & {
      readonly event_type: "reconcile_staged_metadata";
      readonly billable_attempt_id: string;
      readonly transport_attempt_id: string;
      readonly artifact_sha256: `sha256:${string}`;
      readonly metadata_evidence_ref: string;
    })
  | (CreativeConceptEventContext & {
      readonly event_type: "candidate_published";
      readonly billable_attempt_id: string;
      readonly transport_attempt_id: string;
      readonly design_version: DesignVersion | Record<string, unknown>;
      readonly storage_commit_ref: string;
      readonly lineage_evidence_ref: string;
    })
  | (CreativeConceptEventContext & {
      readonly event_type: "cancel_concept";
      readonly billable_attempt_id?: string;
      readonly transport_attempt_id?: string;
      readonly cancellation_evidence_ref: string;
    })
  | (CreativeConceptEventContext & {
      readonly event_type: "late_provider_evidence";
      readonly billable_attempt_id: string;
      readonly transport_attempt_id: string;
      readonly outcome: "succeeded" | "failed" | "unknown";
      readonly outcome_evidence_ref: string;
      readonly provider_request_id?: string;
      readonly artifact_sha256?: `sha256:${string}`;
      readonly usage_evidence_ref: string;
      readonly usage_completeness: "complete" | "partial" | "unknown";
    });

export declare function createCreativeConceptBatchProposal(
  input: CreativeConceptBatchProposalInput,
): CreativeConceptBatchProposal;

export declare function replayCreativeConceptBatch(
  existing: CreativeConceptBatchProposal,
  incoming: Pick<CreativeConceptBatchProposalInput, "trusted_scope" | "request">,
): Readonly<{ status: "replayed"; batch: CreativeConceptBatchProposal }>;

export declare function applyCreativeConceptEvent(
  batch: CreativeConceptBatchProposal,
  event: CreativeConceptBatchEvent,
): Readonly<{ status: "applied" | "duplicate"; batch: CreativeConceptBatchProposal }>;

export interface InspectedConceptImage {
  readonly content_sha256: `sha256:${string}`;
  readonly media_type: "image/png" | "image/jpeg" | "image/webp";
  readonly format: "png" | "jpeg" | "webp";
  readonly width: number;
  readonly height: number;
  readonly byte_length: number;
}

export declare function inspectCreativeConceptImageBytes(input: {
  readonly bytes: Uint8Array;
  readonly expected_media_type: "image/png" | "image/jpeg" | "image/webp";
  readonly maximum_bytes: number;
  readonly expected_dimensions?: Readonly<{ width: number; height: number }>;
}): Promise<InspectedConceptImage>;

export declare function inspectCreativeConceptReferenceBytes(
  batch: CreativeConceptBatchProposal,
  resolvedReferences: readonly Readonly<{ asset_id: string; bytes: Uint8Array }>[],
): Promise<Readonly<{
  references: readonly Readonly<{
    asset_id: string;
    source_ref: string;
    role_ref: string;
    content_sha256: `sha256:${string}`;
    media_type: "image/png" | "image/jpeg" | "image/webp";
    format: "png" | "jpeg" | "webp";
    width: number;
    height: number;
    byte_length: number;
    permission_evidence_ref: string;
  }>[];
  aggregate_byte_length: number;
}>>;
