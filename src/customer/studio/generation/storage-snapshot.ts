// A read-only guard for generation's use of the wall. A JSON array alone does not establish that
// reconciliation or the store's retention pass can read every saved history. Never repair unknown
// content here: keep its bytes, and let an explicit Apply use the open editor without persisting.
import type { Stub } from "../types";
import { WALL_STORAGE_KEY } from "../store";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const optionalString = (value: unknown): boolean => value === undefined || typeof value === "string";

function readableHistory(value: unknown): boolean {
  if (!record(value) || typeof value.id !== "string" || !value.id || typeof value.currentVersionId !== "string"
    || !Array.isArray(value.versions) || value.versions.length === 0) return false;
  return value.versions.every((version) => {
    if (!record(version) || typeof version.id !== "string" || !version.id || !optionalString(version.parentId)
      || typeof version.edition !== "string" || typeof version.createdAt !== "string" || !record(version.art)) return false;
    const art = version.art;
    return typeof art.seed === "number" && Number.isFinite(art.seed) && typeof art.kind === "string" && typeof art.provenance === "string"
      && optionalString(art.src) && optionalString(art.vibe) && (art.unavailable === undefined || typeof art.unavailable === "boolean");
  });
}

/** Validate only the history fields read by generation/reconciliation/retention, not a server contract or other project data. */
export function readGenerationStorage(stubId: string): { status: "present"; stub: Stub } | { status: "absent" | "unknown" } {
  try {
    const raw = localStorage.getItem(WALL_STORAGE_KEY);
    if (raw === null) return { status: "absent" };
    const wall: unknown = JSON.parse(raw);
    if (!Array.isArray(wall) || !wall.every(readableHistory)) return { status: "unknown" };
    const stub = (wall as Stub[]).find((value) => value.id === stubId);
    return stub ? { status: "present", stub } : { status: "absent" };
  } catch {
    return { status: "unknown" };
  }
}
