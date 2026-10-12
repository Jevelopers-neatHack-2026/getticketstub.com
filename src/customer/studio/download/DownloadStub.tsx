"use client";
// "Download": the stub as a PNG, exactly as the studio draws it (exportStub.tsx), front or back. Used in the editor tray
// (desktop inspector and phone), the wall lamp and the memory page. Progress and failures use the shared honest pattern.
import { useState } from "react";
import { PaperButton, TearLink } from "@/customer/desk/Desk";
import { ProgressNote, useProgress } from "@/customer/feedback-messages/progress";
import { flow, errorCode } from "@/customer/flows/events";
import { play } from "../feedback";
import type { Stub } from "../types";
import { deliverPng, renderStubPng, stubFileName, type Delivery, type StubSide } from "./exportStub";
import s from "./DownloadStub.module.css";

type Context = "editor" | "lamp" | "memory";

const DONE: Record<Delivery, string> = {
  download: "Saved to your downloads",
  share: "Saved",
  cancelled: "",
  tab: "Opened in a new tab. Press and hold the picture, then choose Save to Photos.",
};

interface Props {
  stub: Stub;
  context: Context;
  /** Extra tear links after the back, e.g. the memory page's story image. */
  children?: React.ReactNode;
  /** The memory page and lamp already have a status line; pass false to skip the hint text. */
  hint?: boolean;
}

export function DownloadStub({ stub, context, children, hint = true }: Props) {
  const { state, run, reset, busy } = useProgress();
  const [done, setDone] = useState("");
  const [last, setLast] = useState<StubSide>("front");

  async function download(side: StubSide) {
    setLast(side);
    setDone("");
    const delivery = await run(async () => {
      let blob: Blob;
      try {
        blob = await renderStubPng(stub, side);
      } catch (e) {
        flow("stub_download", { side, context, method: "none", result: "failed", error_code: errorCode(e) });
        throw e;
      }
      const method = await deliverPng(blob, stubFileName(stub, side));
      flow("stub_download", { side, context, method, result: "generated" });
      setDone(DONE[method]);
      return method;
    });
    if (delivery === "cancelled") reset(); // closing the share sheet is not an error and not a save
    else if (delivery) play("success");
  }

  return (
    <div className={s.root} data-download-root>
      <div className={s.row}>
        <PaperButton type="button" disabled={busy} data-download="front" onClick={() => download("front")}>
          Download PNG
        </PaperButton>
        <TearLink type="button" disabled={busy} data-download="back" onClick={() => download("back")}>
          Back side
        </TearLink>
        {children}
      </div>
      {hint && state.phase === "idle" ? <p className={s.hint}>The stub as printed, at 3x size, with its edges.</p> : null}
      <ProgressNote state={state} labels={{ sending: "Drawing your stub…", done: done || "Saved" }} onRetry={() => download(last)} />
    </div>
  );
}
