const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const optionalString = (value: unknown): boolean => value === undefined || typeof value === "string";

/**
 * Validate the generation history fields that reconciliation and wall retention consume.
 * A malformed peer makes a whole-wall read unknown; it must never authorize a removal decision.
 */
export function readableGenerationHistory(value: unknown): boolean {
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
