"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Stub } from "../types";
import { upsertStub } from "../store";
import { TearGesture, type TearMethod } from "@/customer/studio/stub/TearGesture";
import { flow } from "@/customer/flows/events";
import { PathTrack } from "@/customer/wayfinding/PathTrack";
import { PaperButton } from "@/customer/desk/Desk";
import { announce } from "@/customer/a11y/announce";
import { useDialogFocus } from "@/customer/a11y/focus";
import styles from "./TearFlow.module.css";

const FADE_MS = 600;

/**
 * Full-screen stage for the tear. The paper desk fades in, you tear the stub off, it flies up and out,
 * and the wall takes over (/wall?pinned=<id> plays the landing and the pin). No sheet, no dimmed
 * editor: the torn state is saved here, so the Editor's onTorn is not needed for the hand-off.
 */
export function TearStage({ stub, onCancel }: { stub: Stub; onTorn: () => void; onCancel: () => void }) {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  // a dialog: focus lands on the tear handle, Tab stays here, and "Back to styling" returns it to the tear strip
  useDialogFocus(stageRef, true, '[role="slider"]');

  useEffect(() => {
    router.prefetch("/wall");
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [router]);

  // the desk fades back out, then the editor is back
  const cancel = useCallback(() => {
    setLeaving((was) => {
      if (!was) timer.current = setTimeout(onCancel, FADE_MS);
      return true;
    });
  }, [onCancel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel]);

  // The one tear completion: the gesture only says how; this saves it and reports it.
  const torn = (method: TearMethod) => {
    const stored = upsertStub({ ...stub, torn: true });
    flow("tear_complete", { method, storage: stored ? "ok" : "failed" });
    announce("Torn off. Pinning it to your wall.");
    router.push(`/wall?pinned=${encodeURIComponent(stub.id)}`);
  };

  return (
    <div ref={stageRef} className={`desk-surface ${styles.stage} ${leaving ? styles.leaving : ""}`} role="dialog" aria-modal="true" aria-label="Tear off your stub">
      <PathTrack current="tear" stubId={stub.id} className={styles.track} />
      <div className={styles.area}>
        <TearGesture stub={stub} onTorn={torn} />
      </div>
      <PaperButton type="button" onClick={cancel}>
        Back to styling
      </PaperButton>
    </div>
  );
}

/**
 * Opening "On your wall" on a stub that is already torn goes to the wall with the stub lifted.
 * The old sheet over a dimmed editor is gone; the wall is where the next steps live.
 */
export function FinishSheet({ stub, open, onClose }: { stub: Stub; open: boolean; onClose: () => void }) {
  const router = useRouter();
  useEffect(() => {
    if (!open) return;
    onClose();
    router.push(`/wall?lift=${encodeURIComponent(stub.id)}`);
  }, [open, onClose, router, stub.id]);
  return null;
}
