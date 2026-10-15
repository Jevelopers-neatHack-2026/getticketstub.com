"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DesignVersion, Stub } from "../types";
import { currentVersion } from "../types";
import { PaperButton, PaperSheet, Tag, Tags, TearLink } from "@/customer/desk/Desk";
import type { GenerationController } from "../generation/operations";
import { useGenerationOp } from "../generation/useGeneration";
import { captureFocusHandoff, type FocusHandoff } from "../generation/focus-handoff";
import { photoProducer, remixProducer } from "../generation/producers";
import { play } from "@/customer/studio/feedback";
import { listVersions, restoreVersion, sameArt, versionHash } from "../versions/versions";
import { vibeOf } from "@/customer/flows/events";
import styles from "./overlays.module.css";

export const VIBES = ["Neon", "Risograph", "70s", "Minimal"] as const;

interface PanelProps {
  stub: Stub;
  onChange: (s: Stub) => void;
  /** The editor's art-generation controller: the panel is only an entry point, it owns no request. */
  generation: GenerationController;
  /** Opens the agent for a free-text description. */
  onDescribe: () => void;
  onDone?: () => void;
}

/** Earlier looks to go back to: one version per distinct art, the current look left out, the same style preferred. Going back selects that version. */
function earlierVersions(stub: Stub): DesignVersion[] {
  const cur = currentVersion(stub);
  const byArt: DesignVersion[] = [];
  for (const v of listVersions(stub)) {
    if (sameArt(v.art, cur.art)) continue;
    const i = byArt.findIndex((x) => sameArt(x.art, v.art));
    if (i < 0) byArt.push(v);
    else if (v.edition === cur.edition && byArt[i].edition !== cur.edition) byArt[i] = v;
  }
  return byArt;
}

/** One name per chip, told apart when two remixes used the same vibe ("Neon", "Neon 2"). */
function chipNames(versions: DesignVersion[]): string[] {
  const seen: Record<string, number> = {};
  return versions.map((v) => {
    const base = v.art.vibe === "photo" ? "Your photo" : v.art.vibe ? v.art.vibe : v.parentId ? "Remix" : "First art";
    seen[base] = (seen[base] ?? 0) + 1;
    return seen[base] > 1 ? `${base} ${seen[base]}` : base;
  });
}

/** Vibe tags, a photo option and one action. Free text lives behind "Describe it instead". */
export function RemixPanel({ stub, onChange, generation, onDescribe, onDone }: PanelProps) {
  const [vibe, setVibe] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const focusHandoff = useRef<FocusHandoff | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const earlier = earlierVersions(stub);
  const names = chipNames(earlier);
  const op = useGenerationOp(generation, stub.id);
  const busy = op?.phase === "pending";
  useLayoutEffect(() => {
    const intent = focusHandoff.current;
    focusHandoff.current = null;
    const close = panelRef.current?.closest('[role="dialog"][aria-modal="true"]')?.querySelector<HTMLButtonElement>("[data-close]:not(:disabled)");
    intent?.finish(close ?? statusRef.current);
  }, [op]);
  useEffect(() => () => focusHandoff.current?.cancel(), []);
  // Art the sheet asked for closes it when applied; a limited fallback stays open so the note is read.
  // (The sheet closing never cancels anything: the editor owns the operation.)
  const mine = useRef<string | null>(null);
  useEffect(() => {
    if (op && op.runId === mine.current && op.phase === "applied" && !op.fallback) onDone?.();
  }, [op, onDone]);

  const dispatch = (req: Parameters<GenerationController["start"]>[0]) => {
    play("remix");
    focusHandoff.current?.cancel();
    const active = panelRef.current?.ownerDocument.activeElement;
    focusHandoff.current = active instanceof HTMLElement && panelRef.current?.contains(active) ? captureFocusHandoff(active) : null;
    const before = generation.get(stub.id);
    try {
      const started = generation.start(req); // the operation exists as soon as this returns
      const now = generation.get(stub.id);
      if (now && now !== before && now.phase === "pending") mine.current = now.runId;
      started.catch(() => undefined);
    } finally {
      if (generation.get(stub.id) === before) {
        focusHandoff.current?.cancel();
        focusHandoff.current = null;
      }
    }
  };
  const run = () => dispatch({ via: "sheet", vibe: vibe ?? undefined, fallback: "apply", run: remixProducer("sheet", vibe ?? undefined, vibeOf(vibe)) });

  const onPhoto = (file: File | undefined) => {
    if (!file) return;
    dispatch({ via: "photo", fallback: "apply", run: photoProducer(file) });
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div ref={panelRef} className={styles.stack} aria-busy={busy}>
      <span className="desk-label">Pick a look</span>
      <Tags label="Vibe">
        {VIBES.map((v) => (
          <Tag key={v} pressed={vibe === v} disabled={busy} onClick={() => setVibe(vibe === v ? null : v)}>
            {v}
          </Tag>
        ))}
        <Tag disabled={busy} onClick={() => fileRef.current?.click()}>
          From my photo
        </Tag>
      </Tags>
      <input
        ref={fileRef}
        className="visually-hidden"
        tabIndex={-1}
        aria-label="Choose a photo for the art"
        type="file"
        accept="image/*"
        disabled={busy}
        onChange={(e) => onPhoto(e.target.files?.[0])}
      />
      <TearLink onClick={onDescribe}>Describe it instead</TearLink>
      <PaperButton block onClick={run} disabled={busy}>
        {busy ? "Remixing…" : "Remix the art"}
      </PaperButton>
      <p ref={statusRef} tabIndex={-1} className={styles.muted}>
        {busy ? (op?.via === "photo" ? "Adding your photo." : "Generating new art.") + " The status stays beside the artwork if you close this." : (op?.message ?? "Each remix is kept as a version, so you can go back.")}
      </p>
      {earlier.length > 0 && (
        <>
          <span className="desk-label">Go back to</span>
          <Tags label="Earlier art">
            {earlier.map((v, i) => (
              <Tag
                key={v.id}
                disabled={busy}
                aria-label={`Go back to ${names[i]}, version ${versionHash(v)}`}
                onClick={() => {
                  // Selects the version that already exists. Nothing is made again, and the next edit branches from it.
                  onChange(restoreVersion(stub, v.id));
                  play("stamp", { emphasis: "subtle" });
                  onDone?.();
                }}
              >
                {names[i]}
              </Tag>
            ))}
          </Tags>
        </>
      )}
    </div>
  );
}

interface SheetProps extends Omit<PanelProps, "onDone"> {
  open: boolean;
  onClose: () => void;
}

export function RemixSheet({ open, onClose, ...rest }: SheetProps) {
  return (
    <PaperSheet title="Remix the art" open={open} onClose={onClose}>
      <RemixPanel {...rest} onDone={onClose} />
    </PaperSheet>
  );
}
