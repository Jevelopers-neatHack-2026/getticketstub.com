"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { announce } from "@/customer/a11y/announce";
import { useDialogFocus } from "@/customer/a11y/focus";
import { StubView } from "@/customer/studio/stub/StubView";
import { play, haptic } from "@/customer/studio/feedback";
import { loadWall, removeStub, saveWall, upsertStub } from "@/customer/studio/store";
import { api } from "@/customer/account/api";
import { sharePath } from "@/customer/account/share";
import { dismissSavePrompt, openSignIn, savePromptDismissed } from "@/customer/account/signin";
import { WALL_SYNCED } from "@/customer/account/sync";
import { useAccount } from "@/customer/account/useAccount";
import { MATERIALS, formatMoney, type Stub } from "@/customer/studio/types";
import { FINISHES, materialPrice } from "@/customer/pages/commerce";
import { copyLink, absoluteUrl, encodeWall, memoryPath, formatDate, shareLink, WALL_TOKEN_MAX, type ShareContext } from "@/customer/pages/share";
import { errorCode, flow } from "@/customer/flows/events";
import { useMounted } from "@/customer/pages/useMounted";
import { LeavesMark } from "@/customer/pages/ui";
import { PathTrack } from "@/customer/wayfinding/PathTrack";
import { PaperButton, SandboxStrip, Stamp, Stamped, Switch, Tag, Tags, TearLink, Tool, Tools } from "@/customer/desk/Desk";
import { FlipIcon } from "@/customer/desk/icons";
import { EditIcon, OpenIcon, PrintIcon, ShareIcon } from "./liftIcons";
import { DeskPage, Pin, chrome as c } from "./chrome";
import { Canvas, type CanvasApi } from "./Canvas";
import { dealMissing, freshAngle, type PlacedStub } from "./placement";
import { DownloadStub } from "@/customer/studio/download/DownloadStub";
import s from "./wall.module.css";

type Filter = "all" | "concert" | "game" | "show" | "generic";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "concert", label: "Concerts" },
  { id: "game", label: "Games" },
  { id: "show", label: "Shows" },
  { id: "generic", label: "Other" },
];
const PUBLIC_KEY = "ticketstub.wall.public.v1";
const LAMP_MS = 600;
const LAND_MS = 900;

/** What printing this stub costs: its material plus the finish upcharge, both from the price tables. */
function printPrice(st: Stub): number {
  const physical = st.material !== "digital";
  return materialPrice(st.material) + (physical ? (FINISHES.find((f) => f.id === st.finish)?.upchargeMinor ?? 0) : 0);
}
const materialLabel = (st: Stub) => MATERIALS.find((m) => m.id === st.material)?.label ?? "";
const finishLabel = (st: Stub) => (st.material === "digital" ? "" : (FINISHES.find((f) => f.id === st.finish)?.label ?? ""));

async function shareStub(st: Stub, context: ShareContext): Promise<string> {
  const url = absoluteUrl(await sharePath(st));
  // cancelled or blocked share sheet: fall back to copying (shareLink reports the one outcome)
  const outcome = await shareLink({ title: st.event.title, url }, context, "stub", { copyOnCancel: true });
  return outcome === "shared" ? "Shared." : outcome === "copied" ? "Link copied. Anyone with the link can see this stub." : "Couldn't copy the link. Open the stub and copy it from there.";
}

interface StubDrag {
  id: string;
  pid: number;
  el: HTMLElement;
  sx: number;
  sy: number;
  ox: number;
  oy: number;
  x: number;
  y: number;
  moved: boolean;
}

interface Lift {
  id: string;
  leaving: boolean;
  top: number;
}

