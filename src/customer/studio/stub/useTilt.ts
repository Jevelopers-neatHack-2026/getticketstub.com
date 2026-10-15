"use client";
// Tilt + light for the stub. Follows brand-kit material-foil.md "foil must never pop":
// every input eases toward its target in one rAF loop with time-based exponential smoothing,
//   current += (target - current) * (1 - exp(-dt / tau)),
// tau tilt 110ms, light 90ms, glow in 400ms / out 600ms, dt clamped to 50ms, rest glow 0.1.
// Pointer on desktop; deviceorientation on mobile after requestGyro() (iOS permission needs a gesture),
// low-pass alpha 0.15, clamped to +-11deg. Reduced motion: no tilt, static glow 0.45.
//
// CSS variables written on ref.current:
//   --rx, --ry  tilt in deg (rotateX / rotateY)
//   --px, --py  parallax, unitless -1..1
//   --lx, --ly  light position in % (0..100%)
//   --glow      0..1 (0.1 at rest)
// Pointer is tracked over the element's parent (an untransformed hit area) when there is one.
import { useCallback, useEffect, useRef, type RefObject } from "react";
import { useReducedMotion } from "@/customer/landing/MotionContext";

const TILT_MAX = 11;
const TAU_TILT = 110;
const TAU_LIGHT = 90;
const TAU_GLOW_IN = 400;
const TAU_GLOW_OUT = 600;
const DT_MAX = 50;
const REST_GLOW = 0.1;
const REDUCED_GLOW = 0.45;
const LOWPASS = 0.15;

interface State {
  rx: number;
  ry: number;
  lx: number;
  ly: number;
  glow: number;
}

const rest = (): State => ({ rx: 0, ry: 0, lx: 50, ly: 35, glow: REST_GLOW });
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

type OrientationCtor = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<"granted" | "denied"> };

