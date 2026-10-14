// How much of the landing page runs on this visit: the full 3D version, the printed (2D) version, or the printed
// version with no motion at all. Device capability is probed once per load; preferences can change during the visit.
//
//   still  no animation, no loader, no scroll-driven movement. The visitor's choice (the Motion switch, ?motion=off),
//          or the system's "reduce motion" setting when they have not chosen.
//   no3d   three.js is never downloaded; the printed version shows at once. Set when still, when WebGL would run
//          without hardware acceleration (failIfMajorPerformanceCaveat, or a software renderer), on Save-Data or a
//          2G connection, or on a device with 2 GB of memory or 2 cores or fewer.

export type MotionPref = "on" | "off" | "auto";
export interface LandingMode {
  still: boolean;
  no3d: boolean;
  /** Why 3D is off, for the console and the tests ("" when 3D runs). */
  reason: string;
}

const KEY = "ticketstub.motion";
const SOFTWARE_GL = /swiftshader|llvmpipe|softpipe|software|basic render|lavapipe/i;

let visitPref: MotionPref | undefined;

export function readMotionPref(): MotionPref {
  if (visitPref !== undefined) return visitPref;
  try {
    const q = new URLSearchParams(window.location.search).get("motion");
    if (q === "on" || q === "off") return q;
    const v = window.localStorage.getItem(KEY);
    return v === "on" || v === "off" ? v : "auto";
  } catch {
    return "auto";
  }
}

export function writeMotionPref(pref: MotionPref): void {
  visitPref = pref; // the switch works even when storage or history is unavailable
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has("motion")) {
      if (pref === "auto") url.searchParams.delete("motion");
      else url.searchParams.set("motion", pref);
      window.history.replaceState(window.history.state, "", url);
    }
  } catch { /* retain the visit choice */ }
  try {
    if (pref === "auto") window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, pref);
  } catch {
    /* storage off: the choice lasts until the next load */
  }
}

let gpu: boolean | undefined;
/** True when WebGL runs on the GPU. Probes once per load on a throwaway canvas, then frees the context. */
export function hasHardwareGL(): boolean {
  if (gpu !== undefined) return gpu;
  gpu = false;
  let gl: WebGLRenderingContext | null = null;
  try {
    const c = document.createElement("canvas");
    const opts = { failIfMajorPerformanceCaveat: true };
    gl = (c.getContext("webgl2", opts) || c.getContext("webgl", opts)) as WebGLRenderingContext | null;
    if (gl) {
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
      gpu = !SOFTWARE_GL.test(renderer);
    }
  } catch {
    gpu = false;
  } finally {
    try { gl?.getExtension("WEBGL_lose_context")?.loseContext(); } catch { /* best-effort release */ }
  }
  return gpu;
}

type NavigatorHints = Navigator & {
  deviceMemory?: number;
  connection?: { saveData?: boolean; effectiveType?: string };
};

export function landingMode(pref: MotionPref = readMotionPref()): LandingMode {
  const osReduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const still = pref === "off" || (pref === "auto" && osReduce);
  if (still) return { still, no3d: true, reason: "motion off" };
  const nav = navigator as NavigatorHints;
  if (nav.connection?.saveData) return { still, no3d: true, reason: "save-data" };
  if (/(^|-)2g$/.test(nav.connection?.effectiveType ?? "")) return { still, no3d: true, reason: "slow connection" };
  if ((nav.deviceMemory ?? 8) <= 2 || (nav.hardwareConcurrency ?? 8) <= 2) return { still, no3d: true, reason: "low-end device" };
  if (!hasHardwareGL()) return { still, no3d: true, reason: "no hardware-accelerated WebGL" };
  return { still, no3d: false, reason: "" };
}
