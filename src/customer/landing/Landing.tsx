"use client";
// The landing page: the hero, then `children` (the studio start, on the paper desk), then the rest of the page.
// The markup is the landing page's own (markup.ts), rendered as HTML so its script can drive it exactly as built;
// landing.script.ts runs on mount and stops everything on unmount. The studio start stays a React child in the middle.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { looksLikeLink } from "@/customer/start/make";
import { CHROME_HTML, FOOT_HTML, HERO_HTML, REST_HTML } from "./markup";
import { mountLanding } from "./landing.script";
import { landingMode, readMotionPref, writeMotionPref } from "./motion";
import { MotionOffContext } from "./MotionContext";
import "./landing.css";

/** Where the "Make yours" form sends a night: a pasted link is researched (?url=), anything typed is searched (?q=). */
export function newStubHref(text: string): string {
  const v = text.trim();
  if (looksLikeLink(v)) return `/new?url=${encodeURIComponent(/^https?:\/\//i.test(v) ? v : `https://${v}`)}`;
  return `/new?q=${encodeURIComponent(v)}`;
}

const PARTS = [CHROME_HTML, HERO_HTML, REST_HTML, FOOT_HTML];
const FOCUS_CONTROLS = "a,button,input,select,textarea,[tabindex]";
const FOCUS_ATTRIBUTES = ["id", "href", "name", "data-demo", "aria-label"];
type FocusTarget = {
  host: number;
  tag: string;
  attributes: (string | null)[];
  occurrence: number;
  selection: { start: number | null; end: number | null; direction: "forward" | "backward" | "none" | null } | null;
};
const matchingControls = (host: HTMLElement, target: FocusTarget) => Array.from(host.querySelectorAll<HTMLElement>(FOCUS_CONTROLS))
  .filter((control) => control.tagName === target.tag && FOCUS_ATTRIBUTES.every((name, i) => control.getAttribute(name) === target.attributes[i]));

export function Landing({ children }: { children: ReactNode }) {
  const router = useRouter();
  const root = useRef<HTMLDivElement>(null);
  // bumped by the Motion switch: the landing unmounts and mounts again in the new mode, without a reload
  const [run, setRun] = useState(0);
  const [motionOff, setMotionOff] = useState(false);
  const refocus = useRef<"toggle" | FocusTarget | null>(null); // only raw hosts rebuild; React children retain their own focus

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    // the four landing parts, in page order (the studio start between the hero and the rest is not one of them)
    const hosts = Array.from(el.querySelectorAll<HTMLElement>(".lp-host"));
    if (hosts.length !== PARTS.length) return;
    const mode = landingMode();
    setMotionOff(mode.still);
    el.dataset.motion = mode.still ? "off" : mode.no3d ? "2d" : "3d";
    if (mode.reason) el.dataset.lite = mode.reason;
    else delete el.dataset.lite;
    const pendingFocus = refocus.current;
    refocus.current = null;
    let mounted = false, boardReady = false, live = true, focusRestored = false;
    const restoreFocus = () => {
      if (!live || !pendingFocus || focusRestored) return;
      // Cards are created by the script, some after fonts load. Resolve their replacement when it exists.
      const target = pendingFocus === "toggle" ? el.querySelector<HTMLButtonElement>(".motion-toggle")
        : matchingControls(hosts[pendingFocus.host], pendingFocus)[pendingFocus.occurrence];
      if (!target || (target.closest("#boardUI") && !boardReady)) return;
      if (target.closest("[inert],[hidden]")) return;
      // Respect any control the visitor focused while generated content was pending.
      if (pendingFocus !== "toggle" && document.activeElement !== document.body) { focusRestored = true; return; }
      target.focus({ preventScroll: true });
      if (document.activeElement !== target) return;
      focusRestored = true;
      if (pendingFocus !== "toggle" && pendingFocus.selection && target) {
        const { start, end, direction } = pendingFocus.selection;
        if (start !== null && end !== null) (target as HTMLInputElement).setSelectionRange(start, end, direction ?? "none");
      }
    };
    const stop = mountLanding({ root: el, hosts, mode, submit: (text: string) => router.push(newStubHref(text)), onBoardReady: () => {
      boardReady = true;
      if (mounted) restoreFocus();
    } });
    mounted = true;
    restoreFocus();
    const toggle = el.querySelector<HTMLButtonElement>(".motion-toggle");
    toggle?.setAttribute("aria-pressed", String(mode.still));
    const flip = () => {
      writeMotionPref(mode.still ? "on" : "off");
      refocus.current = "toggle";
      setRun((n) => n + 1);
    };
    toggle?.addEventListener("click", flip);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const followSystem = () => {
      if (readMotionPref() !== "auto") return;
      const active = document.activeElement;
      // A second automatic change may arrive while fonts/content are pending and focus is still on body.
      refocus.current = active === document.body && !focusRestored ? pendingFocus : null;
      if (active === toggle) refocus.current = "toggle";
      else if (active) {
        const host = hosts.findIndex((h) => h.contains(active));
        if (host >= 0) {
          const input = active as HTMLInputElement;
          const target: FocusTarget = { host, tag: active.tagName, attributes: FOCUS_ATTRIBUTES.map((name) => active.getAttribute(name)), occurrence: 0,
            selection: /^(INPUT|TEXTAREA)$/.test(active.tagName) ? { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection } : null };
          target.occurrence = matchingControls(hosts[host], target).indexOf(active as HTMLElement);
          if (target.occurrence >= 0) refocus.current = target;
        }
      }
      setRun((n) => n + 1);
    };
    reducedMotion.addEventListener("change", followSystem);
    return () => {
      live = false;
      toggle?.removeEventListener("click", flip);
      reducedMotion.removeEventListener("change", followSystem);
      stop();
      const input = el.querySelector<HTMLInputElement>("#maker #ev");
      const draft = input ? { value: input.value, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection } : null;
      // the script rebuilt parts of the DOM; hand it back as served so a remount (strict mode, back navigation) starts clean
      hosts.forEach((h, i) => {
        h.innerHTML = PARTS[i];
      });
      const restoredInput = el.querySelector<HTMLInputElement>("#maker #ev");
      if (draft && restoredInput) {
        restoredInput.value = draft.value;
        if (draft.start !== null && draft.end !== null) restoredInput.setSelectionRange(draft.start, draft.end, draft.direction ?? "none");
      }
      el.classList.remove("ready", "no3d", "still");
    };
  }, [router, run]);

  return (
    <div className="lp" ref={root}>
      <div className="lp-host" dangerouslySetInnerHTML={{ __html: PARTS[0] }} />
      <main id="top">
        <div className="lp-host" dangerouslySetInnerHTML={{ __html: PARTS[1] }} />
        <MotionOffContext.Provider value={motionOff}>{children}</MotionOffContext.Provider>
        <div className="lp-host" dangerouslySetInnerHTML={{ __html: PARTS[2] }} />
      </main>
      <div className="lp-host" dangerouslySetInnerHTML={{ __html: PARTS[3] }} />
    </div>
  );
}
