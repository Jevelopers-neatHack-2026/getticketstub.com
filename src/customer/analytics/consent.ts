// The analytics consent choice: unset until the visitor answers, then granted or denied, kept on this
// device and shared across tabs. It covers optional product analytics only; the server's operational
// logs follow their own policy (docs/operations/analytics.md) and never read or bypass this.

export type ConsentDecision = "granted" | "denied";
export type ConsentState = ConsentDecision | "unset";

export const CONSENT_KEY = "ticketstub.analytics-consent.v1";
/** Fired on window when something asks for the choices panel (a footer link, the privacy page). */
export const CONSENT_OPEN_EVENT = "ticketstub:analytics-consent-open";

type Listener = (state: ConsentState) => void;
const listeners = new Set<Listener>();
let memory: ConsentState | null = null; // this page's answer when storage is off
let watching = false;

function parse(raw: string | null): ConsentState {
  if (!raw) return "unset";
  try {
    const v = JSON.parse(raw) as { v?: unknown; decision?: unknown };
    return v && v.v === 1 && (v.decision === "granted" || v.decision === "denied") ? v.decision : "unset";
  } catch {
    return "unset";
  }
}

export function readConsent(): ConsentState {
  if (typeof window === "undefined") return "unset";
  try {
    const stored = parse(window.localStorage.getItem(CONSENT_KEY));
    return stored === "unset" && memory ? memory : stored;
  } catch {
    return memory ?? "unset";
  }
}

function emit(state: ConsentState) {
  listeners.forEach((l) => {
    try {
      l(state);
    } catch {
      /* a listener's failure never blocks the others */
    }
  });
}

/** Record a decision. Withdrawal is setConsent("denied"). */
export function setConsent(decision: ConsentDecision): void {
  if (typeof window === "undefined") return;
  memory = decision;
  try {
    window.localStorage.setItem(CONSENT_KEY, JSON.stringify({ v: 1, decision }));
  } catch {
    /* storage off: the answer holds for this page and is asked again next visit */
  }
  emit(decision);
}

function onStorage(e: StorageEvent) {
  if (e.key !== CONSENT_KEY && e.key !== null) return;
  memory = null;
  emit(readConsent());
}

/** Follow the choice, including changes made in another tab. */
export function subscribeConsent(listener: Listener): () => void {
  listeners.add(listener);
  if (!watching && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
    watching = true;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && watching) {
      window.removeEventListener("storage", onStorage);
      watching = false;
    }
  };
}

/** Open the analytics choices panel from anywhere (a link on the privacy page, the account page). */
export function openConsentPreferences(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CONSENT_OPEN_EVENT));
}

/** Test-only: forget this page's in-memory answer, as a reload would. */
export function resetConsentForTests(): void {
  memory = null;
}
