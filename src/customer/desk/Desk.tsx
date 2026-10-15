"use client";
// Desk parts: the print-shop controls every studio screen is built from (review page: /parts).
// Each part owns its press, its motion and its sound, so screens never wire feedback by hand.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { useDialogFocus } from "@/customer/a11y/focus";
import { haptic, play, type Cue, type PlayOptions } from "@/customer/studio/feedback";
import type { Provenance } from "@/customer/studio/types";
import s from "./Desk.module.css";
import { CloseIcon, RegistrationIcon } from "./icons";
import { useReducedMotion } from "@/customer/landing/MotionContext";

const SUBTLE: PlayOptions = { emphasis: "subtle" };

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & { children: ReactNode };

/** Pressed state that follows the pointer, plus the part's cue on release. */
function usePress(cue: Cue | null, buzz: number | number[] = 0, opts?: PlayOptions) {
  const reduced = useReducedMotion();
  const [pressed, setPressed] = useState(false);
  const down = useCallback(() => setPressed(true), []);
  const up = useCallback(() => setPressed(false), []);
  const fire = useCallback(() => {
    if (cue) play(cue, opts);
    if (buzz && !reduced) haptic(buzz);
  }, [cue, buzz, opts, reduced]);
  return {
    pressed,
    bind: {
      "data-pressed": pressed,
      onPointerDown: down,
      onPointerUp: up,
      onPointerLeave: up,
      onPointerCancel: up,
    },
    fire,
  };
}

function cx(...names: (string | false | undefined)[]) {
  return names.filter(Boolean).join(" ");
}

/** The one main action on a screen. An optional price rides on its own perforated stub. */
export function Stamp({ children, price, block, className, onClick, ...rest }: ButtonProps & { price?: string; block?: boolean }) {
  const { bind, fire } = usePress("stamp", 12);
  return (
    <button
      {...rest}
      {...bind}
      className={cx(s.stamp, block && s.block, className)}
      onClick={(e) => {
        fire();
        onClick?.(e);
      }}
    >
      <span className={s.stampLabel}>{children}</span>
      {price ? <span className={s.stampStub}>{price}</span> : null}
    </button>
  );
}

/** Secondary action: a raised sheet of card stock. */
export function PaperButton({ children, block, className, onClick, ...rest }: ButtonProps & { block?: boolean }) {
  const { bind, fire } = usePress("tap", 6);
  return (
    <button
      {...rest}
      {...bind}
      className={cx(s.paper, block && s.block, className)}
      onClick={(e) => {
        fire();
        onClick?.(e);
      }}
    >
      {children}
    </button>
  );
}

/** Tertiary action: plain text on a dotted tear line. */
export function TearLink({ children, className, onClick, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      className={cx(s.tearLink, className)}
      onClick={(e) => {
        play("tap", SUBTLE);
        onClick?.(e);
      }}
    >
      {children}
    </button>
  );
}

export function Tools({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div role="toolbar" aria-label={label} className={s.tools}>
      {children}
    </div>
  );
}

