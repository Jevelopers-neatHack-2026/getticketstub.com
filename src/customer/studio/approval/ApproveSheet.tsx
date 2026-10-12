"use client";
// Review before approving (GT-06B.1): the paper sheet that opens from "Approve for print". It shows the stub front and
// back, the printed facts exactly as the binding hashes them, the composition in words, and what changed since the
// owner's last approval, then asks once. Approving is not an order or a payment, and the sheet says so.
import { useCallback, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { api, ApiError, type ApprovalInfo } from "@/customer/account/api";
import { messageFor } from "@/customer/feedback-messages/messages";
import { PaperButton, PaperSheet, SourceMark, Stamp, type MarkKind } from "@/customer/desk/Desk";
import { SIZE_COPY, TIER_SIZES, type PrintSize } from "@/customer/pages/capabilities";
import { StubView } from "../stub/StubView";
import { currentVersion, type Stub } from "../types";
import { versionHash } from "../versions/versions";
import { changesSince, compositionParts, printedLines, valueWords, type ChangeSource, type Composition } from "./printed";
import styles from "./ApproveSheet.module.css";

interface Props {
  stub: Stub;
  open: boolean;
  onClose: () => void;
  /** Called after an approval was issued, with the words to say. The sheet closes itself. */
  onApproved: (said: string) => void;
}

/** The composition the server would bind now: the material's first size (the approve call asks for no other). */
export function compositionNow(stub: Stub): Composition {
  const size: PrintSize = TIER_SIZES[stub.material]?.[0] ?? "classic";
  return { edition: currentVersion(stub).edition, material: stub.material, finish: stub.finish, size };
}

const asSource = (a: ApprovalInfo): ChangeSource => ({ id: a.approval.id, status: a.status, binding: a.approval.binding, summary: a.summary, drift: a.drift });

/** The sheet's body. It exists only while the sheet is open, so every opening starts from a fresh read of the history. */
function Review({ stub, onClose, onApproved }: Omit<Props, "open">) {
  const [history, setHistory] = useState<ApprovalInfo[] | "loading" | "failed">("loading");
  const [said, setSaid] = useState("");
  const [busy, setBusy] = useState(false);
  const id = useId();
  const stubId = stub.id;

  const load = useCallback(() => api.approvals(stubId).then(setHistory, () => setHistory("failed")), [stubId]);
  useEffect(() => {
    let alive = true;
    api.approvals(stubId).then(
      (all) => alive && setHistory(all),
      () => alive && setHistory("failed"),
    );
    return () => {
      alive = false;
    };
  }, [stubId, stub.updatedAt]);

  const approve = async () => {
    setBusy(true);
    try {
      await api.approve(stubId, stub.currentVersionId);
      setBusy(false);
      onApproved("Approved for print.");
      onClose();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "unknown";
      setSaid(messageFor(code).message);
      setBusy(false);
      if (code === "approval_conflict") await load(); // the sheet shows the stub as it is now
    }
  };

  const lines = printedLines(stub);
  const comp = compositionNow(stub);
  const v = currentVersion(stub);
  const last = Array.isArray(history) ? history.find((a) => a.approval.purpose === "print.compose") : undefined;
  const diff = Array.isArray(history) ? changesSince(last && asSource(last), { printed: lines, composition: comp }) : null;
  const hasMarks = lines.some((l) => l.provenance);
  const hidden = stub.personal.hiddenFields;
  const size = SIZE_COPY[comp.size as PrintSize];

  return (
    <div className={styles.review}>
      <p className={styles.lede}>
        Look this over once more. Approving covers version <span className={styles.hash}>#{versionHash(v)}</span> exactly as shown here.
      </p>

      <section className={styles.block} aria-labelledby={`${id}-w`}>
        <h3 className={styles.head} id={`${id}-w`}>
          What changed since your last approval
        </h3>
        {diff === null ? (
          <p className={styles.note}>{history === "failed" ? "We couldn't check your earlier approvals just now. You can still approve." : "Checking your last approval…"}</p>
        ) : diff.first ? (
          <p className={styles.plain}>First approval for this stub.</p>
        ) : diff.same ? (
          <p className={styles.plain}>
            Nothing changed since <span className={styles.hash}>#{diff.hash}</span>
            {last && last.status !== "active" ? ` (${last.status === "stale" ? "replaced" : last.status})` : ""}.
          </p>
        ) : diff.items.length ? (
          <ul className={styles.changes}>
            {diff.items.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        ) : (
          <p className={styles.note}>Something changed since #{diff.hash}, but we can&apos;t say what.</p>
        )}
      </section>

      <section className={styles.stubs} aria-label="The stub, front and back">
        {([false, true] as const).map((back) => (
          <figure key={String(back)} className={styles.side}>
            <StubView stub={stub} flipped={back} size="md" />
            <figcaption className="desk-label">{back ? "Back" : "Front"}</figcaption>
          </figure>
        ))}
      </section>

      <div className={styles.cols}>
        <section className={styles.block} aria-labelledby={`${id}-f`}>
          <h3 className={styles.head} id={`${id}-f`}>
            Printed facts
          </h3>
          <ul className={styles.facts}>
            {lines.map((l) => (
              <li key={l.key}>
                <span className={styles.k}>{l.label}</span>
                <span className={styles.val}>
                  {valueWords(l)}
                  {l.provenance ? <SourceMark p={l.provenance as MarkKind} /> : null}
                </span>
              </li>
            ))}
          </ul>
          {hidden.length ? <p className={styles.note}>Hidden on the stub: {hidden.join(", ")}.</p> : null}
          {hasMarks ? <p className={styles.note}>The dot beside a fact shows where it came from.</p> : null}
        </section>

        <div className={styles.stack}>
          <section className={styles.block} aria-labelledby={`${id}-c`}>
            <h3 className={styles.head} id={`${id}-c`}>
              How it is made
            </h3>
            <dl className={styles.comp}>
              {compositionParts(comp).map((p) => (
                <div key={p.label}>
                  <dt>{p.label}</dt>
                  <dd>{p.label === "Size" && size ? `${size.name}, ${size.measure}` : p.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>

      <p className={styles.notOrder}>This approves the design for print. It is not an order and nothing is charged. It holds for 7 days, and any change to the version, facts or settings needs a new approval.</p>

      <p className={styles.said} data-announce="change">
        {said}
      </p>
      <div className={styles.actions}>
        <Stamp block disabled={busy || history === "loading"} onClick={approve}>
          Approve this version
        </Stamp>
        <PaperButton block onClick={onClose}>
          Cancel
        </PaperButton>
      </div>
    </div>
  );
}

export function ApproveSheet({ stub, open, onClose, onApproved }: Props) {
  const sheet = (
    <PaperSheet open={open} onClose={onClose} title="Approve for print" wide>
      <Review stub={stub} onClose={onClose} onApproved={onApproved} />
    </PaperSheet>
  );
  // Portalled: the sheet is opened from inside the Versions sheet on a phone, and a fixed child of an animated, masked parent is clipped to it.
  return typeof document === "undefined" ? null : createPortal(sheet, document.body);
}
