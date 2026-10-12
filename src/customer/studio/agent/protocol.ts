// The agent action protocol (ticketstub.agent-action/1). Pure: no React, no server imports, so the browser, the
// route and the tests run this exact validation.
//
// The agent never edits a stub. It proposes a small closed set of typed actions; the owner applies them in the
// studio through the same edit paths a person uses, and the observed results come back here for a follow-up.
// Validation is strict on both sides: an unknown type, an unknown field, a wrong type or an oversized string
// rejects the whole message, and nothing is repaired or truncated silently.
import { EDITIONS, MATERIALS } from "../types";
import type { Edition, Finish, Material, Provenance, Stub } from "../types";
import { currentVersion } from "../types";

export const AGENT_SCHEMA = "ticketstub.agent-action/1";

export const FINISHES: readonly Finish[] = ["matte", "foil", "holo"];
const MATERIAL_IDS: readonly Material[] = MATERIALS.map((m) => m.id);
const PROVENANCES: readonly Provenance[] = ["live", "sandbox", "simulated", "estimated", "pending"];

export const LIMITS = {
  message: 400,
  reply: 480,
  question: 200,
  option: 60,
  options: 4,
  vibe: 80,
  value: 80,
  subtitle: 100,
  note: 120,
  actions: 4,
  facts: 12,
  results: 6,
  title: 120,
  city: 60,
  venue: 100,
  label: 80,
} as const;

export type FactField = "date" | "venue" | "keep" | "unkeep";
export type TextField = "title" | "subtitle" | "note";
/** What a question is about: the closed set an answer can be translated against. */
export type AskField = "date" | "venue" | TextField;
export const ASK_FIELDS: readonly AskField[] = ["date", "venue", "title", "subtitle", "note"];

export type Action =
  | { type: "set_fact"; field: FactField; value: string }
  | { type: "set_style"; edition: Edition }
  | { type: "set_material"; material: Material }
  | { type: "set_finish"; finish: Finish }
  | { type: "set_text"; field: TextField; value: string }
  /** `procedural` is the fallback (no provider call); `simulate` is a demo-only forced failure for the recovery path. */
  | { type: "remix_art"; vibe?: string; procedural?: boolean; simulate?: "failure" }
  | { type: "show_back" }
  | { type: "ask_user"; question: string; options?: string[]; field?: AskField }
  | { type: "none" };

export type ActionType = Action["type"];
export const ACTION_TYPES: readonly ActionType[] = ["set_fact", "set_style", "set_material", "set_finish", "set_text", "remix_art", "show_back", "ask_user", "none"];

/** What happened to a proposed action when the owner applied it. */
export type ResultStatus = "applied" | "failed" | "rejected";

export interface ActionResult {
  action: Action;
  status: ResultStatus;
  /** A bounded code for why (art_limit, provider_unavailable, invalid_value, ...). Never a message. */
  code?: string;
  /** How long applying took in the browser, in ms. */
  ms?: number;
}

/** The stub as the agent may see it: facts, style and settings. No guest names, friends, photos, seat or notes. */
export interface StateSummary {
  title: string;
  subtitle?: string;
  dateISO?: string;
  venue?: string;
  city?: string;
  facts: { id: string; label: string; value: string; kept: boolean; provenance: Provenance }[];
  edition: Edition;
  material: Material;
  finish: Finish;
  art: "image" | "procedural";
  versions: number;
}

export interface AgentRequest {
  schema: typeof AGENT_SCHEMA;
  state: StateSummary;
  /** What the person asked. Absent on a follow-up, where `results` says what happened. */
  message?: string;
  /** Observed results: of the action(s) just applied (follow-up) or of the previous turn (context for a new message). */
  results?: ActionResult[];
  /** The question the agent last asked, so a typed or tapped answer can be translated. Only meaningful with a message. */
  pending?: PendingQuestion;
}

/** An unanswered `ask_user`, carried by the browser into the next turn. It is context, never an instruction: only the owner's Apply changes a stub. */
export interface PendingQuestion {
  field: AskField;
  question: string;
  options?: string[];
}

export interface AgentPlan {
  reply: string;
  actions: Action[];
}

