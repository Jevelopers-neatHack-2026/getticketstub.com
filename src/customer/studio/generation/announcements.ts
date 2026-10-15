import type { GenerationController, GenerationOp } from "./operations";

export interface GenerationAnnouncementEffects {
  applied?(op: GenerationOp): void;
  failed?(op: GenerationOp): void;
}

/** Announce each generation transition once through the page's single polite live region. */
export function subscribeGenerationAnnouncements(
  generation: Pick<GenerationController, "all" | "subscribe">,
  announce: (message: string) => void,
  effects: GenerationAnnouncementEffects = {},
): () => void {
  const said = new Map<string, string>();
  return generation.subscribe(() => {
    for (const op of generation.all()) {
      if (said.get(op.runId) === op.phase) continue;
      const first = !said.has(op.runId);
      said.set(op.runId, op.phase);
      if (first && op.phase !== "pending" && op.phase !== "interrupted") continue; // adopted terminal status: already read
      announce(op.phase === "pending" ? (op.via === "photo" ? "Adding your photo." : "Generating new art.") : op.message);
      if (op.via !== "agent" && op.phase === "applied") effects.applied?.(op);
      else if (op.phase === "failed" && op.via !== "agent") effects.failed?.(op);
    }
  });
}
