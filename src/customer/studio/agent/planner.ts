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
  const r = locateDate(t, fallbackYear, fallbackMonth);
  return r && { iso: r.iso, real: r.real };
}

/** True when the text holds a date candidate: an ISO date, a bare ordinal, or a day beside a month name. */
function hasDateCandidate(t: string): boolean {
  if (/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}(?:st|nd|rd|th)\b/i.test(t)) return true;
  const named = [...t.matchAll(/\b\d{1,2}(?:st|nd|rd|th)?(?:\s+of)?\s+([a-z]{3,9})\b/gi), ...t.matchAll(/\b([a-z]{3,9})\.?\s+\d{1,2}\b/gi)];
  return named.some((m) => monthIndex(m[1].toLowerCase()) >= 0);
}

type Located = { iso: string; real: boolean; span: string[] };
/** The text with the words a date was read from taken out. */
const without = (t: string, span: string[]) => span.reduce((acc, w) => acc.replace(w, " "), t);
const REL_SHIFT: Record<string, number> = { next: 1, following: 1, last: -1, previous: -1, this: 0 };
/** "next year" / "last year" / "this year" right after a date: the year it moves to. */
const yearQualifier = (after: string) => {
  const m = /^\s*,?\s*(?:of\s+)?(next|following|last|previous|this)\s+year\b/i.exec(after);
  return m ? { shift: REL_SHIFT[m[1].toLowerCase()], text: m[0] } : null;
};

/**
 * findDate, plus `span`: the words the date was read from, so a caller can plan what else was said. Nothing is guessed:
 * a second candidate date ("12 Oct 2024 or the 13th") or a qualifier left over that was not used ("or", "week", "month",
 * "year") reads as no date, so the caller asks and no qualifier is dropped silently.
 */
function locateDate(t: string, fallbackYear?: number, fallbackMonth?: number): Located | null {
  const r = locateFirst(t, fallbackYear, fallbackMonth);
  if (!r) return null;
  const rest = without(t, r.span);
  return hasDateCandidate(rest) || /\b(or|month|week|weekend|year|tomorrow|yesterday)\b/i.test(rest) ? null : r;
}