export interface AgentResponse extends AgentPlan {
  schema: typeof AGENT_SCHEMA;
  provenance: "live" | "rules";
}

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };
const bad = <T,>(reason: string): Parsed<T> => ({ ok: false, reason });
const good = <T,>(value: T): Parsed<T> => ({ ok: true, value });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const CONTROL = /[\u0000-\u001f\u007f]/;
const CODE = /^[a-z][a-z0-9_]{0,47}$/;
const FACT_ID = /^[A-Za-z0-9_-]{1,40}$/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date in 1900..2100 as yyyy-mm-dd. */
export function isRealDate(v: string): boolean {
  const m = ISO.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 2100) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  const extra = Object.keys(o).find((k) => !allowed.includes(k));
  return extra ? `unknown field "${extra.slice(0, 24)}"` : undefined;
}

function text(v: unknown, max: number, name: string): Parsed<string> {
  if (typeof v !== "string") return bad(`${name} must be a string`);
  const s = v.trim();
  if (!s) return bad(`${name} is empty`);
  if (s.length > max) return bad(`${name} is longer than ${max}`);
  if (CONTROL.test(s)) return bad(`${name} has control characters`);
  if (/[<>]/.test(s)) return bad(`${name} has markup`);
  return good(s);
}

function parseQuestion(question: unknown, rawOptions: unknown): Parsed<{ question: string; options?: string[] }> {
  const q = text(question, LIMITS.question, "question");
  if (!q.ok) return q;
  const out: { question: string; options?: string[] } = { question: q.value };
  if (rawOptions !== undefined) {
    if (!Array.isArray(rawOptions) || rawOptions.length > LIMITS.options) return bad(`options must be a list of at most ${LIMITS.options}`);
    const options: string[] = [];
    for (const o of rawOptions) {
      const t = text(o, LIMITS.option, "option");
      if (!t.ok) return t;
      options.push(t.value);
    }
    if (options.length) out.options = options;
  }
  return good(out);
}

function parsePending(raw: unknown): Parsed<PendingQuestion> {
  if (!isObject(raw)) return bad("pending must be an object");
  const extra = onlyKeys(raw, ["field", "question", "options"]);
  if (extra) return bad(`pending: ${extra}`);
  if (!(ASK_FIELDS as readonly unknown[]).includes(raw.field)) return bad("pending field is not valid");
  const q = parseQuestion(raw.question, raw.options);
  if (!q.ok) return bad(`pending: ${q.reason}`);
  return good({ field: raw.field as AskField, ...q.value });
}

/** Validates one action. `allowSimulate` is true only for the demo planner's forced failure. */
export function parseAction(raw: unknown, opts: { allowSimulate?: boolean } = {}): Parsed<Action> {
  if (!isObject(raw)) return bad("an action must be an object");
  const type = raw.type;
  if (typeof type !== "string" || !(ACTION_TYPES as readonly string[]).includes(type)) return bad("unknown action type");
  const keys = (allowed: string[]) => onlyKeys(raw, ["type", ...allowed]);
  let extra: string | undefined;
  switch (type as ActionType) {
    case "none":
    case "show_back":
      extra = keys([]);
      return extra ? bad(extra) : good({ type } as Action);
    case "set_style":
      extra = keys(["edition"]);
      if (extra) return bad(extra);
      return (EDITIONS as readonly unknown[]).includes(raw.edition) ? good({ type: "set_style", edition: raw.edition as Edition }) : bad("unknown edition");
    case "set_material":
      extra = keys(["material"]);
      if (extra) return bad(extra);
      return (MATERIAL_IDS as readonly unknown[]).includes(raw.material) ? good({ type: "set_material", material: raw.material as Material }) : bad("unknown material");
    case "set_finish":
      extra = keys(["finish"]);
      if (extra) return bad(extra);
      return (FINISHES as readonly unknown[]).includes(raw.finish) ? good({ type: "set_finish", finish: raw.finish as Finish }) : bad("unknown finish");
    case "set_fact": {
      extra = keys(["field", "value"]);
      if (extra) return bad(extra);
      const field = raw.field;
      if (field !== "date" && field !== "venue" && field !== "keep" && field !== "unkeep") return bad("unknown fact field");
      if (field === "keep" || field === "unkeep") {
        return typeof raw.value === "string" && FACT_ID.test(raw.value) ? good({ type: "set_fact", field, value: raw.value }) : bad("value must be a fact id");
      }
      const v = text(raw.value, LIMITS.value, "value");
      if (!v.ok) return v;
      if (field === "date" && !isRealDate(v.value)) return bad("date must be a real yyyy-mm-dd date");
      return good({ type: "set_fact", field, value: v.value });
    }
    case "set_text": {
      extra = keys(["field", "value"]);
      if (extra) return bad(extra);
      const field = raw.field;
      if (field !== "title" && field !== "subtitle" && field !== "note") return bad("unknown text field");
      const v = text(raw.value, field === "note" ? LIMITS.note : field === "subtitle" ? LIMITS.subtitle : LIMITS.title, "value");
      return v.ok ? good({ type: "set_text", field, value: v.value }) : v;
    }
    case "remix_art": {
      extra = keys(["vibe", "procedural", "simulate"]);
      if (extra) return bad(extra);
      const out: Extract<Action, { type: "remix_art" }> = { type: "remix_art" };
      if (raw.vibe !== undefined) {
        const v = text(raw.vibe, LIMITS.vibe, "vibe");
        if (!v.ok) return v;
        out.vibe = v.value;
      }
      if (raw.procedural !== undefined) {
        if (typeof raw.procedural !== "boolean") return bad("procedural must be a boolean");
        if (raw.procedural) out.procedural = true;
      }
      if (raw.simulate !== undefined) {
        if (raw.simulate !== "failure" || !opts.allowSimulate) return bad("simulate is not allowed");
        out.simulate = "failure";
      }
      return good(out);
    }
    case "ask_user": {
      extra = keys(["question", "options", "field"]);
      if (extra) return bad(extra);
      const q = parseQuestion(raw.question, raw.options);
      if (!q.ok) return q;
      const out: Extract<Action, { type: "ask_user" }> = { type: "ask_user", ...q.value };
      if (raw.field !== undefined) {
        if (!(ASK_FIELDS as readonly unknown[]).includes(raw.field)) return bad("unknown question field");
        out.field = raw.field as AskField;
      }
      return good(out);
    }
  }
}

