"use client";
// Research agent side chat. Narrates facts with source + provenance, lets the person keep or fix them,
// and remixes the art (a remix pushes a new DesignVersion). Rule-based unless the server has a model;
// rule-based replies are labelled "simulated agent".

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ArtLayer, DesignVersion, Fact, Provenance, Stub } from "../types";
import { currentVersion } from "../types";
import { askAgent, remixArt } from "../research/client";
import styles from "./AgentChat.module.css";

type Msg =
  | { id: string; role: "agent"; kind: "facts" }
  | { id: string; role: "agent"; kind: "text"; text: string; provenance?: Provenance; by: "simulated" | "live" }
  | { id: string; role: "user"; text: string };

const SUGGESTIONS = ["Make it moodier", "Add the weather", "Use my photo"] as const;

const rid = () => Math.random().toString(36).slice(2, 10);

function shortDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

/** Downscale a photo so it fits local storage. */
function readPhoto(file: File, max = 1200): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read"));
    reader.onload = () => {
      const src = String(reader.result);
      const img = new Image();
      img.onerror = () => reject(new Error("decode"));
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        const ctx = c.getContext("2d");
        if (!ctx) return resolve(src);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", 0.82));
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  });
}

export function AgentChat(props: { stub: Stub; onChange: (s: Stub) => void; onClose?: () => void }) {
  const { stub } = props;
  const inputId = useId();
  const [messages, setMessages] = useState<Msg[]>(() => [{ id: "facts", role: "agent", kind: "facts" }]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | undefined>();
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Latest stub/onChange for async handlers.
  const stubRef = useRef(stub);
  const onChangeRef = useRef(props.onChange);
  useLayoutEffect(() => {
    stubRef.current = stub;
    onChangeRef.current = props.onChange;
  });

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const say = (text: string, by: "simulated" | "live" = "simulated", provenance?: Provenance) =>
    setMessages((m) => [...m, { id: rid(), role: "agent", kind: "text", text, by, provenance }]);
  const userSays = (text: string) => setMessages((m) => [...m, { id: rid(), role: "user", text }]);

  const commit = (next: Stub) => {
    stubRef.current = next;
    onChangeRef.current(next);
  };

  const updateFact = (index: number, patch: Partial<Fact>) => {
    const s = stubRef.current;
    const facts = s.event.facts.map((f, i) => (i === index ? { ...f, ...patch } : f));
    const target = s.event.facts[index];
    const event = { ...s.event, facts };
    if (target?.id === "date" && patch.value && /^\d{4}-\d{2}-\d{2}$/.test(patch.value)) event.dateISO = patch.value;
    commit({ ...s, event });
  };

  const pickAlternative = (index: number, alt: string) => {
    const f = stubRef.current.event.facts[index];
    if (!f) return;
    const isDate = /^\d{4}-\d{2}-\d{2}$/.test(alt);
    updateFact(index, { value: alt, label: isDate ? shortDate(alt) : alt, confidence: 1, kept: true });
    say(`Fixed. ${isDate ? shortDate(alt) : alt} is on your stub.`);
  };

  const remix = async (vibe: string) => {
    setBusy("Remixing the art…");
    try {
      const art: ArtLayer = await remixArt(stubRef.current, vibe);
      const s = stubRef.current;
      const cur = currentVersion(s);
      const v: DesignVersion = {
        id: `v${s.versions.length + 1}-${rid()}`,
        parentId: cur?.id,
        edition: cur?.edition ?? "researched",
        art,
        createdAt: new Date().toISOString(),
      };
      commit({ ...s, versions: [...s.versions, v], currentVersionId: v.id });
      say(
        art.provenance === "live" ? "Remixed the art. Your text and edits are kept." : "Remixed the art. Your text and edits are kept. This art is a simulated preview.",
        "simulated",
        art.provenance,
      );
    } catch (e) {
      say(e instanceof Error ? e.message : "We couldn't remix the art. Try again in a moment.");
    } finally {
      setBusy(undefined);
    }
  };

  const addWeather = () => {
    const facts = stubRef.current.event.facts;
    const i = facts.findIndex((f) => f.id === "weather");
    const f = facts[i];
    if (!f || f.provenance === "pending") {
      say("No weather for this date yet. It stays pending until we can confirm it.", "simulated", "pending");
      return;
    }
    updateFact(i, { kept: true });
    say(`Added the weather: ${f.label}. Source: ${f.source}.`, "simulated", f.provenance);
  };

  const onPhoto = async (file: File | undefined) => {
    if (!file) return;
    setBusy("Adding your photo…");
    try {
      const data = await readPhoto(file);
      const s = stubRef.current;
      commit({ ...s, photos: [...s.photos, data] });
      say("Added your photo to the stub. It stays on this device.");
    } catch {
      say("We couldn't read that photo. Try a JPG or PNG.");
    } finally {
      setBusy(undefined);
    }
  };

  const handle = async (raw: string) => {
    const text = raw.trim();
    if (!text || busy) return;
    userSays(text);
    const t = text.toLowerCase();
    if (/\bweather\b|\brain\b|\btemperature\b/.test(t) && !/\bmood|remix|art\b/.test(t)) return addWeather();
    if (/\bphoto\b|\bpicture\b|\bimage of mine\b/.test(t)) {
      say("Choose a photo to add to your stub.");
      fileRef.current?.click();
      return;
    }
    if (t.endsWith("?")) {
      setBusy("Thinking…");
      try {
        const live = await askAgent(stubRef.current, text);
        if (live) return say(live.reply, "live");
        return say("I can keep facts, fix unsure ones and remix the art. Try “Make it moodier”.");
      } catch (error) {
        return say(error instanceof Error ? error.message : "The agent is unavailable. Try again in a moment.");
      } finally {
        setBusy(undefined);
      }
    }
    return remix(text);
  };

  const facts = stub.event.facts;
  const keptCount = facts.filter((f) => f.kept).length;

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>
          Research agent <span className="provenance">{messages.some((m) => m.role === "agent" && m.kind === "text" && m.by === "live") ? "rules + live model" : "simulated agent"}</span>
        </span>
        {props.onClose ? (
          <button type="button" className={styles.close} onClick={props.onClose} aria-label="Close the chat">
            ×
          </button>
        ) : null}
      </div>

      <div className={styles.list} ref={listRef} aria-live="polite">
        {messages.map((m) => {
          if (m.role === "user") {
            return (
              <div key={m.id} className={`${styles.msg} ${styles.user}`}>
                {m.text}
              </div>
            );
          }
          if (m.kind === "facts") {
            return (
              <div key={m.id} className={`${styles.msg} ${styles.agent}`}>
                <p>
                  {facts.length
                    ? `Found ${facts.length} ${facts.length === 1 ? "fact" : "facts"} for ${stub.event.title}. Keep the ones you want printed on your stub.`
                    : `No facts found for ${stub.event.title} yet.`}
                </p>
                <ul className={styles.facts}>
                  {facts.map((f, i) => {
                    const unsure = f.confidence < 0.8 && f.provenance !== "pending";
                    return (
                      <li key={`${f.id}-${i}`} className={`${styles.fact} ${unsure ? styles.factUnsure : ""}`}>
                        <div className={styles.factRow}>
                          <span className={styles.factLabel}>{f.label}</span>
                          <button
                            type="button"
                            className="chip"
                            aria-pressed={!!f.kept}
                            disabled={f.provenance === "pending"}
                            onClick={() => updateFact(i, { kept: !f.kept })}
                          >
                            {f.kept ? "Kept ✓" : "Keep on stub"}
                          </button>
                        </div>
                        <div className={styles.meta}>
                          {f.sourceUrl ? (
                            <a href={f.sourceUrl} target="_blank" rel="noreferrer noopener">
                              {f.source}
                            </a>
                          ) : (
                            <span>{f.source}</span>
                          )}
                          <span className="provenance">{f.provenance}</span>
                        </div>
                        {unsure ? (
                          <>
                            <span className={styles.ask}>Is this right?</span>
                            {f.alternatives?.length ? (
                              <div className={styles.alts}>
                                {f.alternatives.map((alt) => {
                                  const isDate = /^\d{4}-\d{2}-\d{2}$/.test(alt);
                                  return (
                                    <button key={alt} type="button" className="chip" aria-pressed={f.value === alt && f.confidence >= 1} onClick={() => pickAlternative(i, alt)}>
                                      {isDate ? shortDate(alt) : alt}
                                    </button>
                                  );
                                })}
                              </div>
                            ) : (
                              <div className={styles.alts}>
                                <button type="button" className="chip" onClick={() => updateFact(i, { confidence: 1, kept: true })}>
                                  Yes, keep it
                                </button>
                              </div>
                            )}
                          </>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
                <div className={styles.meta}>
                  <span>{keptCount} kept</span>
                </div>
              </div>
            );
          }
          return (
            <div key={m.id} className={`${styles.msg} ${styles.agent}`}>
              <p>{m.text}</p>
              <div className={styles.meta}>
                {m.provenance ? <span className="provenance">art: {m.provenance}</span> : null}
                <span className="provenance">{m.by === "live" ? "agent: live" : "simulated agent"}</span>
              </div>
            </div>
          );
        })}
        {busy ? <div className={`${styles.msg} ${styles.agent} ${styles.typing}`}>{busy}</div> : null}
      </div>

      <div className={styles.suggest}>
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" className="chip" disabled={!!busy} onClick={() => void handle(s)}>
            {s}
          </button>
        ))}
      </div>

      <form
        className={styles.composer}
        onSubmit={(e) => {
          e.preventDefault();
          const t = draft;
          setDraft("");
          void handle(t);
        }}
      >
        <label htmlFor={inputId} className="label">
          Ask for a change
        </label>
        <div className={styles.composerRow}>
          <input
            id={inputId}
            className={styles.input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Make it feel like a summer night"
            autoComplete="off"
            enterKeyHint="send"
          />
          <button type="submit" className="btn btn-primary" disabled={!draft.trim() || !!busy}>
            Send
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            void onPhoto(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </form>
    </div>
  );
}
