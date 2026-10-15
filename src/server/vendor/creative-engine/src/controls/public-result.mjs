/** Browser consumer projections. These validate presentation, never authority. */
import { snapshotControlJson, isRecord, validId } from './schema.mjs';

const hash = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const failureCodes = new Set(['validation', 'unsupported_version', 'unknown_field', 'invalid_intent', 'permission', 'draft_mismatch',
  'stale_version', 'stale_schema', 'already_completed', 'action_conflict', 'unknown_control', 'invalid_value', 'locked', 'asset_permission',
  'unknown_question', 'follow_up_required', 'no_changes', 'conflict', 'cancelled', 'unavailable', 'invalid_request', 'unauthorized',
  'permission_denied', 'scope_denied', 'not_found', 'review_required', 'budget_unavailable', 'failed']);
const only = (value, keys) => isRecord(value) && Object.keys(value).every(key => keys.includes(key));
// Validate the existing local typed handoff before calling it ready. This is
// presentation validation; the server still enforces scope/rights/dispatch.
function typedHandoff(value, operationId) {
  if (!only(value, ['operation_version', 'kind', 'logical_operation_id', 'action_id', 'tenant_id', 'project_id', 'actor_id', 'brief_id',
    'expected_versions', 'draft_hash', 'control_schema_hash', 'tasks', 'approval', 'purchase']) ||
    value.operation_version !== 'creative-control-operation/1.0' || value.kind !== 'creative.control.apply' ||
    value.logical_operation_id !== operationId || !['action_id', 'tenant_id', 'project_id', 'actor_id', 'brief_id'].every(key => validId(value[key])) ||
    !only(value.expected_versions, ['brief', 'design', 'composition']) || Object.keys(value.expected_versions).length !== 3 ||
    !Object.values(value.expected_versions).every(validId) || typeof value.draft_hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.draft_hash) ||
    !hash(value.control_schema_hash) || value.approval !== false || value.purchase !== false || !Array.isArray(value.tasks) ||
    value.tasks.length < 1 || value.tasks.length > 2) return false;
  const choices = { name_size: ['small', 'medium', 'large'], layout: ['centered', 'stacked'], logo_position: ['top', 'bottom'],
    style: ['calm', 'vibrant'], layout_emphasis: ['balanced', 'name'] }, seen = new Set();
  for (const task of value.tasks) {
    if (!isRecord(task)) return false;
    const composition = task.kind === 'composition.update';
    if (!only(task, composition ? ['kind', 'changes', 'follow_up_answers', 'follow_up_state', 'image_calls', 'jev_calls'] : ['kind', 'changes']) ||
      !['composition.update', 'artwork.edit'].includes(task.kind) || seen.has(task.kind) || !Array.isArray(task.changes) ||
      task.changes.length < 1 || task.changes.length > 5) return false;
    seen.add(task.kind); const fields = new Set();
    for (const change of task.changes) {
      if (!only(change, ['field', 'value', 'asset_id']) || typeof change.field !== 'string' || !Object.hasOwn(choices, change.field) || !choices[change.field].includes(change.value) ||
        composition === (change.field === 'style') || fields.has(change.field) ||
        (change.field === 'logo_position' ? !validId(change.asset_id) : Object.hasOwn(change, 'asset_id'))) return false;
      fields.add(change.field);
    }
    if (composition && (task.image_calls !== 0 || task.jev_calls !== 0 ||
      ![task.follow_up_answers, task.follow_up_state].every(answers => only(answers, ['q01']) && Object.values(answers).every(v => ['balanced', 'name'].includes(v))))) return false;
  }
  return true;
}
function snapshot(value) {
  try { const data = snapshotControlJson(value); return isRecord(data) ? data : {}; }
  catch { return {}; }
}
function selection(value) {
  return isRecord(value) && validId(value.design_version_id) && Number.isSafeInteger(value.revision) && value.revision > 0 ?
    { design_version_id: value.design_version_id, revision: value.revision } : undefined;
}
function artwork(value) {
  return isRecord(value) && validId(value.design_version_id) && isRecord(value.artifact) && hash(value.artifact.content_hash) ?
    { design_version_id: value.design_version_id, artifact: { content_hash: value.artifact.content_hash } } : undefined;
}
export function projectCounters(input) {
  const data = snapshot(input), counts = data.counters;
  if (!isRecord(counts) || !['jobs', 'jev_calls', 'image_calls'].every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0)) return undefined;
  return { jobs: counts.jobs, jev_calls: counts.jev_calls, image_calls: counts.image_calls };
}
export function projectApplyResult(input) {
  const data = snapshot(input), operation = validId(data.operation_id) ? data.operation_id : undefined;
  const invalidReference = Object.hasOwn(data, 'operation_id') && !operation;
  const design = artwork(data.result?.design_version);
  const hasResult = Object.hasOwn(data, 'result'), hasStatus = Object.hasOwn(data, 'status'), hasOperation = Object.hasOwn(data, 'operation');
  const backendError = data.backend_error !== undefined && data.backend_error !== null && data.backend_error !== false;
  const replayFlag = !Object.hasOwn(data, 'replayed') || typeof data.replayed === 'boolean';
  let supported = false;
  if (!invalidReference && replayFlag && data.ok === true && operation && !backendError && !Object.hasOwn(data, 'pending_bridge')) {
    if (data.code === 'accepted') supported = data.status === 'queued' && data.replayed !== true && !hasResult && !Object.hasOwn(data, 'operation');
    if (data.code === 'ready') supported = data.status === 'ready' && data.replayed !== true && !hasResult && typedHandoff(data.operation, operation);
    if (data.code === 'completed') supported = data.status === 'completed' && Boolean(design) && validId(data.backend_job_id) && !Object.hasOwn(data, 'operation');
    if (data.code === 'cancelled') supported = data.status === 'cancelled' && !hasResult && !Object.hasOwn(data, 'operation');
    if (data.code === 'replayed' && data.replayed === true) supported =
      data.status === 'queued' && !hasResult && !Object.hasOwn(data, 'operation') ||
      data.status === 'ready' && !hasResult && (!hasOperation || typedHandoff(data.operation, operation)) ||
      data.status === 'completed' && Boolean(design) && validId(data.backend_job_id) && !Object.hasOwn(data, 'operation');
  } else if (!invalidReference && replayFlag && data.ok === false && failureCodes.has(data.code) && !hasResult && !Object.hasOwn(data, 'operation')) {
    supported = !hasStatus || Boolean(operation) && (
      data.code === 'unavailable' && data.status === 'unknown' ||
      data.code === 'failed' && ['failed', 'unknown'].includes(data.status) ||
      data.code === 'cancelled' && data.status === 'cancelled');
  }
  // A safe ID alone cannot make contradictory status or missing success
  // evidence trustworthy. Omit all state on malformed outcomes so a consumer
  // retains its previous safe identity AND lifecycle, with fixed uncertainty.
  if (!supported) return { ok: false, backend_error: false };
  return {
    ok: data.ok, code: data.code, operation_id: operation,
    // Apply replay acknowledges stored ready state without releasing a fresh
    // typed handoff. An explicitly supplied operation must still validate.
    ...(data.code === 'replayed' && data.status === 'ready' && !hasOperation ? { acknowledgment_only: true } : {}),
    status: operation ? data.status : undefined,
    backend_error: backendError,
    pending_bridge: ['creative.composition.consume/1', 'creative.compound.consume/1'].includes(data.pending_bridge) ? data.pending_bridge : undefined,
    ...(design && validId(data.backend_job_id) ? { backend_job_id: data.backend_job_id, result: { design_version: design } } : {}),
  };
}
export function projectHistoryList(input) {
  const data = snapshot(input), selected = selection(data.selection), items = data.result?.items;
  if (data.ok !== true || !selected || !Array.isArray(items) || items.length > 200) return undefined;
  const projected = items.map(artwork);
  return projected.every(Boolean) ? { selection: selected, items: projected } : undefined;
}
export function projectHistoryResult(input, restore) {
  const data = snapshot(input);
  const result = restore ? selection(data.result?.selection) :
    hash(data.result?.left?.artifact?.content_hash) && hash(data.result?.right?.artifact?.content_hash) ?
      { left: data.result.left.artifact.content_hash, right: data.result.right.artifact.content_hash } : undefined;
  return { ok: data.ok === true && Boolean(result), error: { code: typeof data.error?.code === 'string' ? data.error.code : undefined }, result };
}
