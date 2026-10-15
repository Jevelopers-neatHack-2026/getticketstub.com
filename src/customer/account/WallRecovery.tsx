"use client";
import { useEffect, useState } from "react";
import { inspectWallRecoveryState, restoreInterruptedWall, type WallRecoveryInspection } from "@/customer/studio/store";
import { TearLink } from "@/customer/desk/Desk";
import s from "./account.module.css";

/** Available to guests as well as signed-in accounts. No abandonment timeout. */
export function WallRecovery() {
  const [inspection, setInspection] = useState<WallRecoveryInspection>({ status: "none" });
  const [confirmed, setConfirmed] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let previous = "";
    const inspect = () => {
      const next = inspectWallRecoveryState();
      const signature = JSON.stringify(next);
      if (signature === previous) return;
      previous = signature;
      setInspection(next);
      setConfirmed(false);
    };
    inspect();
    const timer = setInterval(inspect, 2000);
    window.addEventListener("focus", inspect);
    window.addEventListener("storage", inspect);
    return () => { clearInterval(timer); window.removeEventListener("focus", inspect); window.removeEventListener("storage", inspect); };
  }, []);
  if (inspection.status === "none" || inspection.status === "unknown") return null;
  if (inspection.status === "diverged") return <section className={s.recovery} aria-label="Recover interrupted wall save">
    <p role="alert">Saved data differs from the interrupted save record. Automatic saving is paused. This browser cannot safely restore it. Keep this page open and contact support; do not clear browser storage.</p>
  </section>;
  const snapshot = inspection.snapshot;
  return <section className={s.recovery} aria-label="Recover interrupted wall save">
    <p role="status">A wall save may have been interrupted or may still be running in another tab. Automatic saving is paused.</p>
    <p>Before restoring, close every other Ticketstub tab and window on this browser, including installed app windows. If another save is still running, wait for it to finish instead. Restore returns this device to the saved wall and removal list from before the interrupted operation; that operation must be retried. It does not undo server changes.</p>
    <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> I have closed all other Ticketstub tabs and windows. No other save is running.</label>
    <TearLink type="button" disabled={!confirmed} onClick={() => {
      if (restoreInterruptedWall(snapshot, confirmed)) window.location.reload();
      else { setConfirmed(false); setFailed(true); }
    }}>Restore previous saved wall</TearLink>
    {failed ? <p role="alert">Could not restore safely. Data may have changed or browser storage may be blocked. Keep this page open, enable storage, and review the confirmation again. No recovery success was confirmed.</p> : null}
  </section>;
}
