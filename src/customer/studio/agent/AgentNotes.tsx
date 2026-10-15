"use client";
import { questionKey } from "../facts/corrections";
import { factKey, resolveFact } from "../facts/identity";
// The agent as notes. It writes short notes about the stub: one card under it on a phone, and on the
// desktop one small taped card pinned in the corner of the cutting mat (it folds to a tab while the
// camera is away from fit). Each note asks one thing and has one-tap answers; "‹ ›" step through them.
// The full chat (AgentChat) opens only from Ask, or when the person types into a note.
// Rule-based unless a model is configured, so the one MarkLegend line says "Simulated".

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Fact, Provenance, Stub } from "../types";
import { currentVersion } from "../types";
import type { GenerationController } from "../generation/operations";
import { useGenerationOp } from "../generation/useGeneration";
import { remixProducer } from "../generation/producers";
import { EDITION_META } from "@/customer/studio/stub/editions";
import { haptic, play } from "@/customer/studio/feedback";
import { MarkLegend, SourceMark, Tag, Tags } from "@/customer/desk/Desk";
import { CloseIcon } from "@/customer/desk/icons";
import { toggleKept } from "../editor/ops";
import { FactQuestion } from "../facts/FactsReview";
import { openQuestions } from "../facts/corrections";
import styles from "./AgentNotes.module.css";

interface Answer {
  label: string;
  /** Marks the answer that is already true (an alternative that is the current value). */
  pressed?: boolean;
  run: () => void;
}
interface Note {
  id: string;
  body: ReactNode;
  answers: Answer[];
  /** A fact question (shared with the Facts panel). It replaces the answer tags. */
  custom?: ReactNode;
}

interface Props {
  stub: Stub;
  onChange: (s: Stub) => void;
  /** The editor's art-generation controller (the note is an entry point, not the owner). */
  generation: GenerationController;
  /** Opens the full chat, optionally with a line the person typed into a note. */
  onAsk: (text?: string) => void;
  /** Flips the stub over so a change on the back is seen. */
  onShowBack: () => void;
  variant: "card" | "pin";
  /** The pinned card is folded to a tab (the camera is away from fit). */
  folded?: boolean;
  /** The tab was tapped. */
  onUnfold?: () => void;
  /** The Facts panel is on screen and already asks the open questions, so the notes don't ask them again. */
  skipQuestions?: boolean;
}

function FactMark({ f }: { f: Fact }) {
  return (
    <span className={styles.fact}>
      {f.label}
      <SourceMark p={f.provenance} />
    </span>
  );
}

function list(items: ReactNode[]): ReactNode {
  return items.map((it, i) => (
    <span key={i}>
      {i > 0 ? (i === items.length - 1 ? " and " : ", ") : ""}
      {it}
    </span>
  ));
}

