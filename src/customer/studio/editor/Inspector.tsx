"use client";
// The desktop inspector: collapsible paper panels (Selected, Facts, Material & finish, Memories)
// built from the desk parts. Opening and closing a panel plays the sheet cues.
import { useId, useState, type ReactNode } from "react";
import type { Stub } from "../types";
import { currentVersion } from "../types";
import { EDITION_META } from "@/customer/studio/stub/editions";
import { play } from "@/customer/studio/feedback";
import { PaperButton, PunchTabs, Switch, Tag, Tags, TearLink } from "@/customer/desk/Desk";
import { canHide, fontName, hiddenLabel, hideSelection, setFont, setHidden, setTitleColour, swatchLabel, TITLE_SWATCHES, toggleFoil, type Selectable } from "./ops";
import { includedExtraFacts } from "../facts/inclusion";
import { FactsReview, openCount } from "../facts/FactsReview";
import { VersionsPanel } from "../versions/VersionsPanel";
import { MaterialPicker } from "./MaterialPicker";
import { Memories } from "./Memories";
import styles from "./Inspector.module.css";

function Chevron() {
  return (
    <svg className={styles.chevron} viewBox="0 0 24 24" aria-hidden="true">
      <path d="m8 10 4 4 4-4" />
    </svg>
  );
}

/** A paper panel that folds. The heading is a button; the body opens with the paper. */
export function DeskPanel({ title, meta, defaultOpen = true, children }: { title: string; meta?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <section className={styles.panel} data-open={open}>
      <h2 className={styles.panelHead}>
        <button
          type="button"
          className={styles.panelButton}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => {
            play(open ? "close" : "open", { emphasis: "subtle" });
            setOpen(!open);
          }}
        >
          <span className={styles.panelTitle}>{title}</span>
          {meta ? <span className={styles.panelMeta}>{meta}</span> : null}
          <Chevron />
        </button>
      </h2>
      <div className={styles.panelBody} id={id} role="region" aria-label={title} inert={!open}>
        <div className={styles.panelInner}>{children}</div>
      </div>
    </section>
  );
}

interface Props {
  stub: Stub;
  selected: Selectable | null;
  onChange: (s: Stub) => void;
  onToggleFact: (projectId: string, factId: string) => void;
  onDeselect: () => void;
  onRemix: () => void;
}

export function Inspector({ stub, selected: sel, onChange, onToggleFact, onDeselect, onRemix }: Props) {
  const meta = EDITION_META[currentVersion(stub).edition];
  const fonts = (meta?.fontPairs ?? []).map((stack, i) => ({ value: String(i), label: fontName(stack, `Font ${i + 1}`), stack }));
  const hidden = stub.personal.hiddenFields;

  return (
    <>
      <DeskPanel title="Selected" meta={sel ? { title: "Title", subtitle: "Subtitle", facts: "Fact line", art: "Art" }[sel] : undefined}>
        {!sel && <p className={styles.hint}>Click the title, subtitle, facts or art on the stub to edit it.</p>}
        {(sel === "title" || sel === "subtitle") && (
          <div className={styles.stack}>
            <span className="desk-label">Font</span>
            <PunchTabs
              label="Font"
              options={fonts.map((f) => ({ value: f.value, label: f.label }))}
              value={String(stub.personal.titleFont)}
              onChange={(v) => onChange(setFont(stub, Number(v) as 0 | 1 | 2 | 3))}
            />
            <span className="desk-label">Colour · {swatchLabel(stub.personal.titleColor)}</span>
            <div role="radiogroup" aria-label="Title colour" className={styles.swatches}>
              {TITLE_SWATCHES.map((sw) => (
                <button
                  key={sw.label}
                  type="button"
                  role="radio"
                  aria-checked={stub.personal.titleColor === sw.value}
                  className={styles.swatch}
                  title={sw.label}
                  onClick={() => {
                    if (stub.personal.titleColor === sw.value) return;
                    play("select");
                    onChange(setTitleColour(stub, sw.value));
                  }}
                >
                  <span className={styles.dot} style={{ background: sw.value || "var(--ts-foil)" }} aria-hidden="true" />
                  <span className="visually-hidden">{sw.label}</span>
                </button>
              ))}
            </div>
            <Switch checked={stub.personal.foilTitle} onChange={() => onChange(toggleFoil(stub))} hint="A foil title catches the light">
              Foil title
            </Switch>
            {canHide(sel) && (
              <TearLink
                onClick={() => {
                  onChange(hideSelection(stub, sel));
                  onDeselect();
                }}
              >
                Hide the subtitle
              </TearLink>
            )}
          </div>
        )}
        {sel === "art" && (
          <div className={styles.stack}>
            <p className={styles.hint}>Each remix is kept, so you can always go back.</p>
            <PaperButton onClick={onRemix}>Remix the art</PaperButton>
          </div>
        )}
        {sel === "facts" && (
          <TearLink
            onClick={() => {
              onChange(hideSelection(stub, "facts"));
              onDeselect();
            }}
          >
            Hide the fact line
          </TearLink>
        )}
        {hidden.length > 0 && (
          <div className={styles.stack}>
            <span className="desk-label">Hidden on the stub</span>
            <Tags label="Hidden on the stub">
              {hidden.map((f) => (
                <Tag key={f} onClick={() => onChange(setHidden(stub, f, false))}>
                  Show {hiddenLabel(stub, f)}
                </Tag>
              ))}
            </Tags>
          </div>
        )}
      </DeskPanel>

      <DeskPanel
        title="Facts"
        meta={
          <span className={`${styles.num} ${styles.plain}`}>
            {includedExtraFacts(stub).length} extra facts selected{openCount(stub) ? ` · ${openCount(stub)} to answer` : ""}
          </span>
        }
      >
        <FactsReview stub={stub} onChange={onChange} onToggleFact={onToggleFact} />
      </DeskPanel>

      <DeskPanel title="Versions" meta={<span className={`${styles.num} ${styles.plain}`}>{stub.versions.filter((v) => !v.id.startsWith("preview-")).length} made</span>} defaultOpen={false}>
        <VersionsPanel stub={stub} onChange={onChange} layout="side" />
      </DeskPanel>

      <DeskPanel title="Material & finish" meta={<span className={styles.num}>{stub.material} · {stub.finish}</span>}>
        <MaterialPicker stub={stub} onChange={onChange} />
      </DeskPanel>

      <DeskPanel title="Memories" defaultOpen={false}>
        <Memories stub={stub} onChange={onChange} />
      </DeskPanel>
    </>
  );
}
