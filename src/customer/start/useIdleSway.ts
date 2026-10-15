"use client";
// A slow, eased sway for a showcase stub. It does not move the stub itself: it feeds the stub's own
// tilt hook a gentle path of synthetic pointer positions, so the tilt, the light and the foil all follow
// the same smoothing as a real hand. Real pointers take over at once and the sway resumes after a pause.
import { useEffect, type RefObject } from "react";
import { useReducedMotion } from "@/customer/landing/MotionContext";

const RESUME_AFTER_MS = 1800;
const FRAME_MS = 33;

export function useIdleSway(host: RefObject<HTMLElement | null>) {
  const reduced = useReducedMotion();
  useEffect(() => {
    const el = host.current;
    if (!el || reduced) return;
    let stopped = false;
    let lastReal = -Infinity;
    let visible = true;
    let raf = 0;
    let last = 0;
    const real = (e: Event) => {
      if (e.isTrusted) lastReal = performance.now();
    };
    el.addEventListener("pointermove", real);
    el.addEventListener("pointerenter", real);
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    });
    io.observe(el);

    const step = (now: number) => {
      if (stopped) return;
      raf = requestAnimationFrame(step);
      if (!visible || document.hidden || now - last < FRAME_MS || now - lastReal < RESUME_AFTER_MS) return;
      last = now;
      const fig = el.querySelector("figure");
      if (!fig) return;
      const r = fig.getBoundingClientRect();
      const t = now / 1000;
      const nx = 0.5 + 0.3 * Math.sin(t * 0.62);
      const ny = 0.42 + 0.2 * Math.sin(t * 0.47 + 1);
      // pointerType "touch" keeps the sway out of the way of a phone's gyro tilt
      fig.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + nx * r.width, clientY: r.top + ny * r.height, pointerType: "touch" }));
    };
    raf = requestAnimationFrame(step);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      io.disconnect();
      el.removeEventListener("pointermove", real);
      el.removeEventListener("pointerenter", real);
    };
  }, [host, reduced]);
}