/** Validates a plan: { reply, actions }. Any invalid action rejects the plan. */
export function parsePlan(raw: unknown, opts: { allowSimulate?: boolean } = {}): Parsed<AgentPlan> {
  if (!isObject(raw)) return bad("the plan must be an object");
  const extra = onlyKeys(raw, ["reply", "actions", "schema", "provenance"]);
  if (extra) return bad(extra);
  const reply = text(raw.reply, LIMITS.reply, "reply");
  if (!reply.ok) return reply;
  if (!Array.isArray(raw.actions) || raw.actions.length > LIMITS.actions) return bad(`actions must be a list of at most ${LIMITS.actions}`);
  const actions: Action[] = [];
  for (const a of raw.actions) {
    const p = parseAction(a, opts);
    if (!p.ok) return bad(`actions[${actions.length}]: ${p.reason}`);
    if (p.value.type !== "none") actions.push(p.value);
  }
  return good({ reply: reply.value, actions });
}

function parseState(raw: unknown): Parsed<StateSummary> {
  if (!isObject(raw)) return bad("state must be an object");
  const extra = onlyKeys(raw, ["title", "subtitle", "dateISO", "venue", "city", "facts", "edition", "material", "finish", "art", "versions"]);
  if (extra) return bad(extra);
  const title = text(raw.title, LIMITS.title, "title");
  if (!title.ok) return title;
  const out: StateSummary = { title: title.value, facts: [], edition: "researched", material: "digital", finish: "matte", art: "procedural", versions: 1 };
  for (const [key, max] of [["subtitle", LIMITS.subtitle], ["venue", LIMITS.venue], ["city", LIMITS.city]] as const) {
    if (raw[key] === undefined) continue;
    const v = text(raw[key], max, key);
    if (!v.ok) return v;
    out[key] = v.value;
  }
  if (raw.dateISO !== undefined) {
    if (typeof raw.dateISO !== "string" || !isRealDate(raw.dateISO)) return bad("dateISO must be a real yyyy-mm-dd date");
    out.dateISO = raw.dateISO;
  }
  if (!Array.isArray(raw.facts) || raw.facts.length > LIMITS.facts) return bad(`facts must be a list of at most ${LIMITS.facts}`);
  for (const f of raw.facts) {
    if (!isObject(f)) return bad("a fact must be an object");
    const fx = onlyKeys(f, ["id", "label", "value", "kept", "provenance"]);
    if (fx) return bad(fx);
    if (typeof f.id !== "string" || !FACT_ID.test(f.id)) return bad("fact id is not valid");
    const label = text(f.label, LIMITS.label, "fact label");
    if (!label.ok) return label;
    // a pending fact may have no value yet
    const value = typeof f.value === "string" && f.value.trim() === "" ? good("") : text(f.value, LIMITS.value, "fact value");
    if (!value.ok) return value;
    if (typeof f.kept !== "boolean") return bad("fact kept must be a boolean");
    if (!(PROVENANCES as readonly unknown[]).includes(f.provenance)) return bad("fact provenance is not valid");
    out.facts.push({ id: f.id, label: label.value, value: value.value, kept: f.kept, provenance: f.provenance as Provenance });
  }
  if (!(EDITIONS as readonly unknown[]).includes(raw.edition)) return bad("unknown edition");
  if (!(MATERIAL_IDS as readonly unknown[]).includes(raw.material)) return bad("unknown material");
  if (!(FINISHES as readonly unknown[]).includes(raw.finish)) return bad("unknown finish");
  if (raw.art !== "image" && raw.art !== "procedural") return bad("art must be image or procedural");
  if (typeof raw.versions !== "number" || !Number.isInteger(raw.versions) || raw.versions < 1 || raw.versions > 1000) return bad("versions must be a count");
  out.edition = raw.edition as Edition;
  out.material = raw.material as Material;
  out.finish = raw.finish as Finish;
  out.art = raw.art;
  out.versions = raw.versions;
  return good(out);
}

