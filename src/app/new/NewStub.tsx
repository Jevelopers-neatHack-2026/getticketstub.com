"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { PaperButton, Stamp } from "@/customer/desk/Desk";
import { LeavesMark } from "@/customer/pages/ui";
import { useIsClient } from "@/customer/studio/editor/useClient";
import type { EventData } from "@/customer/studio/types";
import { DEMO_EVENTS, demoStubId } from "@/customer/studio/fixtures";
import { Printing } from "@/customer/studio/research/Printing";
import { existingStub, inputSource, isDemoKey, keepStubResult } from "@/customer/start/make";
import { errorCode, flow } from "@/customer/flows/events";
import { ManualEvent } from "@/customer/start/ManualEvent";
import { readManualFallback, type ManualFallback } from "@/customer/studio/research/access";
import styles from "./new.module.css";

/** Search results hand their event over through sessionStorage so we don't research it twice. */
export const PICK_KEY = "ticketstub.pick.v1";

function readPicked(): EventData | undefined {
  try {
    const raw = sessionStorage.getItem(PICK_KEY);
    return raw ? (JSON.parse(raw) as EventData) : undefined;
  } catch {
    return undefined;
  }
}

/** The printing desk: cream paper, the printer set on it. */
function Stage({ children }: { children?: React.ReactNode }) {
  return (
    <div className={`desk-surface ${styles.stage}`} aria-busy="true">
      {children}
    </div>
  );
}

export function NewStub() {
  const params = useSearchParams();
  const router = useRouter();
  const url = params.get("url")?.trim() || undefined;
  const q = params.get("q")?.trim() || undefined;
  const demoParam = params.get("demo");
  const demo = isDemoKey(demoParam) ? demoParam : undefined;
  const pick = params.get("pick") === "1";
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState<ManualFallback | undefined>();
  const [manualEvent, setManualEvent] = useState<EventData | undefined>();
  const client = useIsClient();
  const ready = !pick || client;
  const picked = useMemo(() => {
    if (!pick || !client) return undefined;
    const ev = readPicked();
    return ev && (!q || ev.title === q) ? ev : undefined;
  }, [pick, client, q]);
  const done = useRef(false);
  // One id for the whole print so the preview and the finished stub match. A demo has a fixed id.
  const [freshId] = useState(() => Math.random().toString(36).slice(2, 10));
  const stubId = demo ? demoStubId(demo) : freshId;

  const input = useMemo(() => {
    if (manualEvent) return { event: manualEvent };
    const event = demo ? structuredClone(DEMO_EVENTS[demo]) : picked;
    if (event) return { event };
    if (url) return { url };
    if (q) return { query: q };
    return null;
  }, [manualEvent, demo, picked, url, q]);

  // Opening a demo twice reopens the stub that is already on the wall.
  const already = useMemo(() => (client && demo ? existingStub(undefined, demoStubId(demo)) : undefined), [client, demo]);
  // the address itself is the intake here (/new?url=, ?q=, ?demo=): reported once per visit, never its values
  const reported = useRef(false);
  useEffect(() => {
    if (!ready || reported.current || (demo && !client)) return;
    reported.current = true;
    if (!input) flow("intake_invalid", { entry: "new_page", reason: "missing_input" });
    else flow("intake_submit", { entry: "new_page", input_source: inputSource(input, !!picked), result: already ? "reopened" : "accepted" });
  }, [ready, input, already, demo, client, picked]);

  useEffect(() => {
    if (already) router.replace(`/studio/${already.id}`);
  }, [already, router]);

  useEffect(() => {
    if (ready && !input) router.replace("/make");
  }, [ready, input, router]);

  if (manual) return (
    <main className={`desk-surface ${styles.stage} ${styles.errorPage}`}>
      <ManualEvent fallback={manual} onDone={(event) => { setManualEvent(event); setManual(undefined); setError(null); }} onCancel={() => router.push("/make")} />
    </main>
  );

  if (error) {
    return (
      <main className={`desk-surface ${styles.stage} ${styles.errorPage}`}>
        <div className={styles.card} data-announce>
          <h1 className={styles.errorTitle}>We couldn&apos;t read that link.</h1>
          <p className={styles.muted}>{error}</p>
          <div className={styles.actions}>
            <Stamp onClick={() => router.push("/make")}>
              Paste another link
              <LeavesMark />
            </Stamp>
            <PaperButton onClick={() => router.push("/search")}>
              Search for your show
              <LeavesMark />
            </PaperButton>
          </div>
        </div>
      </main>
    );
  }

  if (!ready || !input || already || (demo && !client)) return <Stage />;

  return (
    <Stage>
      <Printing
        input={input}
        stubId={stubId}
        entry="new_page"
        picked={!!picked}
        onDone={(event) => {
          if (done.current) return;
          done.current = true;
          const kept = keepStubResult(event, stubId);
          flow("creation_complete", { entry: "new_page", input_source: inputSource(input, !!picked), result: kept.created ? "created" : "reopened", storage: kept.stored ? "ok" : "failed" });
          const id = kept.id;
          try {
            sessionStorage.removeItem(PICK_KEY);
          } catch {
            /* ignore */
          }
          router.replace(`/studio/${id}`);
        }}
        onError={(message, err) => {
          flow("creation_error", { entry: "new_page", input_source: inputSource(input, !!picked), error_code: errorCode(err) });
          const fallback = readManualFallback((err as { fallback?: unknown } | null)?.fallback);
          if (fallback) { setManual(fallback); return; }
          setError(message || "Try a different link, or search for the show instead.");
        }}
      />
    </Stage>
  );
}