function locateFirst(t: string, fallbackYear?: number, fallbackMonth?: number): Located | null {
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t);
  if (iso) return { iso: iso[0], real: isRealDate(iso[0]), span: [iso[0]] };
  const dayFirst = /\b(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s+([a-z]{3,9})\.?(?:,?\s+(\d{4}))?\b/i.exec(t);
  const monthFirst = /\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i.exec(t);
  const pick = (day: string, mon: string, year: string | undefined) => {
    const mi = monthIndex(mon.toLowerCase());
    const y = year ? Number(year) : fallbackYear;
    if (mi < 0 || !y) return null;
    const out = `${y}-${pad(mi + 1)}-${pad(Number(day))}`;
    return { iso: out, real: isRealDate(out) };
  };
  // a named month, with "next year" / "last year" honoured when it follows
  const named = (m: RegExpExecArray, day: string, mon: string, year: string | undefined): Located | null => {
    const yq = !year && fallbackYear ? yearQualifier(t.slice(m.index + m[0].length)) : null;
    const r = pick(day, mon, yq ? String(fallbackYear! + yq.shift) : year);
    return r && { ...r, span: [m[0] + (yq ? yq.text : "")] };
  };
  if (dayFirst) {
    const r = named(dayFirst, dayFirst[1], dayFirst[2], dayFirst[3]);
    if (r) return r;
  }
  if (monthFirst) {
    const r = named(monthFirst, monthFirst[2], monthFirst[1], monthFirst[3]);
    if (r) return r;
  }
  // A day alone is in the stub's own month and year only when it is genuinely bare ("the 12th", "on the 17th, and ...").
  // "next month" / "last month" next to it, before or after, move the month; anything else beside it ("or 13th",
  // "12th-ish", "next week", "of this year") is not guessed, so the caller asks.
  const ordinals = t.match(/\b\d{1,2}(?:st|nd|rd|th)\b/gi) ?? [];
  const ordinal = /\b(\d{1,2})(?:st|nd|rd|th)\b/i.exec(t);
  if (!ordinal || ordinals.length !== 1 || !fallbackYear || !fallbackMonth) return null;
  const before = t.slice(0, ordinal.index);
  const after = t.slice(ordinal.index + ordinal[0].length);
  // "the 12th in November [next year]" / "the 12th of November 2025": an explicit month
  const month = /^\s+(?:in|of)\s+([a-z]{3,9})\.?(?:,?\s+(\d{4}))?\b/i.exec(after);
  const monthAt = month ? monthIndex(month[1].toLowerCase()) : -1;
  if (month && monthAt >= 0) {
    const yq = month[2] ? null : yearQualifier(after.slice(month[0].length));
    const out = `${month[2] ?? fallbackYear + (yq ? yq.shift : 0)}-${pad(monthAt + 1)}-${pad(Number(ordinal[1]))}`;
    return { iso: out, real: isRealDate(out), span: [ordinal[0] + month[0] + (yq ? yq.text : "")] };
  }
  const relAfter = /^\s*,?\s*(?:(?:of|in|on)\s+)?(?:the\s+)?(next|following|last|previous|this)\s+month\b/i.exec(after);
  const relBefore = /\b(next|following|last|previous|this)\s+month\s*,?\s*(?:(?:on|for)\s+)?(?:the\s+)?$/i.exec(before);
  if (relAfter && relBefore) return null;
  const rel = relAfter ?? relBefore;
  const bare = /^\s*(?:$|[.,;!?]|(?:and|then|please|also|but|instead|make|remix|switch|show|use|change|keep)\b)/i.test(after);
  if (!rel && !bare) return null;
  const zero = fallbackYear * 12 + (fallbackMonth - 1) + (rel ? REL_SHIFT[rel[1].toLowerCase()] : 0);
  const out = `${Math.floor(zero / 12)}-${pad((zero % 12) + 1)}-${pad(Number(ordinal[1]))}`;
  return { iso: out, real: isRealDate(out), span: rel ? (relAfter ? [ordinal[0] + rel[0]] : [rel[0], ordinal[0]]) : [ordinal[0]] };
}
const stateYear = (state: StateSummary) => (state.dateISO ? Number(state.dateISO.slice(0, 4)) : undefined);
const stubMonth = (state: StateSummary) => (state.dateISO ? Number(state.dateISO.slice(5, 7)) || undefined : undefined);

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
  const year = stateYear(state);
  let dateAsk: AgentPlan | undefined;

  // a demo-only switch so the failure and recovery path is reproducible without a provider
  if (/\bsimulate\b.*\b(fail|failure)\b|\bforce\b.*\bfail/.test(t)) {
    return { reply: "I will try to remix the art, and this run is set to fail so you can see how recovery works. Nothing changes until you apply it.", actions: [{ type: "remix_art", simulate: "failure" }] };
  }

  // date
  if (/\bdate\b/.test(t) && /\b(fix|change|correct|set|update|wrong|should|was|is|to)\b/.test(t)) {
    const found = findDate(valueAfter(raw, /\bdate\b/) ?? raw, year, stubMonth(state));
    if (found?.real) actions.push({ type: "set_fact", field: "date", value: found.iso });
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
 * A message that is a clear instruction: it parses to an action AND is phrased as one (opens with an instruction verb,
 * or says "the <field> is/to ..."). A bare field word is not enough: "The Venue" or "Title Bar" is a literal answer.
 */
const LEAD = String.raw`(?:(?:hi|hey|hello|ok(?:ay)?|so|well|actually|oh|u+m+|uh+|sorry|also|and|then|but|please|pls|kindly|(?:can|could|would|will) you(?: please)?|i'd like you to|i want you to|i (?:want|need|would like) to|i'd like to|let's|lets)\b[\s,.:;!-]*)*`;
const VERB = String.raw`(?:fix|set|change|correct|update|switch|make|remix|regenerate|redo|show|flip|view|turn|keep|include|add|print|unkeep|drop|remove|hide|use|try|go|simulate|force)\b`;
// an instruction verb opens the message, or any clause after a comma, colon, semicolon, "and" or "then"
export const INSTRUCTION = new RegExp(String.raw`(?:^|[,:;]|\b(?:and|then|also)\b)[\s,.:;!-]*${LEAD}${VERB}`, "i");
const FIELD_STATEMENT = /\b(?:date|venue|title|subtitle)\b[^.?!]*?\b(?:is|was|to|should be)\b/i;
const FIELDS = ["date", "venue", "title", "subtitle"];
/** An explicit instruction naming a field other than the one being asked about, wherever it sits in the message. */
export function namesOtherField(raw: string, field?: string): boolean {
  return FIELDS.filter((f) => f !== field).some((f) => new RegExp(String.raw`\b(?:fix|set|change|update|correct)\s+(?:the\s+)?${f}\b|\bthe\s+${f}\s+(?:is|was|should be)\b`, "i").test(raw));
}
function isInstruction(raw: string, state: StateSummary, field?: string): boolean {
  return (INSTRUCTION.test(raw) || FIELD_STATEMENT.test(raw) || namesOtherField(raw, field)) && fromMessage(raw, state).actions.length > 0;
}

/**
 * Translates an answer to the pending question into a typed proposal. Returns undefined when the message is a change
 * of topic (the caller plans it as a new request, which clears the pending question). An answer that can't be used
 * asks again, with a reason: it never goes quiet. The result is a proposal only; the owner still taps Apply.
 */
export function resolvePending(message: string, pending: PendingQuestion, state: StateSummary): AgentPlan | undefined {
  const raw = message.trim();
  const isOption = !!pending.options?.some((o) => o.toLowerCase() === raw.toLowerCase());
  const again = (why: string): AgentPlan => ({ reply: why, actions: [ask(pending.question, pending.options, pending.field)] });
  if (!isOption) {
    // a different request (a question, or something the planner can act on) is a change of topic
    if (raw.endsWith("?")) return undefined;
    // a day that is plainly meant as the date but is ambiguous ("the 12th or 13th") stays an attempt at the answer
    const attempt = pending.field === "date" && hasDateCandidate(raw);
    // (including one that only asks, like "fix the date to the 12th or 13th": it is never the literal answer to another field)
    if (isInstruction(raw, state, pending.field) && !(pending.field === "date" && (attempt || findDate(raw, stateYear(state), stubMonth(state))))) return undefined;
  }
  const answer = isOption ? pending.options!.find((o) => o.toLowerCase() === raw.toLowerCase())! : tidy(raw);
  if (pending.field === "date") {
    const found = locateDate(answer, stateYear(state), stubMonth(state));
    // whatever else was said alongside the date answer ("the 12th and make it moodier") is planned too, minus the date's own words
    const others = (): Action[] => {
      if (isOption) return [];
      const rest = found ? without(raw, found.span) : raw;
      return fromMessage(rest, state).actions.filter((a) => a.type !== "ask_user" && !(a.type === "set_fact" && a.field === "date"));
    };
    const reask = (why: string): AgentPlan => {
      const kept = others().slice(0, LIMITS.actions - 1);
      return kept.length ? { reply: `${sentence(kept, state)} ${why} The date stays as it is until you give it.`, actions: [...kept, ask(pending.question, pending.options, pending.field)] } : again(why);
    };
    if (!found) return reask("I could not find a date in that, so nothing is proposed.");
    if (!found.real) return reask(`${found.iso} is not a real calendar date, so nothing is proposed.`);
    const dateAction: Action = { type: "set_fact", field: "date", value: found.iso };
    const picked = [dateAction, ...others()].slice(0, LIMITS.actions);
    return { reply: sentence(picked, state), actions: picked };
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
