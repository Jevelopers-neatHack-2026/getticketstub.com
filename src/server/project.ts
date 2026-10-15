import "server-only";
import type { DesignVersion, EventData, Fact, Stub } from "@/customer/studio/types";

// Public projections. A share link or a public wall is readable by anyone holding the URL, so what they
// see is rebuilt from a whitelist of fields on the way in and again on the way out (old rows were stored
// whole). Guest lists, notes, photos, the claim set id and anything we add to Stub later stay out unless
// someone lists them here.

const str = (v: unknown, max = 500): string | undefined => (typeof v === "string" ? v.slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const strs = (v: unknown, max = 100): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max).map((x) => x.slice(0, 200)) : []);

function fact(f: Fact): Fact {
  return {
    id: String(f.id).slice(0, 128),
    // App-owned share DTO retains display identity, never a canonical fact ID.
    ...(typeof f.clientEntityKey === "string" && /^ce_[a-zA-Z0-9-]{1,80}$/.test(f.clientEntityKey) ? { clientEntityKey: f.clientEntityKey } : {}),
    label: String(f.label ?? "").slice(0, 200),
    value: String(f.value ?? "").slice(0, 500),
    source: String(f.source ?? "").slice(0, 200),
    ...(str(f.sourceUrl) ? { sourceUrl: str(f.sourceUrl) } : {}),
    confidence: num(f.confidence) ?? 0,
    ...(Array.isArray(f.alternatives) ? { alternatives: strs(f.alternatives, 10) } : {}),
    provenance: f.provenance,
    ...(f.kept ? { kept: true } : {}),
  };
}

function event(e: EventData): EventData {
  const out: EventData = { type: e.type, title: String(e.title).slice(0, 300), facts: Array.isArray(e.facts) ? e.facts.slice(0, 200).map(fact) : [] };
  for (const k of ["subtitle", "venue", "city", "dateISO", "seat", "sourceUrl"] as const) {
    const v = str(e[k]);
    if (v !== undefined) out[k] = v;
  }
  if (Array.isArray(e.setlist)) out.setlist = e.setlist.slice(0, 200).map((s) => ({ title: String(s.title).slice(0, 200), ...(s.starred ? { starred: true } : {}) }));
  if (Array.isArray(e.cast)) out.cast = e.cast.slice(0, 200).map((s) => ({ name: String(s.name).slice(0, 200), ...(s.starred ? { starred: true } : {}) }));
  if (Array.isArray(e.programme)) out.programme = strs(e.programme, 200);
  if (e.score && typeof e.score === "object") {
    const sc = e.score;
    out.score = {
      home: String(sc.home).slice(0, 100),
      away: String(sc.away).slice(0, 100),
      homeScore: num(sc.homeScore) ?? 0,
      awayScore: num(sc.awayScore) ?? 0,
      moments: Array.isArray(sc.moments) ? sc.moments.slice(0, 200).map((m) => ({ minute: String(m.minute).slice(0, 20), text: String(m.text).slice(0, 300), ...(m.starred ? { starred: true } : {}) })) : [],
    };
  }
  return out;
}

function version(v: DesignVersion): DesignVersion {
  const a = v.art;
  // Art is a stored file, a bundled image or a procedural seed. Never an inline data URL.
  const src = typeof a.src === "string" && /^(\/api\/files\/|\/brand\/|https:\/\/)/.test(a.src) ? a.src : undefined;
  return {
    id: String(v.id).slice(0, 128),
    ...(typeof v.parentId === "string" ? { parentId: v.parentId.slice(0, 128) } : {}),
    edition: v.edition,
    art: { kind: src ? a.kind : "procedural", ...(src ? { src } : {}), seed: num(a.seed) ?? 0, ...(str(a.vibe, 120) ? { vibe: str(a.vibe, 120) } : {}), provenance: a.provenance, ...(a.unavailable === true ? { unavailable: true } : {}) },
    createdAt: String(v.createdAt ?? "").slice(0, 40),
  };
}

/** The part of a stub a link holder may see. No friends, note, photos or claim set. */
export function publicStub(s: Stub): Stub {
  const p = s.personal;
  return {
    id: s.id,
    createdAt: String(s.createdAt ?? "").slice(0, 40),
    event: event(s.event),
    versions: Array.isArray(s.versions) ? s.versions.slice(0, 50).map(version) : [],
    currentVersionId: String(s.currentVersionId ?? ""),
    personal: {
      titleFont: ([0, 1, 2, 3] as const).find((n) => n === p?.titleFont) ?? 0,
      titleColor: /^#[0-9a-fA-F]{3,8}$/.test(String(p?.titleColor)) ? p.titleColor : "#000000",
      foilTitle: p?.foilTitle === true,
      hiddenFields: strs(p?.hiddenFields, 50),
      friends: [],
      ...(str(p?.guestName, 120) ? { guestName: str(p?.guestName, 120) } : {}),
    },
    material: s.material,
    finish: s.finish,
    torn: s.torn === true,
    wallAngle: num(s.wallAngle) ?? 0,
    ...(num(s.wallX) !== undefined ? { wallX: num(s.wallX) } : {}),
    ...(num(s.wallY) !== undefined ? { wallY: num(s.wallY) } : {}),
    photos: [],
    ...(num(s.updatedAt) !== undefined ? { updatedAt: num(s.updatedAt) } : {}),
  };
}
