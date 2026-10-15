"use client";
// The start section: paste a link onto a paper ticket and the stub prints right here. Self-contained,
// so a landing page can drop it under its hero. It brings its own paper desk; nothing outside it is assumed.
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { PaperButton, Stamp, Tag, Tags, TearLink } from "@/customer/desk/Desk";
import { LeavesMark } from "@/customer/pages/ui";
import {
  PALE_HOURS,
  demoStubId,
  newStub,
  type DemoKey,
} from "@/customer/studio/fixtures";
import { Printing } from "@/customer/studio/research/Printing";
import { StubView } from "@/customer/studio/stub/StubView";
import {
  DEMO_TAGS,
  existingStub,
  inputFromDemo,
  inputFromText,
  inputSource,
  keepStubResult,
  looksLikeLink,
  type PrintInput,
} from "./make";
import { errorCode, flow } from "@/customer/flows/events";
import { useIdleSway } from "./useIdleSway";
import { useReducedMotion } from "@/customer/landing/MotionContext";
import s from "./StudioStart.module.css";

type Phase = "idle" | "feeding" | "printing" | "leaving";
interface Job {
  input: PrintInput;
  stubId: string;
}

const FEED_MS = 560;
const LEAVE_MS = 420;
const PASTE_LAND_MS = 380;

const cx = (...c: (string | false | undefined)[]) =>
  c.filter(Boolean).join(" ");
const freshId = () => Math.random().toString(36).slice(2, 10);