export function AgentNotes({ stub, onChange, generation, onAsk, onShowBack, variant, folded = false, onUnfold, skipQuestions = false }: Props) {
  const [gone, setGone] = useState<string[]>([]);
  const [leaving, setLeaving] = useState<{ id: string; dir: 1 | -1 } | null>(null);
  const op = useGenerationOp(generation, stub.id);
  const busy = op?.phase === "pending" ? "art" : null;
  const [at, setAt] = useState(0);

  const commit = onChange;

  const dismiss = (id: string, dir: 1 | -1 = -1) => {
    setLeaving({ id, dir });
    window.setTimeout(() => {
      setGone((g) => [...g, id]);
      setLeaving((l) => (l?.id === id ? null : l));
    }, 260);
  };
  const answer = (id: string, fn: () => void) => () => {
    fn();
    haptic(6);
    dismiss(id);
  };

  const remix = () => {
    if (busy) return;
    play("remix");
    // sound, announcement and status come from the editor's controller; the note just leaves once the art is applied or waiting
    generation
      .start({ via: "note", vibe: "moodier", fallback: "apply", run: remixProducer("note", "moodier", "custom") })
      .then((r) => {
        if (r.started && (r.op.phase === "applied" || r.op.phase === "ready")) dismiss("art");
      })
      .catch(() => undefined);
  };

  const ev = stub.event;
  const edition = EDITION_META[currentVersion(stub).edition];
  const kept = ev.facts.filter((f) => f.kept && f.confidence >= 0.8).slice(0, 3);
  const notes: Note[] = [];

  // 1. Facts I need an answer for come first: the same short question the Facts panel asks. It closes everywhere once answered.
  if (!skipQuestions) {
    openQuestions(stub).forEach((q) => {
      const f = resolveFact(ev.facts, questionKey(q));
      notes.push({
        id: `unsure-${questionKey(q)}`,
        body: f && f.provenance !== "pending" ? (
          <>
            I&apos;m not sure about the {q.label}: <FactMark f={f} />. {q.text}
          </>
        ) : (
          <>I couldn&apos;t find the {q.label}. {q.text}</>
        ),
        answers: [],
        custom: <FactQuestion stub={stub} q={q} onChange={commit} />,
      });
    });
  }

  // 2. What the agent did.
  notes.push({
    id: "intro",
    body: (
      <>
        I set up your {edition?.label ?? "first"} stub for {ev.title}. The date and place are on the front
        {kept.length ? <>, with {list(kept.map((f) => <FactMark key={factKey(f)} f={f} />))}</> : null}.
      </>
    ),
    answers: [
      { label: "Looks right", run: answer("intro", () => {}) },
      { label: "Show the back", run: answer("intro", onShowBack) },
    ],
  });

  // 3. Things I found for the back.
  const starred = ev.setlist?.find((s) => s.starred)?.title ?? ev.setlist?.[0]?.title;
  if (starred && !stub.personal.note) {
    const prov: Provenance = ev.facts.find((f) => f.source === "setlist.fm")?.provenance ?? "simulated";
    notes.push({
      id: "setlist",
      body: (
        <>
          Found the setlist
          <SourceMark p={prov} />. Put &ldquo;{starred}&rdquo; on the back?
        </>
      ),
      answers: [
        {
          label: "Put it on",
          run: answer("setlist", () => {
            commit({ ...stub, personal: { ...stub.personal, note: `★ ${starred}` } });
            onShowBack();
          }),
        },
        { label: "Leave it", run: answer("setlist", () => {}) },
      ],
    });
  }
  if (ev.score) {
    notes.push({
      id: "score",
      body: (
        <>
          Found the final score: {ev.score.home} <span className={styles.fact}>{ev.score.homeScore}–{ev.score.awayScore}</span> {ev.score.away}. It&apos;s on the back.
        </>
      ),
      answers: [
        { label: "Show me", run: answer("score", onShowBack) },
        { label: "Leave it", run: answer("score", () => {}) },
      ],
    });
  }

  // 4. A couple of facts I found but did not put on the stub.
  ev.facts
    .filter((f) => !f.kept && f.provenance !== "pending" && f.confidence >= 0.8)
    .slice(0, 2)
    .forEach((f) => {
      const id = `keep-${factKey(f)}`;
      notes.push({
        id,
        body: (
          <>
            Found <FactMark f={f} /> from {f.source}. Keep it on the stub?
          </>
        ),
        answers: [
          { label: "Keep it", run: answer(id, () => commit(toggleKept(stub, factKey(f)))) },
          { label: "Skip", run: answer(id, () => {}) },
        ],
      });
    });

  // 5. The art.
  notes.push({
    id: "art",
    body: <>Want the art moodier? I keep your text and edits.</>,
    answers: [
      {
        label: busy === "art" ? "Remixing…" : "Make it moodier",
        run: remix,
      },
      { label: "Not now", run: answer("art", () => {}) },
    ],
  });

  const open = notes.filter((n) => !gone.includes(n.id));
  // when a note is answered the next one is dealt in, with a small thud
  const dealt = useRef(0);
  const more = open.length > 0;
  useEffect(() => {
    if (gone.length > dealt.current && more) play("drop", { emphasis: "subtle" });
    dealt.current = gone.length;
  }, [gone.length, more]);
  const marks: (Provenance | "sandbox")[] = [...new Set<Provenance | "sandbox">([...ev.facts.map((f) => f.provenance), "simulated"])];

  const total = gone.length + open.length;

  if (variant === "pin") {
    if (!open.length) return null;
    const i = Math.min(at, open.length - 1);
    const n = open[i];
    const step = (d: 1 | -1) => {
      play("select", { emphasis: "subtle", direction: d === 1 ? "forward" : "back" });
      setAt(i + d);
    };
    return (
      <section className={`${styles.wrap} ${styles.pin}`} data-folded={folded || undefined} data-note data-stub-area aria-label="Notes from the agent">
        <button type="button" className={styles.tab} onClick={onUnfold} tabIndex={folded ? 0 : -1} aria-hidden={!folded || undefined} aria-label="Unfold the agent note">
          Note · <span className={styles.count}>{gone.length + i + 1} of {total}</span>
        </button>
        <div className={styles.pinCard} inert={folded}>
          <NoteCard
            key={n.id}
            note={n}
            index={gone.length + i + 1}
            total={total}
            swipe={false}
            leaving={leaving?.id === n.id ? leaving.dir : 0}
            busy={!!busy}
            withReply
            nav={{ prev: i > 0 ? () => step(-1) : undefined, next: i < open.length - 1 ? () => step(1) : undefined }}
            onDismiss={(dir) => {
              play("flick", { emphasis: "subtle" });
              dismiss(n.id, dir);
            }}
            onAsk={onAsk}
          />
          <div className={styles.legend}>
            <MarkLegend marks={marks} />
          </div>
        </div>
      </section>
    );
  }

  const n = open[0];
  return (
    <section className={`${styles.wrap} ${styles.card}`} aria-label="Notes from the agent">
      {n && (
        <NoteCard
          key={n.id}
          note={n}
          index={gone.length + 1}
          total={total}
          swipe
          leaving={leaving?.id === n.id ? leaving.dir : 0}
          busy={!!busy}
          withReply
          onDismiss={(dir) => {
            play("flick", { emphasis: "subtle" });
            dismiss(n.id, dir);
          }}
          onAsk={onAsk}
        />
      )}
      <MarkLegend marks={marks} />
    </section>
  );
}

