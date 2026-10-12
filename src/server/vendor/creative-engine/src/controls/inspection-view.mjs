/** Pure browser validation. Only bounded enums, safe references and known counts
 * enter the view. This does not confer backend repair or Finance authority. */
import { isRecord, snapshotControlJson, validId } from './schema.mjs';
const hash = x => typeof x === 'string' && /^sha256:[a-f0-9]{64}$/.test(x);
export function projectInspectionSource(input) {
 try {
  const source = snapshotControlJson(input);
  if (!isRecord(source) || !validId(source.source_operation_id) || !validId(source.design_version_id) || !hash(source.artifact_hash)) return null;
  return Object.freeze({source_operation_id:source.source_operation_id,design_version_id:source.design_version_id,artifact_hash:source.artifact_hash});
 } catch { return null; }
}
const outcomes = ['acceptable_for_review', 'bounded_repair_recommended', 'needs_human_review', 'refusal', 'failure'];
const messages = Object.freeze({ pending: 'Inspection pending. The saved artwork remains available.',
 unknown: 'Inspection outcome is unknown. Recover the existing inspection; do not regenerate the saved edit.',
 unavailable: 'Inspection unavailable. The saved artwork remains available.', failed: 'Inspection did not complete. The saved artwork remains available.',
 cancelled: 'Inspection cancelled. The saved artwork remains available.',
 acceptable_for_review: 'Ready for human review. This recommendation grants no approval.',
 bounded_repair_recommended: 'Repair recommended for review. A separate explicit authorized action is required.',
 needs_human_review: 'Human review required. Inspection did not establish a safe next action.',
 refusal: 'Inspection refused. Human review is required.', failure: 'Inspection found a failure. Human review is required.' });
export function projectInspectionView(value) {
 try {
  const v = snapshotControlJson(value);
  if (!isRecord(v) || v.ok !== true || v.schema_version !== 'controls-actual-inspection/1.0' ||
    !['pending','unknown','unavailable','failed','cancelled','completed'].includes(v.status) ||
    !isRecord(v.references) || !['source_operation_id','edit_action_id','inspection_action_id','brief_id','design_version_id'].every(k=>validId(v.references[k])) ||
    !hash(v.references.artifact_hash) || v.references.edit_action_id === v.references.inspection_action_id ||
    (v.references.job_id !== undefined && !validId(v.references.job_id)) ||
    !['complete','partial','unknown'].includes(v.usage_completeness) || v.total_cost !== null || v.reservation_status !== 'unknown' ||
    v.approval !== false || v.purchase !== false || typeof v.repair_available !== 'boolean') throw new TypeError();
  const completed = v.status === 'completed';
  if (completed ? !outcomes.includes(v.outcome) || !hash(v.report_hash) || !isRecord(v.provenance) || !isRecord(v.limits) ||
    v.limits.max_repairs !== 2 || v.limits.max_elapsed_ms !== 60000 || v.limits.max_simulated_units !== 3 ||
    ![['remaining_repairs',2],['remaining_elapsed_ms',60000]].every(([k,max])=>Number.isSafeInteger(v.limits[k])&&v.limits[k]>=0&&v.limits[k]<=max) ||
    !Number.isFinite(v.limits.remaining_simulated_units) || v.limits.remaining_simulated_units<0 || v.limits.remaining_simulated_units>3 ||
    !['first_request_ref','route_request_ref','decision_ref'].every(k=>v.provenance[k]===null||hash(v.provenance[k])) ||
    !['fixture','recorded','sandbox','live'].includes(v.evidence_mode) : v.outcome !== null || v.report_hash !== null || v.limits !== null || v.provenance !== null) throw new TypeError();
  if (v.repair_available && (!completed || v.outcome !== 'bounded_repair_recommended' || v.usage_completeness !== 'complete' ||
    v.limits.remaining_repairs<1||v.limits.remaining_elapsed_ms<1||v.limits.remaining_simulated_units<=0)) throw new TypeError();
  return Object.freeze({ status:v.status, outcome:v.outcome, message:messages[v.outcome??v.status], report_hash:v.report_hash,
    references:Object.freeze(Object.fromEntries(['source_operation_id','edit_action_id','inspection_action_id','brief_id','design_version_id','artifact_hash','job_id'].filter(k=>v.references[k]!==undefined).map(k=>[k,v.references[k]]))),
    provenance:completed?Object.freeze(Object.fromEntries(['first_request_ref','route_request_ref','decision_ref'].map(k=>[k,v.provenance[k]]))):null,
    usage_completeness:v.usage_completeness,total_cost:null,reservation_status:'unknown',repair_available:v.repair_available,
    limits:completed?Object.freeze(Object.fromEntries(['max_repairs','max_elapsed_ms','max_simulated_units','remaining_repairs','remaining_elapsed_ms','remaining_simulated_units'].map(k=>[k,v.limits[k]]))):null,
    evidence_mode:completed?v.evidence_mode:'unknown' });
 } catch { return null; }
}
export function projectRepairResult(input, expectedActionId) {
 try {
  const v=snapshotControlJson(input);
  if (!validId(expectedActionId)||!isRecord(v)||v.ok!==true||v.status!=='completed'||v.action_id!==expectedActionId||
    !validId(v.design_version_id)||!hash(v.artifact_hash)||v.approval!==false||v.purchase!==false) return null;
  return Object.freeze({action_id:v.action_id,design_version_id:v.design_version_id,artifact_hash:v.artifact_hash});
 } catch { return null; }
}
