export type ControlSchemaVersion = 'creative-controls/1.0' | 'creative-controls/1.1';
export type ApplyVersion = 'creative-apply/1.0' | 'creative-apply/1.1';
export type Route = 'composition.update' | 'artwork.edit';
export const SCHEMA_VERSIONS: readonly ControlSchemaVersion[];
export const ACTION_VERSIONS: readonly ApplyVersion[];
export function isRecord(value: unknown): value is Record<string, unknown>;
export function validId(value: unknown): value is string;
export function equalVersions(a: unknown, b: unknown): boolean;
export interface TrustedPrincipal { actor_id: string; tenant_id: string; project_id: string }
export interface Versions { brief: string; design: string; composition: string }
export interface Draft { selections: Record<string, string>; answers: Record<string, string> }
export interface Control { id: string; label: string; kind: 'select'; value_type: 'string'; field: string;
  route: Route; options: { value: string; label: string }[]; default_value: string; locked: boolean; asset_id?: string }
export interface ControlSchema { schema_version: ControlSchemaVersion; contract_status: 'local-consumer-proposal';
  tenant_id: string; project_id: string; brief_id: string; expected_versions: Versions; controls: Control[];
  follow_up_questions: { id: string; label: string; field: string; route: Route; locked: boolean; when: { control_id: string; value: string }; required: boolean;
    options: { value: string; label: string }[]; default_value: string }[];
  submit_intent: 'apply'; approval: false; purchase: false }
export interface ApplyPayload { action_version: ApplyVersion; schema_version: ControlSchemaVersion; action_id: string;
  control_schema_hash: string;
  tenant_id: string; project_id: string; brief_id: string; expected_versions: Versions; intent: 'apply';
  draft: Draft; draft_hash: string; correlation_id?: string }
export interface TrustedControlState { tenant_id: string; project_id: string; brief_id: string; versions: Versions;
  available_operations: Route[]; values: Record<string, string>; allowed_options: Record<string, string[]>;
  locks?: string[]; logo_asset_id?: string; follow_up_answers: Record<string, string>; follow_up_locks?: string[] }
export interface CurrentProjection { schema: ControlSchema; can_apply: boolean; supported_schema_versions: readonly ControlSchemaVersion[];
  permitted_asset_ids: string[]; dispatchable_routes: Route[]; can_acknowledge?: boolean; can_read?: boolean }
export interface ControlOperation { operation_version: 'creative-control-operation/1.0'; kind: 'creative.control.apply';
  logical_operation_id: string; action_id: string; tenant_id: string; project_id: string; actor_id: string; brief_id: string;
  expected_versions: Versions; draft_hash: string; control_schema_hash: string; tasks: { kind: Route; changes: { field: string; value: string; asset_id?: string }[];
    follow_up_answers?: Record<string, string>; follow_up_state?: Record<string, string>; image_calls?: 0; jev_calls?: 0 }[]; approval: false; purchase: false }
export type RejectionCode = 'validation' | 'unsupported_version' | 'unknown_field' | 'invalid_intent' | 'permission' | 'draft_mismatch'
  | 'stale_version' | 'stale_schema' | 'already_completed' | 'action_conflict' | 'unknown_control' | 'invalid_value' | 'locked' | 'asset_permission'
  | 'unknown_question' | 'follow_up_required' | 'no_changes' | 'conflict' | 'cancelled' | 'unavailable';
export type ApplyResult = { ok: boolean; code: RejectionCode | 'accepted' | 'replayed' | 'ready' | 'completed'; retryable?: boolean;
  operation_id?: string; status?: 'queued' | 'ready' | 'cancelled' | 'completed'; replayed?: boolean; operation?: ControlOperation;
  current_versions?: Versions; audit_ref?: string; audit_status?: 'unavailable' };
export function canonical(value: unknown): string | undefined;
export function hash(value: unknown): string;
export function createControlSchema(state: TrustedControlState, version?: ControlSchemaVersion): ControlSchema;
export function defaultDraft(schema: ControlSchema): Draft;
export function activeQuestions(schema: ControlSchema, draft: Draft): ControlSchema['follow_up_questions'];
export function assertRenderableSchema(schema: unknown): ControlSchema;
export interface ControlContractReference { contract: 'DesignControlSchema'; schema_version: '1.0';
  tenant_id: string; project_id: string; control_contract: 'creative-controls'; control_schema_version: '1.0' | '1.1';
  expected_versions: Versions; control_schema_hash: string }
export function controlContractReference(schema: ControlSchema): ControlContractReference;
export function assertControlContractBinding(envelope: unknown, schema: ControlSchema): ControlSchema;
export class ApplyStore {
  constructor(path: string, getState: (principal: TrustedPrincipal) => CurrentProjection);
  apply(principal: TrustedPrincipal, untrustedBody: unknown): ApplyResult;
  dispatch(principal: TrustedPrincipal, operationId: string): ApplyResult;
  cancel(principal: TrustedPrincipal, operationId: string): ApplyResult;
  acknowledge(trustedConsumer: TrustedPrincipal, operationId: string, receipt: { completion_id: string; result_ref: string; applied_versions: Versions }): ApplyResult;
  counts(): { jobs: number; image_calls: 0; jev_calls: 0 };
  close(): void;
}
/** Bounded plain-data snapshot. Rejects getters, custom prototypes and methods. */
export function snapshotControlJson(value: unknown): unknown;
export interface CurrentCreativeControlContext {
  brief: import('../contracts/creative/v1.mjs').CreativeBrief;
  design: import('../contracts/creative/v1.mjs').DesignVersion;
  selection: import('../api/v1.mjs').DesignSelection;
  brief_usable: boolean;
  composition: { status: 'unavailable'; bridge: 'creative.composition.consume/1' };
  policy: { can_apply: boolean; can_read?: boolean; available_operations: Route[]; permitted_asset_ids: string[]; logo_asset_id?: string;
    allowed_options?: Record<string, string[]> };
  actor: import('../api/v1.mjs').TrustedCreativeActor;
}
export interface IntegratedApplyResult {
  ok: boolean; code: string; operation_id?: string; status?: string; replayed?: boolean;
  backend_job_id?: string; backend_operation_id?: string; action_id?: string; request_hash?: string;
  result?: import('../api/v1.mjs').CreativeApiResult; pending_bridge?: string;
  approval?: false; purchase?: false;
}
export class CreativeControlsAdapter {
  constructor(options: { path: string; ports: import('../api/v1.mjs').CreativeRuntimePorts & { jobs: NonNullable<import('../api/v1.mjs').CreativeRuntimePorts['jobs']>; storage: NonNullable<import('../api/v1.mjs').CreativeRuntimePorts['storage']> };
    readContext: (principal: TrustedPrincipal) => CurrentCreativeControlContext; now?: () => number });
  readonly store: ApplyStore;
  projection(principal: TrustedPrincipal): CurrentProjection;
  apply(principal: TrustedPrincipal, body: unknown): Promise<IntegratedApplyResult>;
  cancel(principal: TrustedPrincipal, operationId: string): Promise<IntegratedApplyResult>;
  lookup(principal: TrustedPrincipal, actionId: string): { operation_id: string; status: string } | null;
  close(): void;
}
export * from './inspection-consumer.mjs';
export * from './inspection-integration.mjs';
export * from './inspection-view.mjs';
