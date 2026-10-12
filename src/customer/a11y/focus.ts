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

/** Layout alone is not focusability: visibility and inherited fieldset disability matter too. */
function availableForFocus(el: HTMLElement): boolean {
  if (el.matches(":disabled") || el.closest('[inert], [aria-hidden="true"]') || !el.getClientRects().length) return false;
  const visibility = getComputedStyle(el).visibility;
  return visibility !== "hidden" && visibility !== "collapse";
}

export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0 && availableForFocus(el));
}

/** Named radios share one sequential stop within their form; arrow keys stay native. */
function sameRadioGroup(a: HTMLElement, b: HTMLElement): boolean {
  return a instanceof HTMLInputElement && b instanceof HTMLInputElement && a.type === "radio" && b.type === "radio"
    && a.name !== "" && a.name === b.name && a.form === b.form && a.getRootNode() === b.getRootNode();
}

function tabStops(root: HTMLElement, reverse: boolean): HTMLElement[] {
  const list = focusables(root);
  return list.filter((el) => {
    if (!(el instanceof HTMLInputElement) || el.type !== "radio" || !el.name) return true;
    const group = list.filter((other) => sameRadioGroup(el, other)) as HTMLInputElement[];
    return el === (group.find((other) => other.checked) ?? group[reverse ? group.length - 1 : 0]);
  }).sort((a, b) => {
    // Positive tabindex precedes the ordinary DOM-order stops. Equal values retain DOM order.
    if (a.tabIndex === b.tabIndex) return 0;
    if (a.tabIndex === 0) return 1;
    if (b.tabIndex === 0) return -1;
    return a.tabIndex - b.tabIndex;
  });
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
      const current = document.activeElement;
      if (current instanceof HTMLElement && root.contains(current) && current !== root && availableForFocus(current)) return;
      // Explicit initial targets may have tabindex=-1 (for example a heading), but must still be available.
      const requested = initial && initial !== "self" ? root.querySelector<HTMLElement>(initial) : null;
      const list = focusables(root);
      const target = (initial === "self" ? root : requested && availableForFocus(requested) ? requested : null) ?? list.find((el) => !el.hasAttribute("data-close")) ?? list[0] ?? root;
      target.focus({ preventScroll: true });
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.defaultPrevented) return;
      const at = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const modal = at?.closest('[aria-modal="true"]');
      // Both nested and portaled dialogs own their Tab, even when this trap has no usable controls.
      if (modal && (!at || !root.contains(at) || (modal !== root && root.contains(modal)))) return;
      const list = tabStops(root, e.shiftKey);
      e.preventDefault();
      if (!list.length) {
        root.focus();
        return;
      }
      const first = list[0], last = list[list.length - 1];
      if (!at || !root.contains(at) || at === root) {
        (e.shiftKey ? last : first).focus();
        return;
      }
      const index = list.findIndex((el) => el === at || sameRadioGroup(el, at));
      if (index >= 0) {
        list[(index + (e.shiftKey ? -1 : 1) + list.length) % list.length].focus();
        return;
      }
      // A programmatic heading or a newly unavailable control is not in the sequential list.
      // Continue from its DOM position rather than restarting or entering an excluded neighbour.
      const direction = e.shiftKey ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
      const nearby = focusables(root).filter((el) => list.includes(el) && (at.compareDocumentPosition(el) & direction));
      (e.shiftKey ? nearby[nearby.length - 1] ?? last : nearby[0] ?? first).focus();
    };
    // Let an inner widget consume Tab before applying modal traversal.
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey);
      // Back to the opener, unless focus already went somewhere on purpose (a link that navigated, another dialog).
      const now = document.activeElement;
      if (opener && opener.isConnected && (!now || now === document.body || root.contains(now))) opener.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ref]);
}
