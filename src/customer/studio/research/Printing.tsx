"use client";
// The printing reveal, shared by /new and the start section. It paints no ground of its own: the parent
// supplies the paper desk (desk-surface). The stub feeds out of the printer slot with a slight curl and
// the ink settles, while researched facts arrive as receipt lines. Tap a line to stamp it "Kept".
// Minimum 2.5s on screen, then the ink settles and onDone fires.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { newStub } from "../fixtures";
import type { EventData, Fact } from "../types";
import { StubView } from "@/customer/studio/stub/StubView";
import { haptic, play, stopPrint, type PrintBurst } from "@/customer/studio/feedback";
import { MarkLegend, SourceMark, Stamped, TearLink } from "@/customer/desk/Desk";
import { PathTrack } from "@/customer/wayfinding/PathTrack";
import { researchEvent } from "./client";
import { factGroup, type FactGroup } from "../facts/corrections";
import { GROUP_TITLE, whenLabel } from "../facts/FactsReview";
import { clock, errorCode, flow, since } from "@/customer/flows/events";
import styles from "./Printing.module.css";
import { useReducedMotion } from "@/customer/landing/MotionContext";

const MIN_MS = 2500;
const STAGGER_MS = 450;
const DWELL_MS = 1600;
const TAP_EXTEND_MS = 1500;
const SKIP_AFTER_MS = 3000;
const SETTLE_MS = 750;

/** Verified first, then what is in doubt, then what we could not find. Nothing is corrected yet while the stub is still printing. */
const RECEIPT_ORDER: FactGroup[] = ["source", "unsure", "missing"];

const keyOf = (f: Fact, i: number) => `${f.id}-${i}`;

/** The paper leaves a thermal printer in runs, one per printed band, with short rests between. */
function feedSchedule(seed: string): PrintBurst[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  const rand = () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
  const out: PrintBurst[] = [];
  let at = 0.18;
  for (let i = 0; i < 6; i++) {
    const dur = 0.2 + rand() * 0.2;
    out.push({ at, dur });
    at += dur + 0.1 + rand() * 0.16;
  }
  return out;
}

/** Keyframes for the feed: the paper rises out of the slot top edge first, at one steady speed during
 *  each run, holding in the rests. Halfway out it bows towards you off the rollers, then lies flat once cut. */
