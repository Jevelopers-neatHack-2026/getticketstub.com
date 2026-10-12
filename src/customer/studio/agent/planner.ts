// The deterministic planner: rules over the message and the stub's state summary. It answers in demo/fixture mode
// (no provider needed, same input -> same plan) and when a live server has no model. Pure, so tests run it directly.
// It proposes; the owner applies. Every plan it returns passes parsePlan.
import { EDITIONS } from "../types";
import type { Edition, Material } from "../types";
import { LIMITS, describeAction, describeDone, editionLabel, isRealDate, parsePlan } from "./protocol";
import type { Action, ActionResult, AgentPlan, AgentRequest, AskField, PendingQuestion, StateSummary } from "./protocol";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** A month name or its three-letter short form ("sept" too); anything else is not a month. */
const monthIndex = (w: string) => MONTHS.findIndex((m) => w === m || w === m.slice(0, 3) || (m === "september" && w === "sept"));
const pad = (n: number) => String(n).padStart(2, "0");

/** The first date in the text: yyyy-mm-dd, "12 Oct 2024" or "October 12, 2024". The year defaults to the stub's. Null when none is found. */
export function findDate(t: string, fallbackYear?: number, fallbackMonth?: number): { iso: string; real: boolean } | null {
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t);
  if (iso) return { iso: iso[0], real: isRealDate(iso[0]) };
  const dayFirst = /\b(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s+([a-z]{3,9})\.?(?:,?\s+(\d{4}))?\b/i.exec(t);
  const monthFirst = /\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i.exec(t);
  const pick = (day: string, mon: string, year: string | undefined) => {
    const mi = monthIndex(mon.toLowerCase());
    const y = year ? Number(year) : fallbackYear;
    if (mi < 0 || !y) return null;
    const out = `${y}-${pad(mi + 1)}-${pad(Number(day))}`;
    return { iso: out, real: isRealDate(out) };
  };
  if (dayFirst) {
    const r = pick(dayFirst[1], dayFirst[2], dayFirst[3]);
    if (r) return r;
  }
  if (monthFirst) {
    const r = pick(monthFirst[2], monthFirst[1], monthFirst[3]);
    if (r) return r;
  }
  // a day alone ("the 12th") is in the stub's own month and year
  const ordinal = /\b(\d{1,2})(?:st|nd|rd|th)\b/i.exec(t);
  if (ordinal && fallbackYear && fallbackMonth) return pick(ordinal[1], MONTHS[fallbackMonth - 1], String(fallbackYear));
  return null;
}
const stubMonth = (state: StateSummary) => (state.dateISO ? Number(state.dateISO.slice(5, 7)) || undefined : undefined);
const stubYear = (state: StateSummary) => (state.dateISO ? Number(state.dateISO.slice(0, 4)) || undefined : undefined);

/** Every distinct date in the text, in the order found. A bare ordinal only counts when no dated month is named. */
function datesIn(t: string, fallbackYear?: number, fallbackMonth?: number): { iso: string; real: boolean }[] {
  const out: { iso: string; real: boolean }[] = [];
  const add = (iso: string) => {
    if (!out.some((o) => o.iso === iso)) out.push({ iso, real: isRealDate(iso) });
  };
  const named = (day: string, mon: string, year: string | undefined) => {
    const mi = monthIndex(mon.toLowerCase());
    const y = year ? Number(year) : fallbackYear;
    if (mi >= 0 && y) add(`${y}-${pad(mi + 1)}-${pad(Number(day))}`);
  };
  for (const m of t.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) add(m[0]);
  for (const m of t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s+([a-z]{3,9})\.?(?:,?\s+(\d{4}))?\b/gi)) named(m[1], m[2], m[3]);
  for (const m of t.matchAll(/\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/gi)) named(m[2], m[1], m[3]);
  if (!out.length && fallbackYear && fallbackMonth) for (const m of t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)\b/gi)) add(`${fallbackYear}-${pad(fallbackMonth)}-${pad(Number(m[1]))}`);
  return out;
}

