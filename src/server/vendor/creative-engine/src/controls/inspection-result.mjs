/** Bounded browser projection of actual public CE09 results. No report prose,
 * private provider metadata, financial calculations or inferred permissions. */
import { isRecord, snapshotControlJson, validId } from './schema.mjs';
import { canonicalHash } from 'creative-engine/contracts';
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
export const inspectionMessages = Object.freeze({
  pending: 'Inspection pending. The saved artwork remains available.',
  unknown: 'Inspection outcome is unknown. Recover the existing inspection; do not regenerate the saved edit.',
  unavailable: 'Inspection unavailable. The saved artwork remains available.',
  failed: 'Inspection did not complete. The saved artwork remains available.',
  cancelled: 'Inspection cancelled. The saved artwork remains available.',
  acceptable_for_review: 'Ready for human review. This recommendation grants no approval.',
  bounded_repair_recommended: 'Repair recommended for review. A separate explicit authorized action is required.',
  needs_human_review: 'Human review required. Inspection did not establish a safe next action.',
  refusal: 'Inspection refused. Human review is required.',
  failure: 'Inspection found a failure. Human review is required.',
});
export function projectActualInspection(input) {
  try {
    const { binding, response, job_id } = snapshotControlJson(input);
    if (!isRecord(binding) || !['source_operation_id', 'edit_action_id', 'inspection_action_id', 'brief_id', 'design_version_id', 'tenant_id', 'project_id'].every(k => validId(binding[k])) ||
      !['brief_hash', 'design_hash', 'artifact_hash'].every(k => digest(binding[k])) || binding.edit_action_id === binding.inspection_action_id) throw new TypeError();
    let status = 'unknown', report = null;
    const job = response?.job;
    if (!response) status = 'pending';
    else if (response.ok && job?.job_id === job_id && ['queued', 'running'].includes(job.status)) status = 'pending';
    else if (job?.job_id === job_id && job.status === 'cancelled') status = 'cancelled';
    else if (job?.job_id === job_id && job.status === 'failed') status = 'failed';
    else if (!response.ok && ['permission_denied', 'unauthorized', 'scope_denied', 'unavailable'].includes(response.error?.code)) status = 'unavailable';
    if (response?.ok && job?.job_id === job_id && job.status === 'completed') {
      const value = response.result?.report;
      if (!isRecord(value) || value.contract !== 'CreativeInspectionReport' || value.schema_version !== '1.0' ||
        !['fixture', 'recorded', 'sandbox', 'live'].includes(value.evidence_mode) ||
        !['acceptable_for_review', 'bounded_repair_recommended', 'needs_human_review', 'refusal', 'failure'].includes(value.outcome) ||
        !['tenant_id', 'project_id', 'brief_id', 'brief_hash', 'design_version_id', 'design_hash', 'artifact_hash'].every(k => value[k] === binding[k]) ||
        !['complete', 'partial', 'unknown'].includes(value.limits?.usage_completeness) ||
        value.limits.max_repairs !== 2 || value.limits.max_elapsed_ms !== 60000 || value.limits.max_simulated_units !== 3 ||
        ![['remaining_repairs', 2], ['remaining_elapsed_ms', 60000]].every(([k, max]) => Number.isSafeInteger(value.limits[k]) && value.limits[k] >= 0 && value.limits[k] <= max) ||
        !Number.isFinite(value.limits.remaining_simulated_units) || value.limits.remaining_simulated_units < 0 || value.limits.remaining_simulated_units > 3 ||
        !Array.isArray(value.eligible_repair_actions)) throw new TypeError();
      for (const k of ['first_request_ref', 'route_request_ref', 'decision_ref']) if (value[k] !== null && !digest(value[k])) throw new TypeError();
      status = 'completed'; report = value;
    }
    return Object.freeze({ ok: true, code: status, schema_version: 'controls-actual-inspection/1.0', status,
      references: Object.freeze({ source_operation_id: binding.source_operation_id, edit_action_id: binding.edit_action_id,
        inspection_action_id: binding.inspection_action_id, brief_id: binding.brief_id, design_version_id: binding.design_version_id, artifact_hash: binding.artifact_hash,
        ...(validId(job_id) ? { job_id } : {}) }),
      outcome: report?.outcome ?? null, message: inspectionMessages[report?.outcome ?? status],
      evidence_mode: report?.evidence_mode ?? 'unknown', report_hash: report ? canonicalHash(report) : null,
      provenance: report ? Object.freeze({ first_request_ref: report.first_request_ref, route_request_ref: report.route_request_ref, decision_ref: report.decision_ref }) : null,
      usage_completeness: report?.limits.usage_completeness ?? 'unknown', total_cost: null,
      // Only Finance knows holds/settlements. Absence never becomes released.
      reservation_status: 'unknown',
      limits: report ? Object.freeze({ max_repairs: 2, max_elapsed_ms: 60000, max_simulated_units: 3, remaining_repairs: report.limits.remaining_repairs, remaining_elapsed_ms: report.limits.remaining_elapsed_ms, remaining_simulated_units: report.limits.remaining_simulated_units, usage_completeness: report.limits.usage_completeness }) : null,
      repair_available: Boolean(report?.outcome === 'bounded_repair_recommended' && report.limits.usage_completeness === 'complete' &&
        report.eligible_repair_actions.includes('image.edit') && report.limits.remaining_repairs > 0 && report.limits.remaining_elapsed_ms > 0 && report.limits.remaining_simulated_units > 0),
      approval: false, purchase: false });
  } catch { return Object.freeze({ ok: false, code: 'unavailable', status: 'unknown' }); }
}
