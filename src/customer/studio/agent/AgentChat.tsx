"use client";
// Research agent chat. Opens only when the person taps Ask or types to the margin notes. Narrates facts
// with a source mark, lets the person keep or fix them, and remixes the art (a remix pushes a new
// DesignVersion). Rule-based unless the server has a model; the mark legend says which one it is.

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ArtLayer, DesignVersion, Fact, Provenance, Stub } from "../types";
import { currentVersion } from "../types";
import { ART_LIMIT_NOTE, askAgent, failureCopy, remixArtNoted } from "../research/client";
import { MarkLegend, PaperButton, SourceMark, Tag, Tags } from "@/customer/desk/Desk";
import { haptic, play } from "@/customer/studio/feedback";
import { activeCorrection, applyCorrection } from "../facts/corrections";
import { artOutcome, clock, errorCode, flow, since } from "@/customer/flows/events";
import styles from "./AgentChat.module.css";

type Msg =
  | { id: string; role: "agent"; kind: "facts" }
  | { id: string; role: "agent"; kind: "text"; text: string; provenance?: Provenance; by: "simulated" | "live" }
  | { id: string; role: "user"; text: string };

const SUGGESTIONS = ["Make it moodier", "Add the weather", "Use my photo"] as const;
const SUGGESTION_KIND = { "Make it moodier": "moodier", "Add the weather": "weather", "Use my photo": "photo" } as const satisfies Record<(typeof SUGGESTIONS)[number], string>;

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