const RELATIVE_SPAN = /(?:\s+of)?\s*(?:the\s+)?\b(next|following|coming|upcoming|last|previous|prior)\s+(month|year)\b/i;

/**
 * Wording the planner cannot resolve on its own: a relative month or year ("the 12th of next month": next from when?)
 * or more than one date. Returns why, and the dates it could offer as tappable choices. Undefined when the text is plain.
 */
function dateDoubt(t: string, state: StateSummary): { why: string; options?: string[] } | undefined {
  const y = stubYear(state), m = stubMonth(state);
  const rel = RELATIVE_SPAN.exec(t);
  if (rel) {
    const why = `“${rel[1].toLowerCase()} ${rel[2].toLowerCase()}” depends on which date it counts from, so I will not guess.`;
    const stripped = t.replace(RELATIVE_SPAN, "");
    // offer a date only for a bare day, counted from the stub's own month; anything with its own month stays a question
    if (!y || !m || findDate(stripped, y)) return { why };
    const step = /^(last|previous|prior)$/i.test(rel[1]) ? -1 : 1;
    const target = rel[2].toLowerCase() === "month" ? { y: y + Math.floor((m - 1 + step) / 12), m: ((m - 1 + step + 12) % 12) + 1 } : { y: y + step, m };
    const found = findDate(stripped, target.y, target.m);
    return { why, ...(found?.real ? { options: [found.iso] } : {}) };
  }
  const all = datesIn(t, stubYear(state), stubMonth(state));
  if (all.length > 1) {
    const real = all.filter((d) => d.real).map((d) => d.iso).slice(0, LIMITS.options);
    return { why: `I found more than one date in that (${all.map((d) => d.iso).join(", ")}), so I will not guess.`, ...(real.length > 1 ? { options: real } : {}) };
  }
  return undefined;
}

