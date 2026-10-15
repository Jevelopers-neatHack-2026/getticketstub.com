"use client";
// The corkboard as an endless canvas, shared by /wall and /u/[token]: cork that tiles in every direction under a
// camera (wheel, pinch, drag), a paper control cluster (zoom, fit, fullscreen) and a way back when the stubs are out of sight.
// The stage is the element that goes fullscreen, so `overlay` (the lamp) renders inside it and stays visible.
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { play, useMuted } from "@/customer/studio/feedback";
import { SoundIcon } from "@/customer/desk/icons";
import { chrome as c } from "./chrome";
import { useBoardCamera } from "./useBoardCamera";
import s from "./canvas.module.css";

export interface CanvasApi {
  scale: () => number;
  panning: RefObject<boolean>;
  fullscreen: () => boolean;
  /** Re-read where the stubs are (after one moved). */
  measure: () => void;
}

type Fs = "off" | "native" | "css";

interface Props {
  label: string;
  /** Changes whenever a stub was added, removed, moved or filtered: the camera re-reads where they are. */
  layoutKey: string;
  /** A change here (the filter) glides the camera back to fit. */
  fitKey?: string;
  /** Read-only boards let a drag that starts on a stub pan the board. */
  panOverStubs?: boolean;
  /** A second finger landed: a stub drag must let go. */
  onCancelGesture?: () => void;
  onFullscreen?: (on: boolean) => void;
  apiRef?: RefObject<CanvasApi | null>;
  /** Rendered inside the stage, over the board (the lamp). */
  overlay?: ReactNode;
  children: ReactNode;
}

const Minus = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
  </svg>
);
const Plus = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="M3 8h10M8 3v10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
  </svg>
);
const Expand = ({ out }: { out: boolean }) => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path
      d={out ? "M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" : "M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"}
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </svg>
);

