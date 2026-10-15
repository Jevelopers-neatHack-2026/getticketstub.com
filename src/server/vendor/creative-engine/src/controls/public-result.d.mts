/** Source-local browser presentation boundary; grants no backend authority. */
export interface ArtworkReference { design_version_id: string; artifact: { content_hash: string } }
export interface SelectionReference { design_version_id: string; revision: number }
export interface ApplyPresentation {
  ok: boolean; acknowledgment_only?: true; code?: string; operation_id?: string; status?: string;
  backend_error: boolean; pending_bridge?: string; backend_job_id?: string;
  result?: { design_version: ArtworkReference };
}
export function projectApplyResult(input: unknown): ApplyPresentation;
export function projectCounters(input: unknown): { jobs: number; jev_calls: number; image_calls: number } | undefined;
export function projectHistoryList(input: unknown): { selection: SelectionReference; items: ArtworkReference[] } | undefined;
export function projectHistoryResult(input: unknown, restore: true): { ok: boolean; error: { code?: string }; result?: SelectionReference };
export function projectHistoryResult(input: unknown, restore: false): { ok: boolean; error: { code?: string }; result?: { left: string; right: string } };
