"use client";
import { useRef, useState } from "react";
import type { DesignVersion, Stub } from "../types";
import { currentVersion } from "../types";
import { remixArtNoted } from "@/customer/studio/research/client";
import { play, haptic } from "@/customer/studio/feedback";
import { PaperButton, PaperSheet, Tag, Tags, TearLink } from "@/customer/desk/Desk";
import { addArtVersion, readImageFile } from "./ops";
import { listVersions, restoreVersion, sameArt, versionHash } from "../versions/versions";
import { artOutcome, clock, errorCode, flow, since, vibeOf } from "@/customer/flows/events";
import styles from "./overlays.module.css";

export const VIBES = ["Neon", "Risograph", "70s", "Minimal"] as const;

interface PanelProps {
  stub: Stub;
  onChange: (s: Stub) => void;
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
export function RemixPanel({ stub, onChange, onDescribe, onDone }: PanelProps) {
  const [vibe, setVibe] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const earlier = earlierVersions(stub);
  const names = chipNames(earlier);

  const finish = (s: Stub) => {
    onChange(s);
    play("success");
    haptic([18, 40, 28]);
    onDone?.();
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    play("remix");
    flow("remix_request", { via: "sheet", vibe: vibeOf(vibe) });
    const asked = clock();
    try {
      const { art, limitNote } = await remixArtNoted(stub, vibe ?? undefined);
      // the daily cap answers with procedural art: a limited result, never reported as generated
      flow("remix_result", { via: "sheet", result: limitNote ? "limited" : "success", ...artOutcome(art), duration_ms: since(asked) });
      if (limitNote) {
        // Procedural art is applied, and the sheet stays open so the note is read.
        onChange(addArtVersion(stub, art));
        play("success", { emphasis: "subtle" });
        setError(limitNote);
      } else {
        finish(addArtVersion(stub, art));
      }
    } catch (e) {
      flow("remix_result", { via: "sheet", result: "error", duration_ms: since(asked), error_code: errorCode(e) });
      setError(e instanceof Error ? e.message : "We couldn't remix the art. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const onPhoto = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const src = await readImageFile(file);
      // the person's own photo as the art: uploaded, kept on this device (never the photo or its name)
      flow("remix_result", { via: "sheet", result: "success", art: "uploaded", capability: "local" });
      finish(addArtVersion(stub, { kind: "image", src, seed: Date.now() % 100000, vibe: "photo", provenance: "live" }));
    } catch (e) {
      flow("remix_result", { via: "sheet", result: "error", art: "uploaded", capability: "local", error_code: "bad_image" });
      setError(e instanceof Error ? e.message : "We couldn't read that photo. Try another one.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className={styles.stack} aria-busy={busy}>
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
      <p className={styles.muted} data-announce="change">
        {busy ? "Remixing. Your text and edits stay." : (error ?? "Your text and edits stay. Each remix is kept, so you can go back.")}
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
