"use client";
import { useRouter } from "next/navigation";
import type { Stub } from "../types";
import { LeavesMark } from "@/customer/pages/ui";
import { SandboxStrip, Stamp, Tag, Tags } from "@/customer/desk/Desk";
import { openCount } from "../facts/FactsReview";
import { selectedSummary } from "../versions/versions";
import { MaterialPicker, ctaVerb, totalLabel } from "./MaterialPicker";
import { TearStrip } from "./TearStrip";
import { DownloadStub } from "../download/DownloadStub";
import { flow } from "@/customer/flows/events";
import styles from "./Tray.module.css";

interface Props {
  stub: Stub;
  onChange: (s: Stub) => void;
  onTear: () => void;
  /** Leave the stock and finish pickers out when another panel on the page already holds them. */
  compact?: boolean;
  /** Opens the Facts or Versions sheet (phone). Without it the buttons are left out because the inspector holds those panels. */
  onOpen?: (what: "facts" | "versions") => void;
}

/** The paper tray under the stub, in order: stock, finish, the stamped main action, then the tear. */
export function Tray({ stub, onChange, onTear, compact, onOpen }: Props) {
  const router = useRouter();
  const selected = selectedSummary(stub);
  const open = openCount(stub);
  const kept = stub.versions.filter((v) => !v.id.startsWith("preview-")).length;
  return (
    <section className={styles.tray} aria-label="Print your stub">
      <div className={styles.sandbox}>
        <SandboxStrip />
      </div>
      {!compact && <MaterialPicker stub={stub} onChange={onChange} />}
      {onOpen && (
        <Tags label="Review your stub">
          <Tag count={open || undefined} countNote="to check" onClick={() => onOpen("facts")}>
            Facts
          </Tag>
          <Tag count={kept} countNote="kept" onClick={() => onOpen("versions")}>
            Versions
          </Tag>
        </Tags>
      )}
      <p className={styles.note}>
        Prints version <span className={styles.version}>#{selected.hash}</span>: {selected.text}.
      </p>
      <Stamp
        block
        price={totalLabel(stub.material, stub.finish)}
        onClick={() => {
          flow("cta_select", { cta: "print", context: "editor" });
          // Let the stamp land before the page changes.
          window.setTimeout(() => router.push(`/checkout/${stub.id}`), 200);
        }}
      >
        {ctaVerb(stub.material)}
        <LeavesMark />
      </Stamp>
      <DownloadStub stub={stub} context="editor" />
      <TearStrip torn={stub.torn} onTear={onTear} />
    </section>
  );
}
