import type {ActualInspectionView,ActualInspectionSource} from './inspection-integration.mjs';
export declare function projectInspectionSource(input:unknown):Readonly<ActualInspectionSource>|null;
export declare function projectInspectionView(input:unknown):Readonly<Omit<ActualInspectionView,'ok'|'schema_version'|'approval'|'purchase'|'limits'> & {limits:Readonly<Omit<NonNullable<ActualInspectionView['limits']>,'usage_completeness'>>|null}>|null;
export declare function projectRepairResult(input:unknown,expectedActionId:string):Readonly<{action_id:string;design_version_id:string;artifact_hash:string}>|null;
