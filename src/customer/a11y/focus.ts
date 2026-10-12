"use client";
// Focus for overlays (GT-11.1): when a dialog opens, focus moves into it; Tab and Shift+Tab stay inside it; when it
// closes, focus goes back to whatever opened it. Esc stays with each dialog, because what Esc means differs.
import { useEffect, type RefObject } from "react";

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
function availableForFocus(el: HTMLElement, excludeAriaHidden = true): boolean {
  if (el.matches(":disabled") || el.closest("[inert]") || (excludeAriaHidden && el.closest('[aria-hidden="true"]')) || !el.getClientRects().length) return false;
  // Descendants of closed details can retain layout boxes but are not native keyboard targets.
  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement && !parent.open) {
      const summary = [...parent.children].find((child) => child.tagName === "SUMMARY");
      if (!summary?.contains(el)) return false;
    }
  }
  const visibility = getComputedStyle(el).visibility;
  return visibility !== "hidden" && visibility !== "collapse";
}

export function focusables(root: HTMLElement): HTMLElement[] {
  // Ask the native elements for their tabindex instead of maintaining a partial tag-name list.
  // A top-level editing host is natively sequential even though its default tabIndex is -1.
  return [...root.querySelectorAll<HTMLElement>("*")].filter((el) => el instanceof HTMLElement
    && (el.tabIndex >= 0 || (!el.hasAttribute("tabindex") && el.isContentEditable && !el.parentElement?.isContentEditable))
    && availableForFocus(el));
}

/** Native Tab already understands radios and browser-owned controls. Temporarily make
 * excluded subtrees inert while its default action runs, then restore only our own writes. */
function excludeHiddenForTab(root: HTMLElement): () => void {
  const owned = [...root.querySelectorAll<HTMLElement>('[aria-hidden="true"]')]
    .filter((el) => el instanceof HTMLElement && !el.hasAttribute("inert"));
  const changed = new Set<Node>();
  for (const el of owned) el.setAttribute("inert", "");
  const observer = new MutationObserver((records) => records.forEach((record) => changed.add(record.target)));
  for (const el of owned) observer.observe(el, { attributes: true, attributeFilter: ["inert"] });
  return () => {
    for (const record of observer.takeRecords()) changed.add(record.target);
    observer.disconnect();
    for (const el of owned) {
      // A widget that changes inert after the key handler owns its new value, including removal.
      if (!changed.has(el) && el.getAttribute("inert") === "") el.removeAttribute("inert");
    }
  };
}

/** Use sequential tabindex order only for modal boundaries; interior movement stays native. */
function boundaryStops(root: HTMLElement): HTMLElement[] {
  return focusables(root).filter((el) => {
    if (!(el instanceof HTMLInputElement) || el.type !== "radio" || !el.name) return true;
    const tree = el.getRootNode();
    if (!(tree instanceof Document || tree instanceof ShadowRoot)) return true;
    const checked = [...tree.querySelectorAll<HTMLInputElement>('input[type="radio"]:checked')]
      .find((other) => other.name === el.name && other.form === el.form);
    // A native group can extend outside the modal through form=. Do not promote an
    // unchecked interior member when its checked peer is still keyboard-focusable.
    return !checked || checked === el || checked.tabIndex < 0 || !availableForFocus(checked, false);
  }).sort((a, b) => {
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
    let restoreHidden: (() => void) | null = null;
    let nativeBoundary: { first: HTMLElement; last: HTMLElement; reverse: boolean } | null = null;
    let restoreTimer: ReturnType<typeof setTimeout> | undefined;
    const restore = () => {
      clearTimeout(restoreTimer);
      restoreHidden?.();
      restoreHidden = null;
    };
    const clearBoundary = () => { nativeBoundary = null; };
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target;
      if (!nativeBoundary || !(target instanceof HTMLElement) || root.contains(target)
        || target.closest('[aria-modal="true"]')) return;
      const next = nativeBoundary.reverse ? nativeBoundary.last : nativeBoundary.first;
      // Native controls can own internal focus stops that are opaque to the document.
      // Contain their actual exit rather than intercepting their internal Tab movement.
      nativeBoundary = null;
      next.focus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.defaultPrevented) return;
      const at = document.activeElement;
      const modal = at?.closest('[aria-modal="true"]');
      // A nested or portaled dialog owns its Tab, even when the parent has no usable controls.
      if (modal && (!at || !root.contains(at) || (modal !== root && root.contains(modal)))) return;
      restore();
      restoreHidden = excludeHiddenForTab(root);
      // A task, not a microtask: native sequential navigation runs before these masks are restored.
      restoreTimer = setTimeout(restore, 0);
      const list = boundaryStops(root);
      if (!list.length) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = list[0], last = list[list.length - 1];
      nativeBoundary = { first, last, reverse: e.shiftKey };
      // A media element's active internal control is not exposed through activeElement.
      // Let the browser traverse it; onFocusIn contains the exit from this modal.
      if (at instanceof HTMLMediaElement && at.controls) return;
      const index = list.findIndex((el) => el === at);
      const next = index < 0 ? null : list[(index + (e.shiftKey ? -1 : 1) + list.length) % list.length];
      // The document's positive-tabindex phase can otherwise jump to a zero-indexed control
      // outside this modal. Contain that explicit ordering transition, not ordinary native Tab.
      if (at instanceof HTMLElement && next && (at.tabIndex > 0 || (e.shiftKey && next.tabIndex > 0))) {
        e.preventDefault();
        next.focus();
      } else if (!root.contains(at)) {
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
    // Window bubble runs after target and document-delegated widgets, regardless of registration order.
    // Clear the previous keyboard continuation before a widget handles any new input.
    // Native media can finish a focus transition after the keydown task has ended.
    window.addEventListener("keydown", clearBoundary, true);
    window.addEventListener("pointerdown", clearBoundary, true);
    window.addEventListener("blur", clearBoundary);
    window.addEventListener("keydown", onKey);
    window.addEventListener("focusin", onFocusIn);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", clearBoundary, true);
      window.removeEventListener("pointerdown", clearBoundary, true);
      window.removeEventListener("blur", clearBoundary);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("focusin", onFocusIn);
      clearBoundary();
      restore();
      // Back to the opener, unless focus already went somewhere on purpose (a link that navigated, another dialog).
      const now = document.activeElement;
      if (opener && opener.isConnected && (!now || now === document.body || root.contains(now))) opener.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ref]);
}