/** A small labelled tool beside the stub. `active` marks a tool whose panel is open. */
export function Tool({ icon, children, active, onClick, ...rest }: ButtonProps & { icon: ReactNode; active?: boolean }) {
  const { bind, fire } = usePress("tap", 6, SUBTLE);
  return (
    <button
      {...rest}
      {...bind}
      aria-pressed={active}
      className={s.tool}
      onClick={(e) => {
        fire();
        onClick?.(e);
      }}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

export interface TabOption<T extends string> {
  value: T;
  label: string;
  sub?: string;
}

/** One choice from a few. The selected tab slides over and gets punched. */
export function PunchTabs<T extends string>({ options, value, onChange, label }: { options: TabOption<T>[]; value: T; onChange: (v: T) => void; label: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);

  useLayoutEffect(() => {
    const el = wrap.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(value)}"]`);
    if (!el) return;
    const measure = () => setThumb({ x: el.offsetLeft, w: el.offsetWidth });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [value]);

  const move = (dir: 1 | -1, to?: "first" | "last") => {
    const i = options.findIndex((o) => o.value === value);
    const next = to === "first" ? options[0] : to === "last" ? options[options.length - 1] : options[(i + dir + options.length) % options.length];
    play("select", { direction: dir > 0 ? "forward" : "back" });
    onChange(next.value);
    wrap.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus();
  };

  return (
    <div ref={wrap} role="radiogroup" aria-label={label} className={s.tabs}>
      {thumb ? <span aria-hidden className={s.tabThumb} style={{ transform: `translateX(${thumb.x}px)`, width: thumb.w }} /> : null}
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          data-value={o.value}
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          className={s.tab}
          onClick={() => {
            if (o.value !== value) {
              const from = options.findIndex((x) => x.value === value);
              const to = options.findIndex((x) => x.value === o.value);
              play("select", { direction: to > from ? "forward" : "back" });
              haptic(6);
              onChange(o.value);
            }
          }}
          onKeyDown={(e) => {
            const go = e.key === "ArrowRight" || e.key === "ArrowDown" ? () => move(1) : e.key === "ArrowLeft" || e.key === "ArrowUp" ? () => move(-1) : e.key === "Home" ? () => move(1, "first") : e.key === "End" ? () => move(1, "last") : null;
            if (!go) return;
            e.preventDefault();
            go();
          }}
        >
          <span>{o.label}</span>
          {o.sub ? <span className={s.tabSub}>{o.sub}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** A paper tag. Pass `pressed` to make it a toggle. */
export function Tag({ children, count, countNote, pressed, onClick, ...rest }: ButtonProps & { count?: number; /** What the count counts, said to a screen reader after it ("to check"). */ countNote?: string; pressed?: boolean }) {
  const { bind, fire } = usePress("select", 4);
  return (
    <button
      {...rest}
      {...bind}
      aria-pressed={pressed}
      className={s.tag}
      onClick={(e) => {
        fire();
        onClick?.(e);
      }}
    >
      {children}
      {count !== undefined ? (
        <span className={s.tagCount}>
          <span className="visually-hidden">, </span>
          {count}
          {countNote ? <span className="visually-hidden"> {countNote}</span> : null}
        </span>
      ) : null}
    </button>
  );
}

export function Tags({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className={s.tags} role={label ? "group" : undefined} aria-label={label}>
      {children}
    </div>
  );
}

export type FinishValue = "matte" | "foil" | "holo";

/** Finish picker: a chip of each material, so you choose by look. */
export function FinishSwatches({
  value,
  onChange,
  prices,
  marks,
}: {
  value: FinishValue;
  onChange: (v: FinishValue) => void;
  prices?: Partial<Record<FinishValue, string>>;
  /** A printer's mark after the price for a finish that is only a preview, or can't be ordered. */
  marks?: Partial<Record<FinishValue, "preview" | "blocked">>;
}) {
  const items: { v: FinishValue; label: string }[] = [
    { v: "matte", label: "Matte" },
    { v: "foil", label: "Foil" },
    { v: "holo", label: "Holo" },
  ];
  const wrap = useRef<HTMLDivElement>(null);
  const pick = (v: FinishValue, focus = false) => {
    if (focus) wrap.current?.querySelector<HTMLElement>(`[data-finish="${v}"]`)?.focus();
    if (value === v) return;
    play(v === "matte" ? "select" : "flick");
    haptic(8);
    onChange(v);
  };
  const step = (dir: 1 | -1) => {
    const i = items.findIndex((x) => x.v === value);
    pick(items[(i + dir + items.length) % items.length].v, true);
  };
  return (
    <div ref={wrap} role="radiogroup" aria-label="Finish" className={s.swatches}>
      {items.map((it) => (
        <button
          key={it.v}
          type="button"
          role="radio"
          aria-checked={value === it.v}
          tabIndex={value === it.v ? 0 : -1}
          data-finish={it.v}
          className={s.swatch}
          onKeyDown={(e) => {
            const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
            if (!dir) return;
            e.preventDefault();
            step(dir);
          }}
          onClick={() => {
            if (value === it.v) return;
            play(it.v === "matte" ? "select" : "flick");
            haptic(8);
            onChange(it.v);
          }}
        >
          <span className={s.swatchChip} aria-hidden />
          <span>{it.label}</span>
          {prices?.[it.v] ? (
            <span className={s.swatchPrice}>
              {prices[it.v]}
              {marks?.[it.v] ? <SourceMark p={marks[it.v]!} /> : null}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/** On/off as a paper slider in a slot. */
export function Switch({ checked, onChange, children, hint }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; hint?: ReactNode }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={s.switch}
      onClick={() => {
        play("toggle", { direction: checked ? "back" : "forward" });
        haptic(6);
        onChange(!checked);
      }}
    >
      <span className={s.switchText}>
        <span>{children}</span>
        {hint ? <span className={s.switchHint}>{hint}</span> : null}
      </span>
      <span className={s.switchSlot} aria-hidden>
        <span className={s.switchKnob} />
      </span>
    </button>
  );
}

/** Write on the line. Organizer and checkout only: the fan path has no fields. */
export function Field({ id, label, hint, error, "aria-describedby": describedBy, ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { id: string; label: string; hint?: string; error?: string }) {
  // The hint and the error are the field's description, so a screen reader says them after its name. Required and
  // invalid are states of the input itself (required is announced from the attribute, invalid from aria-invalid).
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const described = [error ? errId : null, hint ? hintId : null, describedBy].filter(Boolean).join(" ") || undefined;
  return (
    <div className={s.field}>
      <label htmlFor={id} className={s.fieldLabel}>
        <span className="desk-label">{label}</span>
        {rest.required ? <span className={s.fieldReq}>Required</span> : null}
      </label>
      <input id={id} className={s.fieldInput} aria-describedby={described} aria-invalid={error ? true : rest["aria-invalid"]} {...rest} />
      {error ? (
        <span id={errId} className={s.fieldError} data-announce>
          {error}
        </span>
      ) : null}
      {hint ? (
        <span id={hintId} className={s.fieldHint}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function Rule({ kind = "single" }: { kind?: "single" | "double" | "perf" }) {
  return <hr className={kind === "double" ? s.ruleDouble : kind === "perf" ? s.rulePerf : s.rule} />;
}

/** Marks for what can be ordered: a preview has no confirmed printer SKU yet, blocked can't be ordered at all. */
export type MarkKind = Provenance | "sandbox" | "preview" | "blocked";

const MARK_WORDS: Record<MarkKind, string> = {
  preview: "Preview, not yet orderable",
  blocked: "Not orderable",
  live: "Live source",
  sandbox: "Sandbox",
  simulated: "Simulated",
  estimated: "Estimate",
  pending: "Not known yet",
};

/** A printer's mark after a fact that says where it came from (EVAL-03), without shouting. */
export function SourceMark({ p }: { p: MarkKind }) {
  return <span className={s.mark} data-p={p} role="img" aria-label={MARK_WORDS[p]} title={MARK_WORDS[p]} />;
}

/** One legend line per screen for the marks used on it. */
export function MarkLegend({ marks }: { marks: MarkKind[] }) {
  return (
    <p className={s.legend}>
      {marks.map((m) => (
        <span key={m}>
          <span className={s.mark} data-p={m} aria-hidden />
          {MARK_WORDS[m]}
        </span>
      ))}
    </p>
  );
}

/** The single sandbox notice for a page that shows prices. */
export function SandboxStrip({ children = "Sandbox prices. Nothing is charged." }: { children?: ReactNode }) {
  return (
    <p className={s.sandbox}>
      <RegistrationIcon />
      {children}
    </p>
  );
}

/** A sheet of paper that slides up (phone) or in from the side (desktop). */
export function PaperSheet({ open, onClose, title, wide, children }: { open: boolean; onClose: () => void; title: string; /** A wider sheet on desktop, for two things side by side. */ wide?: boolean; children: ReactNode }) {
  const opened = useRef(false);
  const box = useRef<HTMLElement>(null);
  const titleId = useId();
  useDialogFocus(box, open);
  useEffect(() => {
    if (open && !opened.current) play("open");
    if (!open && opened.current) play("close");
    opened.current = open;
    if (!open) return;
    // Esc closes the sheet on top only: a sheet opened from inside another leaves the first one open.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const modals = document.querySelectorAll('[aria-modal="true"]');
      if (box.current && modals[modals.length - 1] !== box.current) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className={s.scrim} onClick={onClose} aria-hidden />
      <section ref={box} role="dialog" aria-modal="true" aria-labelledby={titleId} className={cx(s.sheet, wide && s.sheetWide)}>
        <span className={s.sheetGrip} aria-hidden />
        <header className={s.sheetHead}>
          <h2 id={titleId} className={s.sheetTitle}>
            {title}
          </h2>
          <button type="button" className={s.close} onClick={onClose} aria-label={`Close ${title}`} data-close>
            <CloseIcon />
          </button>
        </header>
        {children}
      </section>
    </>
  );
}

/** Confirmation that lands like a rubber stamp ("Kept", "Pinned", "Sent"). */
export function Stamped({ children, say }: { children: ReactNode; /** Announce it. Leave off when the line it sits in is already announced. */ say?: boolean }) {
  useEffect(() => play("success"), []);
  return (
    <span className={s.stamped} data-announce={say ? "" : undefined}>
      {children}
    </span>
  );
}
