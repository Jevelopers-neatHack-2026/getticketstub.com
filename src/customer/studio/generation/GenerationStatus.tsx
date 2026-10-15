"use client";
// Artwork-adjacent, persistent generation status. It reads the editor-owned controller, so it survives any panel closing,
// and says only what is known: no percentage, no ETA, no promise about the provider.
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { PaperButton } from "@/customer/desk/Desk";
import type { GenerationController } from "./operations";
import { useGenerationOp } from "./useGeneration";
import { captureFocusHandoff, type FocusHandoff } from "./focus-handoff";
import styles from "./GenerationStatus.module.css";

const SLOW_MS = 20_000;

const TITLES = {
  pending: "Generating new art…",
  ready: "New art ready",
  applied: "New art applied",
  failed: "New art not made",
  canceled: "Stopped",
  discarded: "Not applied",
  interrupted: "Art generation interrupted",
} as const;

export function GenerationStatus({ controller, stubId, onOpenRemix }: { controller: GenerationController; stubId: string; onOpenRemix: () => void }) {
  const op = useGenerationOp(controller, stubId);
  const root = useRef<HTMLElement>(null);
  const focusHandoff = useRef<FocusHandoff | null>(null);
  const [slowRun, setSlowRun] = useState<string | null>(null);
  const pendingRun = op?.phase === "pending" ? op.runId : null;
  useEffect(() => {
    if (!pendingRun) return;
    const t = window.setTimeout(() => setSlowRun(pendingRun), SLOW_MS);
    return () => window.clearTimeout(t);
  }, [pendingRun]);
  useLayoutEffect(() => {
    const intent = focusHandoff.current;
    focusHandoff.current = null;
    intent?.finish(root.current?.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? root.current);
  }, [op]);
  useEffect(() => () => focusHandoff.current?.cancel(), []);
  if (!op) return null;
  const { runId, phase } = op;
  const act = (event: MouseEvent<HTMLButtonElement>, action: () => unknown) => {
    focusHandoff.current?.cancel();
    focusHandoff.current = captureFocusHandoff(event.currentTarget);
    const before = controller.get(stubId);
    try { action(); }
    finally {
      if (controller.get(stubId) === before) {
        focusHandoff.current?.cancel();
        focusHandoff.current = null;
      }
    }
  };
  const retry = () => {
    if (controller.canRetry(runId)) void controller.retry(runId)?.catch(() => undefined);
    else onOpenRemix();
  };
  return (
    <section ref={root} tabIndex={-1} className={styles.status} data-phase={phase} data-run={runId} aria-label="Art generation status" aria-busy={phase === "pending"}>
      <p className={styles.title}>{phase === "pending" && op.via === "photo" ? "Adding your photo…" : TITLES[phase]}</p>
      {phase === "pending" && <div className={styles.bar} aria-hidden="true" />}
      <p className={styles.text}>
        {op.message}
        {phase === "pending" && slowRun === runId ? " Still waiting. A long wait does not mean it failed." : ""}
      </p>
      <div className={styles.actions}>
        {phase === "pending" && <PaperButton onClick={(event) => act(event, () => controller.cancel(runId))}>Stop and ignore the result</PaperButton>}
        {phase === "ready" && (
          <>
            <PaperButton onClick={(event) => act(event, () => controller.apply(runId))}>Apply as new version</PaperButton>
            <PaperButton onClick={(event) => act(event, () => controller.discard(runId))}>Discard</PaperButton>
          </>
        )}
        {(phase === "failed" || phase === "canceled" || phase === "interrupted") && <PaperButton onClick={(event) => act(event, retry)}>{phase === "interrupted" && !controller.canRetry(runId) ? "Open Remix" : "Try again"}</PaperButton>}
        {phase !== "pending" && phase !== "ready" && <PaperButton onClick={() => controller.dismiss(runId)}>Dismiss</PaperButton>}
      </div>
    </section>
  );
}
