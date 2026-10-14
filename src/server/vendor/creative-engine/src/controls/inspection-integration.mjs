/** Controls bookkeeping over the public API. All inspection/repair authority,
 * stages, attempts and root limits belong to the shared creative store. */
import { createCreativeApi } from 'creative-engine/api/v1';
import { canonicalHash } from 'creative-engine/contracts';
import { snapshotControlJson, isRecord, validId, canonical } from './schema.mjs';
import { projectActualInspection } from './inspection-result.mjs';

const exact = (x, keys) => isRecord(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const rejected = code => ({ ok: false, code, status: 'unknown' });
export class InspectionControlsAdapter {
  constructor({ controls, ports, now = () => Date.now() }) {
    this.controls = controls; this.ports = ports; this.now = now; this.inflight = new Map();
    this.db = controls.db;
    // This table is only a stable UI request/selection binding, never a report,
    // observer stage, financial hold or independent repair counter.
    this.db.exec(`CREATE TABLE IF NOT EXISTS control_inspection_requests_v1 (
      tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      action_id TEXT NOT NULL, source_operation_id TEXT NOT NULL, kind TEXT NOT NULL,
      request_json TEXT NOT NULL, request_hash TEXT NOT NULL, binding_json TEXT NOT NULL,
      job_id TEXT, PRIMARY KEY(tenant_id,project_id,action_id));`);
    this.api = createCreativeApi({ now, ports: { ...ports, jobs: { ...ports.jobs,
      begin: async input => {
        if (this.db.isTransaction) throw new TypeError('Controls transaction unavailable');
        const result = await ports.jobs.begin(input);
        if (this.db.isTransaction) throw new TypeError('Controls transaction unavailable');
        if (result.kind !== 'conflict') this.db.prepare(`UPDATE control_inspection_requests_v1 SET job_id=?
          WHERE tenant_id=? AND project_id=? AND actor_id=? AND action_id=?`)
          .run(result.kind === 'started' ? result.job_id : result.job.job_id,
            input.scope.tenant_id, input.scope.project_id, input.actor_id, input.action_id);
        return result;
      },
    } } });
  }
  context(principal) {
    const context = this.controls.context(principal);
    if (!this.controls.projection(principal).can_read) throw new TypeError('Read authority unavailable');
    return context;
  }
  row(principal, actionId) {
    if (this.db.isTransaction || !validId(actionId)) throw new TypeError('Inspection unavailable');
    this.context(principal);
    return this.db.prepare(`SELECT * FROM control_inspection_requests_v1
      WHERE tenant_id=? AND project_id=? AND actor_id=? AND action_id=?`)
      .get(principal.tenant_id, principal.project_id, principal.actor_id, actionId);
  }
  requestEnvelope(context, actionId) {
    const brief = context.brief, timestamp = new Date(this.now()).toISOString();
    return { contract: 'CreativeApiRequest', schema_version: '1.0', tenant_id: brief.tenant_id, project_id: brief.project_id,
      event_id: `event:${actionId}`, request_id: `request:${actionId}`, correlation_id: actionId,
      producer: 'creative-controls-inspection/1', occurred_at: timestamp, ingested_at: timestamp,
      environment: brief.environment, billing_mode: brief.billing_mode, source_refs: [] };
  }
  async saved(principal, sourceId) {
    this.context(principal);
    const apply = this.db.prepare(`SELECT b.result_json,b.action_id,b.job_id,b.backend_request_hash FROM control_api_bindings_v1 b
      JOIN control_jobs c ON c.operation_id=b.operation_id JOIN control_completions cc ON cc.operation_id=c.operation_id
      WHERE c.operation_id=? AND c.tenant_id=? AND c.project_id=? AND c.actor_id=?`)
      .get(sourceId, principal.tenant_id, principal.project_id, principal.actor_id);
    let design;
    if (apply) {
      design = JSON.parse(apply.result_json)?.result?.design_version;
      const job=await this.ports.jobs.get({scope:principal,job_id:apply.job_id});this.context(principal);
      if(!design || job?.status!=='completed' || job.action_id!==apply.action_id || job.request_hash!==apply.backend_request_hash || canonicalHash(job.result?.design)!==canonicalHash(design))throw new TypeError('Saved completion mismatch');
    }
    else {
      const repair = this.row(principal, sourceId);
      if (!repair || repair.kind !== 'repair') throw new TypeError('Saved operation unavailable');
      const request=JSON.parse(repair.request_json);
      if(canonicalHash(request)!==repair.request_hash || request.action_id!==repair.action_id || !repair.job_id)throw new TypeError('Saved repair unavailable');
      const job=await this.ports.jobs.get({scope:principal,job_id:repair.job_id});this.context(principal);
      if(job?.status!=='completed' || job.action_id!==repair.action_id || job.operation!=='edit')throw new TypeError('Saved repair unavailable');
      design=job.result?.design;
      if(design?.logical_operation_id!==repair.action_id || design.parent_version_id!==JSON.parse(repair.binding_json).design_version_id)throw new TypeError('Saved repair mismatch');
    }
    if (!design) throw new TypeError('Saved design unavailable');
    const stored = await this.ports.storage.getDesignVersion({ scope: principal, brief_id: design.brief_id, design_version_id: design.design_version_id });
    this.context(principal);
    if (canonicalHash(stored) !== canonicalHash(design) || (apply && design.logical_operation_id !== apply.action_id)) throw new TypeError('Saved design mismatch');
    return design;
  }
  persist(principal, sourceId, kind, request, design) {
    if (this.db.isTransaction) throw new TypeError('Controls transaction unavailable');
    const binding = { source_operation_id: sourceId, edit_action_id: design.logical_operation_id,
      inspection_action_id: kind === 'inspect' ? request.action_id : request.payload.inspection_repair.inspection_action_id,
      brief_id: design.brief_id, brief_hash: design.brief_hash, design_version_id: design.design_version_id,
      design_hash: design.design_hash, artifact_hash: design.artifact.content_hash, tenant_id: principal.tenant_id, project_id: principal.project_id };
    this.db.prepare(`INSERT OR IGNORE INTO control_inspection_requests_v1
      (tenant_id,project_id,actor_id,action_id,source_operation_id,kind,request_json,request_hash,binding_json)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(principal.tenant_id, principal.project_id, principal.actor_id, request.action_id,
        sourceId, kind, canonical(request), canonicalHash(request), canonical(binding));
    return this.row(principal, request.action_id);
  }
  async start(principal, input) {
    try {
      principal = snapshotControlJson(principal); input = snapshotControlJson(input);
      if (!exact(input, ['source_operation_id', 'inspection_action_id']) || !Object.values(input).every(validId)) return rejected('validation');
      let row = this.row(principal, input.inspection_action_id);
      if (!row) {
        const design = await this.saved(principal, input.source_operation_id), context = this.context(principal);
        if (context.design.design_version_id !== design.design_version_id || canonicalHash(context.brief) !== design.brief_hash ||
          design.logical_operation_id === input.inspection_action_id) return rejected('stale_version');
        const request = { ...this.requestEnvelope(context, input.inspection_action_id), operation: 'inspect', action_id: input.inspection_action_id,
          payload: { brief_id: design.brief_id, design_version_id: design.design_version_id } };
        row = this.persist(principal, input.source_operation_id, 'inspect', request, design);
      }
      if (row.source_operation_id !== input.source_operation_id || row.kind !== 'inspect') return rejected('conflict');
      return await this.execute(principal, row);
    } catch { return rejected('unavailable'); }
  }
  async execute(principal, row) {
    const key = `${row.tenant_id}/${row.project_id}/${row.action_id}`;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const work = this.invoke(principal, row); this.inflight.set(key, work);
    try { return await work; } finally { this.inflight.delete(key); }
  }
  async invoke(principal, row) {
    const request = snapshotControlJson(JSON.parse(row.request_json));
    if (canonicalHash(request) !== row.request_hash || request.action_id !== row.action_id ||
      request.tenant_id !== principal.tenant_id || request.project_id !== principal.project_id) throw new TypeError('Request mismatch');
    const response = await this.api.invoke(this.context(principal).actor, request);
    this.context(principal); // Current read authorization also applies after awaits.
    const current = this.row(principal, row.action_id), binding = JSON.parse(row.binding_json);
    if (row.kind === 'repair') {
      // An edit completion is checked against the exact public durable job and bytes.
      const job = current.job_id && await this.ports.jobs.get({ scope: principal, job_id: current.job_id });
      this.context(principal);
      const design = response.result?.design_version;
      if (response.ok && response.job?.status === 'completed' && design && job?.status === 'completed' &&
        job.action_id === row.action_id && design.logical_operation_id === row.action_id && design.parent_version_id === binding.design_version_id &&
        canonicalHash(job.result?.design) === canonicalHash(design)) {
        const stored = await this.ports.storage.getDesignVersion({ scope: principal, brief_id: design.brief_id, design_version_id: design.design_version_id });
        this.context(principal);
        if (canonicalHash(stored) === canonicalHash(design)) return { ok: true, status: 'completed', code: 'completed', action_id: row.action_id,
          design_version_id: design.design_version_id, artifact_hash: design.artifact.content_hash, replayed: response.replayed === true, approval: false, purchase: false };
      }
      return { ...rejected(response.error?.code === 'review_required' ? 'review_required' : 'unavailable'), action_id: row.action_id };
    }
    let publicResponse = response;
    if (!response.ok && current.job_id) {
      const status = await this.api.invoke(this.context(principal).actor, { ...this.requestEnvelope(this.context(principal), `status:${row.action_id}`), operation: 'job.status', payload: { job_id: current.job_id } });
      this.context(principal);
      if (status.ok && ['failed', 'cancelled'].includes(status.job?.status)) publicResponse = status;
    }
    return projectActualInspection({ response: publicResponse, binding, job_id: current.job_id });
  }
  async lookup(principal, actionId) {
    try {
      principal = snapshotControlJson(principal);
      const row = this.row(principal, actionId);
      if (!row || row.kind !== 'inspect') return rejected('not_found');
      if (!row.job_id) return projectActualInspection({ binding: JSON.parse(row.binding_json) });
      const status = await this.api.invoke(this.context(principal).actor, {
        ...this.requestEnvelope(this.context(principal), `status:${actionId}`), operation: 'job.status', payload: { job_id: row.job_id } });
      this.context(principal);
      if (status.ok && status.job?.status === 'completed') return await this.invoke(principal, row);
      return projectActualInspection({ response: status, binding: JSON.parse(row.binding_json), job_id: row.job_id });
    } catch { return rejected('unavailable'); }
  }
  async latest(principal) {
    try {
      principal = snapshotControlJson(principal); this.context(principal);
      const row = this.db.prepare(`SELECT action_id FROM control_inspection_requests_v1 WHERE tenant_id=? AND project_id=? AND actor_id=? AND kind='inspect' ORDER BY rowid DESC LIMIT 1`)
        .get(principal.tenant_id, principal.project_id, principal.actor_id);
      return row ? this.lookup(principal, row.action_id) : null;
    } catch { return rejected('unavailable'); }
  }
  async currentSource(principal) {
    try {
      principal = snapshotControlJson(principal);
      if (this.db.isTransaction) return null;
      const current = this.context(principal).design;
      const apply = this.db.prepare(`SELECT b.operation_id FROM control_api_bindings_v1 b
        JOIN control_jobs c ON c.operation_id=b.operation_id JOIN control_completions cc ON cc.operation_id=c.operation_id
        WHERE c.tenant_id=? AND c.project_id=? AND c.actor_id=? AND b.design_hash=? ORDER BY b.rowid DESC LIMIT 1`)
        .get(principal.tenant_id, principal.project_id, principal.actor_id, current.design_hash);
      const repair = !apply && this.row(principal, current.logical_operation_id);
      const sourceId = apply?.operation_id ?? (repair?.kind === 'repair' ? repair.action_id : null);
      if (!sourceId) return null;
      // Source recovery only reads durable jobs and immutable versions. It must
      // never invoke Apply/repair to reconstruct a missing or pending result.
      const design = await this.saved(principal, sourceId), context = this.context(principal);
      if (context.design.design_version_id !== design.design_version_id || context.design.design_hash !== design.design_hash ||
        context.design.artifact.content_hash !== design.artifact.content_hash || canonicalHash(context.brief) !== design.brief_hash) return null;
      return Object.freeze({ source_operation_id: sourceId, design_version_id: design.design_version_id, artifact_hash: design.artifact.content_hash });
    } catch { return null; }
  }
  async latestRepair(principal) {
    try {
      principal=snapshotControlJson(principal);this.context(principal);
      const row=this.db.prepare(`SELECT action_id,job_id,binding_json FROM control_inspection_requests_v1 WHERE tenant_id=? AND project_id=? AND actor_id=? AND kind='repair' ORDER BY rowid DESC LIMIT 1`).get(principal.tenant_id,principal.project_id,principal.actor_id);
      if(!row)return null;
      const job=row.job_id?await this.ports.jobs.get({scope:principal,job_id:row.job_id}):null;this.context(principal);
      if(!job || ['queued','running'].includes(job.status))return {ok:false,code:'pending',status:'pending',action_id:row.action_id,inspection_action_id:JSON.parse(row.binding_json).inspection_action_id};
      if(job.status!=='completed')return null;
      const design=await this.saved(principal,row.action_id),context=this.context(principal);
      if(context.design.design_version_id!==design.design_version_id)return null;
      return {ok:true,code:'completed',status:'completed',action_id:row.action_id,design_version_id:design.design_version_id,artifact_hash:design.artifact.content_hash,replayed:true,approval:false,purchase:false};
    }catch{return null;}
  }
  async cancel(principal, actionId) {
    try {
      principal = snapshotControlJson(principal); const row = this.row(principal, actionId);
      if (!row?.job_id) return rejected('unavailable');
      await this.api.invoke(this.context(principal).actor, { ...this.requestEnvelope(this.context(principal), `cancel:${actionId}`),
        operation: 'cancel', action_id: `cancel:${actionId}`, payload: { job_id: row.job_id } });
      return await this.lookup(principal, actionId);
    } catch { return rejected('unavailable'); }
  }
  async repair(principal, input) {
    try {
      principal = snapshotControlJson(principal); input = snapshotControlJson(input);
      if (!exact(input, ['inspection_action_id', 'repair_action_id', 'repair_action']) || input.repair_action !== 'image.edit' || ![input.inspection_action_id, input.repair_action_id].every(validId) ||
        input.inspection_action_id === input.repair_action_id) return rejected('validation');
      let row = this.row(principal, input.repair_action_id);
      if (row) {
        if (row.kind !== 'repair' || JSON.parse(row.binding_json).inspection_action_id !== input.inspection_action_id) return rejected('conflict');
        return await this.execute(principal, row);
      }
      const source = this.row(principal, input.inspection_action_id);
      if (!source || source.kind !== 'inspect') return rejected('not_found');
      const view = await this.lookup(principal, input.inspection_action_id);
      if (!view?.repair_available) return rejected('review_required');
      const context = this.context(principal), design = await this.saved(principal, source.source_operation_id);
      if (context.design.design_version_id !== design.design_version_id) return rejected('stale_version');
      const envelope = this.requestEnvelope(context, input.repair_action_id);
      // The explicit image.edit repair preserves existing style/facts/locks. It
      // does not select a fallback preference or reinterpret a dropdown change.
      const request = { ...envelope, operation: 'edit', action_id: input.repair_action_id,
        payload: { brief_id: design.brief_id, design_version_id: design.design_version_id, selection_mode: 'advance',
          plan: { ...envelope, contract: 'EditPlan', plan_id: `plan:${input.repair_action_id}`,
            base: { brief_hash: design.brief_hash, design_hash: design.design_hash, design_version_id: design.design_version_id },
            operation: 'image.edit', steps: [{ step_id: `step:${input.repair_action_id}`, action: 'image.edit', source_refs: [],
              parameters: { design_version_id: design.design_version_id, artifact_id: design.artifact.artifact_id,
                instruction: 'Repair the defect in the bound inspection report. Preserve existing style preferences, verified facts, approved assets and locked fields.' } }],
            expected_result: { contract: 'DesignVersion', schema_version: '1.0', parent_version_id: design.design_version_id, artifact_kind: 'image' }, invalidates: [] } } };
      delete request.payload.plan.request_id;
      delete request.payload.plan.event_id;
      request.payload.plan.event_id = `event:plan:${input.repair_action_id}`;
      request.payload.inspection_repair = { contract: 'CreativeInspectionRepairRequest', schema_version: '1.0',
        inspection_action_id: input.inspection_action_id, report_hash: view.report_hash, repair_action: 'image.edit' };
      row = this.persist(principal, source.source_operation_id, 'repair', request, design);
      // Another caller may have bound this action while lookup/saved awaited.
      // Recheck the durable winner before joining or executing its work.
      if (row.kind !== 'repair' || JSON.parse(row.binding_json).inspection_action_id !== input.inspection_action_id) return rejected('conflict');
      return await this.execute(principal, row);
    } catch { return rejected('unavailable'); }
  }
}
