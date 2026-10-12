"use client";
// The stub. Three layers per face:
//   ART       currentVersion(stub).art (image, or procedural from seed). Never contains text.
//   LIVE TYPE title / subtitle / place+date / kept facts as a fact line / unsure facts as pulsing chips.
//   MATERIAL  paper + grain, edition edge (perforated stamp, admit-one corners, tear-off), foil + glare.
// Back (flipped): setlist / score / cast / programme by event.type, note, friends, "Memory page" QR, Ts stamp.
/* eslint-disable @next/next/no-img-element */
import { useCallback, useId, useMemo, useRef, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { activeCorrection } from "../facts/corrections";
import { currentVersion, type ArtLayer, type Edition, type Fact, type Stub } from "../types";
import { EDITION_META, type EditionMeta } from "./editions";
import { Foil, foilTextClass } from "./Foil";
import { proceduralArt } from "./proceduralArt";
import { hashSeed, rng } from "./rng";
import { useTilt } from "./useTilt";
import { SvgStub } from "./svg/SvgStub";
import { stubData } from "./svg/style";
import { templateById } from "./svg/templates";
import s from "./StubView.module.css";

export type StubElement = "title" | "subtitle" | "facts" | "art";

export interface StubViewProps {
  stub: Stub;
  flipped?: boolean;
  /** Export mode (src/customer/studio/download): one face, flat on the page, as printed. No tilt, flip, light, shadow or animation. */
  still?: "front" | "back";
  tilt?: boolean;
  size?: "sm" | "md" | "lg";
  selected?: string | null;
  onSelect?: (element: StubElement) => void;
  onChipTap?: (factId: string) => void;
  className?: string;
}

const WIDTHS = {
  portrait: { sm: 140, md: 260, lg: 360 },
  landscape: { sm: 230, md: 420, lg: 560 },
} as const;

const ASPECT: Record<Edition, string> = {
  researched: "2 / 3",
  risograph: "2 / 3",
  minimal: "2 / 3",
  letterpress: "1.9 / 1",
  classic: "2.4 / 1",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface DateParts {
  dd: string;
  mm: string;
  yyyy: string;
  yy: string;
  mon: string;
  dow: string;
  long: string; // 12 Oct 2024
}

function parseDate(iso?: string): DateParts | null {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  if (!m) return null;
  const [, y, mo, d] = m;
  const mi = Number(mo) - 1;
  if (mi < 0 || mi > 11) return null;
  const dow = DAYS[new Date(Date.UTC(Number(y), mi, Number(d))).getUTCDay()];
  return { dd: d, mm: mo, yyyy: y, yy: y.slice(2), mon: MONTHS[mi], dow, long: `${Number(d)} ${MONTHS[mi]} ${y}` };
}

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/** The paper's noise as an inline SVG, for export mode only: the screen tiles it as a CSS data-URL background, which the PNG rasteriser cannot carry (its "#" cuts the URL). Same filter, same alpha. */
function GrainNoise() {
  const id = `g${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <svg width="100%" height="100%" aria-hidden="true" style={{ position: "absolute", inset: 0 }}>
      <filter id={id} x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" stitchTiles="stitch" />
        <feColorMatrix values="0 0 0 0 0.55 0 0 0 0 0.5 0 0 0 0 0.42 0 0 0 0.55 0" />
      </filter>
      <rect width="100%" height="100%" filter={`url(#${id})`} />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* shared render context                                               */

interface Ctx {
  stub: Stub;
  edition: Edition;
  meta: EditionMeta;
  date: DateParts | null;
  place: string;
  kept: Fact[];
  unsure: Fact[];
  show: (key: string) => boolean;
  foilTitle: boolean;
  selected?: string | null;
  onSelect?: (el: StubElement) => void;
  onChipTap?: (factId: string) => void;
}

function Pick({ c, el, className, children }: { c: Ctx; el: StubElement; className?: string; children: ReactNode }) {
  const selected = c.selected === el;
  if (!c.onSelect) return <span className={cx(s.pick, className)}>{children}</span>;
  return (
    <button
      type="button"
      className={cx(s.pick, s.pickBtn, selected && s.selected, className)}
      aria-pressed={selected}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        c.onSelect?.(el);
      }}
    >
      {children}
    </button>
  );
}

function Title({ c, className, children }: { c: Ctx; className?: string; children?: ReactNode }) {
  return (
    <Pick c={c} el="title" className={cx(s.title, c.foilTitle && c.edition !== "risograph" && cx(foilTextClass, s.foilTitle), className)}>
      {children ?? c.stub.event.title}
    </Pick>
  );
}

function Subtitle({ c, className }: { c: Ctx; className?: string }) {
  const sub = c.stub.event.subtitle;
  if (!sub || !c.show("subtitle")) return null;
  return (
    <Pick c={c} el="subtitle" className={cx(s.subtitle, className)}>
      {sub}
    </Pick>
  );
}

/** "Admit · Jamie R." in the edition's own type and ink, last on the type block so it can't meet the title or the art. Only when the stub was issued to a named guest. */
function Admit({ c, className }: { c: Ctx; className?: string }) {
  const name = c.stub.personal.guestName;
  if (!name) return null;
  return (
    <span className={cx(s.admit, className)}>
      Admit<span aria-hidden="true"> · </span>
      <span className={s.admitName}>{name}</span>
    </span>
  );
}

function Chip({ c, f }: { c: Ctx; f: Fact }) {
  if (!c.onChipTap)
    return (
      <span className={s.chip}>
        {f.label}
        <span className={s.chipQ} aria-hidden="true">?</span>
      </span>
    );
  return (
    <button
      type="button"
      className={s.chip}
      aria-label={`Unsure: ${f.label}. Tap to check.`}
      onClick={(e) => {
        e.stopPropagation();
        c.onChipTap?.(f.id);
      }}
    >
      {f.label}
      <span className={s.chipQ} aria-hidden="true">?</span>
    </button>
  );
}

// Open-Meteo weather is CC BY 4.0: wherever it shows, on screen or in print, its credit sits next to it (#48).
// "live" matters: demo and pending weather also name Open-Meteo as their source. A value the person typed over the
// research is theirs, not Open-Meteo's. Public projections carry no correction history, so there it stays credited.
const fromOpenMeteo = (stub: Stub) => (f: Fact) =>
  f.id === "weather" && f.provenance === "live" && f.source.startsWith("Open-Meteo") && activeCorrection(stub, f.id)?.kind !== "correct";

function WeatherCredit() {
  return <span className={s.weatherCredit}>Weather data by Open-Meteo.com</span>;
}

function Facts({ c, className, sep = " · ", upper }: { c: Ctx; className?: string; sep?: string; upper?: boolean }) {
  if (!c.show("facts")) return null;
  const line = c.kept.map((f) => f.label).join(sep);
  if (!line && !c.unsure.length) return null;
  return (
    <div className={cx(s.facts, className)}>
      {line && (
        <Pick c={c} el="facts" className={s.factLine}>
          {upper ? line.toUpperCase() : line}
        </Pick>
      )}
      {c.unsure.length > 0 && (
        <span className={s.chips}>
          {c.unsure.map((f) => (
            <Chip key={f.id} c={c} f={f} />
          ))}
        </span>
      )}
      {[...c.kept, ...c.unsure].some(fromOpenMeteo(c.stub)) && <WeatherCredit />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* art                                                                 */

function ArtLayers({ art, edition }: { art: ArtLayer; edition: Edition }) {
  if (art.kind === "image" && art.src) {
    const img = <img className={s.artImg} src={art.src} alt="" draggable={false} decoding="async" />;
    if (edition === "risograph")
      return (
        <>
          <div className={cx(s.risoLayer, s.risoPink)}>{img}</div>
          <div className={cx(s.risoLayer, s.risoTeal)}>{img}</div>
        </>
      );
    return img;
  }
  const layers = proceduralArt(art.seed, edition);
  if (edition === "risograph")
    return (
      <>
        <div className={s.risoLayer} style={{ background: layers[0] }} />
        <div className={cx(s.risoLayer)} style={{ background: layers[1], transform: "translate(1.2%, 0.9%)" }} />
      </>
    );
  return <div className={s.artProc} style={{ background: layers[0] }} />;
}

function ArtBox({ c }: { c: Ctx }) {
  const art = currentVersion(c.stub).art;
  const selected = c.selected === "art";
  return (
    <div className={s.artBox}>
      <div className={s.artInner}>
        <ArtLayers art={art} edition={c.edition} />
      </div>
      {c.onSelect && (
        <button
          type="button"
          className={cx(s.artButton, selected && s.selected)}
          aria-label="Artwork"
          aria-pressed={selected}
          onClick={(e) => {
            e.stopPropagation();
            c.onSelect?.("art");
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* fronts                                                              */

function metaLine(_c: Ctx, parts: (string | undefined | false)[], sep = " · ") {
  return parts.filter(Boolean).join(sep);
}

function ResearchedFront({ c }: { c: Ctx }) {
  const e = c.stub.event;
  const meta = metaLine(c, [c.show("venue") && e.venue, c.show("city") && e.city, c.show("date") && c.date?.long]);
  return (
    <>
      <ArtBox c={c} />
      <div className={s.type}>
        <Title c={c} />
        <Subtitle c={c} />
        {meta && <span className={s.meta}>{meta}</span>}
        <span className={s.rule} aria-hidden="true" />
        <Facts c={c} />
        <Admit c={c} />
      </div>
    </>
  );
}

function LetterpressFront({ c }: { c: Ctx }) {
  const e = c.stub.event;
  const meta = metaLine(c, [c.show("venue") && e.venue, c.show("city") && e.city]);
  return (
    <>
      <div className={s.lpFrame} aria-hidden="true" />
      <div className={s.lpAdmit} aria-hidden="true">
        Admit one
      </div>
      <span className={cx(s.lpCorner, s.lpCornerTL)} aria-hidden="true">
        No. {String(hashSeed(c.stub.id) % 100000).padStart(5, "0")}
      </span>
      {c.stub.personal.guestName ? (
        <span className={cx(s.lpCorner, s.lpCornerBR)}>
          <Admit c={c} className={s.lpAdmitName} />
        </span>
      ) : (
        <span className={cx(s.lpCorner, s.lpCornerBR)} aria-hidden="true">
          Admit one
        </span>
      )}
      <ArtBox c={c} />
      <div className={s.type}>
        {meta && <span className={s.meta}>{meta}</span>}
        <Title c={c} />
        <Subtitle c={c} />
        {e.seat && c.show("seat") && <span className={s.seat}>{e.seat}</span>}
        <Facts c={c} />
      </div>
      {c.date && c.show("date") && (
        <span className={s.lpStamp} aria-hidden="true">
          {c.date.dd} {c.date.mon} {c.date.yyyy}
        </span>
      )}
    </>
  );
}

function RisoFront({ c }: { c: Ctx }) {
  const e = c.stub.event;
  const meta = metaLine(c, [c.show("date") && c.date?.long, c.show("venue") && e.venue, c.show("city") && e.city]);
  return (
    <>
      <ArtBox c={c} />
      <div className={s.type}>
        <div className={s.risoBlock}>
          <Title c={c} />
        </div>
        <Subtitle c={c} />
        {meta && <span className={s.meta}>{meta}</span>}
        <Facts c={c} sep=" / " />
        <Admit c={c} />
      </div>
    </>
  );
}

function MinimalFront({ c }: { c: Ctx }) {
  const e = c.stub.event;
  const meta = metaLine(c, [c.show("venue") && e.venue, c.show("city") && e.city, c.show("seat") && e.seat]);
  const showDate = c.date && c.show("date");
  return (
    <>
      <span className={s.minNum} aria-hidden="true">
        {showDate ? `${c.date!.dd}.${c.date!.mm}` : "00.00"}
      </span>
      {showDate && (
        <span className={s.minYear} aria-hidden="true">
          {c.date!.dow} {c.date!.yyyy}
        </span>
      )}
      <ArtBox c={c} />
      <span className={s.minBlock} aria-hidden="true" />
      <div className={s.type}>
        <Title c={c} />
        <Subtitle c={c} />
        {meta && <span className={s.meta}>{meta}</span>}
        <Facts c={c} sep="  /  " />
        <Admit c={c} />
      </div>
    </>
  );
}

function ClassicFront({ c }: { c: Ctx }) {
  const e = c.stub.event;
  const no = String(hashSeed(c.stub.id) % 1000000).padStart(6, "0");
  const rows: [string, string][] = [];
  if (e.venue && c.show("venue")) rows.push(["Venue", [e.venue, c.show("city") && e.city].filter(Boolean).join(", ")]);
  else if (e.city && c.show("city")) rows.push(["City", e.city]);
  if (c.date && c.show("date")) rows.push(["Date", `${c.date.dow} ${c.date.long}`]);
  if (e.seat && c.show("seat")) rows.push(["Seat", e.seat]);
  return (
    <>
      <div className={s.type}>
        <div className={s.clHead} aria-hidden="true">
          <span>Admit one</span>
          <span>No {no}</span>
        </div>
        <Title c={c} className={c.foilTitle ? undefined : s.dotMatrix} />
        <Subtitle c={c} />
        {rows.length > 0 && (
          <dl className={s.clRows}>
            {rows.map(([k, v]) => (
              <div key={k} style={{ display: "contents" }}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        )}
        <Facts c={c} sep=" * " upper />
        <Admit c={c} />
      </div>
      <span className={s.clPerf} aria-hidden="true" />
      <div className={s.clStub}>
        <ArtBox c={c} />
        {c.date && c.show("date") && (
          <span className={s.clStubDate}>
            {c.date.dd}.{c.date.mm}.{c.date.yy}
          </span>
        )}
        {e.seat && c.show("seat") && <span>{e.seat.split("·")[0]}</span>}
        <span className={s.clBarcode} aria-hidden="true" />
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* back                                                                */

function QrPlaceholder({ seed }: { seed: string }) {
  const cells = useMemo(() => {
    const r = rng(hashSeed(seed + ":qr"));
    const N = 21;
    const out: [number, number][] = [];
    const inFinder = (x: number, y: number) => (x < 8 && y < 8) || (x > N - 9 && y < 8) || (x < 8 && y > N - 9);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (!inFinder(x, y) && r() > 0.52) out.push([x, y]);
    return out;
  }, [seed]);
  const finder = (x: number, y: number) => (
    <g key={`${x}-${y}`}>
      <rect x={x} y={y} width={7} height={7} fill="#17140F" />
      <rect x={x + 1} y={y + 1} width={5} height={5} fill="#fff" />
      <rect x={x + 2} y={y + 2} width={3} height={3} fill="#17140F" />
    </g>
  );
  return (
    <svg viewBox="0 0 21 21" shapeRendering="crispEdges" aria-hidden="true">
      {cells.map(([x, y]) => (
        <rect key={`${x}.${y}`} x={x} y={y} width={1} height={1} fill="#17140F" />
      ))}
      {finder(0, 0)}
      {finder(14, 0)}
      {finder(0, 14)}
    </svg>
  );
}

function BackList({ c }: { c: Ctx }) {
  const e = c.stub.event;
  const cap = c.meta.orientation === "landscape" ? 7 : 9;
  if (e.type === "concert" && e.setlist?.length) {
    return (
      <ol className={s.backList}>
        {e.setlist.slice(0, cap).map((song, i) => (
          <li key={i} className={song.starred ? s.starred : undefined}>
            <span className={s.backIdx}>{String(i + 1).padStart(2, "0")}</span>
            <span>{song.title}</span>
            {song.starred && (
              <span className={s.star} aria-label="starred">
                ★
              </span>
            )}
          </li>
        ))}
      </ol>
    );
  }
  if (e.type === "game" && e.score) {
    const sc = e.score;
    return (
      <div className={s.backList}>
        <div className={s.score}>
          <span className={s.scoreNum}>
            {sc.homeScore}–{sc.awayScore}
          </span>
          <span>Full time</span>
        </div>
        <ul className={s.backList}>
          {sc.moments.slice(0, cap - 2).map((m, i) => (
            <li key={i} className={m.starred ? s.starred : undefined}>
              <span className={s.backIdx}>{m.minute}</span>
              <span>{m.text}</span>
              {m.starred && (
                <span className={s.star} aria-label="starred">
                  ★
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (e.type === "show" && e.cast?.length) {
    return (
      <ul className={s.backList}>
        {e.cast.slice(0, cap).map((p, i) => (
          <li key={i} className={p.starred ? s.starred : undefined}>
            <span>{p.name}</span>
            {p.starred && (
              <span className={s.star} aria-label="starred">
                ★
              </span>
            )}
          </li>
        ))}
      </ul>
    );
  }
  const shown = e.programme?.length ? [] : e.facts.filter((f) => c.show(f.id));
  // The list clips at its last row, so the credit takes a row of the cap rather than overflowing. Weather that would
  // land in that last row, with no room left for its credit, is left off the back instead.
  const om = fromOpenMeteo(c.stub);
  const credited = shown.slice(0, cap - 1).some(om);
  const listed = shown.slice(0, credited || (shown[cap - 1] && om(shown[cap - 1])) ? cap - 1 : cap);
  const items = e.programme?.length ? e.programme.slice(0, cap) : listed.map((f) => f.label);
  return (
    <ul className={s.backList}>
      {items.map((p, i) => (
        <li key={i}>
          <span className={s.backIdx}>·</span>
          <span>{p}</span>
        </li>
      ))}
      {credited && (
        <li>
          <WeatherCredit />
        </li>
      )}
    </ul>
  );
}

const KICKER: Record<string, string> = { concert: "Setlist", game: "Final score", show: "Cast", generic: "Programme" };

function Back({ c }: { c: Ctx }) {
  const e = c.stub.event;
  const { note, friends } = c.stub.personal;
  return (
    <div className={s.backBody}>
      <div className={s.backHead}>
        <span className={s.backKicker}>{KICKER[e.type] ?? "Programme"}</span>
        <span className={s.backTitle}>{e.title}</span>
        <Admit c={c} className={s.backAdmit} />
      </div>
      <BackList c={c} />
      {(note || friends.length > 0) && (
        <div style={{ display: "flex", flexDirection: "column", gap: "calc(1.6 * var(--u))", minWidth: 0 }}>
          {note && <p className={s.note}>&ldquo;{note}&rdquo;</p>}
          {friends.length > 0 && (
            <div className={s.friends} aria-label={`With ${friends.map((f) => f.name).join(", ")}`}>
              {friends.slice(0, 6).map((f, i) => (
                <span
                  key={i}
                  className={cx(s.friend, f.claimed ? s.friendClaimed : s.friendOpen)}
                  title={f.name + (f.claimed ? "" : " (not claimed yet)")}
                  aria-hidden="true"
                >
                  {initials(f.name)}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      <div className={s.backFoot}>
        <div className={s.qrWrap}>
          <div className={s.qr}>
            <QrPlaceholder seed={c.stub.id} />
          </div>
          <span className={s.qrLabel}>
            Memory page
            <span className={s.qrSub}>Scan to relive it</span>
          </span>
        </div>
        <img className={s.tsStamp} src="/brand/ts-stamp-mono-ink.svg" alt="TicketStub" draggable={false} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

const FRONTS: Record<Edition, (p: { c: Ctx }) => ReactNode> = {
  researched: ResearchedFront,
  letterpress: LetterpressFront,
  risograph: RisoFront,
  minimal: MinimalFront,
  classic: ClassicFront,
};

export function StubView({ stub, flipped = false, still, tilt = false, size = "md", selected = null, onSelect, onChipTap, className }: StubViewProps) {
  const tiltRef = useRef<HTMLDivElement | null>(null);
  const { requestGyro } = useTilt(tiltRef, tilt);
  const version = currentVersion(stub);
  const edition: Edition = version?.edition ?? "researched";
  const meta = EDITION_META[edition];
  const e = stub.event;

  const c: Ctx = useMemo(() => {
    const hidden = new Set(stub.personal.hiddenFields);
    const show = (k: string) => !hidden.has(k);
    const facts = e.facts.filter((f) => show(f.id));
    return {
      stub,
      edition,
      meta,
      date: parseDate(e.dateISO),
      place: [e.venue, e.city].filter(Boolean).join(", "),
      kept: facts.filter((f) => f.kept && f.confidence >= 0.8),
      unsure: facts.filter((f) => f.confidence < 0.8),
      show,
      foilTitle: stub.personal.foilTitle,
      selected,
      onSelect,
      onChipTap,
    };
  }, [stub, e, edition, meta, selected, onSelect, onChipTap]);

  const onClick = useCallback(() => {
    if (!tilt) return;
    if (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches) void requestGyro();
  }, [tilt, requestGyro]);

  const template = version?.template ? templateById(version.template) : undefined;
  const svgData = useMemo(
    () => (template ? stubData(stub, version.art.kind === "image" ? version.art.src : undefined) : null),
    [template, stub, version],
  );

  const Front = FRONTS[edition];
  const titleFont = meta.fontPairs[stub.personal.titleFont] ?? meta.fontPairs[0];
  const orientation = template?.orientation ?? meta.orientation;
  const vars = {
    "--w": `${WIDTHS[orientation][size]}px`,
    "--aspect": template ? `${template.width} / ${template.height}` : ASPECT[edition],
    "--paper": meta.paper,
    "--ink": meta.ink,
    "--accent": meta.accent,
    "--body": meta.bodyFont,
    "--title-font": titleFont,
    "--title-color": stub.personal.titleColor || meta.titleColor,
  } as CSSProperties;

  // The name is short (what it is); the description carries the rest (when, where, which facts, how it is finished).
  const label = `${e.title}, ${template?.name ?? meta.label} ${template ? "style" : "edition"} stub${flipped || still === "back" ? ", back" : ""}`;
  const description = [
    e.subtitle,
    e.venue,
    e.city,
    c.date?.long,
    stub.personal.guestName ? `Admits ${stub.personal.guestName}` : undefined,
    c.kept.length ? `Facts on the stub: ${c.kept.map((f) => f.label).join(", ")}` : undefined,
    c.unsure.length ? `${c.unsure.length} unsure ${c.unsure.length === 1 ? "fact" : "facts"} to check` : undefined,
    `${stub.finish} finish`,
    flipped || still === "back" ? "Showing the back" : "Showing the front",
  ]
    .filter(Boolean)
    .join(". ");
  const descId = useId();

  return (
    <figure
      className={cx(s.stub, template ? s.svgStub : s[edition], s[orientation], flipped && !still && s.flipped, still && s.still, still === "back" && s.stillBack, className)}
      style={vars}
      aria-label={label}
      aria-describedby={descId}
      data-edition={template?.id ?? edition}
      data-size={size}
      data-guest={stub.personal.guestName ? "" : undefined}
      onClick={onClick}
    >
      <span id={descId} hidden>
        {description}
      </span>
      <div ref={tiltRef} className={s.tilt}>
        <div className={s.flipper}>
          {template && svgData ? (
            <>
              {/* SVG template: paper, art, type, foil, holo and the die-cut are all in the file; its foil and holo
                  follow the tilt vars. No CSS paper, grain or glare: they would paint outside the die-cut. */}
              <div className={cx(s.face, s.front, s.svgFace)} aria-hidden={flipped || undefined}>
                <SvgStub template={template.id} face="front" data={svgData} className={s.svgHost} />
              </div>
              <div className={cx(s.face, s.back, s.svgFace)} aria-hidden={!flipped || undefined}>
                <SvgStub template={template.id} face="back" data={svgData} className={s.svgHost} />
              </div>
            </>
          ) : (
            <>
              <div className={cx(s.face, s.front)} aria-hidden={flipped || undefined}>
                <div className={s.paper} />
                <Front c={c} />
                <div className={s.grain} aria-hidden="true">
                  {still && <GrainNoise />}
                </div>
                <Foil finish={stub.finish} seed={stub.id} />
              </div>
              <div className={cx(s.face, s.back)} aria-hidden={!flipped || undefined}>
                <div className={s.paper} />
                <Back c={c} />
                <div className={s.grain} aria-hidden="true">
                  {still && <GrainNoise />}
                </div>
                <Foil finish="matte" seed={stub.id + ":back"} />
              </div>
            </>
          )}
        </div>
      </div>
    </figure>
  );
}
