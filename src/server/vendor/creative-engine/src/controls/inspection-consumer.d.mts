export type InspectionPresentationStatus = 'pending' | 'unavailable' | 'failed' | 'completed';
export type InspectionPresentationOutcome = 'acceptable_for_review' | 'bounded_repair_recommended' | 'needs_human_review' | 'refusal' | 'failure';
export interface InspectionPresentationInput {
  schema_version: 'controls-inspection-presentation/1.0';
  evidence_mode: 'local-input-fixture';
  references: { edit_action_id: string; inspection_action_id: string; brief_id: string; design_version_id: string; artifact_hash: string };
  status: InspectionPresentationStatus;
  report: { contract: 'CreativeInspectionReport'; schema_version: '1.0'; outcome: InspectionPresentationOutcome } | null;
  usage: { completeness: 'complete' | 'partial' | 'unknown'; hold: 'held' | 'released' | 'unknown' };
}
export interface InspectionRequestPreparation {
  readonly proposal_version: 'controls-inspection-request/1.0';
  readonly capability_status: 'pending_qualified_producer';
  readonly binding: Readonly<{ edit_action_id: string; inspection_action_id: string; brief_id: string; brief_hash: string; selection_revision: number;
    design_version_id: string; design_hash: string; artifact_hash: string }>;
  readonly request: Readonly<{ operation: 'inspect'; action_id: string; payload: Readonly<{ brief_id: string; design_version_id: string }> }>;
}
export declare function prepareInspectionRequest(input: {
  current_brief: { brief_id: string; brief_hash: string; tenant_id: string; project_id: string };
  current_selection: { revision: number; design_version_id: string; design_hash: string };
  saved_design: { logical_operation_id: string; design_version_id: string; brief_id: string; brief_hash: string; tenant_id: string; project_id: string; design_hash: string; artifact: { content_hash: string } };
  edit_action_id: string;
  inspection_action_id: string;
}): InspectionRequestPreparation;
export declare function projectInspectionPresentation(input: unknown): Readonly<{
  schema_version: 'controls-inspection-presentation/1.0'; evidence_label: string; status: InspectionPresentationStatus; message: string;
  references: Readonly<InspectionPresentationInput['references']>; usage_message: string; hold_message: string;
  authority_message: string; retry_message: string;
}>;
