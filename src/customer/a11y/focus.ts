"use client";
// Focus for overlays (GT-11.1): when a dialog opens, focus moves into it; Tab and Shift+Tab stay inside it; when it
// closes, focus goes back to whatever opened it. Esc stays with each dialog, because what Esc means differs.
import { useEffect, type RefObject } from "react";

// What had focus before a dialog took it. A dialog's own autoFocus runs before our effect does, so reading
// document.activeElement when the effect starts would already be inside the dialog. This remembers the last
// control focused outside any modal, which is the one that opened it.
type FocusTarget = HTMLElement | SVGElement;
const isFocusTarget = (el: unknown): el is FocusTarget => el instanceof HTMLElement || el instanceof SVGElement;
const isEditingHost = (el: FocusTarget) => el instanceof HTMLElement && !el.hasAttribute("tabindex")
  && el.isContentEditable && !el.parentElement?.isContentEditable;
let lastOutside: FocusTarget | null = null;
if (typeof document !== "undefined") {
  document.addEventListener(
    "focusin",
    (e) => {
      const t = e.target;
      if (isFocusTarget(t) && t !== document.body && !t.closest('[aria-modal="true"]')) lastOutside = t;
    },
    true,
  );
}

/** Layout alone is not focusability: visibility and inherited fieldset disability matter too. */
function availableForFocus(el: FocusTarget, excludeAriaHidden = true): boolean {
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

export function focusables(root: HTMLElement): FocusTarget[] {
  // Ask the native elements for their tabindex instead of maintaining a partial tag-name list.
  // A top-level editing host is natively sequential even though its default tabIndex is -1.
  return [...root.querySelectorAll("*")].filter(isFocusTarget)
    .filter((el) => (el.tabIndex >= 0 || isEditingHost(el)) && availableForFocus(el));
}

/** Native Tab already understands radios and browser-owned controls. Temporarily make
 * excluded subtrees inert while its default action runs, then restore only our own writes. */
function excludeHiddenForTab(root: HTMLElement): () => void {
  const owned: { el: FocusTarget; name: "inert" | "tabindex"; before: string | null; value: string }[] = [];
  const write = (el: FocusTarget, name: "inert" | "tabindex", value: string) => {
    if (owned.some((item) => item.el === el && item.name === name)) return;
    owned.push({ el, name, before: el.getAttribute(name), value });
    el.setAttribute(name, value);
  };
  for (const el of root.querySelectorAll('[aria-hidden="true"]')) {
    if (el instanceof HTMLElement) {
      if (!el.hasAttribute("inert")) write(el, "inert", "");
    } else if (el instanceof SVGElement) {
      // SVG does not implement HTML's inert attribute. Mask its native stops without
      // changing SVG structure, and restore the exact original tabindex after Tab.
      for (const target of [el, ...el.querySelectorAll("*")].filter(isFocusTarget)) {
        if (target.tabIndex >= 0 || isEditingHost(target)) write(target, "tabindex", "-1");
      }
    }
  }
  const changed = new Map<Node, Set<string>>();
  const observe = (records: MutationRecord[]) => {
    for (const record of records) {
      const names = changed.get(record.target) ?? new Set<string>();
      if (record.attributeName) names.add(record.attributeName);
      changed.set(record.target, names);
    }
  };
  const observer = new MutationObserver(observe);
  for (const { el } of owned) observer.observe(el, { attributes: true, attributeFilter: ["inert", "tabindex"] });
  return () => {
    observe(observer.takeRecords());
    observer.disconnect();
    for (const { el, name, before, value } of owned) {
      // A widget that changes this attribute owns its new value, including same-value
      // writes or removal. Only restore untouched writes made by this key handler.
      if (!changed.get(el)?.has(name) && el.getAttribute(name) === value) {
        if (before === null) el.removeAttribute(name);
        else el.setAttribute(name, before);
      }
    }
  };
}

function sameRadioGroup(a: Element | null, b: FocusTarget): boolean {
  return a instanceof HTMLInputElement && b instanceof HTMLInputElement && a.type === "radio" && b.type === "radio"
    && a.name !== "" && a.name === b.name && a.form === b.form && a.getRootNode() === b.getRootNode();
}

/** Use sequential tabindex order only for modal boundaries; interior movement stays native. */
function boundaryStops(root: HTMLElement): FocusTarget[] {
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
    const here = isFocusTarget(document.activeElement) ? document.activeElement : null;
    const opener = here && !root.contains(here) ? here : lastOutside;
    const parentModal = opener?.closest('[aria-modal="true"]') ?? null;
    if (!root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
    // after paint, so the entering animation never moves focus off the target
    const raf = requestAnimationFrame(() => {
      const current = document.activeElement;
      if (isFocusTarget(current) && root.contains(current) && current !== root && availableForFocus(current)) return;
      // Explicit initial targets may have tabindex=-1 (for example a heading), but must still be available.
      const requested = initial && initial !== "self" ? root.querySelector<FocusTarget>(initial) : null;
      const list = focusables(root);
      const target = (initial === "self" ? root : requested && availableForFocus(requested) ? requested : null) ?? list.find((el) => !el.hasAttribute("data-close")) ?? list[0] ?? root;
      target.focus({ preventScroll: true });
    });
    let restoreHidden: (() => void) | null = null;
    let nativeBoundary: { first: FocusTarget; last: FocusTarget; reverse: boolean } | null = null;
    let restoreTimer: ReturnType<typeof setTimeout> | undefined;
    const restore = () => {
      clearTimeout(restoreTimer);
      restoreHidden?.();
      restoreHidden = null;
    };
    let nativeTabHeld = false;
    const clearBoundary = () => { nativeBoundary = null; nativeTabHeld = false; };
    const onKeyUp = () => { nativeTabHeld = false; };
    const onWindowBlur = () => {
      // A native media control at the document edge can Tab directly into browser
      // chrome without dispatching focusin. Contain only the in-flight Tab default,
      // never a later pointer/window change after its keyup or another key event.
      const boundary = nativeTabHeld ? nativeBoundary : null;
      clearBoundary();
      if (boundary) (boundary.reverse ? boundary.last : boundary.first).focus();
    };
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target;
      if (!nativeBoundary || !isFocusTarget(target) || root.contains(target)) return;
      const modal = target.closest('[aria-modal="true"]');
      // Yield to a newly opened modal, not to the ancestor/portal parent whose
      // control native media navigation just reached while this dialog is active.
      if (modal && modal !== parentModal && !modal.contains(root)) return;
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
      nativeTabHeld = true;
      // A media element's active internal control is not exposed through activeElement.
      // Let the browser traverse it; onFocusIn contains the exit from this modal.
      if (at instanceof HTMLMediaElement && at.controls) return;
      // A focused named radio represents its group even when none is checked.
      // Positive-tabindex containment must not insert its other members as stops.
      const sequential = list.filter((el) => el === at || !sameRadioGroup(at, el));
      const index = sequential.findIndex((el) => el === at);
      const next = index < 0 ? null : sequential[(index + (e.shiftKey ? -1 : 1) + sequential.length) % sequential.length];
      // The document's positive-tabindex phase can otherwise jump to a zero-indexed control
      // outside this modal. Contain that explicit ordering transition, not ordinary native Tab.
      if (isFocusTarget(at) && next && (at.tabIndex > 0 || (e.shiftKey && next.tabIndex > 0))) {
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
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("keydown", onKey);
    window.addEventListener("focusin", onFocusIn);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", clearBoundary, true);
      window.removeEventListener("pointerdown", clearBoundary, true);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onWindowBlur);
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