export function AgentChat(props: { stub: Stub; onChange: (s: Stub) => void; /** A line typed into a margin note: sent as the first message. */ initial?: string }) {
  const { stub } = props;
  const inputId = useId();
  const [messages, setMessages] = useState<Msg[]>(() => [{ id: "facts", role: "agent", kind: "facts" }]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | undefined>();
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sentInitial = useRef(false);

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
    commit(applyCorrection(stubRef.current, { factId: f.id, value: alt }));
    say(`Fixed. ${isDate ? shortDate(alt) : alt} is on your stub.`);
  };

  const remix = async (vibe: string) => {
    setBusy("Remixing the art…");
    // what was typed is the vibe; only "custom" is reported
    flow("remix_request", { via: "agent", vibe: "custom" });
    const asked = clock();
    try {
      const { art, limitNote }: { art: ArtLayer; limitNote?: string } = await remixArtNoted(stubRef.current, vibe);
      flow("remix_result", { via: "agent", result: limitNote ? "limited" : "success", ...artOutcome(art), duration_ms: since(asked) });
      const s = stubRef.current;
      const cur = currentVersion(s);
      const v: DesignVersion = {
        id: `v${s.versions.length + 1}-${rid()}`,
        parentId: cur?.id,
        edition: cur?.edition ?? "researched",
        template: cur?.template,
        art,
        createdAt: new Date().toISOString(),
      };
      commit({ ...s, versions: [...s.versions, v], currentVersionId: v.id });
      say(
        limitNote
          ? `${ART_LIMIT_NOTE} Your text and edits are kept.`
          : art.provenance === "live"
            ? "Remixed the art. Your text and edits are kept."
            : "Remixed the art. Your text and edits are kept. This art is a simulated preview.",
        "simulated",
        art.provenance,
      );
    } catch (e) {
      flow("remix_result", { via: "agent", result: "error", duration_ms: since(asked), error_code: errorCode(e) });
      say(failureCopy(e, "We couldn't remix the art. Try again in a moment."));
    } finally {
      setBusy(undefined);
    }
  };

  const addWeather = () => {
    const facts = stubRef.current.event.facts;
    const i = facts.findIndex((f) => f.id === "weather");
    const f = facts[i];
    if (!f || f.provenance === "pending") {
      flow("agent_message", { intent: "weather", result: "pending" });
      say("No weather for this date yet. It stays pending until we can confirm it.", "simulated", "pending");
      return;
    }
    updateFact(i, { kept: true });
    flow("agent_message", { intent: "weather", result: "rules" });
    say(`Added the weather: ${f.label}. Source: ${f.source}.`, "simulated", f.provenance);
  };

  const onPhoto = async (file: File | undefined) => {
    if (!file) return;
    setBusy("Adding your photo…");
    try {
      const data = await readPhoto(file);
      const s = stubRef.current;
      commit({ ...s, photos: [...s.photos, data] });
      flow("photo_add", { via: "agent", result: "success", photo_count: s.photos.length + 1 });
      say("Added your photo to the stub. It stays on this device.");
    } catch {
      flow("photo_add", { via: "agent", result: "error", photo_count: stubRef.current.photos.length });
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
      flow("agent_message", { intent: "photo", result: "rules" });
      say("Choose a photo to add to your stub.");
      fileRef.current?.click();
      return;
    }
    if (t.endsWith("?")) {
      setBusy("Thinking…");
      try {
        const live = await askAgent(stubRef.current, text);
        // a live model reply, or the rules when no model answers (204): never the question or the reply
        flow("agent_message", { intent: "question", result: live ? "live" : "rules" });
        if (live) return say(live.reply, "live");
        return say("I can keep facts, fix unsure ones and remix the art. Try “Make it moodier”.");
      } catch (error) {
        flow("agent_message", { intent: "question", result: "error", error_code: errorCode(error) });
        return say(failureCopy(error, "The agent is unavailable. Try again in a moment."));
      } finally {
        setBusy(undefined);
      }
    }
    flow("agent_message", { intent: "remix", result: "rules" });
    return remix(text);
  };

  useEffect(() => {
    if (sentInitial.current || !props.initial) return;
    sentInitial.current = true;
    void handle(props.initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const facts = stub.event.facts;
  const keptCount = facts.filter((f) => f.kept).length;

  const live = messages.some((m) => m.role === "agent" && m.kind === "text" && m.by === "live");
  const marks: (Provenance | "sandbox")[] = [...new Set<Provenance | "sandbox">([...facts.map((f) => f.provenance), live ? "live" : "simulated"])];

  return (
    <div className={styles.root}>
      <div className={styles.list} ref={listRef} data-announce="added">
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
                    const unsure = f.confidence < 0.8 && f.provenance !== "pending" && !activeCorrection(stub, f.id);
                    return (
                      <li key={`${f.id}-${i}`} className={styles.fact} data-unsure={unsure || undefined}>
                        <div className={styles.factRow}>
                          <span className={styles.factLabel}>
                            {f.label}
                            <SourceMark p={f.provenance} />
                          </span>
                          <Tag pressed={!!f.kept} disabled={f.provenance === "pending"} onClick={() => updateFact(i, { kept: !f.kept })}>
                            {f.kept ? "Kept" : "Keep on stub"}
                          </Tag>
                        </div>
                        <div className={styles.meta}>
                          {f.sourceUrl ? (
                            <a href={f.sourceUrl} target="_blank" rel="noreferrer noopener">
                              {f.source}
                            </a>
                          ) : (
                            <span>{f.source}</span>
                          )}
                        </div>
                        {unsure ? (
                          <>
                            <span className={styles.ask}>Is this right?</span>
                            {f.alternatives?.length ? (
                              <Tags label="Alternatives">
                                {f.alternatives.map((alt) => {
                                  const isDate = /^\d{4}-\d{2}-\d{2}$/.test(alt);
                                  return (
                                    <Tag key={alt} pressed={f.value === alt && !!activeCorrection(stub, f.id)} onClick={() => pickAlternative(i, alt)}>
                                      {isDate ? shortDate(alt) : alt}
                                    </Tag>
                                  );
                                })}
                              </Tags>
                            ) : (
                              <Tags>
                                <Tag onClick={() => commit(applyCorrection(stubRef.current, { factId: f.id, value: f.value }))}>Yes, keep it</Tag>
                              </Tags>
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
              <p>
                {m.text}
                {m.provenance ? <SourceMark p={m.provenance} /> : null}
              </p>
            </div>
          );
        })}
        {busy ? <div className={`${styles.msg} ${styles.agent} ${styles.typing}`}>{busy}</div> : null}
      </div>

      <div className={styles.foot}>
        <Tags label="Suggestions">
          {SUGGESTIONS.map((s) => (
            <Tag
              key={s}
              disabled={!!busy}
              onClick={() => {
                flow("agent_suggestion", { suggestion: SUGGESTION_KIND[s] });
                void handle(s);
              }}
            >
              {s}
            </Tag>
          ))}
        </Tags>

        <form
          className={styles.composer}
          onSubmit={(e) => {
            e.preventDefault();
            const t = draft;
            if (!t.trim()) return;
            setDraft("");
            play("tap", { emphasis: "subtle" });
            haptic(6);
            void handle(t);
          }}
        >
          <label htmlFor={inputId} className="desk-label">
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
            <PaperButton type="submit" disabled={!draft.trim() || !!busy}>
              Send
            </PaperButton>
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
        <MarkLegend marks={marks} />
      </div>
    </div>
  );
}
