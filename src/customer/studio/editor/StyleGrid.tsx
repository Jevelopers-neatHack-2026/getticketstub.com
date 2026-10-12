"use client";
import type { Stub } from "../types";
import { currentVersion } from "../types";
import { StubView } from "@/customer/studio/stub/StubView";
import { STYLES, styleBlurb, styleLabel, styleOf, styleOrientation, type StyleId } from "@/customer/studio/stub/svg/style";
import { PaperSheet } from "@/customer/desk/Desk";
import { previewStyle } from "./ops";
import styles from "./StyleGrid.module.css";

interface GridProps {
  stub: Stub;
  onPick: (style: StyleId) => void;
  /** "rail" is the desktop left rail: smaller cells, the active style described beside them. */
  variant?: "sheet" | "rail";
}

/** Every style with the same data and art, each drawn whole at its own shape. */
export function StyleGridItems({ stub, onPick, variant = "sheet" }: GridProps) {
  const active = styleOf(currentVersion(stub));
  const rail = variant === "rail";
  return (
    <div className={`${styles.grid} ${rail ? styles.rail : ""}`} role="group" aria-label="Styles">
      {STYLES.map((ed) => {
        const blurb = styleBlurb(ed);
        return (
          <button
            key={ed}
            type="button"
            className={styles.cell}
            data-shape={styleOrientation(ed)}
            data-edition={ed}
            aria-pressed={ed === active}
            onClick={() => onPick(ed)}
          >
            <span className={styles.thumb} aria-hidden="true">
              <StubView stub={previewStyle(stub, ed)} size="sm" />
            </span>
            <span className={styles.name}>{styleLabel(ed)}</span>
            {!rail && blurb && <span className={styles.blurb}>{blurb}</span>}
          </button>
        );
      })}
      {rail && (
        <p className={styles.aside}>
          <span className={styles.asideName}>{styleLabel(active)}</span>
          {styleBlurb(active)}
        </p>
      )}
    </div>
  );
}

interface SheetProps extends Omit<GridProps, "variant"> {
  open: boolean;
  onClose: () => void;
}

/** The sheet closes the moment a style is picked, while the stub is dealt behind it. */
export function StyleGrid({ open, onClose, stub, onPick }: SheetProps) {
  return (
    <PaperSheet title="All styles" open={open} onClose={onClose}>
      <div className={styles.sheet}>
        <StyleGridItems
          stub={stub}
          onPick={(ed) => {
            onClose();
            onPick(ed);
          }}
        />
      </div>
    </PaperSheet>
  );
}
