"use client";
// Research agent chat. Opens only when the person taps Ask or types to the margin notes. Narrates facts
// with a source mark, lets the person keep or fix them, and turns a request into typed actions
// (ticketstub.agent-action/1) the owner applies one at a time or all at once. Applying runs the same edit paths the
// editor's own controls use, and what actually happened goes back to the agent for a follow-up. The planner is rule-based
// unless the server has a model; the mark legend says which one it is.

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { Fact, Provenance, Stub } from "../types";
import { failureCopy, planAgent, remixArtNoted } from "../research/client";
import { MarkLegend, PaperButton, SourceMark, Tag, Tags } from "@/customer/desk/Desk";
import { haptic, play } from "@/customer/studio/feedback";
import { activeCorrection, applyCorrection, isIsoDate } from "../facts/corrections";
import { artOutcome, clock, errorCode, flow, since } from "@/customer/flows/events";
import { announce } from "@/customer/a11y/announce";
import { MESSAGE_CODES } from "@/customer/feedback-messages/messages";
import { AGENT_SCHEMA, describeAction, summarize } from "./protocol";
import type { Action, ActionResult, PendingQuestion, ResultStatus } from "./protocol";
import { applyToStub, proceduralArt, withArt } from "./apply";
import styles from "./AgentChat.module.css";

type Msg =
  | { id: string; role: "agent"; kind: "facts" }
  | { id: string; role: "agent"; kind: "text"; text: string; provenance?: Provenance; by: "simulated" | "live"; items?: PlanItem[] }
  | { id: string; role: "user"; text: string };

/** One proposed action in the chat: applied only when the owner taps Apply. */
interface PlanItem {
  key: string;
  action: Action;
}
type ItemState = { status: "applying" | ResultStatus; code?: string };

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

