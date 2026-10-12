"use client";
// Focus for overlays (GT-11.1): when a dialog opens, focus moves into it; Tab and Shift+Tab stay inside it; when it
// closes, focus goes back to whatever opened it. Esc stays with each dialog, because what Esc means differs.
import { useEffect, type RefObject } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

// What had focus before a dialog took it. A dialog's own autoFocus runs before our effect does, so reading
// document.activeElement when the effect starts would already be inside the dialog. This remembers the last
// control focused outside any modal, which is the one that opened it.
let lastOutside: HTMLElement | null = null;
if (typeof document !== "undefined") {
  document.addEventListener(
    "focusin",
    (e) => {
      const t = e.target;
      if (t instanceof HTMLElement && t !== document.body && !t.closest('[aria-modal="true"]')) lastOutside = t;
    },
    true,
  );
}

export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0 && !el.closest("[inert]") && el.getAttribute("aria-hidden") !== "true" && (el.offsetParent !== null || el === document.activeElement || getComputedStyle(el).position === "fixed"));
}

/**
 * Hold focus inside `ref` while `active`. `initial` picks what gets focus first (a selector inside the dialog);
 * by default the first control, or the dialog itself when it has none ("self" always picks the dialog). Restores focus to the opener on close.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, active: boolean, initial?: string): void {
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    const here = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const opener = here && !root.contains(here) ? here : lastOutside;
    if (!root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
    // after paint, so the entering animation never moves focus off the target
    const raf = requestAnimationFrame(() => {
      if (root.contains(document.activeElement) && document.activeElement !== root) return;
      const target = (initial === "self" ? root : initial ? root.querySelector<HTMLElement>(initial) : null) ?? focusables(root).find((el) => !el.hasAttribute("data-close")) ?? focusables(root)[0] ?? root;
      target.focus({ preventScroll: true });
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const list = focusables(root);
      if (!list.length) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const at = document.activeElement;
      // A dialog opened from inside this one holds Tab itself.
      if (at && !root.contains(at) && at.closest('[aria-modal="true"]')) return;
      if (!root.contains(at)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (at === first || at === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey, true);
      // Back to the opener, unless focus already went somewhere on purpose (a link that navigated, another dialog).
      const now = document.activeElement;
      if (opener && opener.isConnected && (!now || now === document.body || root.contains(now))) opener.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ref]);
}
