"use client";
import { useEffect, useId, useRef, useState } from "react";
import { PaperButton, Stamp } from "@/customer/desk/Desk";
import type { EventData } from "@/customer/studio/types";
import { providerLabel, type ManualFallback } from "@/customer/studio/research/access";
import { MANUAL_LIMITS, readManualDetails } from "@/customer/studio/research/manual";
import { createManualEvent, failureCopy } from "@/customer/studio/research/client";
import styles from "./ManualEvent.module.css";

/** The same fallback for the landing desk, /make and direct /new links. */
export function ManualEvent({ fallback, onDone, onCancel }: { fallback: ManualFallback; onDone: (event: EventData) => void; onCancel: () => void }) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const active = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    active.current = true;
    heading.current?.focus();
    return () => { active.current = false; };
  }, []);
  return (
    <section className={styles.paper} aria-labelledby={`${id}-heading`}>
      <p className="desk-label">Make it from your memory</p>
      <h2 id={`${id}-heading`} ref={heading} tabIndex={-1}>Your night. Your details.</h2>
      <p>{providerLabel(fallback.provider)} blocks automated page reads. You can still make a stub by entering the event details.</p>
      <a className={styles.link} href={fallback.url} target="_blank" rel="noopener noreferrer">Open event in your browser <span className="visually-hidden">(new tab)</span></a>
      <p className={styles.note}>Your browser may also show a verification step. Details you enter are marked “Entered by you”.</p>
      <form aria-busy={busy} onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        const form = new FormData(e.currentTarget);
        const details = readManualDetails(Object.fromEntries(["title", "dateISO", "venue", "city"].map((key) => [key, form.get(key)])));
        if (!details) { setError("Enter an event name and a valid date. Check the field lengths."); return; }
        setBusy(true);
        setError("");
        try {
          const event = await createManualEvent(details, fallback.url);
          if (active.current) onDone(event);
        } catch (err) {
          if (active.current) setError(failureCopy(err, "We couldn't save those details. Try again."));
        } finally { if (active.current) setBusy(false); }
      }}>
        <label htmlFor={`${id}-title`}>Event name</label>
        <input id={`${id}-title`} name="title" type="text" defaultValue={fallback.title} maxLength={MANUAL_LIMITS.title} required disabled={busy} autoComplete="off" />
        <label htmlFor={`${id}-date`}>Event date</label>
        <input id={`${id}-date`} name="dateISO" type="date" required disabled={busy} />
        <label htmlFor={`${id}-venue`}>Venue <span>(optional)</span></label>
        <input id={`${id}-venue`} name="venue" type="text" maxLength={MANUAL_LIMITS.venue} disabled={busy} autoComplete="off" />
        <label htmlFor={`${id}-city`}>City <span>(optional, for weather)</span></label>
        <input id={`${id}-city`} name="city" type="text" maxLength={MANUAL_LIMITS.city} disabled={busy} autoComplete="off" />
        <p role="status" className={styles.note}>{error || (busy ? "Preparing your event…" : "Check the details before continuing.")}</p>
        <div className={styles.actions}>
          <Stamp type="submit" disabled={busy}>{busy ? "Preparing…" : "Make my stub"}</Stamp>
          <PaperButton type="button" onClick={onCancel} disabled={busy}>Use another link</PaperButton>
        </div>
      </form>
    </section>
  );
}
