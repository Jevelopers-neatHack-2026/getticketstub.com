/** UI-only consumer proposal. No invocation, durable authority or repair controller.
 * Report inputs are labeled local presentation fixtures, never qualified CE09 results. */
import { isRecord, snapshotControlJson, validId } from './schema.mjs';

const VERSION = 'controls-inspection-presentation/1.0';
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const invalid = () => { throw new TypeError('Unsupported inspection presentation'); };
const outcomes = Object.freeze({
  acceptable_for_review: 'Ready for human review. This recommendation grants no approval.',
  bounded_repair_recommended: 'Repair recommended for review. A separate explicit authorized action is required.',
  needs_human_review: 'Human review required. Inspection did not establish a safe next action.',
  refusal: 'Inspection refused. Human review is required.',
  failure: 'Inspection found a failure. Human review is required.',
});

/** Prepare only the api.invoke operation fragment; the trusted host must supply its
 * envelope, authority, qualified producer and same-store wiring in a later grant.
 * Reuse the returned fragment for inspection-only retry. Never retry the edit. */
export function prepareInspectionRequest(input) {
  input = snapshotControlJson(input);
  if (!exact(input, ['current_brief', 'current_selection', 'saved_design', 'edit_action_id', 'inspection_action_id'])) invalid();
  const brief = input.current_brief, selection = input.current_selection, design = input.saved_design;
  if (!exact(brief, ['brief_id', 'brief_hash', 'tenant_id', 'project_id']) || !digest(brief.brief_hash) ||
      !['brief_id', 'tenant_id', 'project_id'].every(key => validId(brief[key])) || !isRecord(selection) ||
      !Number.isSafeInteger(selection.revision) || selection.revision < 1 ||
      !isRecord(design) || !validId(design.design_version_id) || !validId(design.brief_id) ||
      !digest(design.design_hash) || !isRecord(design.artifact) || !digest(design.artifact.content_hash) ||
      !validId(input.edit_action_id) || !validId(input.inspection_action_id) || input.edit_action_id === input.inspection_action_id ||
      design.logical_operation_id !== input.edit_action_id ||
      selection.design_version_id !== design.design_version_id || selection.design_hash !== design.design_hash ||
      brief.brief_id !== design.brief_id || brief.brief_hash !== design.brief_hash ||
      brief.tenant_id !== design.tenant_id || brief.project_id !== design.project_id) invalid();
  return Object.freeze({
    proposal_version: 'controls-inspection-request/1.0', capability_status: 'pending_qualified_producer',
    binding: Object.freeze({ edit_action_id: input.edit_action_id, inspection_action_id: input.inspection_action_id,
      brief_id: brief.brief_id, brief_hash: brief.brief_hash, selection_revision: selection.revision, design_version_id: design.design_version_id,
      design_hash: design.design_hash, artifact_hash: design.artifact.content_hash }),
    request: Object.freeze({ operation: 'inspect', action_id: input.inspection_action_id,
      payload: Object.freeze({ brief_id: brief.brief_id, design_version_id: design.design_version_id }) }),
  });
}

/** Strict local fixture subset, NOT a validator or receipt for the CE09 producer.
 * Freeform recommendations, errors, private IDs, artwork and prompts never render. */
export function projectInspectionPresentation(input) {
  input = snapshotControlJson(input);
  if (!exact(input, ['schema_version', 'evidence_mode', 'references', 'status', 'report', 'usage']) ||
      input.schema_version !== VERSION || input.evidence_mode !== 'local-input-fixture' ||
      !exact(input.references, ['edit_action_id', 'inspection_action_id', 'brief_id', 'design_version_id', 'artifact_hash']) ||
      !Object.entries(input.references).every(([key, value]) => key === 'artifact_hash' ? digest(value) : validId(value)) ||
      input.references.edit_action_id === input.references.inspection_action_id ||
      !['pending', 'unavailable', 'failed', 'completed'].includes(input.status) ||
      !exact(input.usage, ['completeness', 'hold']) || !['complete', 'partial', 'unknown'].includes(input.usage.completeness) ||
      !['held', 'released', 'unknown'].includes(input.usage.hold)) invalid();
  if (input.status === 'completed') {
    if (!exact(input.report, ['contract', 'schema_version', 'outcome']) || input.report.contract !== 'CreativeInspectionReport' ||
        input.report.schema_version !== '1.0' || typeof input.report.outcome !== 'string' || !Object.hasOwn(outcomes, input.report.outcome)) invalid();
  } else if (input.report !== null) invalid();
  const messages = {
    pending: 'Inspection pending. The saved artwork remains available.',
    unavailable: 'Inspection unavailable. The saved artwork remains available. Recover the existing inspection before retrying.',
    failed: 'Inspection did not complete. The saved artwork remains available. Retry inspection only when authorized.',
    completed: input.report ? outcomes[input.report.outcome] : '',
  };
  return Object.freeze({ schema_version: VERSION, evidence_label: 'LOCAL INPUT FIXTURE · Presentation only; actual CE09 integration pending.',
    status: input.status, message: messages[input.status],
    references: Object.freeze({ ...input.references }),
    usage_message: input.usage.completeness === 'complete' ? 'Usage reported complete. Cost is not provided here.' :
      input.usage.completeness === 'partial' ? 'Usage is partial. Total cost remains unknown.' : 'Usage and total cost remain unknown.',
    hold_message: input.usage.hold === 'held' ? 'Reservation remains held. UI status does not release funds.' :
      input.usage.hold === 'released' ? 'Input reports a released reservation; this page does not release funds.' : 'Reservation status is unknown.',
    authority_message: 'Recommendations cannot start repair, approve artwork or authorize purchase.',
    retry_message: 'Keep the inspection action ID for lookup or retry. Do not regenerate the saved edit.',
  });
}