export default function WallClient({ emailSent, pinnedId, liftId }: { emailSent: boolean; pinnedId?: string; liftId?: string }) {
  const router = useRouter();
  const mounted = useMounted();
  const [stubs, setStubs] = useState<PlacedStub[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [lift, setLift] = useState<Lift | null>(null);
  const [banner, setBanner] = useState(emailSent);
  const [isPublic, setIsPublic] = useState(false);
  // the account's public page token, once the server has issued one; until then the encoded link stands in
  const [publicToken, setPublicToken] = useState<string | null>(null);
  const { status: acct } = useAccount();
  const canvasApi = useRef<CanvasApi | null>(null);
  const drag = useRef<StubDrag | null>(null);
  const suppressClick = useRef(false);
  const publicRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyMove = useRef<{ t: ReturnType<typeof setTimeout>; stored: boolean } | null>(null);

  const [loaded, setLoaded] = useState(false);
  if (mounted && !loaded) {
    setLoaded(true);
    setStubs(loadWall());
    try {
      setIsPublic(localStorage.getItem(PUBLIC_KEY) === "1");
    } catch {
      /* storage unavailable */
    }
  }

  // The wall as it was read on arrival: once per visit, after the stored wall is loaded.
  const viewed = useRef(false);
  useEffect(() => {
    if (!loaded || viewed.current) return;
    viewed.current = true;
    flow("wall_view", { state: stubs.length ? "loaded" : "empty", stub_count: Math.min(1000, stubs.length) });
  }, [loaded, stubs.length]);

  // a sync that finished (sign-in, focus, another device) hands the merged wall back to the board
  useEffect(() => {
    const onSynced = () => setStubs(loadWall());
    window.addEventListener(WALL_SYNCED, onSynced);
    return () => window.removeEventListener(WALL_SYNCED, onSynced);
  }, []);

  // signed in with the page already public: fetch the stable token (the call is idempotent)
  useEffect(() => {
    if (acct !== "in" || !isPublic) return;
    let live = true;
    api
      .setPublic(true)
      .then((r) => live && setPublicToken(r.token))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [acct, isPublic]);

  const landing = pinnedId ? (stubs.find((x) => x.id === pinnedId) ?? null) : null;
  const landingId = landing?.id;

  // The landing: the pin presses in as the stub settles. Then the address drops its ?pinned so a reload is at rest.
  useEffect(() => {
    if (!landingId) return;
    const t = setTimeout(
      () => {
        play("pin");
        haptic([30, 30, 60]);
      },
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : LAND_MS - 120,
    );
    // bring the board up so the landing and its next steps are in view, on a phone as on a desk
    const sc = setTimeout(() => {
      const top = (trackRef.current ?? boardRef.current)?.getBoundingClientRect().top;
      if (top !== undefined) window.scrollTo({ top: window.scrollY + top - 12, behavior: "instant" });
    }, 120);
    window.history.replaceState(null, "", "/wall");
    return () => {
      clearTimeout(t);
      clearTimeout(sc);
    };
  }, [landingId]);

  const openLift = useCallback((id: string, via?: "pointer" | "keyboard") => {
    if (via) flow("wall_stub_open", { via });
    const r = publicRef.current?.getBoundingClientRect();
    // keep the public switch in the light: the lamp starts below it when it's on screen
    const top = !canvasApi.current?.fullscreen() && r && r.bottom > 0 && r.top < window.innerHeight ? Math.ceil(r.bottom) + 12 : 16;
    setLift({ id, leaving: false, top });
    play("flick");
    haptic([8]);
  }, []);

  // /wall?lift=<id> (from "On your wall" in the editor) opens with that stub already lifted
  const [lifted, setLifted] = useState(false);
  if (loaded && !lifted) {
    setLifted(true);
    if (liftId && stubs.some((x) => x.id === liftId)) setLift({ id: liftId, leaving: false, top: 16 });
  }

  const putBack = useCallback(() => {
    setLift((cur) => {
      if (!cur || cur.leaving) return cur;
      play("pin");
      haptic([10]);
      timer.current = setTimeout(() => {
        setLift(null);
        document.querySelector<HTMLElement>(`[data-stub-id="${CSS.escape(cur.id)}"]`)?.focus();
      }, LAMP_MS);
      return { ...cur, leaving: true };
    });
  }, []);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const counts = useMemo(() => {
    const n: Record<Filter, number> = { all: stubs.length, concert: 0, game: 0, show: 0, generic: 0 };
    for (const st of stubs) {
      const t = (st.event?.type ?? "generic") as Filter;
      n[t in n ? t : "generic"]++;
    }
    return n;
  }, [stubs]);
  const cities = useMemo(() => new Set(stubs.map((x) => x.event.city).filter(Boolean)).size, [stubs]);
  // a filter only shows up when it would find something, and only when there is more than one kind
  const shownFilters = FILTERS.filter((f) => f.id !== "all" && counts[f.id] > 0);
  const activeFilter = filter === "all" || counts[filter] > 0 ? filter : "all";
  // every stub has a spot on the canvas; ones that never had one are dealt into the next free slot (and saved, below)
  const placed = useMemo(() => dealMissing(stubs), [stubs]);
  useEffect(() => {
    if (!placed.placed.length) return;
    const at = Date.now();
    saveWall(placed.stubs.map((st) => (placed.placed.includes(st.id) ? { ...st, updatedAt: at } : st)));
  }, [placed]);
  const onCanvas = useMemo(() => placed.stubs.filter((x) => x.id !== landingId), [placed, landingId]);
  // the filter dims what doesn't match, so nothing jumps around the canvas
  const matches = (st: Stub) => activeFilter === "all" || (st.event.type ?? "generic") === activeFilter;
  // the most recently moved stub lies on top
  const stack = useMemo(() => new Map([...onCanvas].sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0)).map((st, i) => [st.id, i + 1])), [onCanvas]);
  const layoutKey = `${activeFilter}|${onCanvas.map((st) => `${st.id}:${Math.round(st.wallX ?? 0)}:${Math.round(st.wallY ?? 0)}`).join(",")}`;
  const liftedStub = lift ? (stubs.find((x) => x.id === lift.id) ?? null) : null;

  function chooseFilter(f: Filter) {
    if (f !== activeFilter) flow("wall_filter", { filter: f });
    setFilter(f);
  }

  function togglePublic(next: boolean) {
    setIsPublic(next);
    try {
      localStorage.setItem(PUBLIC_KEY, next ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
    if (acct === "in") {
      api
        .setPublic(next)
        .then((r) => {
          flow("wall_public_toggle", { public: next, result: "saved" });
          setPublicToken(next ? r.token : null);
        })
        .catch((e) => {
          /* the encoded link still works; the switch tries again next time */
          flow("wall_public_toggle", { public: next, result: "error", error_code: errorCode(e) });
        });
    } else flow("wall_public_toggle", { public: next, result: "local" }); // signed out: the page is the encoded link on this device
  }

  /** "Stop sharing": the page goes private and its link is replaced, so the old one is dead for good. */
  function stopSharingWall() {
    setIsPublic(false);
    setPublicToken(null);
    try {
      localStorage.setItem(PUBLIC_KEY, "0");
    } catch {
      /* storage unavailable */
    }
    api
      .stopSharingWall()
      .then(() => flow("wall_stop_sharing", { result: "saved" }))
      .catch((e) => {
        /* the switch is off here; the server copy goes private the next time the switch is touched */
        flow("wall_stop_sharing", { result: "error", error_code: errorCode(e) });
      });
  }

  /** Let go of a stub drag in progress (a second finger landed: that is a pinch, not a move). */
  const cancelDrag = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const li = d.el.closest<HTMLElement>("[data-stub-area]");
    li?.style.setProperty("--x", `${d.ox}px`);
    li?.style.setProperty("--y", `${d.oy}px`);
    if (li) delete li.dataset.drag;
  }, []);

  function stubDown(e: React.PointerEvent<HTMLButtonElement>, st: PlacedStub) {
    // middle and space drags pan, and so does the second finger of a pinch
    if (e.button !== 0 || drag.current || canvasApi.current?.panning.current) return;
    const el = e.currentTarget;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is already gone */
    }
    const x = st.wallX ?? 0;
    const y = st.wallY ?? 0;
    drag.current = { id: st.id, pid: e.pointerId, el, sx: e.clientX, sy: e.clientY, ox: x, oy: y, x, y, moved: false };
  }

  function stubMove(e: React.PointerEvent<HTMLButtonElement>) {
    const d = drag.current;
    if (!d || d.pid !== e.pointerId) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    const li = d.el.closest<HTMLElement>("[data-stub-area]");
    if (!li) return;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 5) return;
      d.moved = true;
      li.dataset.drag = "true";
      play("tap", { emphasis: "subtle" });
      haptic([6]);
    }
    // the pointer moved dx on screen, which is dx over the zoom on the canvas, so the stub stays under it at any zoom
    const k = canvasApi.current?.scale() || 1;
    d.x = d.ox + dx / k;
    d.y = d.oy + dy / k;
    li.style.setProperty("--x", `${d.x}px`);
    li.style.setProperty("--y", `${d.y}px`);
  }

  function stubUp(e: React.PointerEvent<HTMLButtonElement>, st: PlacedStub) {
    const d = drag.current;
    if (!d || d.pid !== e.pointerId) return;
    drag.current = null;
    try {
      d.el.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (!d.moved) return; // a tap: the click lifts it
    suppressClick.current = true;
    window.setTimeout(() => (suppressClick.current = false), 80);
    // pinned back down at a fresh small tilt
    const angle = freshAngle();
    const li = d.el.closest<HTMLElement>("[data-stub-area]");
    li?.style.setProperty("--angle", `${angle}deg`);
    if (li) delete li.dataset.drag;
    const next: PlacedStub = { ...st, wallX: Math.round(d.x), wallY: Math.round(d.y), wallAngle: angle };
    setStubs((prev) => prev.map((x) => (x.id === next.id ? { ...next, updatedAt: Date.now() } : x)));
    flow("wall_reorder", { method: "drag", storage: upsertStub(next) ? "ok" : "failed" });
    play("pin");
    haptic([20]);
  }

  /** Move a focused stub with the arrow keys (12 px, 48 with Shift): the keyboard way to do what a drag does. */
  function stubKey(e: React.KeyboardEvent<HTMLButtonElement>, st: PlacedStub) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const step = e.shiftKey ? 48 : 12;
    const by: Record<string, [number, number, string]> = { ArrowLeft: [-step, 0, "left"], ArrowRight: [step, 0, "right"], ArrowUp: [0, -step, "up"], ArrowDown: [0, step, "down"] };
    const move = by[e.key];
    if (!move) return;
    e.preventDefault();
    const next: PlacedStub = { ...st, wallX: Math.round((st.wallX ?? 0) + move[0]), wallY: Math.round((st.wallY ?? 0) + move[1]) };
    setStubs((prev) => prev.map((x) => (x.id === next.id ? { ...next, updatedAt: Date.now() } : x)));
    const stored = upsertStub(next);
    // each arrow press moves and saves; the move is reported once the keys settle, not per press
    const ok = stored && (keyMove.current?.stored ?? true);
    if (keyMove.current) clearTimeout(keyMove.current.t);
    keyMove.current = {
      stored: ok,
      t: setTimeout(() => {
        flow("wall_reorder", { method: "keyboard", storage: keyMove.current?.stored ? "ok" : "failed" });
        keyMove.current = null;
      }, 800),
    };
    play("tap", { emphasis: "subtle" });
    announce(`Moved ${move[2]}.`);
  }

  function remove(id: string) {
    flow("wall_remove", { storage: removeStub(id) ? "ok" : "failed" });
    setStubs((prev) => prev.filter((x) => x.id !== id));
    setLift(null);
  }

  return (
    <DeskPage>
      {landing ? <div className={`desk-surface ${s.lights}`} aria-hidden="true" /> : null}

      {banner ? (
        <div className={s.banner} data-announce>
          <p>
            <strong>Check your email.</strong> Your receipt is on its way.
          </p>
          <TearLink
            type="button"
            onClick={() => {
              flow("wall_banner_dismiss");
              setBanner(false);
            }}
          >
            Dismiss
          </TearLink>
        </div>
      ) : null}

      {landing ? (
        <div ref={trackRef} className={s.track}>
          <PathTrack current="wall" stubId={landing.id} fork />
        </div>
      ) : null}

      <div className={s.headRow}>
        <div className={c.head}>
          <h1 className={c.title}>Your wall</h1>
          {mounted && stubs.length > 0 ? (
            <p className={c.caption}>
              {stubs.length} {stubs.length === 1 ? "night" : "nights"}
              {cities > 0 ? ` · ${cities} ${cities === 1 ? "city" : "cities"}` : ""}
            </p>
          ) : null}
        </div>
        {mounted && stubs.length > 0 ? (
          <div ref={publicRef} className={s.publicBox}>
            <Switch checked={isPublic} onChange={togglePublic} hint="Only people with the link can see it.">
              Public page
            </Switch>
            {isPublic ? <PublicLink path={`/u/${publicToken ?? encodeWall(stubs)}`} capped={!publicToken && stubs.length > WALL_TOKEN_MAX} onStop={publicToken ? stopSharingWall : undefined} /> : null}
          </div>
        ) : null}
      </div>

      {mounted && shownFilters.length > 1 ? (
        <Tags label="Filter by event type">
          <Tag pressed={activeFilter === "all"} count={counts.all} onClick={() => chooseFilter("all")}>
            All
          </Tag>
          {shownFilters.map((f) => (
            <Tag key={f.id} pressed={activeFilter === f.id} count={counts[f.id]} onClick={() => chooseFilter(f.id)}>
              {f.label}
            </Tag>
          ))}
        </Tags>
      ) : null}

      {mounted && landing ? (
        <div className={`${c.cork} ${s.feature}`}>
          <div className={s.landing} style={{ ["--angle" as string]: `${landing.wallAngle ?? 0}deg` } as CSSProperties}>
            <Pin seed={landing.id} press delay={LAND_MS - 160} />
            <StubView stub={landing} size="md" />
          </div>
          <NextSteps stub={landing} />
        </div>
      ) : null}

      {mounted && stubs.length === 0 ? (
        <section ref={boardRef} className={`${c.cork} ${s.board}`} aria-label="Your stubs, pinned to a corkboard">
          <div className={s.empty}>
            <div className={s.emptySlot} aria-hidden="true" />
            <p className={s.emptyText}>Your first stub goes here.</p>
            <Stamp
              type="button"
              onClick={() => {
                flow("cta_select", { cta: "make", context: "wall" });
                router.push("/make");
              }}
            >
              Make your first stub
              <LeavesMark />
            </Stamp>
          </div>
        </section>
      ) : null}

      {mounted && stubs.length > 0 ? (
        <section ref={boardRef} className={s.board} aria-label="Your stubs, pinned to a corkboard">
          <Canvas
            label="Your wall. Arrow keys move around the cork, plus and minus zoom, 0 fits, F is fullscreen. Tab to a stub and press Enter to lift it, or use the arrow keys to move it."
            layoutKey={layoutKey}
            fitKey={activeFilter}
            apiRef={canvasApi}
            onCancelGesture={cancelDrag}
            overlay={lift && liftedStub ? <Lamp key={liftedStub.id} stub={liftedStub} lift={lift} onPutBack={putBack} onDelete={remove} /> : null}
          >
            {onCanvas.map((st, i) => (
              <div
                key={st.id}
                className={`${s.pinned} ${lift?.id === st.id ? s.lifted : ""}`}
                data-stub-area
                data-dim={matches(st) ? undefined : "true"}
                style={
                  {
                    ["--x" as string]: `${st.wallX ?? 0}px`,
                    ["--y" as string]: `${st.wallY ?? 0}px`,
                    ["--angle" as string]: `${st.wallAngle ?? 0}deg`,
                    ["--i" as string]: Math.min(i, 12),
                    zIndex: stack.get(st.id),
                  } as CSSProperties
                }
              >
                <Pin seed={st.id} />
                <button
                  type="button"
                  data-stub-id={st.id}
                  className={s.stubBtn}
                  aria-label={`Lift ${st.event.title}${st.event.dateISO ? `, ${formatDate(st.event.dateISO)}` : ""}`}
                  aria-describedby="wall-stub-help"
                  aria-expanded={lift?.id === st.id}
                  onKeyDown={(e) => stubKey(e, st)}
                  onPointerDown={(e) => stubDown(e, st)}
                  onPointerMove={stubMove}
                  onPointerUp={(e) => stubUp(e, st)}
                  onPointerCancel={cancelDrag}
                  onClick={(e) => {
                    // a click with no pointer detail came from the keyboard (Enter or Space)
                    if (!suppressClick.current) openLift(st.id, e.detail === 0 ? "keyboard" : "pointer");
                  }}
                >
                  {/* the button's own label names it; the printed stub inside is a picture of that */}
                  <span aria-hidden="true" style={{ display: "contents" }}>
                    <StubView stub={st} size="sm" />
                  </span>
                </button>
              </div>
            ))}
          </Canvas>
          <p id="wall-stub-help" hidden>
            Enter lifts the stub. Arrow keys move it 12 pixels, or 48 with Shift. Escape pins it back.
          </p>
        </section>
      ) : null}
      {mounted && stubs.length > 1 ? <p className={s.hint}>Drag a stub to move it. Scroll to zoom, drag the cork to pan.</p> : null}
    </DeskPage>
  );
}