export function Canvas({ label, layoutKey, fitKey, panOverStubs = false, onCancelGesture, onFullscreen, apiRef, overlay, children }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const [fs, setFs] = useState<Fs>("off");
  const [muted, setMuted] = useMuted();
  const fsRef = useRef<Fs>("off");
  const cancelRef = useRef(onCancelGesture);
  const notifyRef = useRef(onFullscreen);
  useEffect(() => {
    cancelRef.current = onCancelGesture;
    notifyRef.current = onFullscreen;
  });
  const cam = useBoardCamera({ areaRef, grabStubs: panOverStubs, onCancelGesture: () => cancelRef.current?.() });

  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = { scale: cam.scale, panning: cam.panning, fullscreen: () => fsRef.current !== "off", measure: cam.measure };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, cam]);

  // A visit starts at fit. A second pass catches stubs that settled a moment late, unless the visitor already moved.
  useEffect(() => {
    const r = requestAnimationFrame(() => cam.fitNow());
    const t = window.setTimeout(() => {
      if (!cam.touched.current) cam.fitNow();
    }, 700);
    return () => {
      cancelAnimationFrame(r);
      clearTimeout(t);
    };
  }, [cam]);

  // stubs moved, came or went: re-read where they are (the camera stays put)
  useEffect(() => {
    const r = requestAnimationFrame(() => cam.measure());
    return () => cancelAnimationFrame(r);
  }, [cam, layoutKey]);

  // the filter changed: show what is left
  const firstFit = useRef(true);
  useEffect(() => {
    if (firstFit.current) {
      firstFit.current = false;
      return;
    }
    const r = requestAnimationFrame(() => cam.fit());
    return () => cancelAnimationFrame(r);
  }, [cam, fitKey]);

  const apply = useCallback(
    (next: Fs) => {
      const was = fsRef.current;
      fsRef.current = next;
      setFs(next);
      if ((was === "off") !== (next === "off")) {
        play(next === "off" ? "close" : "open", { emphasis: "subtle" });
        notifyRef.current?.(next !== "off");
        // the board changed size: frame the stubs again once the layout has settled
        requestAnimationFrame(() => requestAnimationFrame(() => cam.fit()));
      }
    },
    [cam],
  );

  const enter = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenEnabled && typeof el.requestFullscreen === "function") {
      el.requestFullscreen().then(
        () => apply("native"),
        () => apply("css"),
      );
    } else {
      // iOS Safari has no element fullscreen: fill the viewport instead
      apply("css");
    }
  }, [apply]);
  const exit = useCallback(() => {
    if (fsRef.current === "native" && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else apply("off");
  }, [apply]);
  const toggle = useCallback(() => (fsRef.current === "off" ? enter() : exit()), [enter, exit]);

  useEffect(() => {
    const onChange = () => {
      // Esc (or the browser's own control) left fullscreen
      if (fsRef.current === "native" && document.fullscreenElement !== stageRef.current) apply("off");
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [apply]);

  // the CSS fallback has no browser Esc, and it must not let the page scroll behind it
  useEffect(() => {
    if (fs !== "css") return;
    const onKey = (e: KeyboardEvent) => {
      // the lamp takes Esc first when a stub is lifted
      if (e.key === "Escape" && !stageRef.current?.querySelector('[role="dialog"]')) exit();
    };
    const root = document.documentElement;
    const prev = root.style.overflow;
    root.style.overflow = "hidden";
    root.setAttribute("data-board-fs", ""); // the sidebar and cart sit above the page's layer: canvas.module.css hides them
    window.addEventListener("keydown", onKey);
    return () => {
      root.style.overflow = prev;
      root.removeAttribute("data-board-fs");
      window.removeEventListener("keydown", onKey);
    };
  }, [fs, exit]);
  useEffect(
    () => () => {
      if (fsRef.current === "native" && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    },
    [],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.key === "f" || e.key === "F") && !(e.target as HTMLElement).closest("input, textarea, select, [contenteditable='true']")) {
      e.preventDefault();
      toggle();
    }
  };

  return (
    <div ref={stageRef} className={s.stage} data-fs={fs} onKeyDown={onKeyDown}>
      <div ref={areaRef} className={`${c.cork} ${s.area}`} tabIndex={0} role="group" aria-label={label} data-lost="false">
        <div className={s.world} data-cam-world>
          {children}
        </div>
      </div>
      <div className={s.frame} aria-hidden="true" />
      <button type="button" className={s.back} data-cam-ui onClick={cam.fit}>
        Back to your stubs
      </button>
      <div className={s.controls} data-cam-ui data-lamp={overlay ? "" : undefined} role="toolbar" aria-label="Board view">
        <button type="button" className={s.btn} aria-label="Zoom out" title="Zoom out (−)" onClick={() => cam.zoomBy(1 / 1.25)}>
          <Minus />
        </button>
        <span className={s.pct} data-cam-pct aria-live="off">
          100%
        </span>
        <button type="button" className={s.btn} aria-label="Zoom in" title="Zoom in (+)" onClick={() => cam.zoomBy(1.25)}>
          <Plus />
        </button>
        <button type="button" className={`${s.btn} ${s.fit}`} title="Fit all stubs (0)" onClick={cam.fit}>
          Fit
        </button>
        <span className={s.sep} aria-hidden="true" />
        {fs !== "off" ? (
          // fullscreen hides the sidebar, where the sound switch lives: it stays one press away here
          <button
            type="button"
            className={s.btn}
            aria-label={muted ? "Sound off. Press to turn it on" : "Sound on. Press to turn it off"}
            title={muted ? "Sound is off" : "Sound is on"}
            onClick={() => {
              setMuted(!muted);
              if (muted) play("toggle", { emphasis: "subtle", direction: "forward" });
            }}
          >
            <SoundIcon muted={muted} />
          </button>
        ) : null}
        <button
          type="button"
          className={s.btn}
          aria-label={fs === "off" ? "Fullscreen" : "Exit fullscreen"}
          aria-pressed={fs !== "off"}
          title={fs === "off" ? "Fullscreen (F)" : "Exit fullscreen (Esc)"}
          onClick={toggle}
        >
          <Expand out={fs !== "off"} />
        </button>
      </div>
      {overlay}
    </div>
  );
}
