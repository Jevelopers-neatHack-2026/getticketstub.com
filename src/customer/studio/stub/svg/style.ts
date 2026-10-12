// A stub's style: an SVG template id (the current catalogue) or, for older stubs, a legacy edition.
import { EDITIONS, type DesignVersion, type Edition, type Stub } from "../../types";
import { EDITION_META } from "../editions";
import { STUB_TEMPLATES, templateById } from "./templates";
import type { StubCategory, StubData } from "./contract";

export type StyleId = string;

/** The styles offered in the studio, in picker order: the five editions (still the default, and what the agent,
 * exact download and approval code key on), then the SVG templates. */
export const STYLES: StyleId[] = [...EDITIONS, ...STUB_TEMPLATES.map((t) => t.id)];

const LEGACY_ASPECT: Record<Edition, number> = { researched: 2 / 3, risograph: 2 / 3, minimal: 2 / 3, letterpress: 1.9, classic: 2.4 };
const LEGACY_INCHES: Record<Edition, [number, number]> = {
  researched: [2, 3],
  risograph: [2, 3],
  minimal: [2, 3],
  letterpress: [5.5, 2.9],
  classic: [5.5, 2.3],
};

export const styleOf = (v: Pick<DesignVersion, "edition" | "template">): StyleId => v.template ?? v.edition;

/** Width / height. */
export function styleAspect(style: StyleId): number {
  const t = templateById(style);
  return t ? t.width / t.height : (LEGACY_ASPECT[style as Edition] ?? 2 / 3);
}

/** Printed size in inches (templates are drawn at 200 units per inch). */
export function styleInches(style: StyleId): [number, number] {
  const t = templateById(style);
  return t ? [t.width / 200, t.height / 200] : (LEGACY_INCHES[style as Edition] ?? [2, 3]);
}

export function styleLabel(style: StyleId): string {
  return templateById(style)?.name ?? EDITION_META[style as Edition]?.label ?? style;
}

export function styleBlurb(style: StyleId): string | undefined {
  return templateById(style)?.blurb ?? EDITION_META[style as Edition]?.blurb;
}

export function styleOrientation(style: StyleId): "portrait" | "landscape" {
  return templateById(style)?.orientation ?? EDITION_META[style as Edition]?.orientation ?? "portrait";
}

const CATEGORY: Record<string, StubCategory> = { concert: "concert", game: "sport", show: "theater", generic: "other" };

/** The studio stub as template slot data. */
export function stubData(stub: Stub, art?: string): StubData {
  const e = stub.event;
  const people =
    e.cast?.map((c) => c.name) ??
    e.setlist?.slice(0, 6).map((t) => t.title) ??
    (e.score ? [`${e.score.home} ${e.score.homeScore}`, `${e.score.away} ${e.score.awayScore}`] : undefined);
  const seat = e.seat?.trim();
  const parts = seat ? /sec(?:tion)?\.?\s*(\w+)|row\s*(\w+)|seat\s*(\w+)/gi : null;
  let section: string | undefined, row: string | undefined, seatNo: string | undefined;
  if (seat && parts) {
    for (const m of seat.matchAll(parts)) {
      section ??= m[1];
      row ??= m[2];
      seatNo ??= m[3];
    }
    if (!section && !row && !seatNo) seatNo = seat;
  }
  const kept = e.facts.filter((f) => f.kept && f.confidence >= 0.8 && !stub.personal.hiddenFields.includes(f.id));
  return {
    category: CATEGORY[e.type] ?? "other",
    title: e.title,
    subtitle: e.subtitle,
    kicker: kept[0]?.value,
    people,
    tagline: stub.personal.note,
    venue: e.venue,
    city: e.city,
    dateISO: e.dateISO,
    section,
    row,
    seat: seatNo,
    home: e.score?.home,
    away: e.score?.away,
    score: e.score ? `${e.score.homeScore} – ${e.score.awayScore}` : undefined,
    serial: String(100000000 + (parseInt(stub.id.replace(/\D/g, "").slice(0, 8) || "7", 10) % 899999999)),
    edition: `No. ${stub.id.replace(/[^a-z0-9]/gi, "").slice(-4).toUpperCase()}`,
    admit: stub.personal.guestName ? `Admit ${stub.personal.guestName}` : "Admit one",
    art: art ? { src: art } : undefined,
  };
}