export function useTilt(ref: RefObject<HTMLElement | null>, enabled: boolean): { requestGyro: () => Promise<void> } {
  const reduced = useReducedMotion();
  const reducedRef = useRef(reduced);
  const active = useRef(true);
  const cur = useRef<State>(rest());
  const tgt = useRef<State>(rest());
  const raf = useRef<number | null>(null);
  const last = useRef<number>(0);
  const gyroOn = useRef(false);
  const gyroBase = useRef<{ beta: number; gamma: number } | null>(null);
  const gyroLP = useRef<{ beta: number; gamma: number } | null>(null);
  const enabledRef = useRef(enabled);
  const wrote = useRef(false);
  useEffect(() => {
    enabledRef.current = enabled;
    reducedRef.current = reduced;
  }, [enabled, reduced]);

  const write = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const s = cur.current;
    wrote.current = true;
    el.style.setProperty("--rx", `${s.rx.toFixed(3)}deg`);
    el.style.setProperty("--ry", `${s.ry.toFixed(3)}deg`);
    el.style.setProperty("--px", (s.ry / TILT_MAX).toFixed(4));
    el.style.setProperty("--py", (-s.rx / TILT_MAX).toFixed(4));
    el.style.setProperty("--lx", `${s.lx.toFixed(2)}%`);
    el.style.setProperty("--ly", `${s.ly.toFixed(2)}%`);
    el.style.setProperty("--glow", s.glow.toFixed(4));
  }, [ref]);

  const kick = useCallback(() => {
    if (!active.current || reducedRef.current || raf.current != null) return;
    last.current = 0;
    const step = (now: number) => {
      if (!active.current || reducedRef.current) { raf.current = null; return; }
      const dt = clamp(now - (last.current || now - 16.7), 0, DT_MAX);
      last.current = now;
      const c = cur.current;
      const t = tgt.current;
      const kTilt = 1 - Math.exp(-dt / TAU_TILT);
      const kLight = 1 - Math.exp(-dt / TAU_LIGHT);
      const kGlow = 1 - Math.exp(-dt / (t.glow > c.glow ? TAU_GLOW_IN : TAU_GLOW_OUT));
      c.rx += (t.rx - c.rx) * kTilt;
      c.ry += (t.ry - c.ry) * kTilt;
      c.lx += (t.lx - c.lx) * kLight;
      c.ly += (t.ly - c.ly) * kLight;
      c.glow += (t.glow - c.glow) * kGlow;
      write();
      const settled =
        Math.abs(t.rx - c.rx) < 0.01 &&
        Math.abs(t.ry - c.ry) < 0.01 &&
        Math.abs(t.lx - c.lx) < 0.05 &&
        Math.abs(t.ly - c.ly) < 0.05 &&
        Math.abs(t.glow - c.glow) < 0.001;
      if (settled) {
        raf.current = null;
        last.current = 0;
      } else {
        raf.current = requestAnimationFrame(step);
      }
    };
    raf.current = requestAnimationFrame(step);
  }, [write]);

  const aim = useCallback(
    (nx: number, ny: number, glow: number) => {
      // nx, ny: 0..1 across the element
      const x = clamp(nx, 0, 1);
      const y = clamp(ny, 0, 1);
      tgt.current = {
        ry: (x - 0.5) * 2 * TILT_MAX,
        rx: -(y - 0.5) * 2 * TILT_MAX,
        lx: x * 100,
        ly: y * 100,
        glow: clamp(glow, REST_GLOW, 1),
      };
      kick();
    },
    [kick],
  );

  const relax = useCallback(() => {
    tgt.current = rest();
    kick();
  }, [kick]);

  // pointer + lifecycle
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduced) {
      if (raf.current != null) cancelAnimationFrame(raf.current);
      raf.current = null;
      last.current = 0;
      cur.current = { ...rest(), glow: REDUCED_GLOW };
      tgt.current = { ...cur.current };
      if (enabled || wrote.current) write();
      return;
    }
    if (!enabled) {
      // ease home from wherever it is (CSS defaults apply if we never wrote anything)
      if (wrote.current) relax();
      return;
    }
    write();
    const host = el.parentElement ?? el;
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch" && gyroOn.current) return;
      const r = host.getBoundingClientRect();
      if (!r.width || !r.height) return;
      aim((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, 1);
    };
    const onLeave = () => {
      if (!gyroOn.current) relax();
    };
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerenter", onMove);
    host.addEventListener("pointerleave", onLeave);
    host.addEventListener("pointercancel", onLeave);
    return () => {
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerenter", onMove);
      host.removeEventListener("pointerleave", onLeave);
      host.removeEventListener("pointercancel", onLeave);
    };
  }, [enabled, reduced, ref, aim, relax, write]);

  // gyro listener
  const onOrient = useCallback(
    (e: DeviceOrientationEvent) => {
      if (!active.current || !enabledRef.current || reducedRef.current || e.beta == null || e.gamma == null) return;
      const lp = gyroLP.current;
      const next = lp
        ? { beta: lp.beta + (e.beta - lp.beta) * LOWPASS, gamma: lp.gamma + (e.gamma - lp.gamma) * LOWPASS }
        : { beta: e.beta, gamma: e.gamma };
      gyroLP.current = next;
      if (!gyroBase.current) gyroBase.current = { ...next };
      const dBeta = clamp(next.beta - gyroBase.current.beta, -TILT_MAX, TILT_MAX);
      const dGamma = clamp(next.gamma - gyroBase.current.gamma, -TILT_MAX, TILT_MAX);
      // slowly re-centre the neutral pose so a new grip doesn't pin the tilt at the clamp
      gyroBase.current.beta += (next.beta - gyroBase.current.beta) * 0.004;
      gyroBase.current.gamma += (next.gamma - gyroBase.current.gamma) * 0.004;
      const mag = Math.min(1, Math.hypot(dBeta, dGamma) / TILT_MAX);
      aim(0.5 + dGamma / (2 * TILT_MAX), 0.5 - dBeta / (2 * TILT_MAX), REST_GLOW + (1 - REST_GLOW) * Math.max(0.35, mag));
    },
    [aim],
  );

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      if (raf.current != null) cancelAnimationFrame(raf.current);
      raf.current = null;
      if (gyroOn.current) window.removeEventListener("deviceorientation", onOrient);
      gyroOn.current = false;
    };
  }, [onOrient]);

  useEffect(() => {
    if ((!enabled || reduced) && gyroOn.current) {
      window.removeEventListener("deviceorientation", onOrient);
      gyroOn.current = false;
      gyroBase.current = null;
      gyroLP.current = null;
    }
  }, [enabled, reduced, onOrient]);

  const requestGyro = useCallback(async () => {
    if (typeof window === "undefined" || !active.current || gyroOn.current || !enabledRef.current || reducedRef.current) return;
    if (typeof DeviceOrientationEvent === "undefined") return;
    try {
      const ctor = DeviceOrientationEvent as OrientationCtor;
      if (typeof ctor.requestPermission === "function") {
        const res = await ctor.requestPermission();
        if (res !== "granted") return;
      }
      if (!active.current || !enabledRef.current || reducedRef.current) return;
      gyroBase.current = null;
      gyroLP.current = null;
      window.addEventListener("deviceorientation", onOrient);
      gyroOn.current = true;
    } catch {
      /* denied or not from a gesture: pointer tilt still works */
    }
  }, [onOrient]);

  return { requestGyro };
}
