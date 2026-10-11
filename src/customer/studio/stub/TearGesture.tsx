"use client";
// Signature move: tear the stub off along the perforation. Drag the handle along the dotted line and
// the torn edge opens behind your finger; the paper bends more the further you go. There is no
// readout: progress is the paper and the sound (a light tick at every few perforation holes, fading
// as you commit). Past 60% it rips, lifts off and flies away (600ms enter ease), then onTorn() fires once.
// Keyboard: arrows move the handle, Enter tears. "Tear it off for me" does the same tear on its own,
// and with reduced motion it skips the animation.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { Stub } from "../types";
import { haptic, play } from "../feedback";
import { TearLink } from "@/customer/desk/Desk";
import { StubView } from "./StubView";
import t from "./TearGesture.module.css";

const RIP_AT = 60;
const HOLE_PX = 12; // spacing of the perforation dots in the track
const TICK_HOLES = 3; // tick on every third hole
const KEY_STEP = 8;
const RESIST = 0.82; // handle covers 82% of the finger's travel: paper resists
const FLY_MS = 600;
const AUTO_MS = 900;

const clamp = (v: number) => Math.min(100, Math.max(0, v));
const reduced = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** How the tear was finished: dragged along the line, with the keyboard, or by "Tear it off for me". */
export type TearMethod = "drag" | "keyboard" | "auto";

export function TearGesture({ stub, onTorn }: { stub: Stub; onTorn: (method: TearMethod) => void }) {
  const headingId = useId();
  const [p, setP] = useState(0);
  const [phase, setPhase] = useState<"idle" | "drag" | "settle" | "ripped">("idle");
  const trackRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; p: number; id: number } | null>(null);
  const lastHole = useRef(0);
  const lastTickAt = useRef(0);
  const done = useRef(false);
  // whichever input last moved the tear; the parent reports the completion once, with it
  const via = useRef<TearMethod>("drag");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const raf = useRef<number | null>(null);
  const onTornRef = useRef(onTorn);
  useEffect(() => {
    onTornRef.current = onTorn;
  }, [onTorn]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (raf.current) cancelAnimationFrame(raf.current);
    },
    [],
  );

  const rip = useCallback(() => {
    if (done.current) return;
    done.current = true;
    drag.current = null;
    if (raf.current) cancelAnimationFrame(raf.current);
    setP(100);
    setPhase("ripped");
    play("tear");
    haptic([30, 30, 60]);
    timer.current = setTimeout(() => onTornRef.current(via.current), reduced() ? 260 : FLY_MS);
  }, []);

  const advance = useCallback(
    (next: number) => {
      if (done.current) return;
      const v = clamp(next);
      const w = trackRef.current?.getBoundingClientRect().width || 300;
      const hole = Math.floor(((v / 100) * w) / (HOLE_PX * TICK_HOLES));
      const now = performance.now();
      if (hole > lastHole.current && now - lastTickAt.current > 50) {
        lastTickAt.current = now;
        play("select", { emphasis: "subtle", volume: Math.max(0.3, 1 - v / 110) });
        haptic(3);
      }
      lastHole.current = hole;
      setP(v);
      if (v >= RIP_AT) rip();
    },
    [rip],
  );

  /** The button: tear on its own, slow then fast like a real tear. */
  const tearItOff = () => {
    if (done.current) return;
    via.current = "auto";
    if (reduced()) {
      rip();
      return;
    }
    setPhase("drag");
    const from = p;
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / AUTO_MS);
      advance(from + (RIP_AT + 1 - from) * k * k);
      if (!done.current && k < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  };

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (done.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    via.current = "drag";
    drag.current = { x: e.clientX, p, id: e.pointerId };
    setPhase("drag");
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const track = trackRef.current;
    if (!d || d.id !== e.pointerId || !track) return;
    const w = track.getBoundingClientRect().width || 1;
    advance(d.p + ((e.clientX - d.x) / w) * 100 * RESIST);
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (done.current) return;
    // not far enough: the paper springs back
    lastHole.current = 0;
    setPhase("settle");
    setP(0);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (done.current) return;
    via.current = "keyboard";
    if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      setPhase("drag");
      advance(p + KEY_STEP);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      setPhase("drag");
      lastHole.current = 0;
      setP(clamp(p - KEY_STEP));
    } else if (e.key === "Home") {
      e.preventDefault();
      lastHole.current = 0;
      setPhase("settle");
      setP(0);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      rip();
    }
  };

  const ripped = phase === "ripped";
  // the stub bends as the tear runs, then lifts off and flies up and away
  const k = p / 100;
  const moverTransform = ripped
    ? "translate(14%, -135%) rotate(-14deg)"
    : `perspective(900px) translateY(${(-k * 10).toFixed(2)}px) rotateX(${(k * 14).toFixed(2)}deg) rotateZ(${(-k * 4.5).toFixed(2)}deg)`;
  const pct = Math.round(p);
  const bar = phase === "settle" ? t.settlingBar : "";

  return (
    <section className={t.wrap} aria-labelledby={headingId}>
      <h2 id={headingId} className={t.heading}>
        Tear it off
      </h2>
      <div className={t.stage}>
        <div className={`${t.mover} ${ripped ? t.flyAway : phase === "drag" ? t.dragging : t.settling}`} style={{ transform: moverTransform }}>
          <StubView stub={stub} size="md" />
        </div>
      </div>
      <div className={t.track} ref={trackRef}>
        <span className={t.line} aria-hidden="true" />
        <span className={`${t.torn} ${bar}`} aria-hidden="true" style={{ width: `${pct}%` }} />
        <div
          role="slider"
          tabIndex={0}
          aria-label="Tear along the perforation"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-valuetext={ripped ? "Torn" : pct === 0 ? "Not torn yet. Arrow keys tear a little at a time, past the middle it comes off. Press Enter to tear it off." : `${pct} percent torn`}
          className={`${t.handle} ${bar}`}
          style={{ left: `${pct}%` }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onKeyDown={onKey}
        >
          <span className={t.grip} aria-hidden="true" />
        </div>
      </div>
      <p className={t.hint}>Drag along the dotted line.</p>
      <TearLink type="button" onClick={tearItOff} disabled={ripped}>
        Or tear it off for me
      </TearLink>
    </section>
  );
}
