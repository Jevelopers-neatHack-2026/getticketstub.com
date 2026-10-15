"use client";
import { factKey } from "./identity";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useEffect, useState } from "react";
import type { Stub } from "../types";
import { StubView } from "../stub/StubView";
import { includedExtraFacts } from "./inclusion";
import { measureFactFit, type FactFit } from "./fit";

/** Local browser proof only; not canonical print preflight or a supplier eligibility grant. */
export async function checkFactFit(stub: Stub): Promise<FactFit[]> {
  const requested = includedExtraFacts(stub);
  if (!requested.length) return [];
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:0;top:0;z-index:-1;clip-path:inset(100%);pointer-events:none;--stub-max:2000px;";
  host.setAttribute("aria-hidden", "true");
  host.inert = true;
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(<><StubView stub={stub} size="lg" still="front" /><StubView stub={stub} size="lg" still="back" /></>));
    await document.fonts.ready;
    const figures = Array.from(host.children) as HTMLElement[];
    const reports = figures.map((figure) => measureFactFit(figure, requested));
    return requested.map((f, i) => ({ id: factKey(f), label: f.label, state: reports.some((r) => r[i].state === "visible") ? "visible" : "blocked" }));
  } finally {
    root.unmount();
    host.remove();
  }
}

export function useFactFit(stub: Stub): FactFit[] | null {
  const [checked, setChecked] = useState<{ stub: Stub; result: FactFit[] } | null>(null);
  useEffect(() => {
    let live = true;
    void checkFactFit(stub).then((result) => { if (live) setChecked({ stub, result }); }, () => {
      if (live) setChecked({ stub, result: includedExtraFacts(stub).map((f) => ({ id: factKey(f), label: f.label, state: "blocked" })) });
    });
    return () => { live = false; };
  }, [stub]);
  return checked?.stub === stub ? checked.result : null;
}

export function FactFitNotice({ stub }: { stub: Stub }) {
  const report = useFactFit(stub);
  const blocked = report?.filter((f) => f.state === "blocked");
  if (!includedExtraFacts(stub).length) return null;
  return <p role="status">{!report ? "Checking selected facts against both faces…" : blocked?.length ? `These facts do not fit completely: ${blocked.map((f) => f.label).join("; ")}. Remove some facts or choose another style before approval or export.` : "Selected extra facts fit on at least one face of the local proof."}</p>;
}
