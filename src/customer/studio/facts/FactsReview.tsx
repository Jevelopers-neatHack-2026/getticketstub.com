"use client";
// Research review (GT-05): the facts grouped by how far to trust them, where each came from, one short question for
// anything required that is missing or in doubt, and the person's corrections with their history. The same pieces sit in
// the desktop Inspector, the phone Facts sheet and the agent's margin note, and they all read openQuestions(), so a
// question is asked once and closes everywhere when it is answered.
import { useId, useState } from "react";
import type { Correction, Fact, Stub } from "../types";
import { haptic, play } from "@/customer/studio/feedback";
import { MarkLegend, PaperButton, SourceMark, Tag, Tags, TearLink } from "@/customer/desk/Desk";
import { altLabel } from "../editor/ops";
import {
  ASSET_WORDS,
  activeCorrection,
  applyCorrection,
  assetExplanation,
  changesPrintedStub,
  entries,
  groupFacts,
  isPrinted,
  openQuestions,
  originalOf,
  reviewAssets,
  undoCorrection,
  type FactGroup,
  type Question,
} from "./corrections";
import { isCoreFact, isFactIncluded } from "./inclusion";
import { FactFitNotice } from "./fitProof";
import styles from "./Facts.module.css";

const TIME: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };

export function whenLabel(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat("en-GB", TIME).format(d);
}

export const GROUP_TITLE: Record<FactGroup, string> = {
  source: "From a source",
  corrected: "Your corrections",
  unsure: "Unsure",
  missing: "Missing",
};
const GROUP_NOTE: Record<FactGroup, string> = {
  source: "Read from a page or service we can name. Check the mark for whether it was live or a sample.",
  corrected: "You changed these. The original stays on record.",
  unsure: "Low confidence, or the sources disagree.",
  missing: "We couldn't find these. They stay unknown until you add them.",
};
const ORDER: FactGroup[] = ["unsure", "missing", "corrected", "source"];

/** Where a fact came from and when it was read, as one line. Never claims a time we don't have. */
export function SourceLine({ f }: { f: Fact }) {
  const when = whenLabel(f.retrievedAt);
  return (
    <span className={styles.source}>
      {f.sourceUrl ? (
        <a href={f.sourceUrl} target="_blank" rel="noreferrer noopener">
          {f.source}
        </a>
      ) : (
        f.source
      )}
      {when ? <> · read {when}</> : f.provenance === "live" ? <> · time not recorded</> : null}
    </span>
  );
}

/** A short question: the known answers, and a way to type your own. Answering records a correction and closes the question. */
export function FactQuestion({ stub, q, onChange, onDone }: { stub: Stub; q: Question; onChange: (s: Stub) => void; onDone?: () => void }) {
  const [typing, setTyping] = useState(false);
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const id = useId();
  const answer = (v: string, why?: string) => {
    onChange(applyCorrection(stub, { factId: q.factId, value: v, reason: why }));
    play("stamp");
    haptic([12]);
    onDone?.();
  };
  const prints = typing && changesPrintedStub(stub, q.factId, value);
  return (
    <section className={styles.question} aria-labelledby={`${id}-q`}>
      <p className={styles.qText} id={`${id}-q`}>
        {q.text}
        {q.required ? <span className={styles.req}> Needed for the stub</span> : null}
      </p>
      <Tags label={q.text}>
        {q.alternatives.map((alt) => (
          <Tag key={alt} onClick={() => answer(alt)}>
            {altLabel(alt)}
          </Tag>
        ))}
        <Tag pressed={typing} aria-expanded={typing} onClick={() => setTyping((t) => !t)}>
          None of these, I&apos;ll type it
        </Tag>
      </Tags>
      {typing && (
        <form
          className={styles.typed}
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) answer(value, reason);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setTyping(false);
            }
          }}
        >
          <label className={styles.fieldLabel} htmlFor={`${id}-v`}>
            {q.input === "date" ? "The date" : `The ${q.label}`}
          </label>
          <input
            id={`${id}-v`}
            className={styles.input}
            type={q.input}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            required
            aria-required="true"
            autoFocus
          />
          <label className={styles.fieldLabel} htmlFor={`${id}-r`}>
            Why? <span className={styles.opt}>Optional</span>
          </label>
          <input id={`${id}-r`} className={styles.input} value={reason} onChange={(e) => setReason(e.target.value)} autoComplete="off" />
          {prints && <p className={styles.notice}>This changes the printed stub.</p>}
          <PaperButton type="submit" disabled={!value.trim()}>
            Use this
          </PaperButton>
        </form>
      )}
    </section>
  );
}

