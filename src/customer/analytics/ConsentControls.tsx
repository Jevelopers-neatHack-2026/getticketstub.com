"use client";
// The analytics choice: a small card that asks once, and an "Analytics" tag that reopens it at any time.
// Both answers weigh the same. Nothing is loaded or sent until "Allow"; "Turn off" stops it at once and
// clears Google Analytics' cookies. The card never traps focus or blocks the page behind it.
import Link from "next/link";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { announce } from "@/customer/a11y/announce";
import { PaperButton } from "@/customer/desk/Desk";
import { useMounted } from "@/customer/pages/useMounted";
import { CONSENT_OPEN_EVENT, readConsent, setConsent, subscribeConsent, type ConsentDecision, type ConsentState } from "./consent";
import c from "./consent.module.css";

function useConsent(): ConsentState {
  return useSyncExternalStore(
    (cb) => subscribeConsent(cb),
    readConsent,
    () => "unset",
  );
}

export function ConsentControls() {
  const mounted = useMounted();
  const consent = useConsent();
  const [reopened, setReopened] = useState(false);
  const titleId = useId();
  const cardRef = useRef<HTMLElement>(null);
  const tagRef = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  const open = mounted && (consent === "unset" || reopened);

  useEffect(() => {
    const onOpen = () => {
      returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setReopened(true);
    };
    window.addEventListener(CONSENT_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(CONSENT_OPEN_EVENT, onOpen);
  }, []);

  // A reopened card takes focus (someone asked for it); the first-visit card waits to be reached.
  useEffect(() => {
    if (reopened) cardRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [reopened]);

  const close = () => {
    setReopened(false);
    const back = returnTo.current?.isConnected ? returnTo.current : tagRef.current;
    returnTo.current = null;
    requestAnimationFrame(() => back?.focus());
  };

  const choose = (decision: ConsentDecision) => {
    const was = consent;
    setConsent(decision);
    if (decision !== was) announce(decision === "granted" ? "Analytics is on. Thank you." : "Analytics is off.");
    if (reopened) close();
  };

  if (!mounted) return null;

  return (
    <>
      {open ? (
        <section
          ref={cardRef}
          className={c.card}
          role="region"
          aria-labelledby={titleId}
          onKeyDown={(e) => {
            if (e.key === "Escape" && consent !== "unset") {
              e.stopPropagation();
              close();
            }
          }}
        >
          <h2 id={titleId} className={c.title}>
            {consent === "unset" ? "Help us make TicketStub better?" : consent === "granted" ? "Analytics is on" : "Analytics is off"}
          </h2>
          <p className={c.text}>
            With your OK, Google Analytics counts which pages and steps people use and how fast they load. It sees the
            kind of page (&ldquo;a share page&rdquo;), never your links, stubs, names or what you type. No ads.
          </p>
          <p className={c.small}>
            Change it any time with <strong>Analytics</strong> at the bottom of the screen.{" "}
            <Link href="/privacy" className={c.link}>
              Privacy
            </Link>
          </p>
          <div className={c.row}>
            {consent === "granted" ? (
              <PaperButton type="button" onClick={() => choose("denied")}>
                Turn off analytics
              </PaperButton>
            ) : (
              <PaperButton type="button" onClick={() => choose("granted")}>
                Allow analytics
              </PaperButton>
            )}
            {consent === "unset" ? (
              <PaperButton type="button" onClick={() => choose("denied")}>
                No thanks
              </PaperButton>
            ) : (
              <PaperButton type="button" onClick={close}>
                {consent === "granted" ? "Keep it on" : "Keep it off"}
              </PaperButton>
            )}
          </div>
        </section>
      ) : null}
      {consent !== "unset" && !open ? (
        <button
          ref={tagRef}
          type="button"
          className={c.tag}
          aria-label={`Analytics choices. Analytics is ${consent === "granted" ? "on" : "off"}.`}
          onClick={() => {
            returnTo.current = tagRef.current;
            setReopened(true);
          }}
        >
          Analytics
        </button>
      ) : null}
    </>
  );
}
