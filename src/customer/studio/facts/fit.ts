import type { Fact } from "../types";

export interface FactFit { id: string; label: string; state: "visible" | "blocked" }

/** Check actual laid-out text against every clipping ancestor. DOM presence alone is insufficient. */
export function measureFactFit(root: HTMLElement, requested: Fact[]): FactFit[] {
  const copies = Array.from(root.querySelectorAll<HTMLElement>("[data-fact-id]"));
  return requested.map((fact) => ({ id: fact.id, label: fact.label, state: copies.some((el) => {
    if (el.dataset.factId !== fact.id) return false;
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = Array.from(range.getClientRects());
    if (!rects.length || rects.some((r) => !r.width || !r.height)) return false;
    for (let parent: HTMLElement | null = el; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const bound = parent.getBoundingClientRect();
      const clipX = parent === root || /hidden|clip|scroll|auto/.test(style.overflowX);
      const clipY = parent === root || /hidden|clip|scroll|auto/.test(style.overflowY);
      if (rects.some((r) => (clipX && (r.left < bound.left - 1 || r.right > bound.right + 1)) || (clipY && (r.top < bound.top - 1 || r.bottom > bound.bottom + 1)))) return false;
      if (parent === root) break;
    }
    return true;
  }) ? "visible" : "blocked" }));
}
