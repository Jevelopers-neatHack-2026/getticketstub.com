// A read-only guard for generation's use of the wall. A JSON array alone does not establish that
// reconciliation or the store's retention pass can read every saved history. Never repair unknown
// content here: keep its bytes, and let an explicit Apply use the open editor without persisting.
import type { Stub } from "../types";
import { WALL_STORAGE_KEY } from "../store";
import { readableGenerationHistory } from "./readable-history";

/** Validate only the history fields read by generation/reconciliation/retention, not a server contract or other project data. */
export function readGenerationStorage(stubId: string): { status: "present"; stub: Stub } | { status: "absent" | "unknown" } {
  try {
    const raw = localStorage.getItem(WALL_STORAGE_KEY);
    if (raw === null) return { status: "absent" };
    const wall: unknown = JSON.parse(raw);
    if (!Array.isArray(wall) || !wall.every(readableGenerationHistory)) return { status: "unknown" };
    const stub = (wall as Stub[]).find((value) => value.id === stubId);
    return stub ? { status: "present", stub } : { status: "absent" };
  } catch {
    return { status: "unknown" };
  }
}
