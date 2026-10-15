"use client";
import type { Edition, Stub } from "../types";
import { EDITIONS, currentVersion } from "../types";
import { StubView } from "@/customer/studio/stub/StubView";
import { EDITION_META } from "@/customer/studio/stub/editions";
import { PaperSheet } from "@/customer/desk/Desk";
import { previewEdition } from "./ops";
import styles from "./StyleGrid.module.css";

interface GridProps {
  stub: Stub;
  onPick: (e: Edition) => void;
  /** "rail" is the desktop left rail: smaller cells, the active style described beside them. */
  variant?: "sheet" | "rail";
}

/** All five styles with the same data and art, each drawn whole at its own shape. */
export function StyleGridItems({ stub, onPick, variant = "sheet" }: GridProps) {
  const active = currentVersion(stub).edition;
  const activeMeta = EDITION_META[active];
  const rail = variant === "rail";
  return (
    <div className={`${styles.grid} ${rail ? styles.rail : ""}`} role="group" aria-label="Styles">
      {EDITIONS.map((ed) => {
        const meta = EDITION_META[ed];
        return (
          <button
            key={ed}
            type="button"
            className={styles.cell}
            data-shape={meta?.orientation}
            data-edition={ed}
            aria-pressed={ed === active}
            onClick={() => onPick(ed)}
          >
            <span className={styles.thumb} aria-hidden="true">
              <StubView stub={previewEdition(stub, ed)} size="sm" />
            </span>
            <span className={styles.name}>{meta?.label ?? ed}</span>
            {!rail && meta?.blurb && <span className={styles.blurb}>{meta.blurb}</span>}
          </button>
        );
      })}
      {rail && activeMeta && (
        <p className={styles.aside}>
          <span className={styles.asideName}>{activeMeta.label}</span>
          {activeMeta.blurb}
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