function NoteCard({
  note,
  index,
  total,
  swipe,
  leaving,
  busy,
  withReply,
  nav,
  onDismiss,
  onAsk,
}: {
  note: Note;
  index: number;
  total: number;
  swipe: boolean;
  leaving: 1 | -1 | 0;
  busy: boolean;
  withReply: boolean;
  /** Steps through the notes (the pinned card only). */
  nav?: { prev?: () => void; next?: () => void };
  onDismiss: (dir: 1 | -1) => void;
  onAsk: (text?: string) => void;
}) {
  const el = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; y: number; on: boolean; id: number } | null>(null);
  const [draft, setDraft] = useState("");

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    const node = el.current;
    if (!d || !node || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.on && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      d.on = true;
      node.setPointerCapture(e.pointerId);
      node.dataset.dragging = "true";
    }
    if (d.on) {
      node.style.transform = `translateX(${dx}px) rotate(${dx / 30}deg)`;
      node.style.opacity = String(Math.max(0.35, 1 - Math.abs(dx) / 360));
    }
  };
  const end = (e: React.PointerEvent) => {
    const d = drag.current;
    const node = el.current;
    drag.current = null;
    if (!d || !node || !d.on) return;
    const dx = e.clientX - d.x;
    delete node.dataset.dragging;
    if (Math.abs(dx) > 70) onDismiss(dx > 0 ? 1 : -1);
    else {
      node.style.transform = "";
      node.style.opacity = "";
    }
  };

  return (
    <article
      ref={el}
      className={styles.note}
      data-leaving={leaving || undefined}
      style={{ ["--dir" as string]: leaving }}
      onPointerDown={(e) => {
        if (!swipe || e.button !== 0 || (e.target as HTMLElement).closest("button, input, a")) return;
        drag.current = { x: e.clientX, y: e.clientY, on: false, id: e.pointerId };
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <header className={styles.head}>
        <span className="desk-label">
          Agent note · <span className={styles.count}>{index} of {total}</span>
        </span>
        <span className={styles.headBtns}>
          {nav && (
            <>
              <button type="button" className={styles.step} aria-label="Previous note" disabled={!nav.prev} onClick={nav.prev}>
                ‹
              </button>
              <button type="button" className={styles.step} aria-label="Next note" disabled={!nav.next} onClick={nav.next}>
                ›
              </button>
            </>
          )}
          <button type="button" className={styles.close} aria-label="Dismiss this note" onClick={() => onDismiss(-1)}>
            <CloseIcon />
          </button>
        </span>
      </header>
      <p className={styles.body}>{note.body}</p>
      {note.custom ?? (
        <Tags label="Answers">
          {note.answers.map((a) => (
            <Tag key={a.label} pressed={a.pressed} disabled={busy} onClick={a.run}>
              {a.label}
            </Tag>
          ))}
        </Tags>
      )}
      {withReply && (
        <form
          className={styles.reply}
          onSubmit={(e) => {
            e.preventDefault();
            const t = draft.trim();
            if (!t) return;
            setDraft("");
            onAsk(t);
          }}
        >
          <input
            className={styles.replyInput}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Or tell me what to change"
            aria-label="Tell the agent what to change"
            autoComplete="off"
            enterKeyHint="send"
          />
        </form>
      )}
    </article>
  );
}