function History({ c }: { c: Correction }) {
  return (
    <li className={styles.entry}>
      <span className={styles.entryHead}>
        {c.kind === "undo" ? "You undid a change" : c.kind === "confirm" ? "You confirmed it" : "You corrected it"}
        <span className={styles.when}> · {whenLabel(c.at)}</span>
      </span>
      <span className={styles.entryBody}>
        {c.kind === "confirm" ? <>Kept &ldquo;{altLabel(c.corrected.value)}&rdquo;.</> : <>From &ldquo;{altLabel(c.original.value)}&rdquo; to &ldquo;{altLabel(c.corrected.value)}&rdquo;.</>}
        {c.reason ? <> Reason: {c.reason}</> : null}
      </span>
    </li>
  );
}

/** The same action and associated status in the inspector, phone sheet and chip popover. */
export function FactInclusion({ stub, fact, onToggleFact }: { stub: Stub; fact: Fact; onToggleFact: (projectId: string, factId: string) => void }) {
  const statusId = useId();
  const included = isFactIncluded(stub, fact);
  if (isCoreFact(fact)) return <span className={styles.source}>{included ? "Included by default" : "Core detail hidden or missing"}</span>;
  const action = included ? "Remove from stub" : "Add to stub";
  return <span className={styles.inclusion}>
    <span id={statusId} className={styles.source}>{included ? "Selected for stub" : "Not selected"}</span>
    <Tag aria-label={`${action}: ${fact.label}`} aria-describedby={statusId} onClick={() => onToggleFact(stub.id, fact.id)}>{action}</Tag>
  </span>;
}