function parseResults(raw: unknown): Parsed<ActionResult[]> {
  if (!Array.isArray(raw) || raw.length > LIMITS.results) return bad(`results must be a list of at most ${LIMITS.results}`);
  const out: ActionResult[] = [];
  for (const r of raw) {
    if (!isObject(r)) return bad("a result must be an object");
    const extra = onlyKeys(r, ["action", "status", "code", "ms"]);
    if (extra) return bad(extra);
    const a = parseAction(r.action, { allowSimulate: true });
    if (!a.ok) return bad(`result action: ${a.reason}`);
    if (r.status !== "applied" && r.status !== "failed" && r.status !== "rejected") return bad("unknown result status");
    const res: ActionResult = { action: a.value, status: r.status };
    if (r.code !== undefined) {
      if (typeof r.code !== "string" || !CODE.test(r.code)) return bad("result code is not valid");
      res.code = r.code;
    }
    if (r.ms !== undefined) {
      if (typeof r.ms !== "number" || !Number.isFinite(r.ms) || r.ms < 0 || r.ms > 3_600_000) return bad("result ms is not valid");
      res.ms = Math.round(r.ms);
    }
    out.push(res);
  }
  return good(out);
}

/** Validates a request body from the browser. */
export function parseRequest(raw: unknown): Parsed<AgentRequest> {
  if (!isObject(raw)) return bad("the request must be an object");
  const extra = onlyKeys(raw, ["schema", "state", "message", "results", "pending"]);
  if (extra) return bad(extra);
  if (raw.schema !== AGENT_SCHEMA) return bad("unknown schema");
  const state = parseState(raw.state);
  if (!state.ok) return state;
  const out: AgentRequest = { schema: AGENT_SCHEMA, state: state.value };
  if (raw.message !== undefined) {
    // what the person typed is data, never an action value: markup is harmless here, control characters are not
    if (typeof raw.message !== "string" || !raw.message.trim()) return bad("message is empty");
    if (raw.message.trim().length > LIMITS.message) return bad(`message is longer than ${LIMITS.message}`);
    if (CONTROL.test(raw.message.trim())) return bad("message has control characters");
    out.message = raw.message.trim();
  }
  if (raw.results !== undefined) {
    const r = parseResults(raw.results);
    if (!r.ok) return r;
    out.results = r.value;
  }
  if (raw.pending !== undefined) {
    // a question can only be answered: without a message there is nothing to translate
    if (out.message === undefined) return bad("pending needs a message");
    const p = parsePending(raw.pending);
    if (!p.ok) return p;
    out.pending = p.value;
  }
  if (out.message === undefined && !out.results?.length) return bad("send a message or results");
  return good(out);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The stub as the agent may see it. Excludes guest name, friends, photos, seat, notes and links (the Apply chip reads the local note itself); strings are clipped to the limits. */
export function summarize(stub: Stub): StateSummary {
  const ev = stub.event;
  const v = currentVersion(stub);
  const out: StateSummary = {
    title: clip(ev.title || "Untitled", LIMITS.title),
    facts: ev.facts.slice(0, LIMITS.facts).map((f) => ({
      id: /^[A-Za-z0-9_-]{1,40}$/.test(f.id) ? f.id : "fact",
      label: clip(f.label || "fact", LIMITS.label),
      value: clip(f.value ?? "", LIMITS.value),
      kept: !!f.kept,
      provenance: f.provenance,
    })),
    edition: v.edition,
    material: stub.material,
    finish: stub.finish,
    art: v.art.kind,
    versions: Math.min(1000, stub.versions.length),
  };
  if (ev.subtitle) out.subtitle = clip(ev.subtitle, LIMITS.subtitle);
  if (ev.dateISO && isRealDate(ev.dateISO)) out.dateISO = ev.dateISO;
  if (ev.venue) out.venue = clip(ev.venue, LIMITS.venue);
  if (ev.city) out.city = clip(ev.city, LIMITS.city);
  // angle brackets never pass validation; a title with one is sent without it
  for (const k of ["title", "subtitle", "venue", "city"] as const) if (out[k]) out[k] = out[k]!.replace(/[<>]/g, "");
  for (const f of out.facts) {
    f.label = f.label.replace(/[<>]/g, "") || "fact";
    f.value = f.value.replace(/[<>]/g, "");
  }
  return out;
}

/** "12 Oct 2024" for a yyyy-mm-dd string. */
export function shortDay(iso: string): string {
  const m = ISO.exec(iso);
  // fixed month names: the same words in every browser and Node version (Intl says "Sept" in some)
  return m ? `${Number(m[3])} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m[2]) - 1] ?? m[2]} ${m[1]}` : iso;
}

export const editionLabel = (e: Edition): string => cap(e);

/** What an action does, as a short imperative phrase: the chip's label and the agent's proposal. */
export function describeAction(a: Action, state?: StateSummary, currentNote?: string): string {
  switch (a.type) {
    case "set_fact": {
      if (a.field === "date") return `Set the date to ${shortDay(a.value)}`;
      if (a.field === "venue") return `Set the venue to ${a.value}`;
      const f = state?.facts.find((x) => x.id === a.value);
      return `${a.field === "keep" ? "Keep" : "Unkeep"} ${f ? f.label : "a fact"} on the stub`;
    }
    case "set_style":
      return `Switch to ${editionLabel(a.edition)}`;
    case "set_material":
      return `Make it ${cap(a.material)}`;
    case "set_finish":
      return `Use a ${a.finish} finish`;
    case "set_text":
      if (a.field !== "note") return `Set the ${a.field} to ${a.value}`;
      // The note stays out of the state sent to the model, so the owner sees what Apply would overwrite here, on this
      // device only: `currentNote` comes from the local stub and goes nowhere else.
      return currentNote ? `Set your note to “${clip(a.value, 40)}”, replacing “${clip(currentNote, 40)}”` : `Set your note to “${clip(a.value, 40)}”`;
    case "remix_art":
      return a.procedural ? "Use procedural art" : a.vibe ? `Remix the art: ${a.vibe}` : "Remix the art";
    case "show_back":
      return "Show the back";
    case "ask_user":
      return a.question;
    case "none":
      return "Nothing to change";
  }
}

/** Past tense, for the follow-up. */
export function describeDone(a: Action, state?: StateSummary): string {
  switch (a.type) {
    case "set_fact":
      if (a.field === "date") return `date set to ${shortDay(a.value)}`;
      if (a.field === "venue") return `venue set to ${a.value}`;
      return `${state?.facts.find((x) => x.id === a.value)?.label ?? "fact"} ${a.field === "keep" ? "kept" : "unkept"}`;
    case "set_style":
      return `style switched to ${editionLabel(a.edition)}`;
    case "set_material":
      return `material set to ${cap(a.material)}`;
    case "set_finish":
      return `finish set to ${a.finish}`;
    case "set_text":
      return a.field === "note" ? "note set" : `${a.field} set to ${a.value}`;
    case "remix_art":
      return a.procedural ? "procedural art added" : "art remixed";
    case "show_back":
      return "showing the back";
    default:
      return "noted";
  }
}