/** The public link on a paper strip. */
function PublicLink({ path, capped, onStop }: { path: string; capped: boolean; onStop?: () => void }) {
  const [status, setStatus] = useState("");
  const [confirming, setConfirming] = useState(false);
  const url = absoluteUrl(path);
  return (
    <div className={s.publicLink}>
      <div className={s.copyRow}>
        <input className={s.copyInput} readOnly aria-label="Public wall link" value={url} onFocus={(e) => e.currentTarget.select()} />
        <PaperButton type="button" onClick={async () => setStatus((await copyLink(url, "wall", "wall")) ? "Link copied." : "Couldn't copy. Select the link and copy it.")}>
          Copy link
        </PaperButton>
      </div>
      {onStop ? (
        confirming ? (
          <p className={s.small} role="group" aria-label="Stop sharing this page">
            This link stops working for everyone who has it.{" "}
            <TearLink type="button" onClick={onStop}>
              Stop sharing
            </TearLink>{" "}
            <TearLink type="button" onClick={() => setConfirming(false)}>
              Keep sharing
            </TearLink>
          </p>
        ) : (
          <TearLink type="button" onClick={() => setConfirming(true)}>
            Stop sharing
          </TearLink>
        )
      ) : null}
      {capped ? <p className={s.small}>Your {WALL_TOKEN_MAX} newest stubs appear on the public page.</p> : null}
      <p className={s.small} data-announce>
        {status}
      </p>
    </div>
  );
}