function feedKeyframes(schedule: PrintBurst[]): { keyframes: Keyframe[]; duration: number } {
  const last = schedule[schedule.length - 1];
  const total = last.at + last.dur;
  const travel = schedule.reduce((n, b) => n + b.dur, 0);
  const frame = (t: number, p: number, easing = "linear"): Keyframe => ({
    offset: Math.min(1, t / total),
    transform: `translateY(${(100 - p * 100).toFixed(2)}%) rotateX(${(-11 * Math.sin(Math.PI * p)).toFixed(2)}deg)`,
    easing,
  });
  const keyframes: Keyframe[] = [frame(0, 0)];
  let done = 0;
  for (const b of schedule) {
    keyframes.push(frame(b.at, done / travel));
    done += b.dur;
    keyframes.push(frame(b.at + b.dur, done / travel));
  }
  return { keyframes, duration: total * 1000 };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The headline names what is being looked up, from the event data: "Finding 12 October in Glasgow…". */
function findingLine(event?: EventData): string {
  if (!event) return "Finding your night…";
  const m = event.dateISO ? /^(\d{4})-(\d{2})-(\d{2})/.exec(event.dateISO) : null;
  const date = m && MONTHS[Number(m[2]) - 1] ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : "";
  const city = event.city?.trim();
  const place = !city ? "" : /^online$/i.test(city) ? "online" : `in ${city}`;
  if (date && place) return `Finding ${date} ${place}…`;
  if (date) return `Finding ${date}…`;
  if (place) return `Finding the night ${place}…`;
  return `Finding ${event.title}…`;
}

/** Push the auto-advance deadline out so a person can finish tapping facts (event-time only). */
function extendDeadline(ref: { current: number }) {
  ref.current = Math.max(ref.current, Date.now() + TAP_EXTEND_MS);
}

export function Printing(props: {
  input: { url?: string; query?: string; event?: EventData };
  /** Id the finished stub will carry, so the preview prints the same number and art. */
  stubId?: string;
  /** Which screen is printing (analytics only). */
  entry?: "home" | "make" | "new_page";
  /** A handed-in event is a demo unless the caller says it was picked from search (analytics only). */
  picked?: boolean;
  onDone: (event: EventData) => void;
  /** `error` is what research threw, for its bounded code; the message is already the person's copy. */
  onError: (message: string, error?: unknown) => void;
}) {
  const { input } = props;
  const entry = props.entry ?? "new_page";
  const source = input.event ? (props.picked ? "picked" : "demo") : input.url ? "link" : "query";
  const reduced = useReducedMotion();
  const [event, setEvent] = useState<EventData | undefined>(input.event);
  const [staggered, setShown] = useState(0);
  const [kept, setKept] = useState<Record<string, boolean>>(() =>
    Object.fromEntries((input.event?.facts ?? []).map((f, i) => [keyOf(f, i), !!f.kept])),
  );
  const [showSkip, setShowSkip] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [settling, setSettling] = useState(false);

  // Refs mirror state for the finish timer (no stale closures).
  const onDoneRef = useRef(props.onDone);
  const onErrorRef = useRef(props.onError);
  const eventRef = useRef(event);
  const keptRef = useRef(kept);
  const shownRef = useRef(0);
  const reducedRef = useRef(reduced);
  useLayoutEffect(() => {
    onDoneRef.current = props.onDone;
    onErrorRef.current = props.onError;
    eventRef.current = event;
    keptRef.current = kept;
    shownRef.current = reduced ? (event?.facts.length ?? 0) : staggered;
    reducedRef.current = reduced;
  });
  const startRef = useRef(0);
  const deadlineRef = useRef(0);
  const skipRef = useRef(false);
  // the print's own clock for analytics, set once: a Strict Mode re-run of the effect must not restart it or report twice
  const begunRef = useRef<number | null>(null);
  const researchedAt = useRef<number | null>(null);
  const finishingRef = useRef(false);
  const feedRef = useRef<HTMLDivElement>(null);
  const schedule = useMemo(() => feedSchedule(props.stubId ?? input.url ?? input.query ?? "stub"), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Printer sound, skip link, finish checker.
  useEffect(() => {
    startRef.current = Date.now();
    finishingRef.current = false;
    if (begunRef.current === null) {
      begunRef.current = clock();
      flow("creation_start", { entry, input_source: source });
    }
    try {
      play("print", { schedule });
    } catch {
      /* sound is optional */
    }
    let stopped = false;
    const skipTimer = window.setTimeout(() => { if (!stopped) setShowSkip(true); }, SKIP_AFTER_MS);
    let doneTimer: number | undefined;

    const finish = () => {
      const ev = eventRef.current;
      if (stopped || !ev || finishingRef.current) return;
      finishingRef.current = true;
      try {
        stopPrint();
        play("done");
        if (!reducedRef.current) haptic([18, 40, 28]);
      } catch {
        /* feedback is optional */
      }
      setSettling(true);
      const final: EventData = {
        ...ev,
        facts: ev.facts.map((f, i) => ({ ...f, kept: !!keptRef.current[keyOf(f, i)] })),
      };
      // the reveal runs from when the facts were in hand (research done, or handed in) to the ink settling
      flow("reveal_complete", { entry, skipped: skipRef.current, duration_ms: since(researchedAt.current ?? begunRef.current ?? clock()), fact_count: final.facts.length, kept_count: final.facts.filter((f) => f.kept).length });
      doneTimer = window.setTimeout(() => { if (!stopped) onDoneRef.current(final); }, reducedRef.current ? 0 : SETTLE_MS);
    };

    const tick = window.setInterval(() => {
      if (stopped) return;
      const ev = eventRef.current;
      if (!ev || finishingRef.current) return;
      if (skipRef.current) return finish();
      const allShown = shownRef.current >= ev.facts.length;
      if (!allShown) return;
      if (!deadlineRef.current) {
        deadlineRef.current = Math.max(startRef.current + MIN_MS, Date.now() + (reducedRef.current ? 800 : DWELL_MS));
      }
      // Someone working through the lines with the keyboard has not finished: the page waits while focus is on a line.
      const here = document.activeElement;
      if (here instanceof HTMLElement && here.closest("[data-receipt]") && deadlineRef.current) extendDeadline(deadlineRef);
      if (Date.now() >= deadlineRef.current) finish();
    }, 100);

    return () => {
      stopped = true;
      window.clearTimeout(skipTimer);
      window.clearInterval(tick);
      if (doneTimer !== undefined) window.clearTimeout(doneTimer);
      try {
        stopPrint();
      } catch {
        /* ignore */
      }
    };
  }, [schedule]); // eslint-disable-line react-hooks/exhaustive-deps -- schedule, entry and source are fixed for the life of the print

  // Feed the paper out in runs, in step with the printer's ticks. One feed: the blank paper and the
  // printed stub share it, so the stub never jumps back into the slot when the research lands.
  useEffect(() => {
    const el = feedRef.current;
    if (!el || reduced || typeof el.animate !== "function") return;
    const { keyframes, duration } = feedKeyframes(schedule);
    const anim = el.animate(keyframes, { duration, fill: "forwards" });
    return () => anim.cancel();
  }, [reduced, schedule]);

  // Research when no event was handed in.
  const url = input.url;
  const query = input.query;
  const hasEvent = !!input.event;
  useEffect(() => {
    if (hasEvent) {
      researchedAt.current ??= clock();
      return;
    }
    let cancelled = false;
    const asked = clock();
    researchEvent({ url, query })
      .then((ev) => {
        if (cancelled) return;
        researchedAt.current = clock();
        flow("research_complete", { entry, input_source: url ? "link" : "query", result: "success", duration_ms: since(asked), fact_count: ev.facts.length });
        setKept(Object.fromEntries(ev.facts.map((f, i) => [keyOf(f, i), !!f.kept])));
        setEvent(ev);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        flow("research_complete", { entry, input_source: url ? "link" : "query", result: "error", duration_ms: since(asked), error_code: errorCode(err) });
        try {
          stopPrint();
        } catch {
          /* ignore */
        }
        onErrorRef.current(err instanceof Error && err.message ? err.message : "We couldn't read that link.", err);
      });
    return () => {
      cancelled = true;
    };
  }, [url, query, hasEvent]); // eslint-disable-line react-hooks/exhaustive-deps -- entry is fixed for the print

  // Stagger fact cards in as they arrive.
  const factCount = event?.facts.length ?? 0;
  // Reduced motion shows every fact at once; otherwise cards stagger in.
  const shown = reduced ? factCount : staggered;
  useEffect(() => {
    if (!factCount || reduced) return;
    if (shown >= factCount) return;
    const t = window.setTimeout(() => {
      setShown((n) => Math.min(n + 1, factCount));
      try {
        play("tick");
      } catch {
        /* optional */
      }
    }, shown === 0 ? 250 : STAGGER_MS);
    return () => window.clearTimeout(t);
  }, [factCount, shown, reduced]);

  const toggle = (k: string) => {
    const turningOn = !keptRef.current[k];
    flow("reveal_fact_toggle", { kept: turningOn });
    setKept((m) => ({ ...m, [k]: !m[k] }));
    setTouched((m) => ({ ...m, [k]: true }));
    // The "Kept" stamp plays its own thunk; taking a line off is a quiet tap.
    if (!turningOn) {
      try {
        play("tap", { emphasis: "subtle" });
      } catch {
        /* optional */
      }
    } else if (!reduced) haptic(10);
    // Give the person time to finish choosing.
    extendDeadline(deadlineRef);
  };

  const preview = useMemo(() => {
    if (!event) return undefined;
    return newStub({ ...event, facts: event.facts.map((f, i) => ({ ...f, kept: !!kept[keyOf(f, i)] })) }, props.stubId ?? "printing-preview");
  }, [event, kept, props.stubId]);

  const lines = (event?.facts ?? []).slice(0, shown).map((f, i) => ({ f, i, k: keyOf(f, i) }));
  const marks = [...new Set(lines.map((l) => l.f.provenance))];
  const grouped = useMemo(() => {
    const out: Record<string, FactGroup> = {};
    (event?.facts ?? []).forEach((f, i) => {
      out[keyOf(f, i)] = factGroup({}, f);
    });
    return out;
  }, [event]);
  const allIn = factCount > 0 && shown >= factCount;
  const headline = settling ? "Letting the ink settle…" : allIn ? `Printing ${event?.title ?? "your stub"}…` : findingLine(event);

  return (
    <section className={styles.stage} aria-label="Printing your stub" aria-busy={!settling}>
      <PathTrack current="paste" className={styles.track} />
      <h1 className={styles.headline} key={headline} data-announce>
        {headline}
      </h1>
      <p className={styles.hint}>{shown > 0 ? "Choose a line to keep it on your stub." : " "}</p>

      <div className={styles.layout}>
        <div className={styles.printer}>
          <div className={styles.feedWindow}>
            <div ref={feedRef} className={`${styles.feed} ${reduced ? styles.reduced : ""}`}>
              <div className={`${styles.ink} ${settling ? styles.settling : ""}`}>
                {preview ? <StubView stub={preview} size="md" /> : <div className={styles.placeholder} aria-hidden="true" />}
              </div>
            </div>
          </div>
          <div className={styles.slot} aria-hidden="true" />
          <div className={`${styles.body} ${settling ? styles.bodyDone : ""}`} aria-hidden="true">
            <span className={styles.led} />
          </div>
        </div>

        <div className={`${styles.receipt} ${lines.length ? styles.receiptOn : ""}`} data-receipt aria-hidden={lines.length ? undefined : true}>
          <p className={`desk-label ${styles.receiptHead}`}>What we found</p>
          {RECEIPT_ORDER.map((g) => {
            const inGroup = lines.filter((l) => grouped[l.k] === g);
            if (!inGroup.length) return null;
            return (
              <section key={g} aria-label={GROUP_TITLE[g]}>
                <p className={`desk-label ${styles.groupHead}`}>{GROUP_TITLE[g]}</p>
                <ol className={styles.lines}>
                  {inGroup.map(({ f, k }) => {
                    const on = !!kept[k];
                    const missing = g === "missing";
                    const when = whenLabel(f.retrievedAt);
                    return (
                      <li key={k} className={styles.lineItem}>
                        <button type="button" className={styles.line} aria-pressed={missing ? undefined : on} aria-disabled={missing || undefined} onClick={() => !missing && toggle(k)}>
                          <span className={styles.lineText}>
                            <span className={styles.lineLabel}>
                              {f.label}
                              <SourceMark p={f.provenance} />
                            </span>
                            <span className={styles.lineSource}>
                              {missing ? `Not found on ${f.source}` : f.source}
                              {when ? ` · read ${when}` : ""}
                              {g === "unsure" ? ` · unsure, ${Number.isFinite(f.confidence) ? `${Math.round(f.confidence * 100)}%` : "unknown confidence"}` : ""}
                            </span>
                          </span>
                          <span className={styles.lineAction}>
                            {missing ? (
                              <span className={styles.keep}>Unknown</span>
                            ) : on ? (
                              touched[k] ? (
                                <Stamped>Kept</Stamped>
                              ) : (
                                <span className={styles.keptStatic}>Kept</span>
                              )
                            ) : (
                              <span className={styles.keep}>Keep</span>
                            )}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </section>
            );
          })}
          {lines.some((l) => grouped[l.k] === "unsure" || grouped[l.k] === "missing") ? <p className={styles.fixNote}>Answer what&apos;s unsure or missing in the editor, in Facts.</p> : null}
          {marks.length ? <MarkLegend marks={marks} /> : null}
        </div>
      </div>

      {showSkip && !settling ? (
        <div className={styles.skip}>
          <TearLink
            onClick={() => {
              if (!skipRef.current) flow("reveal_skip", { entry });
              skipRef.current = true;
            }}
          >
            Skip to the stub
          </TearLink>
        </div>
      ) : null}
    </section>
  );
}
