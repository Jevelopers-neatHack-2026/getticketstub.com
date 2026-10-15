"use client";
import type { Stub } from "../types";
import { PaperSheet, SourceMark } from "@/customer/desk/Desk";
import { FactInclusion, FactQuestion, SourceLine } from "../facts/FactsReview";
import { activeCorrection, openQuestions } from "../facts/corrections";
import styles from "./overlays.module.css";

interface Props {
  stub: Stub;
  factId: string | null;
  onChange: (s: Stub) => void;
  onToggleFact: (projectId: string, factId: string) => void;
  onClose: () => void;
}

/** Tapping a chip on the stub: where the fact came from, and the short question when it needs an answer. The same question the Facts panel asks. */
export function ChipPopover({ stub, factId, onChange, onToggleFact, onClose }: Props) {
  const fact = factId ? stub.event.facts.find((f) => f.id === factId) : undefined;
  const question = fact ? openQuestions(stub).find((q) => q.factId === fact.id) : undefined;
  const mine = fact ? activeCorrection(stub, fact.id) : undefined;

  return (
    <PaperSheet title={fact ? (question ? question.text : fact.label) : "Fact"} open={!!fact} onClose={onClose}>
      {fact && (
        <div className={styles.stack}>
          <p className={styles.muted}>
            {mine ? (mine.kind === "confirm" ? "You confirmed this one." : "Your correction.") : null} <SourceLine f={fact} />
            {mine ? null : <SourceMark p={fact.provenance} />}
          </p>
          {question && <FactQuestion stub={stub} q={question} onChange={onChange} onDone={onClose} />}
          <FactInclusion stub={stub} fact={fact} onToggleFact={onToggleFact} />
        </div>
      )}
    </PaperSheet>
  );
}