const tidy = (s: string) => s.trim().replace(/^["'“”‘’]+|["'“”‘’.!?]+$/g, "").trim();

/** The value after "to" / "is" / "should be" in a sentence about one field. */
function valueAfter(raw: string, field: RegExp): string | undefined {
  const m = new RegExp(`${field.source}[^.?!]*?\\b(?:to|is|was|be|as)\\b\\s+(.+)$`, "i").exec(raw);
  return m ? tidy(m[1]) : undefined;
}

const EDITION_WORDS: Record<string, Edition> = { letterpress: "letterpress", risograph: "risograph", riso: "risograph", minimal: "minimal", classic: "classic", researched: "researched" };
const VIBES = ["neon", "70s", "moodier", "minimal", "risograph"] as const;

const ask = (question: string, options?: string[], field?: AskField): Action => ({ type: "ask_user", question, ...(options?.length ? { options } : {}), ...(field ? { field } : {}) });

function sentence(actions: Action[], state: StateSummary): string {
  const list = actions.map((a) => describeAction(a, state).replace(/^./, (c) => c.toLowerCase()));
  const joined = list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}` : list[0];
  return `Here is what I would change: ${joined}. Nothing changes until you apply it.`;
}

function fromMessage(message: string, state: StateSummary): AgentPlan {
  const raw = message.trim();
  const t = raw.toLowerCase();
  const actions: Action[] = [];
  const year = state.dateISO ? Number(state.dateISO.slice(0, 4)) : undefined;
  let dateAsk: AgentPlan | undefined;

  // a demo-only switch so the failure and recovery path is reproducible without a provider
  if (/\bsimulate\b.*\b(fail|failure)\b|\bforce\b.*\bfail/.test(t)) {
    return { reply: "I will try to remix the art, and this run is set to fail so you can see how recovery works. Nothing changes until you apply it.", actions: [{ type: "remix_art", simulate: "failure" }] };
  }

  // date
  if (/\bdate\b/.test(t) && /\b(fix|change|correct|set|update|wrong|should|was|is|to)\b/.test(t)) {
    const text = valueAfter(raw, /\bdate\b/) ?? raw;
    const doubt = dateDoubt(text, state);
    const found = doubt ? null : findDate(text, year, stubMonth(state));
    if (doubt) dateAsk = { reply: doubt.why, actions: [ask("Which date did you mean? Give a day, month and year, like 12 Oct 2024.", doubt.options, "date")] };
    else if (found?.real) actions.push({ type: "set_fact", field: "date", value: found.iso });
    else
      dateAsk = {
        reply: found ? `${found.iso} is not a real calendar date, so I will not change anything.` : "I could not find a date in that.",
        actions: [ask("Which date was it? Give a day, month and year, like 12 Oct 2024.", undefined, "date")],
      };
  }
  // venue
  if (/\bvenue\b/.test(t)) {
    const v = valueAfter(raw, /\bvenue\b/);
    if (v && v.length <= LIMITS.value && !/[<>]/.test(v)) actions.push({ type: "set_fact", field: "venue", value: v });
    else if (!actions.length) return { reply: "I need the venue's name to change it.", actions: [ask("Where was it?", undefined, "venue")] };
  }
  // title and subtitle
  for (const field of ["title", "subtitle"] as const) {
    if (!new RegExp(`\\b${field}\\b`).test(t)) continue;
    const v = valueAfter(raw, new RegExp(`\\b${field}\\b`));
    if (v && v.length <= (field === "title" ? LIMITS.title : LIMITS.subtitle) && !/[<>]/.test(v)) actions.push({ type: "set_text", field, value: v });
  }
  // keep / unkeep a fact by its label
  const keepWord = /\b(keep|include|add|print)\b/.test(t) ? "keep" : /\b(unkeep|drop|remove|hide)\b/.test(t) ? "unkeep" : undefined;
  if (keepWord && !/\b(date|venue|title|subtitle)\b/.test(t)) {
    const fact = state.facts.find((f) => f.provenance !== "pending" && t.includes(f.label.toLowerCase().split(/[:(]/)[0].trim()) && f.label.length > 2) ?? state.facts.find((f) => f.provenance !== "pending" && f.id.length > 2 && t.includes(f.id.toLowerCase()));
    if (fact && fact.kept !== (keepWord === "keep")) actions.push({ type: "set_fact", field: keepWord, value: fact.id });
  }
  // style, material, finish
  const styleCue = /\b(style|edition|look|switch|use|change|make it|go|try)\b/.test(t);
  const edWord = Object.keys(EDITION_WORDS).find((w) => new RegExp(`\\b${w}\\b`).test(t));
  if (edWord && styleCue) {
    const edition = EDITION_WORDS[edWord];
    if ((EDITIONS as readonly string[]).includes(edition) && edition !== state.edition) actions.push({ type: "set_style", edition });
  }
  const materialWord = /\b(?:as a|material\b[^.?!]*?)\s*\b(card|print)\b|\b(card|print)\s+(?:stock|material)\b/.exec(t);
  const material: Material | undefined = /\bframed\b|\bframe it\b/.test(t) ? "framed" : /\bdigital\b/.test(t) ? "digital" : ((materialWord?.[1] ?? materialWord?.[2]) as Material | undefined);
  if (material && material !== state.material) actions.push({ type: "set_material", material });
  const finish = /\bmatte\b/.test(t) ? "matte" : /\bfoil\b/.test(t) ? "foil" : /\bholo(graphic)?\b/.test(t) ? "holo" : undefined;
  if (finish && finish !== state.finish) actions.push({ type: "set_finish", finish });

  // art
  const remixCue = /\b(remix|regenerate|redo|new art|another version|moodier|neon|70s|vibe|mood|summer|retro)\b|\bmake it (feel|look|moodier|brighter|darker)\b|\bfeel like\b/.test(t);
  if (remixCue) {
    const chip = VIBES.find((v) => t.includes(v));
    const feel = /\b(?:feel|look)(?:s)?\s+(?:like|more)\s+(.+)$/i.exec(raw)?.[1];
    const rest = /\bmake it\s+(.+)$/i.exec(raw)?.[1];
    const vibe = chip ?? (feel ? tidy(feel) : undefined) ?? (rest ? tidy(rest) : undefined);
    const clean = vibe && vibe.length <= LIMITS.vibe && !/[<>]/.test(vibe) && !/\b(remix|art)\b/i.test(vibe) ? vibe : undefined;
    actions.push({ type: "remix_art", ...(clean ? { vibe: clean } : {}) });
  }
  if (/\b(show|flip|see|view|turn)\b.*\b(back|reverse)\b|\bback of\b/.test(t)) actions.push({ type: "show_back" });

  // the date could not be read: keep what else was asked for, and ask for the date after it
  if (dateAsk) {
    if (!actions.length) return dateAsk;
    const kept = actions.slice(0, LIMITS.actions - 1);
    return { reply: `${sentence(kept, state)} ${dateAsk.reply} The date stays as it is until you give it.`, actions: [...kept, ...dateAsk.actions] };
  }
  const picked = actions.slice(0, LIMITS.actions);
  if (!picked.length) {
    const question = raw.endsWith("?");
    return {
      reply: question
        ? "I can only answer from the facts on your stub. Ask me to change something and I will propose it."
        : "I can fix a fact, change the style, material or finish, remix the art or show the back. Try “switch to letterpress and remix the art”.",
      actions: [],
    };
  }
  return { reply: sentence(picked, state), actions: picked };
}

const REASON_WORDS: Record<string, string> = {
  art_limit: "the daily art limit was reached",
  rate_limited: "there were too many requests",
  provider_unavailable: "the art service did not respond",
  network: "the connection dropped",
  invalid_value: "that value did not pass validation",
  not_found: "that fact is not on this stub",
  unchanged: "it was already set that way",
  unavailable: "that is not available from here",
};

function fromResults(results: ActionResult[], state: StateSummary): AgentPlan {
  const done = results.filter((r) => r.status === "applied");
  const failed = results.filter((r) => r.status !== "applied");
  const where = `Your stub is ${editionLabel(state.edition)}, ${state.material}, ${state.finish}, with ${state.versions} ${state.versions === 1 ? "version" : "versions"}.`;
  if (!failed.length) {
    const recovered = done.some((r) => r.action.type === "remix_art" && r.action.procedural);
    const summary = done.map((r) => describeDone(r.action, state)).join("; ");
    if (recovered) return { reply: `Recovered: ${summary}. It is procedural art, labelled simulated. ${where} Say “remix the art” to try generated art again.`, actions: [] };
    return { reply: `Done: ${summary}. ${where}`, actions: [] };
  }
  const first = failed[0];
  const reason = REASON_WORDS[first.code ?? ""] ?? "something went wrong";
  const applied = done.length ? ` ${done.map((r) => describeDone(r.action, state)).join("; ")} went through.` : "";
  const a = first.action;
  if (a.type === "remix_art" && !a.procedural) {
    const retry: Action = { type: "remix_art", ...(a.vibe ? { vibe: a.vibe } : {}) };
    return {
      reply: `The art was not remixed: ${reason}. Your stub is unchanged.${applied} I can use procedural art instead, which needs no art service, or try the remix again.`,
      actions: [{ type: "remix_art", procedural: true, ...(a.vibe ? { vibe: a.vibe } : {}) }, retry],
    };
  }
  if (a.type === "set_fact" || a.type === "set_text") {
    return { reply: `I could not apply that: ${reason}. Your stub is unchanged.${applied}`, actions: [a.type === "set_fact" ? (a.field === "date" || a.field === "venue" ? ask(a.field === "date" ? "Which date was it? Give a day, month and year." : "Where was it?", undefined, a.field) : ask("What should it say instead?")) : ask("What should it say instead?", undefined, a.field)] };
  }
  return { reply: `I could not apply ${describeAction(a, state).replace(/^./, (c) => c.toLowerCase())}: ${reason}. Your stub is unchanged.${applied}`, actions: [] };
}

const FIELD_LABEL: Record<AskField, string> = { date: "date", venue: "venue", title: "title", subtitle: "subtitle", note: "note" };
const FIELD_MAX: Record<AskField, number> = { date: LIMITS.value, venue: LIMITS.value, title: LIMITS.title, subtitle: LIMITS.subtitle, note: LIMITS.note };

/**
 * Translates an answer to the pending question into a typed proposal. Returns undefined when the message is a change
 * of topic (the caller plans it as a new request, which clears the pending question). An answer that can't be used
 * asks again, with a reason: it never goes quiet. The result is a proposal only; the owner still taps Apply.
 */
export function resolvePending(message: string, pending: PendingQuestion, state: StateSummary): AgentPlan | undefined {
  const raw = message.trim();
  const isOption = !!pending.options?.some((o) => o.toLowerCase() === raw.toLowerCase());
  const again = (why: string): AgentPlan => ({ reply: why, actions: [ask(pending.question, pending.options, pending.field)] });
  const year = stubYear(state), month = stubMonth(state);
  // what else the answer asks for ("the 12th and make it moodier"): kept, never dropped while the question is answered
  const others = isOption ? [] : fromMessage(raw, state).actions.filter((a) => a.type !== "ask_user" && !(a.type === "set_fact" && a.field === "date"));
  if (!isOption) {
    // a different request (a question, or something the planner can act on) is a change of topic
    if (raw.endsWith("?")) return undefined;
    if (others.length && !(pending.field === "date" && (findDate(raw, year, month) || RELATIVE_SPAN.test(raw)))) return undefined;
  }
  const answer = isOption ? pending.options!.find((o) => o.toLowerCase() === raw.toLowerCase())! : tidy(raw);
  // the answer's own reply, with the other asks proposed alongside it (the question is asked again after them)
  const withOthers = (own: AgentPlan): AgentPlan => {
    if (!others.length) return own;
    const kept = others.slice(0, LIMITS.actions - own.actions.length);
    const proposed = own.actions.filter((a) => a.type !== "ask_user");
    return {
      reply: proposed.length ? sentence([...proposed, ...kept], state) : `${sentence(kept, state)} ${own.reply} The date stays as it is until you give it.`,
      actions: [...proposed, ...kept, ...own.actions.filter((a) => a.type === "ask_user")],
    };
  };
  if (pending.field === "date") {
    const doubt = isOption ? undefined : dateDoubt(answer, state);
    if (doubt) return withOthers({ reply: doubt.why, actions: [ask("Which date did you mean? Give a day, month and year, like 12 Oct 2024.", doubt.options, "date")] });
    const found = findDate(answer, year, month);
    if (!found) return again("I could not find a date in that, so nothing is proposed.");
    if (!found.real) return withOthers(again(`${found.iso} is not a real calendar date, so nothing is proposed.`));
    const action: Action = { type: "set_fact", field: "date", value: found.iso };
    return withOthers({ reply: sentence([action], state), actions: [action] });
  }
  const label = FIELD_LABEL[pending.field];
  if (!answer) return again(`I need a ${label} to propose it.`);
  if (answer.length > FIELD_MAX[pending.field] || /[<>]/.test(answer)) return again(`That ${label} is too long or has characters I cannot use, so nothing is proposed.`);
  const action: Action = pending.field === "venue" ? { type: "set_fact", field: "venue", value: answer } : { type: "set_text", field: pending.field, value: answer };
  return { reply: sentence([action], state), actions: [action] };
}

/** One turn: a plan for a new message, or the follow-up to results. Always valid. */
export function planDemo(req: AgentRequest): AgentPlan {
  const answered = req.message !== undefined && req.pending ? resolvePending(req.message, req.pending, req.state) : undefined;
  const plan = answered ?? (req.message !== undefined ? fromMessage(req.message, req.state) : fromResults(req.results ?? [], req.state));
  const checked = parsePlan(plan, { allowSimulate: true });
  return checked.ok ? checked.value : { reply: "I could not turn that into a safe change.", actions: [] };
}