/** The next steps, on a paper note pinned beside the stub that just landed. */
function NextSteps({ stub }: { stub: Stub }) {
  const router = useRouter();
  const [status, setStatus] = useState("");
  const { status: acct, savingOff } = useAccount();
  const [notNow, setNotNow] = useState(savePromptDismissed);
  const digital = stub.material === "digital";
  const price = formatMoney(printPrice(stub));
  const detail = [materialLabel(stub), finishLabel(stub)].filter(Boolean).join(", ");
  return (
    <aside className={s.note} aria-labelledby="next-h">
      <Pin seed={`${stub.id}-note`} />
      <Stamped say>Pinned</Stamped>
      <h2 id="next-h" className={s.noteTitle}>
        It&apos;s on your wall.
      </h2>
      <p className={s.noteBody}>Send it to a friend, print it, or keep it on your phone.</p>
      {acct === "out" && !savingOff && !notNow ? (
        <div className={s.save}>
          <p className={s.saveText}>Save to your wall. We&apos;ll email you a link, so your stubs follow you to any phone or laptop.</p>
          <div className={s.saveRow}>
            <PaperButton type="button" onClick={() => openSignIn({ reason: "save", returnTo: "/wall" })}>
              Save to your wall
            </PaperButton>
            <TearLink
              type="button"
              onClick={() => {
                dismissSavePrompt();
                setNotNow(true);
              }}
            >
              Not now
            </TearLink>
          </div>
        </div>
      ) : null}
      <div className={s.noteActions}>
        <Stamp type="button" block onClick={async () => setStatus(await shareStub(stub, "wall"))}>
          Share your stub
        </Stamp>
        <PaperButton
          type="button"
          block
          className={s.printBtn}
          onClick={() => {
            flow("cta_select", { cta: "print", context: "wall" });
            router.push(`/checkout/${stub.id}`);
          }}
        >
          <span className={s.printLabel}>
            {digital ? "Get the file" : "Print it"}
            <LeavesMark />
          </span>
          <span className={s.price}>{price}</span>
        </PaperButton>
        <p className={s.small}>{detail}</p>
        <div className={s.noteLinks}>
          <TearLink
            type="button"
            onClick={() => {
              flow("cta_select", { cta: "wallet", context: "wall" });
              router.push(`/wallet/${stub.id}`);
            }}
          >
            Keep it in Wallet
            <LeavesMark />
          </TearLink>
          <TearLink
            type="button"
            onClick={() => {
              flow("cta_select", { cta: "friends", context: "wall" });
              router.push(`/friends/${stub.id}`);
            }}
          >
            Send matching stubs to friends
            <LeavesMark />
          </TearLink>
        </div>
      </div>
      <p className={s.small} data-announce>
        {status}
      </p>
      <SandboxStrip />
    </aside>
  );
}