export function AgentChat(props: {
  stub: Stub;
  onChange: (s: Stub) => void;
  /** Flip the editor to the back of the stub (the show_back action). */
  onShowBack?: () => void;
  /** A line typed into a margin note: sent as the first message. */
  initial?: string;
}) {
  const { stub } = props;
  const inputId = useId();
  const [messages, setMessages] = useState<Msg[]>(() => [{ id: "facts", role: "agent", kind: "facts" }]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | undefined>();
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sentInitial = useRef(false);
  const [items, setItems] = useState<Record<string, ItemState>>({});
  const itemsRef = useRef<Record<string, ItemState>>({});
  // what the last follow-up reported: context for the next message
  const lastResults = useRef<ActionResult[]>([]);
  // the question the agent is waiting on: sent with the next message, cleared once it is answered or the topic changes
  const pendingRef = useRef<PendingQuestion | undefined>(undefined);

  // Latest stub/onChange for async handlers.
  const stubRef = useRef(stub);
  const onChangeRef = useRef(props.onChange);
  const onShowBackRef = useRef(props.onShowBack);
  useLayoutEffect(() => {
    stubRef.current = stub;
    onChangeRef.current = props.onChange;
    onShowBackRef.current = props.onShowBack;
  });

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const say = (text: string, by: "simulated" | "live" = "simulated", provenance?: Provenance, plan?: Action[]) =>
    setMessages((m) => [...m, { id: rid(), role: "agent", kind: "text", text, by, provenance, ...(plan?.length ? { items: plan.map((action) => ({ key: rid(), action })) } : {}) }]);
  const setItem = (key: string, state: ItemState) => {
    itemsRef.current = { ...itemsRef.current, [key]: state };
    setItems(itemsRef.current);
  };
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
    const current = stubRef.current;
    const f = current.event.facts[index];
    if (!f) return;
    const value = alt.trim();
    const next = applyCorrection(current, { factId: f.id, value });
    if (next === current) {
      say(f.id === "date" ? "That date was not changed. Choose a real calendar date." : "That answer was not changed. Choose a non-empty answer.");
      return;
    }
    commit(next);
    say(`Fixed. ${f.id === "date" && isIsoDate(value) ? shortDate(value) : value} is on your stub.`);
  };

  /** Carry out one action through the editor's own edit paths and report what actually happened. */
  const runAction = async (action: Action): Promise<ActionResult> => {
    const t0 = clock();
    const done = (status: ResultStatus, code?: string): ActionResult => {
      const known = code && (MESSAGE_CODES as readonly string[]).includes(code) ? (code as (typeof MESSAGE_CODES)[number]) : code === "invalid_value" ? "bad_request" : undefined;
      if (action.type !== "none" && action.type !== "ask_user") flow("agent_action", { action: action.type, result: status, error_code: status === "applied" ? undefined : known, duration_ms: since(t0) });
      play(status === "applied" ? (action.type === "remix_art" ? "remix" : "success") : "tick", { emphasis: "subtle" });
      return { action, status, ...(code ? { code } : {}), ms: since(t0) };
    };
    if (action.type === "remix_art") {
      setBusy(action.procedural ? "Adding procedural art…" : "Remixing the art…");
      if (action.procedural) {
        commit(withArt(stubRef.current, proceduralArt(action.vibe)));
        return done("applied");
      }
      // what was typed is the vibe; only "custom" is reported
      flow("remix_request", { via: "agent", vibe: "custom" });
      const asked = clock();
      try {
        const { art, limitNote } = await remixArtNoted(stubRef.current, action.vibe, action.simulate ? { simulate: action.simulate } : {});
        if (limitNote) {
          // the cap is a failure for the agent: nothing was generated, and the procedural fallback is offered instead
          flow("remix_result", { via: "agent", result: "limited", ...artOutcome(art), duration_ms: since(asked) });
          return done("failed", "art_limit");
        }
        flow("remix_result", { via: "agent", result: "success", ...artOutcome(art), duration_ms: since(asked) });
        commit(withArt(stubRef.current, art));
        return done("applied");
      } catch (e) {
        flow("remix_result", { via: "agent", result: "error", duration_ms: since(asked), error_code: errorCode(e) });
        return done("failed", errorCode(e));
      }
    }
    if (action.type === "show_back") {
      if (!onShowBackRef.current) return done("failed", "unavailable");
      onShowBackRef.current();
      return done("applied");
    }
    if (action.type === "ask_user" || action.type === "none") return done("rejected", "invalid_value");
    const out = applyToStub(stubRef.current, action);
    if (!out.ok) return done("rejected", out.code);
    commit(out.stub);
    return done("applied");
  };

  /** One agent turn: a plan for a message, or the follow-up to results. Shows the reply and its proposed actions. */
  const turn = async (message: string | undefined, results?: ActionResult[]) => {
    setBusy(message === undefined ? "Checking what happened…" : "Thinking…");
    try {
      const res = await planAgent({
        schema: AGENT_SCHEMA,
        state: summarize(stubRef.current),
        ...(message !== undefined ? { message } : {}),
        ...(results?.length ? { results } : {}),
        ...(message !== undefined && pendingRef.current ? { pending: pendingRef.current } : {}),
      });
      // the first typed question this reply asks becomes the pending one; anything else clears it
      const q = res.actions.find((a): a is Extract<Action, { type: "ask_user" }> => a.type === "ask_user" && !!a.field);
      pendingRef.current = q?.field ? { field: q.field, question: q.question, ...(q.options?.length ? { options: q.options } : {}) } : undefined;
      if (message !== undefined) flow("agent_message", { intent: res.actions.some((a) => a.type !== "ask_user") ? "action" : "question", result: res.provenance === "live" ? "live" : "rules" });
      say(res.reply, res.provenance === "live" ? "live" : "simulated", undefined, res.actions);
    } catch (error) {
      if (message !== undefined) flow("agent_message", { intent: "question", result: "error", error_code: errorCode(error) });
      say(failureCopy(error, "The agent is unavailable. Try again in a moment."));
    } finally {
      setBusy(undefined);
    }
  };

  /** Apply the chosen actions in order, then tell the agent what actually happened. */
  const apply = async (chosen: PlanItem[]) => {
    if (busy) return;
    const todo = chosen.filter((it) => it.action.type !== "ask_user" && !itemsRef.current[it.key]);
    if (!todo.length) return;
    const results: ActionResult[] = [];
    for (const it of todo) {
      setItem(it.key, { status: "applying" });
      const r = await runAction(it.action);
      setItem(it.key, { status: r.status, code: r.code });
      results.push(r);
    }
    setBusy(undefined);
    lastResults.current = results;
    announce(`${results.filter((r) => r.status === "applied").length} of ${results.length} changes applied.`);
    await turn(undefined, results);
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
    const answering = pendingRef.current?.options?.some((o) => o.toLowerCase() === t);
    if (!answering && /\bweather\b|\brain\b|\btemperature\b/.test(t) && !/\bmood|remix|art\b/.test(t)) {
      pendingRef.current = undefined;
      return addWeather();
    }
    if (!answering && /\bphoto\b|\bpicture\b|\bimage of mine\b/.test(t)) {
      pendingRef.current = undefined;
      flow("agent_message", { intent: "photo", result: "rules" });
      say("Choose a photo to add to your stub.");
      fileRef.current?.click();
      return;
    }
    return turn(text.slice(0, 400), lastResults.current);
  };
  useEffect(() => {
    if (sentInitial.current || !props.initial) return;
    sentInitial.current = true;
    void handle(props.initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const state = summarize(stub);
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
                                  const isDate = f.id === "date" && isIsoDate(alt);
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
          const proposals = (m.items ?? []).filter((it) => it.action.type !== "ask_user");
          const questions = (m.items ?? []).filter((it): it is PlanItem & { action: Extract<Action, { type: "ask_user" }> } => it.action.type === "ask_user");
          const waiting = proposals.filter((it) => !items[it.key]);
          return (
            <div key={m.id} className={`${styles.msg} ${styles.agent}`}>
              <p>
                {m.text}
                {m.provenance ? <SourceMark p={m.provenance} /> : null}
              </p>
              {proposals.length ? (
                <ul className={styles.actions} aria-label="Proposed changes">
                  {proposals.map((it) => {
                    const st = items[it.key];
                    return (
                      <li key={it.key} className={styles.action} data-status={st?.status}>
                        <span className={styles.actionText}>{describeAction(it.action, state, stub.personal.note)}</span>
                        {st && st.status !== "applying" ? (
                          <span className={styles.actionState}>{st.status === "applied" ? "Applied" : st.status === "failed" ? "Failed" : "Not applied"}</span>
                        ) : (
                          <PaperButton className={styles.apply} disabled={!!busy || !!st} onClick={() => void apply([it])}>
                            {st ? "Applying…" : "Apply"}
                            <span className="visually-hidden"> {describeAction(it.action, state, stub.personal.note)}</span>
                          </PaperButton>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {/* two remixes are alternatives (a fallback or a retry), not a set to apply together */}
              {waiting.length > 1 && proposals.filter((it) => it.action.type === "remix_art").length < 2 ? (
                <div className={styles.applyAll}>
                  <PaperButton disabled={!!busy} onClick={() => void apply(waiting)}>
                    Apply all {waiting.length}
                  </PaperButton>
                </div>
              ) : null}
              {questions.map((q) => (
                <div key={q.key} className={styles.question}>
                  <p>{q.action.question}</p>
                  {q.action.options?.length ? (
                    <Tags label="Answers">
                      {q.action.options.map((o) => (
                        <Tag key={o} disabled={!!busy} onClick={() => void handle(o)}>
                          {o}
                        </Tag>
                      ))}
                    </Tags>
                  ) : null}
                </div>
              ))}
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
