// A generation action can disable or remove its focused control. Keep that one transition local;
// another focus choice or a later key/pointer action cancels the handoff before it can steal focus.
export interface FocusHandoff {
  finish(target: HTMLElement | null): boolean;
  cancel(): void;
}

export function captureFocusHandoff(origin: HTMLElement | null): FocusHandoff | null {
  if (!origin?.isConnected || origin.ownerDocument.activeElement !== origin || origin.matches(":disabled")) return null;
  const doc = origin.ownerDocument;
  let settled = false;
  const dispose = () => {
    if (settled) return false;
    settled = true;
    doc.removeEventListener("focusin", onFocus, true);
    doc.removeEventListener("pointerdown", onInput, true);
    doc.removeEventListener("keydown", onInput, true);
    return true;
  };
  const onFocus = (event: FocusEvent) => { if (event.target !== origin) dispose(); };
  const onInput = () => { dispose(); };
  doc.addEventListener("focusin", onFocus, true);
  doc.addEventListener("pointerdown", onInput, true);
  doc.addEventListener("keydown", onInput, true);
  return {
    cancel() { dispose(); },
    finish(target) {
      if (!dispose() || origin.ownerDocument !== doc || !target?.isConnected || target.ownerDocument !== doc) return false;
      // A disabled/removed control can leave BODY active without a focusin event. A still-usable control
      // needs no handoff, and an actual new focus choice must be kept even if it was made programmatically.
      if (origin.isConnected && !origin.matches(":disabled")) return false;
      if (doc.activeElement !== origin && doc.activeElement !== doc.body) return false;
      if (target.matches(":disabled, [aria-disabled='true']") || target.closest("[inert], [hidden], [aria-hidden='true']")) return false;
      const box = target.getBoundingClientRect();
      if (!Number.isFinite(box.width) || !Number.isFinite(box.height) || box.width <= 0 || box.height <= 0) return false;
      for (let node: HTMLElement | null = target; node; node = node.parentElement) {
        const style = doc.defaultView?.getComputedStyle(node);
        if (!style || style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) return false;
      }
      target.focus({ preventScroll: true });
      return doc.activeElement === target;
    },
  };
}