/** A stub lifted under the lamp: the rest of the wall dims under a warm paper scrim, the stub tilts toward you, its tools sit on the cork. */
function Lamp({ stub, lift, onPutBack, onDelete }: { stub: Stub; lift: Lift; onPutBack: () => void; onDelete: (id: string) => void }) {
  const router = useRouter();
  const [flipped, setFlipped] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [status, setStatus] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const dragX = useRef<number | null>(null);
  const swiped = useRef(false);

  // The lamp is a dialog: focus lands on it, Tab stays inside it, and pinning back returns focus to the stub.
  useDialogFocus(rootRef, true, "self");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onPutBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onPutBack]);

  function flip() {
    setFlipped((f) => !f);
    play("flip");
    haptic([10]);
  }

  const path = memoryPath(stub);
  const style = { ["--lamp-top" as string]: `${lift.top}px` } as CSSProperties;
  return (
    <div ref={rootRef} tabIndex={-1} role="dialog" aria-label={`${stub.event.title}, lifted off the wall`} className={`${s.lamp} ${lift.leaving ? s.lampOff : ""}`} style={style}>
      <button type="button" className={s.scrim} aria-label="Pin it back" tabIndex={-1} onClick={onPutBack} />
      <div className={s.lampBody}>
        <div className={s.lampHead}>
          <h2 className={s.lampTitle}>{stub.event.title}</h2>
          <p className={s.lampMeta}>{[formatDate(stub.event.dateISO), stub.event.venue, stub.event.city].filter(Boolean).join(" · ")}</p>
        </div>
        <div
          className={s.lampStub}
          onPointerDown={(e) => {
            dragX.current = e.clientX;
            swiped.current = false;
          }}
          onPointerMove={(e) => {
            if (dragX.current !== null && !swiped.current && Math.abs(e.clientX - dragX.current) > 48) {
              swiped.current = true;
              flip();
            }
          }}
          onPointerUp={() => {
            dragX.current = null;
          }}
          onPointerCancel={() => {
            dragX.current = null;
          }}
        >
          <StubView stub={stub} size="md" tilt flipped={flipped} />
        </div>
        <div className={`${c.cork} ${c.corkFlat} ${s.tray}`}>
          <div className={s.trayPaper}>
            <Tools label="Stub actions">
              <Tool icon={<FlipIcon />} onClick={flip}>
                Flip
              </Tool>
              <Tool
                icon={<OpenIcon />}
                aria-label="Open the stub's page"
                onClick={() => {
                  flow("cta_select", { cta: "open_page", context: "lamp" });
                  router.push(path);
                }}
              >
                <span className={s.toolGo}>
                  Page
                  <LeavesMark />
                </span>
              </Tool>
              <Tool
                icon={<EditIcon />}
                onClick={() => {
                  flow("cta_select", { cta: "edit", context: "lamp" });
                  router.push(`/studio/${stub.id}`);
                }}
              >
                <span className={s.toolGo}>
                  Edit
                  <LeavesMark />
                </span>
              </Tool>
              <Tool icon={<ShareIcon />} onClick={async () => setStatus(await shareStub(stub, "lamp"))}>
                Share
              </Tool>
              <Tool
                icon={<PrintIcon />}
                onClick={() => {
                  flow("cta_select", { cta: "print", context: "lamp" });
                  router.push(`/checkout/${stub.id}`);
                }}
              >
                <span className={s.toolGo}>
                  Print
                  <LeavesMark />
                </span>
                <span className={s.toolPrice}>{formatMoney(printPrice(stub))}</span>
              </Tool>
            </Tools>
            <DownloadStub stub={stub} context="lamp" hint={false} />
            <div className={s.trayFoot}>
              <p className={s.small}>Tap anywhere else, or press Escape, to pin it back.</p>
              <p className={s.small} data-announce>
                {status}
              </p>
              <TearLink type="button" onClick={onPutBack}>
                Pin it back
              </TearLink>
              <TearLink
                type="button"
                onClick={() => {
                  if (confirmDelete) {
                    play("tear");
                    onDelete(stub.id);
                  } else setConfirmDelete(true);
                }}
              >
                {confirmDelete ? "Tap again to take it down" : "Take it down"}
              </TearLink>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
