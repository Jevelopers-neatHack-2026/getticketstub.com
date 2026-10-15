import type { CreativeRuntimePorts } from '../api/v1.mjs';
import type { CreativeControlsAdapter, TrustedPrincipal } from './index.mjs';
export interface ActualInspectionView {
 readonly ok: true; readonly schema_version: 'controls-actual-inspection/1.0';
 readonly status: 'pending'|'unknown'|'unavailable'|'failed'|'cancelled'|'completed';
 readonly references: Readonly<{source_operation_id:string;edit_action_id:string;inspection_action_id:string;brief_id:string;design_version_id:string;artifact_hash:string;job_id?:string}>;
 readonly outcome: 'acceptable_for_review'|'bounded_repair_recommended'|'needs_human_review'|'refusal'|'failure'|null;
 readonly report_hash:string|null; readonly message:string; readonly evidence_mode:'fixture'|'recorded'|'sandbox'|'live'|'unknown';
 readonly provenance:Readonly<{first_request_ref:string|null;route_request_ref:string|null;decision_ref:string|null}>|null;
 readonly usage_completeness:'complete'|'partial'|'unknown'; readonly total_cost:null; readonly reservation_status:'unknown';
 readonly limits:Readonly<{max_repairs:2;max_elapsed_ms:60000;max_simulated_units:3;remaining_repairs:number;remaining_elapsed_ms:number;remaining_simulated_units:number;usage_completeness:'complete'|'partial'|'unknown'}>|null;
 readonly repair_available:boolean;readonly approval:false;readonly purchase:false;
}
export interface InspectionConsumerFailure {readonly ok:false;readonly code:string;readonly status:'unknown'}
export interface InspectionRepairCompletion {readonly ok:true;readonly status:'completed';readonly code:'completed';readonly action_id:string;readonly design_version_id:string;readonly artifact_hash:string;readonly replayed:boolean;readonly approval:false;readonly purchase:false}
export interface ActualInspectionSource {readonly source_operation_id:string;readonly design_version_id:string;readonly artifact_hash:string}
/** Stable request bookkeeping only; report/stages/limits and recovery remain public API authority. */
export declare class InspectionControlsAdapter {
 constructor(input:{controls:CreativeControlsAdapter;ports:CreativeRuntimePorts & {jobs:NonNullable<CreativeRuntimePorts['jobs']>;storage:NonNullable<CreativeRuntimePorts['storage']>};now?:()=>number});
 start(principal:TrustedPrincipal,input:unknown):Promise<ActualInspectionView|InspectionConsumerFailure>;
 lookup(principal:TrustedPrincipal,inspectionActionId:string):Promise<ActualInspectionView|InspectionConsumerFailure>;
 latest(principal:TrustedPrincipal):Promise<ActualInspectionView|InspectionConsumerFailure|null>;
 currentSource(principal:TrustedPrincipal):Promise<Readonly<ActualInspectionSource>|null>;
 latestRepair(principal:TrustedPrincipal):Promise<InspectionRepairCompletion|Readonly<{ok:false;code:"pending";status:"pending";action_id:string;inspection_action_id:string}>|null>;
 cancel(principal:TrustedPrincipal,inspectionActionId:string):Promise<ActualInspectionView|InspectionConsumerFailure>;
 repair(principal:TrustedPrincipal,input:{inspection_action_id:string;repair_action_id:string;repair_action:'image.edit'}):Promise<InspectionRepairCompletion|InspectionConsumerFailure>;
}