/** `fill`: the section is the whole page (/make) and centres its content in the screen height. Without it, it sizes to its content, for sitting under a hero. */
export function StudioStart({ fill = false }: { fill?: boolean } = {}) {
  const router = useRouter();
  const reduced = useReducedMotion();
  // where this start section sits: the whole /make page, or under the landing hero
  const entry = fill ? "make" : "home";
  const inputId = useId();
  const noteId = useId();
  const titleId = useId();
  const section = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const showcase = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);
  const [link, setLink] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [job, setJob] = useState<Job | null>(null);

  useIdleSway(showcase);

  // A finished stub for the shelf: only facts we are sure of, so nothing on it pulses.
  const sample = useMemo(
    () =>
      newStub(
        {
          ...PALE_HOURS,
          facts: PALE_HOURS.facts.filter((f) => f.confidence >= 0.8),
        },
        "start-showcase",
      ),
    [],
  );

  const later = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  };
  useEffect(() => {
    const t = timers.current;
    return () => t.forEach((id) => window.clearTimeout(id));
  }, []);

  // Printing happens in place, on the same paper: the section only grows to the height of the screen.
  const inPress = phase !== "idle";

  const open = (id: string) => {
    setPhase("leaving");
    later(() => router.push(`/studio/${id}`), LEAVE_MS);
  };

  const begin = (next: Job) => {
    setMessage(null);
    setJob(next);
    setPhase("feeding");
    section.current?.scrollIntoView({
      behavior: reduced ? "auto" : "smooth",
      block: "start",
    });
    later(() => setPhase("printing"), FEED_MS);
  };

  const submit = (value: string) => {
    const v = value.trim();
    if (!v) {
      flow("intake_invalid", { entry, reason: "empty" });
      setMessage("Paste your event link first.");
      inputRef.current?.focus();
      return;
    }
    const input = inputFromText(v);
    flow("intake_submit", { entry, input_source: inputSource(input), result: "accepted" });
    begin({ input, stubId: freshId() });
  };

  // Opening a demo twice reopens the stub that is already on the wall.
  const demo = (key: DemoKey) => {
    const id = demoStubId(key);
    if (existingStub(undefined, id)) {
      flow("intake_submit", { entry, input_source: "demo", result: "reopened" });
      setPhase("feeding");
      later(() => open(id), FEED_MS);
      return;
    }
    flow("intake_submit", { entry, input_source: "demo", result: "accepted" });
    begin({ input: inputFromDemo(key), stubId: id });
  };

  // A pasted link lands on the ticket, then prints on its own.
  const landLink = (text: string) => {
    setLink(text);
    setMessage(null);
    if (looksLikeLink(text.trim())) later(() => submit(text), PASTE_LAND_MS);
  };

  const paste = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) {
        flow("intake_paste", { entry, via: "button", result: "empty" });
        setMessage(
          "Your clipboard is empty. Copy the event page link first.",
        );
        inputRef.current?.focus();
        return;
      }
      flow("intake_paste", { entry, via: "button", result: "success" });
      landLink(text);
    } catch {
      flow("intake_paste", { entry, via: "button", result: "denied" });
      setMessage(
        "Your browser won't let us read the clipboard. Press and hold the line to paste.",
      );
      inputRef.current?.focus();
    }
  };

  const printing = phase === "printing" || phase === "leaving";

  return (
    <section
      ref={section}
      data-reduced-motion={reduced ? "" : undefined}
      className={cx(
        "desk-surface",
        s.section,
        fill && s.fill,
        inPress && s.press,
      )}
      aria-labelledby={titleId}
    >
      <div className={s.frame}>
        {printing ? (
          job && (
            <div
              className={cx(s.printing, phase === "leaving" && s.printingOut)}
            >
              <Printing
                input={job.input}
                stubId={job.stubId}
                entry={entry}
                onDone={(event) => {
                  const kept = keepStubResult(event, job.stubId);
                  flow("creation_complete", { entry, input_source: inputSource(job.input), result: kept.created ? "created" : "reopened", storage: kept.stored ? "ok" : "failed" });
                  open(kept.id);
                }}
                onError={(msg, err) => {
                  flow("creation_error", { entry, input_source: inputSource(job.input), error_code: errorCode(err) });
                  setPhase("idle");
                  setJob(null);
                  setMessage(
                    msg || "Try a different link, or search for your show.",
                  );
                  // back to the field with the problem, so the next key goes where the fix is
                  requestAnimationFrame(() => inputRef.current?.focus());
                }}
              />
            </div>
          )
        ) : (
          <div className={cx(s.desk, phase === "feeding" && s.feeding)}>
            <div ref={showcase} className={s.shelf} aria-hidden="true">
              <StubView stub={sample} size="lg" tilt className={s.bigStub} />
            </div>

            <div className={s.entry}>
              <h2 id={titleId} className={s.title}>
                Paste your link. We design the stub.
              </h2>
              <p className={s.lede}>
                Use the event page link, or type the night. We find it
                and design your keepsake stub.
              </p>

              <form
                className={s.ticketWrap}
                onSubmit={(e) => {
                  e.preventDefault();
                  submit(link);
                }}
              >
                <div className={s.ticket}>
                  <div className={s.main}>
                    <p className={s.admit}>Admit one</p>
                    <label
                      htmlFor={inputId}
                      className={cx("desk-label", s.linkLabel)}
                    >
                      Event link
                    </label>
                    <input
                      ref={inputRef}
                      id={inputId}
                      className={s.ink}
                      type="text"
                      inputMode="url"
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      enterKeyHint="go"
                      placeholder="ticketmaster.com/event/…"
                      value={link}
                      disabled={phase !== "idle"}
                      required
                      aria-invalid={message ? true : undefined}
                      aria-describedby={message ? noteId : undefined}
                      onChange={(e) => {
                        setLink(e.target.value);
                        if (message) setMessage(null);
                      }}
                      onPaste={(e) => {
                        const text = e.clipboardData.getData("text").trim();
                        if (text) {
                          e.preventDefault();
                          flow("intake_paste", { entry, via: "field", result: "success" });
                          landLink(text);
                        }
                      }}
                    />
                  </div>
                  <div className={s.tearOff}>
                    <span className={s.no} aria-hidden="true">
                      No. 0001
                    </span>
                    <PaperButton
                      type="button"
                      className={s.paste}
                      onClick={paste}
                      disabled={phase !== "idle"}
                    >
                      Paste
                    </PaperButton>
                  </div>
                </div>
                <span className={s.slot} aria-hidden="true" />
              </form>

              <p
                id={noteId}
                className={s.note}
                data-announce
              >
                {message ?? ""}
              </p>

              <div className={s.actions}>
                <Stamp
                  type="button"
                  disabled={phase !== "idle"}
                  onClick={() => submit(link)}
                >
                  Make my stub
                </Stamp>
              </div>

              <div className={s.demos}>
                <p className={cx("desk-label", s.demoLabel)}>Or try a demo</p>
                <Tags label="Demo events">
                  {DEMO_TAGS.map((d) => (
                    <Tag
                      key={d.key}
                      type="button"
                      disabled={phase !== "idle"}
                      onClick={() => demo(d.key)}
                    >
                      {d.label}
                    </Tag>
                  ))}
                </Tags>
              </div>

              <TearLink
                type="button"
                className={s.search}
                onClick={() => {
                  flow("cta_select", { cta: "search", context: entry });
                  router.push("/search");
                }}
              >
                No link? Search for your show
                <LeavesMark />
              </TearLink>
            </div>
          </div>
        )}
      </div>
      {phase === "leaving" ? (
        <div className={s.curtain} aria-hidden="true" />
      ) : null}
    </section>
  );
}
