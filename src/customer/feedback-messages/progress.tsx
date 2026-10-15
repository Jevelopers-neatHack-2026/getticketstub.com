"use client";
// Honest progress: a screen shows only what it knows. There is no percentage, because nothing here knows one.
// The states are the real ones: idle, sending (the request is out), slow (still waiting past SLOW_MS: "Still
// working..."), unknown (past UNKNOWN_MS the answer hasn't come, so we say we can't tell whether it went
// through), done and failed. A late answer after "unknown" still lands: it moves the state to done or failed.
// A run that was superseded (a newer run, `reset`, or unmount) is stale: it neither moves the state nor hands its
// value to the caller, so a caller can't act on an answer the screen has already moved past.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useAnnounce } from "@/customer/a11y/announce";
import { PaperButton, TearLink } from "@/customer/desk/Desk";
import { codeOf, messageFor, type FeedbackMessage } from "./messages";
import s from "./feedback.module.css";

export const SLOW_MS = 6_000;
export const UNKNOWN_MS = 20_000;

export type Phase = "idle" | "sending" | "slow" | "unknown" | "done" | "failed";
export interface ProgressState {
  phase: Phase;
  /** The catalog code of a failure. Never shown to the person. */
  code?: string;
}

export function useProgress(opts: { slowMs?: number; unknownMs?: number } = {}) {
  const { slowMs = SLOW_MS, unknownMs = UNKNOWN_MS } = opts;
  const [state, setState] = useState<ProgressState>({ phase: "idle" });
  const run$ = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clear = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  // Unmounting ends the current generation: whatever is still in flight is stale and its value is dropped.
  useEffect(
    () => () => {
      run$.current++;
      clear();
    },
    [],
  );

  /** Runs `fn`, tracking only real states. Resolves with its value, or undefined when it failed or was superseded (newer run, reset, unmount). */
  const run = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      const mine = ++run$.current;
      clear();
      setState({ phase: "sending" });
      timers.current = [
        setTimeout(() => run$.current === mine && setState((cur) => (cur.phase === "sending" ? { phase: "slow" } : cur)), slowMs),
        setTimeout(() => run$.current === mine && setState((cur) => (cur.phase === "sending" || cur.phase === "slow" ? { phase: "unknown", code: "timeout" } : cur)), unknownMs),
      ];
      try {
        const value = await fn();
        if (run$.current !== mine) return undefined;
        clear();
        setState({ phase: "done" });
        return value;
      } catch (e) {
        if (run$.current === mine) {
          clear();
          setState({ phase: "failed", code: codeOf(e) });
        }
        return undefined;
      }
    },
    [slowMs, unknownMs],
  );

  const reset = useCallback(() => {
    run$.current++;
    clear();
    setState({ phase: "idle" });
  }, []);

  return { state, run, reset, busy: state.phase === "sending" || state.phase === "slow" };
}

export interface RecoveryHandlers {
  onRetry?: () => void;
  onSignIn?: () => void;
}

/** A message and its way out. `onRetry` and `onSignIn` map the catalog's actions; reload and links are handled here. */
export function FeedbackNote({ code, message, onRetry, onSignIn, children }: { code?: unknown; message?: FeedbackMessage; children?: ReactNode } & RecoveryHandlers) {
  const m = message ?? messageFor(code);
  const a = m.action;
  const act = a?.href ? null : a?.action === "sign-in" ? onSignIn : a?.action === "reload" ? () => window.location.reload() : onRetry;
  // The failure is on screen as text; the screen's one live region says it once, politely.
  useAnnounce(m.message);
  return (
    <div className={s.note} data-failure>
      <p className={s.text}>{m.message}</p>
      {children}
      {a?.href ? (
        <a className={s.link} href={a.href}>
          {a.label}
        </a>
      ) : a && act ? (
        <TearLink type="button" onClick={act}>
          {a.label}
        </TearLink>
      ) : null}
    </div>
  );
}

/** The words for a `useProgress` state (also said through the screen's one live region): what is happening now, and what to do when it isn't going well. */
export function ProgressNote({ state, labels, onRetry, onSignIn }: { state: ProgressState; labels: { sending: string; done?: string } } & RecoveryHandlers) {
  const { phase } = state;
  useAnnounce(phase === "sending" ? labels.sending : phase === "slow" ? "Still working" : phase === "done" ? labels.done : phase === "unknown" ? messageFor("timeout").message : null);
  if (phase === "failed") return <FeedbackNote code={state.code} onRetry={onRetry} onSignIn={onSignIn} />;
  if (phase === "unknown") {
    return (
      <div className={s.note} data-failure>
        <p className={s.text}>{messageFor("timeout").message}</p>
        {onRetry ? (
          <PaperButton type="button" onClick={onRetry}>
            Try again
          </PaperButton>
        ) : null}
      </div>
    );
  }
  return (
    <p className={s.progress} data-phase={phase}>
      {phase === "sending" ? (
        <>
          <span className={s.dot} aria-hidden="true" />
          {labels.sending}
        </>
      ) : phase === "slow" ? (
        <>
          <span className={s.dot} aria-hidden="true" />
          Still working…
        </>
      ) : phase === "done" ? (
        labels.done ?? ""
      ) : null}
    </p>
  );
}