function FactRow({ stub, f, group, onChange, onToggleFact, onAsk }: { stub: Stub; f: Fact; group: FactGroup; onChange: (s: Stub) => void; onToggleFact: (projectId: string, factId: string) => void; onAsk: () => void }) {
  const [showOriginal, setShowOriginal] = useState(false);
  const id = useId();
  const active = activeCorrection(stub, f.id);
  const original = originalOf(stub, f);
  const history = entries(stub, f.id);
  const printed = isPrinted(f);
  return (
    <li className={styles.fact} data-group={group}>
      <div className={styles.factTop}>
        <div className={styles.factText}>
          <span className={styles.factLabel}>
            {group === "corrected" ? active?.corrected.label || f.label : f.label}
            {group === "corrected" ? null : <SourceMark p={f.provenance} />}
          </span>
          {group === "corrected" && active ? (
            <span className={styles.source}>{active.kind === "confirm" ? "You confirmed this" : "Your correction"}, {whenLabel(active.at)}</span>
          ) : group === "missing" ? (
            <span className={styles.source}>Not found{f.source ? ` on ${f.source}` : ""}</span>
          ) : (
            <SourceLine f={f} />
          )}
          {group === "unsure" && <span className={styles.source}>Confidence {Number.isFinite(f.confidence) ? `${Math.round(f.confidence * 100)}%` : "unknown"}</span>}
          {group === "corrected" && active && printed && <span className={styles.notice}>This changes the printed stub.</span>}
        </div>
        <Tags>
          {(group === "unsure" || group === "missing") && (
            <Tag aria-label={`${group === "missing" ? "Add" : "Fix"} ${f.label}`} onClick={onAsk}>
              {group === "missing" ? "Add" : "Fix"}
            </Tag>
          )}
          {group === "corrected" && (
            <Tag
              aria-label={`Undo your change to ${f.label}`}
              onClick={() => {
                onChange(undoCorrection(stub, f.id));
                play("tap", { emphasis: "subtle" });
              }}
            >
              Undo
            </Tag>
          )}
          {group !== "missing" && (
<FactInclusion stub={stub} fact={f} onToggleFact={onToggleFact} />
          )}
        </Tags>
      </div>
      {group === "corrected" && history.length > 0 && (
        <div className={styles.original}>
          <TearLink aria-expanded={showOriginal} aria-controls={id} onClick={() => setShowOriginal((s) => !s)}>
            {showOriginal ? "Hide the original" : "See the original"}
          </TearLink>
          {showOriginal && (
            <div id={id} className={styles.originalBody}>
              <p className={styles.entryBody}>
                Original: &ldquo;{altLabel(original.value)}&rdquo; from {original.source}
                {original.provenance === "pending" ? ", not known yet" : `, ${Math.round(original.confidence * 100)}% sure`}.
              </p>
              <ol className={styles.history} aria-label="Correction history">
                {history.map((c) => (
                  <History key={c.id} c={c} />
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** The whole review: open questions, then the facts in four groups, then any images we can't use. */
export function FactsReview({ stub, onChange, onToggleFact }: { stub: Stub; onChange: (s: Stub) => void; onToggleFact: (projectId: string, factId: string) => void }) {
  const [asking, setAsking] = useState<string | null>(null);
  const questions = openQuestions(stub);
  const groups = groupFacts(stub.event.facts, stub);
  const assets = reviewAssets(stub);
  const marks = [...new Set(stub.event.facts.filter((f) => !activeCorrection(stub, f.id)).map((f) => f.provenance))];
  const asked = asking ? questions.find((q) => q.factId === asking) : undefined;
  // A "Fix" or "Add" on a row opens that question even when it isn't one that always asks (an optional fact).
  const manual: Question | undefined =
    asking && !asked
      ? (() => {
          const f = stub.event.facts.find((x) => x.id === asking);
          return f ? { factId: f.id, label: f.label, text: "What should it say?", alternatives: [...new Set(f.alternatives ?? [])], input: "text", required: false } : undefined;
        })()
      : undefined;
  const shown = [...questions.filter((q) => q.factId !== asking), ...(asked ? [asked] : []), ...(manual ? [manual] : [])];

  if (!stub.event.facts.length && !shown.length && !assets.length) return <p className={styles.empty}>No facts found yet. Ask the agent to look again.</p>;

  return (
    <div className={styles.review}>
      <p className={styles.groupNote}>Choose which extra facts appear on your stub. Inclusion does not verify or approve a fact.</p>
      <FactFitNotice stub={stub} />
      {stub.corrections?.some((c) => c.unresolvedIdentity) && (
        <p className={styles.notice} role="status">Some older corrections referred to duplicate fact IDs. Their history is retained, but cannot be assigned to a particular row. Review those facts again.</p>
      )}
      {shown.length > 0 && (
        <div className={styles.questions} role="group" aria-label="Questions about your facts">
          {shown.map((q) => (
            <FactQuestion key={q.factId} stub={stub} q={q} onChange={onChange} onDone={() => setAsking(null)} />
          ))}
        </div>
      )}
      {ORDER.map((g) =>
        groups[g].length ? (
          <section key={g} className={styles.group} aria-label={GROUP_TITLE[g]}>
            <h3 className={styles.groupHead}>
              <span className="desk-label">{GROUP_TITLE[g]}</span>
              <span className={styles.count}>{groups[g].length}</span>
            </h3>
            <p className={styles.groupNote}>{GROUP_NOTE[g]}</p>
            <ul className={styles.facts}>
              {groups[g].map((f) => (
                <FactRow key={f.id} stub={stub} f={f} group={g} onChange={onChange} onToggleFact={onToggleFact} onAsk={() => setAsking(f.id)} />
              ))}
            </ul>
          </section>
        ) : null,
      )}
      {assets.length > 0 && (
        <section className={styles.group} aria-label="Images we can't use">
          <h3 className={styles.groupHead}>
            <span className="desk-label">Images</span>
            <span className={styles.count}>{assets.length}</span>
          </h3>
          <ul className={styles.facts}>
            {assets.map((a) => (
              <li key={a.id} className={styles.fact} data-group="asset">
                <div className={styles.factText}>
                  <span className={styles.factLabel}>
                    {a.label}
                    <span className={styles.badge} data-status={a.status}>
                      {ASSET_WORDS[a.status]}
                    </span>
                  </span>
                  <span className={styles.source}>{assetExplanation(a)}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {marks.length > 0 && <MarkLegend marks={marks} />}
    </div>
  );
}

/** How many things still need an answer, for a badge on the Facts panel or button. */
export function openCount(stub: Stub): number {
  return openQuestions(stub).length;
}
