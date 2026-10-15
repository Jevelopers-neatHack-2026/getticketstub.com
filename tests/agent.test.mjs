import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { registerHooks } from "node:module";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

// The agent action protocol (ticketstub.agent-action/1): validation, the demo planner, applying actions to a stub,
// and the /api/agent route (demo planner, live model with the repair path, gates, tracing). Fully offline: fetch is
// replaced in every test and the in-memory collector stands in for the tracing sink.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
    if (specifier.startsWith("@/")) {
      const file = fileURLToPath(new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url));
      if (existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true };
    }
    if (specifier.startsWith(".") && context.parentURL) {
      const url = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".ts")) return {
      format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    };
    return nextLoad(url, context);
  },
});

const scratch = mkdtempSync(join(tmpdir(), "ticketstub-agent-"));
process.env.TICKETSTUB_DB = join(scratch, "agent.sqlite");
process.env.TICKETSTUB_FILES = join(scratch, "files");
delete process.env.TICKETSTUB_OPS_TELEMETRY;

const P = await import("../src/customer/studio/agent/protocol.ts");
const { planDemo, findDate, INSTRUCTION, namesOtherField } = await import("../src/customer/studio/agent/planner.ts");
const { applyToStub } = await import("../src/customer/studio/agent/apply.ts");
const { PALE_HOURS, newStub } = await import("../src/customer/studio/fixtures.ts");
const { currentVersion } = await import("../src/customer/studio/types.ts");
const { memoryCollector, setOpsSink } = await import("../src/server/observability/sink.ts");
const { sanitizeOpsEvent } = await import("../src/server/observability/schema.ts");
const { sanitizeEvent } = await import("../src/server/events.ts");
const { buildTrace } = await import("../src/server/observability/neatlogs.ts");
const agent = await import("../src/app/api/agent/route.ts");
const art = await import("../src/app/api/art/route.ts");

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let sink;
beforeEach(() => { sink = memoryCollector(); setOpsSink(sink); });
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...originalEnv }; setOpsSink(undefined); });

const SECRET = "GUESTSECRET7f3a";
const stub = () => {
  const s = newStub(structuredClone(PALE_HOURS), "agent-test");
  s.personal.guestName = `Ada ${SECRET}`;
  s.personal.friends = [{ name: `Ravi ${SECRET}`, claimed: false }];
  s.personal.note = `note ${SECRET}`;
  return s;
};
const state = () => P.summarize(stub());
const request = (extra = {}) => ({ schema: P.AGENT_SCHEMA, state: state(), ...extra });
const post = (body, headers = {}) => new Request("http://localhost/api/agent", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const chat = (content) => Response.json({ model: "anthropic/test-model", provider: "Anthropic", choices: [{ finish_reason: "stop", message: { content } }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, cost: 0.001 } });
function live() {
  process.env.TICKETSTUB_RUNTIME_MODE = "live";
  process.env.TICKETSTUB_AGENT_PROVIDER = "openrouter";
  process.env.TICKETSTUB_AGENT_MODEL = "anthropic/test-model";
  process.env.TICKETSTUB_AGENT_OPENROUTER_API_KEY = "offline-test-placeholder";
  delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY;
}
const demo = () => { delete process.env.TICKETSTUB_RUNTIME_MODE; };

// ---------------------------------------------------------------------------------------------
// Protocol validation
// ---------------------------------------------------------------------------------------------

test("every action type validates when well formed", () => {
  const good = [
    { type: "set_fact", field: "date", value: "2024-10-11" },
    { type: "set_fact", field: "venue", value: "Rosewood Hall" },
    { type: "set_fact", field: "keep", value: "opener" },
    { type: "set_style", edition: "letterpress" },
    { type: "set_material", material: "framed" },
    { type: "set_finish", finish: "foil" },
    { type: "set_text", field: "subtitle", value: "Night 3 of 3" },
    { type: "remix_art" },
    { type: "remix_art", vibe: "neon", procedural: true },
    { type: "show_back" },
    { type: "ask_user", question: "Which date?", options: ["11 Oct", "12 Oct"] },
    { type: "none" },
  ];
  for (const a of good) assert.equal(P.parseAction(a).ok, true, JSON.stringify(a));
  assert.deepEqual(P.ACTION_TYPES.slice().sort(), good.map((a) => a.type).filter((t, i, l) => l.indexOf(t) === i).sort());
});

test("unknown types and fields, wrong types and oversized strings are rejected, not repaired", () => {
  const long = (n) => "x".repeat(n);
  const bad = [
    null, "set_style", [], {},
    { type: "delete_stub" },
    { type: "set_style", edition: "gothic" },
    { type: "set_style", edition: "classic", extra: 1 },
    { type: "set_material", material: 5 },
    { type: "set_finish", finish: "glitter" },
    { type: "set_fact", field: "seat", value: "A1" },
    { type: "set_fact", field: "date", value: "2024-02-31" },
    { type: "set_fact", field: "date", value: "yesterday" },
    { type: "set_fact", field: "date", value: 20241011 },
    { type: "set_fact", field: "venue", value: long(P.LIMITS.value + 1) },
    { type: "set_fact", field: "venue", value: "   " },
    { type: "set_fact", field: "venue", value: "<script>" },
    { type: "set_fact", field: "keep", value: "has space" },
    { type: "set_text", field: "title", value: long(P.LIMITS.title + 1) },
    { type: "set_text", field: "guestName", value: "x" },
    { type: "set_text", field: "title", value: "a\u0000b" },
    { type: "remix_art", vibe: long(P.LIMITS.vibe + 1) },
    { type: "remix_art", procedural: "yes" },
    { type: "remix_art", simulate: "failure" }, // demo-only: refused unless the caller allows it
    { type: "show_back", now: true },
    { type: "ask_user", question: long(P.LIMITS.question + 1) },
    { type: "ask_user", question: "q", options: ["a", "b", "c", "d", "e"] },
    { type: "ask_user", question: "q", options: [1] },
  ];
  for (const a of bad) assert.equal(P.parseAction(a).ok, false, JSON.stringify(a)?.slice(0, 80));
  assert.equal(P.parseAction({ type: "remix_art", simulate: "failure" }, { allowSimulate: true }).ok, true);
  assert.equal(P.parseAction({ type: "set_fact", field: "date", value: "2024-02-29" }).ok, true, "2024 is a leap year");
  assert.equal(P.parseAction({ type: "set_fact", field: "date", value: "2023-02-29" }).ok, false);
});

test("a plan is { reply, actions }: any invalid action rejects it, and `none` is dropped", () => {
  assert.equal(P.parsePlan({ reply: "ok", actions: [{ type: "none" }, { type: "show_back" }] }).value.actions.length, 1);
  assert.equal(P.parsePlan({ reply: "ok", actions: [{ type: "show_back" }, { type: "nuke" }] }).ok, false);
  assert.equal(P.parsePlan({ reply: "", actions: [] }).ok, false);
  assert.equal(P.parsePlan({ reply: "x".repeat(P.LIMITS.reply + 1), actions: [] }).ok, false);
  assert.equal(P.parsePlan({ reply: "ok", actions: Array(P.LIMITS.actions + 1).fill({ type: "show_back" }) }).ok, false);
  assert.equal(P.parsePlan({ reply: "ok", actions: "none" }).ok, false);
  assert.equal(P.parsePlan({ reply: "ok", actions: [], tool_calls: [] }).ok, false);
});

test("requests are strict, and the summary leaves out guest names, friends, notes, seats and photos", () => {
  const s = state();
  assert.ok(!JSON.stringify(s).includes(SECRET));
  assert.ok(!JSON.stringify(s).includes("Sec 104"));
  assert.equal(P.parseRequest(request({ message: "hello" })).ok, true);
  assert.equal(P.parseRequest(request()).ok, false, "a request needs a message or results");
  assert.equal(P.parseRequest({ ...request({ message: "hi" }), schema: "other/1" }).ok, false);
  assert.equal(P.parseRequest({ ...request({ message: "hi" }), event: {} }).ok, false);
  assert.equal(P.parseRequest(request({ message: "x".repeat(P.LIMITS.message + 1) })).ok, false);
  assert.equal(P.parseRequest(request({ message: "bad\u0007" })).ok, false);
  assert.equal(P.parseRequest({ schema: P.AGENT_SCHEMA, state: { ...s, guestName: "Ada" }, message: "hi" }).ok, false, "PII fields cannot ride along");
  assert.equal(P.parseRequest({ schema: P.AGENT_SCHEMA, state: { ...s, facts: Array(P.LIMITS.facts + 1).fill(s.facts[0]) }, message: "hi" }).ok, false);
  assert.equal(P.parseRequest(request({ results: [{ action: { type: "show_back" }, status: "maybe" }] })).ok, false);
  assert.equal(P.parseRequest(request({ results: [{ action: { type: "show_back" }, status: "applied", code: "Not A Code" }] })).ok, false);
  assert.equal(P.parseRequest(request({ results: [{ action: { type: "show_back" }, status: "applied", code: "x_y", ms: 12 }] })).ok, true);
});

// ---------------------------------------------------------------------------------------------
// The demo planner
// ---------------------------------------------------------------------------------------------

const ask = (message) => planDemo(request({ message }));
const types = (plan) => plan.actions.map((a) => a.type);

test("the demo planner is deterministic and every plan it returns validates", () => {
  const messages = [
    "Fix the date to 11 Oct 2024", "the venue is Barrowland Ballroom", "Switch to letterpress and remix the art", "make it moodier", "keep the opener on my stub",
    "show me the back", "set the finish to foil", "make it framed", "what time did it start?", "gibberish", "Simulate an art failure", "fix the date to 2024-02-31",
  ];
  for (const m of messages) {
    const a = ask(m), b = ask(m);
    assert.deepEqual(a, b, m);
    assert.equal(P.parsePlan(a, { allowSimulate: true }).ok, true, m);
  }
});

test("the demo planner turns requests into the right actions", () => {
  assert.deepEqual(ask("Fix the date to 11 Oct 2024").actions, [{ type: "set_fact", field: "date", value: "2024-10-11" }]);
  assert.deepEqual(ask("The date was October 13, 2024").actions, [{ type: "set_fact", field: "date", value: "2024-10-13" }]);
  assert.deepEqual(ask("change the date to the 11th of october").actions, [{ type: "set_fact", field: "date", value: "2024-10-11" }], "the stub's year is the default");
  assert.deepEqual(ask("the venue is Barrowland Ballroom.").actions, [{ type: "set_fact", field: "venue", value: "Barrowland Ballroom" }]);
  assert.deepEqual(types(ask("Switch to letterpress and remix the art")), ["set_style", "remix_art"]);
  assert.deepEqual(ask("make it moodier").actions, [{ type: "remix_art", vibe: "moodier" }]);
  assert.deepEqual(ask("Make it feel like a summer night").actions, [{ type: "remix_art", vibe: "a summer night" }]);
  assert.deepEqual(ask("keep the opener on my stub").actions, [{ type: "set_fact", field: "keep", value: "opener" }]);
  assert.deepEqual(ask("use a holo finish").actions, [{ type: "set_finish", finish: "holo" }]);
  assert.deepEqual(ask("make it framed").actions, [{ type: "set_material", material: "framed" }]);
  assert.deepEqual(ask("show me the back").actions, [{ type: "show_back" }]);
  assert.deepEqual(ask("set the title to The Pale Hours Live").actions, [{ type: "set_text", field: "title", value: "The Pale Hours Live" }]);
  assert.deepEqual(ask("simulate an art failure").actions, [{ type: "remix_art", simulate: "failure" }]);
  assert.deepEqual(ask("What time did my friend arrive?").actions, []);
  assert.deepEqual(findDate("9 Mar", 2024), { iso: "2024-03-09", real: true });
  assert.equal(findDate("market 5", 2024), null, "a word that merely starts like a month is not one");
});

test("an invalid date is not proposed: the planner asks instead", () => {
  const plan = ask("fix the date to 2024-02-31");
  assert.deepEqual(types(plan), ["ask_user"]);
  assert.match(plan.reply, /not a real calendar date/);
  assert.deepEqual(types(ask("fix the date")), ["ask_user"]);
});

test("a day alone resolves in the stub's own month and year, and an unreadable date does not drop the other asks", () => {
  const iso = state().dateISO;
  const [y, m] = iso.split("-");
  assert.deepEqual(findDate("the 12th", Number(y), Number(m)), { iso: `${y}-${m}-12`, real: true });
  assert.deepEqual(findDate("on the 17th", Number(y), Number(m)), { iso: `${y}-${m}-17`, real: true });
  assert.equal(findDate("the 12th", Number(y)), null, "without a month there is nothing to resolve against");
  assert.deepEqual(ask("Fix the date to the 12th").actions, [{ type: "set_fact", field: "date", value: `${y}-${m}-12` }]);
  assert.deepEqual(ask("Fix the date to the 12th and make it moodier").actions, [
    { type: "set_fact", field: "date", value: `${y}-${m}-12` },
    { type: "remix_art", vibe: "moodier" },
  ]);
  const both = ask("Fix the date to soonish and make it moodier");
  assert.deepEqual(types(both), ["remix_art", "ask_user"], "the art change is still proposed, the date is asked for");
  assert.match(both.reply, /could not find a date/);
  assert.match(both.reply, /moodier/);
  assert.equal(both.actions[1].field, "date");
  assert.deepEqual(types(ask("fix the date to 2024-02-31 and make it moodier")), ["remix_art", "ask_user"]);
});

// the stub as the reviewer saw it: dated 2024-10-11
const on1011 = { ...state(), dateISO: "2024-10-11" };
const askOn = (message, pending) => planDemo(request({ message, pending, state: on1011 }));

const setDate = (value) => [{ type: "set_fact", field: "date", value }];
const moodier = { type: "remix_art", vibe: "moodier" };
test("reviewer case 1: '12th of next month' resolves to next month, with the remix kept", () => {
  assert.deepEqual(askOn("Fix the date to the 12th of next month and make it moodier").actions, [...setDate("2024-11-12"), moodier]);
});
test("'the 12th of last month' and 'of the previous month' resolve to the month before", () => {
  assert.deepEqual(askOn("Fix the date to the 12th of last month").actions, setDate("2024-09-12"));
  assert.deepEqual(askOn("Fix the date to the 12th of the previous month").actions, setDate("2024-09-12"));
});
test("'the 12th of next month' in December rolls over to January of the next year, and last month back across January", () => {
  assert.deepEqual(findDate("the 12th of next month", 2024, 12), { iso: "2025-01-12", real: true });
  assert.deepEqual(findDate("the 12th of last month", 2025, 1), { iso: "2024-12-12", real: true });
});
test("a bare day still resolves to the current month, and an explicit month is used", () => {
  assert.deepEqual(findDate("the 17th", 2024, 10), { iso: "2024-10-17", real: true });
  assert.deepEqual(askOn("Fix the date to the 17th").actions, setDate("2024-10-17"));
  assert.deepEqual(findDate("the 12th of May", 2024, 10), { iso: "2024-05-12", real: true });
});
test("an ambiguous day ('12th or 13th', '12th-ish', 'of this year', 'next week') asks and keeps the other ask", () => {
  for (const vague of ["the 12th or 13th", "the 12th-ish", "the 12th of this year", "the 12th next week", "the 12th, 13th"]) {
    const plan = askOn(`Fix the date to ${vague} and make it moodier`);
    assert.deepEqual(plan.actions.map((a) => a.type), ["remix_art", "ask_user"], `${vague}: the other ask is kept, the date is asked for`);
    assert.equal(plan.actions[1].field, "date");
  }
  assert.equal(findDate("the 12th or 13th", 2024, 10), null);
});

// What the browser carries from one turn to the next: the first typed question of the last plan.
const pendingOf = (plan) => {
  const q = plan.actions.find((a) => a.type === "ask_user" && a.field);
  return q ? { field: q.field, question: q.question, ...(q.options ? { options: q.options } : {}) } : undefined;
};
const answer = (prev, message) => planDemo(request({ message, pending: pendingOf(prev) }));

test("a clarifying question is answered on the next turn: date and venue, typed", () => {
  const d1 = ask("fix the date");
  assert.deepEqual(pendingOf(d1), { field: "date", question: d1.actions[0].question });
  assert.deepEqual(answer(d1, "11 Oct 2024").actions, [{ type: "set_fact", field: "date", value: "2024-10-11" }]);
  assert.deepEqual(answer(d1, "October 13, 2024.").actions, [{ type: "set_fact", field: "date", value: "2024-10-13" }]);
  const v1 = ask("change the venue");
  assert.deepEqual(pendingOf(v1), { field: "venue", question: "Where was it?" });
  assert.deepEqual(answer(v1, "Barrowland Ballroom").actions, [{ type: "set_fact", field: "venue", value: "Barrowland Ballroom" }]);
  const plan = answer(v1, "Barrowland Ballroom");
  assert.match(plan.reply, /Nothing changes until you apply it/);
  assert.equal(P.parsePlan(plan).ok, true);
});

const answerOn = (prev, message) => askOn(message, pendingOf(prev));
test("reviewer case 2: two turns, 'fix the date' then 'the 12th and make it moodier' proposes both", () => {
  const d1 = askOn("fix the date");
  const both = answerOn(d1, "the 12th and make it moodier");
  assert.deepEqual(both.actions, [...setDate("2024-10-12"), moodier]);
  assert.equal(P.parsePlan(both).ok, true);
});
test("a pending date answer plans the other actions too, and keeps a relative date's month", () => {
  const d1 = askOn("fix the date");
  assert.deepEqual(answerOn(d1, "11 Oct 2024 and show me the back").actions, [...setDate("2024-10-11"), { type: "show_back" }]);
  assert.deepEqual(answerOn(d1, "the 12th of next month and make it moodier").actions, [...setDate("2024-11-12"), moodier]);
});
test("a pending date answer that is itself unclear re-asks and keeps the other ask", () => {
  const d1 = askOn("fix the date");
  const unclear = answerOn(d1, "the 12th or 13th and make it moodier");
  assert.deepEqual(unclear.actions.map((a) => a.type), ["remix_art", "ask_user"]);
  assert.deepEqual(pendingOf(unclear), pendingOf(d1));
  assert.deepEqual(answerOn(d1, "no idea").actions.map((a) => a.type), ["ask_user"]);
});

test("a tapped option is an answer to the pending question", () => {
  const prev = { reply: "Which one?", actions: [{ type: "ask_user", field: "venue", question: "Which venue?", options: ["Barrowland Ballroom", "O2 Academy"] }] };
  assert.equal(P.parsePlan(prev).ok, true);
  assert.deepEqual(answer(prev, "O2 Academy").actions, [{ type: "set_fact", field: "venue", value: "O2 Academy" }]);
  const dates = { reply: "Which date?", actions: [{ type: "ask_user", field: "date", question: "Which date?", options: ["2024-10-11", "2024-10-12"] }] };
  assert.deepEqual(answer(dates, "2024-10-12").actions, [{ type: "set_fact", field: "date", value: "2024-10-12" }]);
});

test("an answer that cannot be used asks again, with a reason", () => {
  const d1 = ask("fix the date");
  for (const bad of ["no idea", "2024-02-31"]) {
    const plan = answer(d1, bad);
    assert.deepEqual(types(plan), ["ask_user"], bad);
    assert.equal(plan.actions[0].field, "date");
    assert.ok(plan.reply.length > 10);
  }
  const v1 = ask("change the venue");
  const long = answer(v1, "x".repeat(P.LIMITS.value + 1));
  assert.deepEqual(types(long), ["ask_user"]);
  assert.equal(long.actions[0].field, "venue");
  assert.deepEqual(types(answer(v1, "<script>")), ["ask_user"]);
});

test("a change of topic ignores the pending question and clears it", () => {
  const d1 = ask("fix the date");
  const plan = answer(d1, "make it framed");
  assert.deepEqual(plan.actions, [{ type: "set_material", material: "framed" }]);
  assert.equal(pendingOf(plan), undefined);
  assert.deepEqual(answer(d1, "what time did it start?").actions, []);
});

test("the pending question is validated like every other input", () => {
  const ok = { field: "date", question: "Which date was it?", options: ["a", "b"] };
  assert.equal(P.parseRequest(request({ message: "x", pending: ok })).ok, true);
  const tampered = [
    { ...ok, field: "password" }, { ...ok, extra: 1 }, { ...ok, question: "q".repeat(P.LIMITS.question + 1) }, { ...ok, question: "<b>x</b>" },
    { ...ok, question: "a\u0000b" }, { ...ok, options: ["a", "b", "c", "d", "e"] }, { ...ok, options: ["o".repeat(P.LIMITS.option + 1)] }, { ...ok, options: [1] },
    { field: "date" }, "date", [], null,
  ];
  for (const pending of tampered) assert.equal(P.parseRequest(request({ message: "x", pending })).ok, false, JSON.stringify(pending));
  assert.equal(P.parseRequest(request({ pending: ok, results: [] })).ok, false, "pending needs a message");
  assert.equal(P.parseAction({ type: "ask_user", question: "q", field: "seat" }).ok, false);
});

test("the pending context never applies anything: the route returns proposals only, and a tampered one is a 400", async () => {
  demo();
  const pending = { field: "date", question: "Which date was it?" };
  const res = await agent.POST(post(request({ message: "11 Oct 2024", pending })));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.actions, [{ type: "set_fact", field: "date", value: "2024-10-11" }]);
  assert.equal((await agent.POST(post(request({ message: "11 Oct 2024", pending: { ...pending, field: "evil" } })))).status, 400);
  assert.equal((await agent.POST(post(request({ message: "x", pending: { ...pending, question: "q".repeat(5000) } })))).status, 400);
});

test("live mode hands the pending question to the model as data, and still validates what comes back", async () => {
  live();
  const prompts = [];
  globalThis.fetch = async (url, init) => {
    prompts.push(JSON.parse(init.body));
    return chat('{"reply":"I can set the venue.","actions":[{"type":"set_fact","field":"venue","value":"Barrowland Ballroom"}]}');
  };
  const pending = { field: "venue", question: "Where was it?" };
  const body = await (await agent.POST(post(request({ message: "Barrowland Ballroom", pending })))).json();
  assert.deepEqual(body.actions, [{ type: "set_fact", field: "venue", value: "Barrowland Ballroom" }]);
  assert.match(JSON.stringify(prompts[0]), /Pending question/);
  assert.match(JSON.stringify(prompts[0]), /Where was it/);
});

test("the follow-up refers to what actually happened", () => {
  const s = P.summarize(stub());
  const applied = planDemo({ schema: P.AGENT_SCHEMA, state: { ...s, edition: "letterpress", versions: 3 }, results: [
    { action: { type: "set_fact", field: "date", value: "2024-10-11" }, status: "applied" },
    { action: { type: "set_style", edition: "letterpress" }, status: "applied" },
  ] });
  assert.match(applied.reply, /date set to 11 Oct 2024/);
  assert.match(applied.reply, /style switched to Letterpress/);
  assert.match(applied.reply, /3 versions/);
  assert.deepEqual(applied.actions, []);

  const failed = planDemo({ schema: P.AGENT_SCHEMA, state: s, results: [{ action: { type: "remix_art", vibe: "neon", simulate: "failure" }, status: "failed", code: "provider_unavailable" }] });
  assert.match(failed.reply, /art service did not respond/);
  assert.match(failed.reply, /unchanged/);
  assert.deepEqual(failed.actions, [{ type: "remix_art", procedural: true, vibe: "neon" }, { type: "remix_art", vibe: "neon" }], "fallback first, then a retry that no longer forces the failure");

  const limit = planDemo({ schema: P.AGENT_SCHEMA, state: s, results: [{ action: { type: "remix_art" }, status: "failed", code: "art_limit" }] });
  assert.match(limit.reply, /daily art limit/);

  const recovered = planDemo({ schema: P.AGENT_SCHEMA, state: { ...s, art: "procedural", versions: 4 }, results: [{ action: { type: "remix_art", procedural: true }, status: "applied" }] });
  assert.match(recovered.reply, /^Recovered/);
  assert.match(recovered.reply, /labelled simulated/);

  const rejected = planDemo({ schema: P.AGENT_SCHEMA, state: s, results: [{ action: { type: "set_fact", field: "date", value: "2024-10-11" }, status: "rejected", code: "invalid_value" }] });
  assert.deepEqual(types(rejected), ["ask_user"]);
});

// ---------------------------------------------------------------------------------------------
// Applying actions: the editor's own edit paths
// ---------------------------------------------------------------------------------------------

test("applying goes through corrections, editions and the stub's own settings", () => {
  const s = stub();
  const fixed = applyToStub(s, { type: "set_fact", field: "date", value: "2024-10-11" });
  assert.equal(fixed.ok, true);
  assert.equal(fixed.stub.event.dateISO, "2024-10-11");
  assert.equal(fixed.stub.corrections.length, 1, "a fact change is a recorded correction");
  assert.equal(fixed.stub.corrections[0].corrected.value, "2024-10-11");
  assert.equal(fixed.stub.corrections[0].original.value, "2024-10-12");
  assert.equal(applyToStub(fixed.stub, { type: "set_fact", field: "date", value: "2024-10-11" }).code, "unchanged");

  const styled = applyToStub(s, { type: "set_style", edition: "letterpress" });
  assert.equal(currentVersion(styled.stub).edition, "letterpress");
  assert.equal(styled.stub.versions.length, s.versions.length + 1);
  assert.equal(applyToStub(styled.stub, { type: "set_style", edition: "letterpress" }).code, "unchanged");

  assert.equal(applyToStub(s, { type: "set_material", material: "framed" }).stub.material, "framed");
  assert.equal(applyToStub(s, { type: "set_finish", finish: "holo" }).stub.finish, "holo");
  assert.equal(applyToStub(s, { type: "set_fact", field: "keep", value: "opener" }).stub.event.facts.find((f) => f.id === "opener").kept, true);
  assert.equal(applyToStub(s, { type: "set_fact", field: "keep", value: "nope" }).code, "not_found");
  assert.equal(applyToStub(s, { type: "set_text", field: "subtitle", value: "Night 3 of 3" }).stub.event.subtitle, "Night 3 of 3");
  assert.equal(applyToStub(s, { type: "set_text", field: "title", value: "Pale Hours Live" }).stub.corrections.length, 1);
  assert.equal(s.corrections, undefined, "the original stub is not mutated");
});

test("applying validates again: a bad value is refused and the stub is untouched", () => {
  const s = stub();
  for (const a of [
    { type: "set_fact", field: "date", value: "2024-13-45" },
    { type: "set_fact", field: "venue", value: "x".repeat(200) },
    { type: "set_style", edition: "gothic" },
    { type: "remix_art" }, // carried out by the chat, not here
    { type: "show_back" },
  ]) assert.deepEqual(applyToStub(s, a), { ok: false, code: "invalid_value" }, JSON.stringify(a));
});

// ---------------------------------------------------------------------------------------------
// /api/agent: demo planner
// ---------------------------------------------------------------------------------------------

test("demo mode answers from the deterministic planner with no provider and no network", async () => {
  demo();
  globalThis.fetch = () => { assert.fail("demo attempted network"); };
  const res = await agent.POST(post(request({ message: "Fix the date to 11 Oct 2024" })));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.schema, P.AGENT_SCHEMA);
  assert.equal(body.provenance, "rules");
  assert.deepEqual(body.actions, [{ type: "set_fact", field: "date", value: "2024-10-11" }]);
  assert.deepEqual(body, await (await agent.POST(post(request({ message: "Fix the date to 11 Oct 2024" })))).json(), "same input, same answer");
  const again = await (await agent.POST(post(request({ results: [{ action: { type: "set_fact", field: "date", value: "2024-10-11" }, status: "applied", ms: 4 }] })))).json();
  assert.match(again.reply, /date set to 11 Oct 2024/);
});

test("the legacy short reply keeps its 204 in demo mode", async () => {
  demo();
  assert.equal((await agent.POST(post({ event: { type: "concert", title: "x", facts: [] }, message: "Hello?" }))).status, 204);
});

test("gates: foreign Origin, bad bodies, bad requests, capability and rate limit all use the error envelope", async () => {
  demo();
  let res = await agent.POST(post(request({ message: "hi" }), { origin: "https://evil.example" }));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, "bad_origin");
  res = await agent.POST(post(request({ message: "hi" }), { origin: "http://localhost", host: "localhost" }));
  assert.equal(res.status, 200, "our own Origin passes");

  res = await agent.POST(post("{not json"));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "bad_request");
  res = await agent.POST(post(JSON.stringify({ schema: P.AGENT_SCHEMA, state: state(), message: "x".repeat(30_000) })));
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error.code, "too_large");

  for (const bad of [{ schema: P.AGENT_SCHEMA }, { ...request({ message: "hi" }), extra: 1 }, request({ message: "x".repeat(401) }), request({ results: [{ action: { type: "drop_tables" }, status: "applied" }] })]) {
    res = await agent.POST(post(bad));
    assert.equal(res.status, 400);
    const e = await res.json();
    assert.equal(e.error.code, "bad_request");
    assert.deepEqual(Object.keys(e), ["error"]);
  }

  const ip = { "x-real-ip": "203.0.113.77" };
  let last;
  for (let i = 0; i < 125; i++) {
    last = await agent.POST(post(request({ message: "hi" }), ip));
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429);
  const limited = await last.json();
  assert.equal(limited.error.code, "rate_limited");
  assert.ok(last.headers.get("retry-after"));
  assert.equal((await agent.POST(post(request({ message: "hi" }), { "x-real-ip": "203.0.113.78" }))).status, 200, "another caller is not limited");
});

// ---------------------------------------------------------------------------------------------
// /api/agent: live model, validation and the repair path
// ---------------------------------------------------------------------------------------------

test("live mode validates the model's JSON and returns its actions", async () => {
  live();
  const prompts = [];
  globalThis.fetch = async (url, init) => {
    prompts.push(JSON.parse(init.body));
    return chat('```json\n{"reply":"I can switch it to letterpress.","actions":[{"type":"set_style","edition":"letterpress"}]}\n```');
  };
  const body = await (await agent.POST(post(request({ message: "make it letterpress" })))).json();
  assert.equal(body.provenance, "live");
  assert.deepEqual(body.actions, [{ type: "set_style", edition: "letterpress" }]);
  assert.equal(body.providerMetadata.usage.totalTokens, 20);
  assert.equal(prompts.length, 1);
  const sent = JSON.stringify(prompts[0]);
  assert.ok(!sent.includes(SECRET), "no guest names, friends or notes reach the model");
  assert.ok(!sent.includes("Sec 104"), "no seat reaches the model");
  assert.match(prompts[0].messages[0].content, /ticketstub|TicketStub/);
});

test("live mode: invalid JSON gets one repair attempt, then a safe reply with no actions", async () => {
  live();
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    const prompt = JSON.parse(init.body).messages.at(-1).content;
    if (calls === 1) return chat("Sure! I will do that for you.");
    assert.match(prompt, /previous reply was rejected/);
    return chat('{"reply":"Switching to letterpress.","actions":[{"type":"set_style","edition":"letterpress"}]}');
  };
  let body = await (await agent.POST(post(request({ message: "make it letterpress" })))).json();
  assert.equal(calls, 2);
  assert.equal(body.provenance, "live");
  assert.equal(body.actions[0].type, "set_style");
  const outcomes = sink.events.filter((e) => e.name === "agent_step").map((e) => e.fields.outcome);
  assert.deepEqual(outcomes, ["repaired"]);
  assert.equal(sink.events.filter((e) => e.name === "provider_attempt").length, 2, "both model calls are traced with usage");

  calls = 0;
  sink.events.length = 0;
  globalThis.fetch = async () => { calls++; return chat(calls === 1 ? "not json" : '{"reply":"ok","actions":[{"type":"format_disk"}]}'); };
  const res = await agent.POST(post(request({ message: "make it letterpress" })));
  body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(calls, 2, "one repair, no more");
  assert.deepEqual(body.actions, []);
  assert.match(body.reply, /could not turn that into a safe change/);
  assert.deepEqual(sink.events.filter((e) => e.name === "agent_step").map((e) => e.fields.outcome), ["invalid_plan"]);
});

test("live mode: the model cannot smuggle the demo-only forced failure, an invalid date or an oversize string", async () => {
  live();
  for (const actions of [[{ type: "remix_art", simulate: "failure" }], [{ type: "set_fact", field: "date", value: "2024-02-31" }], [{ type: "set_fact", field: "venue", value: "x".repeat(81) }]]) {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return chat(JSON.stringify({ reply: "ok", actions })); };
    const body = await (await agent.POST(post(request({ message: "go" })))).json();
    assert.equal(calls, 2);
    assert.deepEqual(body.actions, [], JSON.stringify(actions));
  }
});

test("live mode with no model configured falls back to the rules; a provider failure uses the error envelope", async () => {
  process.env.TICKETSTUB_RUNTIME_MODE = "live";
  for (const k of ["TICKETSTUB_AGENT_OPENROUTER_API_KEY", "TICKETSTUB_AGENT_PROVIDER", "TICKETSTUB_AGENT_MODEL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) delete process.env[k];
  globalThis.fetch = () => { assert.fail("no model, no network"); };
  const body = await (await agent.POST(post(request({ message: "show me the back" })))).json();
  assert.equal(body.provenance, "rules");
  assert.deepEqual(body.actions, [{ type: "show_back" }]);

  live();
  globalThis.fetch = async () => Response.json({ error: "down" }, { status: 500 });
  const res = await agent.POST(post(request({ message: "show me the back" })));
  assert.equal(res.status, 502);
  const e = await res.json();
  assert.equal(e.error.code, "provider_unavailable");
  assert.ok(!JSON.stringify(e).includes("offline-test-placeholder"));
});

// ---------------------------------------------------------------------------------------------
// The forced failure on the art route (demo only) and tracing
// ---------------------------------------------------------------------------------------------

test("art: a simulated failure answers as a failed provider in demo mode only", async () => {
  demo();
  const event = { type: "concert", title: "Offline Test", facts: [] };
  const mk = (extra) => new Request("http://localhost/api/art", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event, ...extra }) });
  let res = await art.POST(mk({ simulate: "failure" }));
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error.code, "provider_unavailable");
  res = await art.POST(mk({}));
  assert.equal(res.status, 200, "without the flag the same server makes art");
  live();
  globalThis.fetch = () => { assert.fail("no provider call expected"); };
  res = await art.POST(mk({ simulate: "failure" }));
  assert.notEqual(res.status, 502, "a live runtime ignores the flag");
});

test("the note chip shows the text it would replace, from the local note only", () => {
  const a = { type: "set_text", field: "note", value: "Best night ever" };
  assert.equal(P.describeAction(a, state()), "Set your note to “Best night ever”");
  assert.equal(P.describeAction(a, state(), "old words"), "Set your note to “Best night ever”, replacing “old words”");
  assert.ok(!JSON.stringify(state()).includes("note"), "the summary sent to the model still has no note");
});

test("art: a simulated failure is metered like a real request, so it can't be looped past the allowance", async () => {
  demo();
  const { getStorage } = await import("../src/server/index.ts");
  const { hashToken } = await import("../src/server/crypto.ts");
  const ip = "203.0.113.77";
  const event = { type: "concert", title: "Offline Test", facts: [] };
  const mk = () => new Request("http://localhost/api/art", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip }, body: JSON.stringify({ event, simulate: "failure" }) });
  let res = await art.POST(mk());
  assert.equal(res.status, 502, "inside the allowance the forced failure still answers as a failed provider");
  const before = sink.events.length;
  for (let i = 0; i < 30; i++) await getStorage().useArtQuota([{ key: `ip:${hashToken(ip)}`, max: 30 }], Date.now(), true);
  res = await art.POST(mk());
  assert.equal(res.status, 429, "over the allowance the quota answers first");
  assert.equal((await res.json()).error.code, "art_limit");
  assert.ok(!JSON.stringify(sink.events.slice(before)).includes("provider_unavailable"), "no failure is recorded for a limited request");
});

test("every step is traced: plan, result, failure, recovery and follow-up, with no message text or values", async () => {
  demo();
  await agent.POST(post(request({ message: `Fix the date to 11 Oct 2024 ${SECRET}` })));
  await agent.POST(post(request({ results: [{ action: { type: "remix_art", vibe: "neon", simulate: "failure" }, status: "failed", code: "provider_unavailable", ms: 31 }] })));
  await agent.POST(post(request({ results: [{ action: { type: "remix_art", procedural: true }, status: "applied", ms: 5 }] })));
  const steps = sink.events.filter((e) => e.name === "agent_step").map((e) => `${e.fields.step}:${e.fields.outcome}`);
  assert.deepEqual(steps, [
    "plan:ok",
    "result:failed", "failure:failed", "followup:ok",
    "result:applied", "recovery:applied", "followup:ok",
  ]);
  const failedResult = sink.events.find((e) => e.name === "agent_step" && e.fields.step === "result" && e.fields.outcome === "failed");
  assert.equal(failedResult.fields.durationMs, 31);
  assert.equal(failedResult.fields.code, "provider_unavailable");
  assert.ok(sink.events.filter((e) => e.name === "api_request").every((e) => e.fields.route === "agent" && ["agent_plan", "agent_followup"].includes(e.fields.operation)));
  const all = JSON.stringify(sink.events);
  for (const leak of [SECRET, "Pale Hours", "11 Oct", "2024-10-11", "Rosewood"]) assert.ok(!all.includes(leak), `trace leaked ${leak}`);

  // one Neatlogs trace per operation: the agent step is a TOOL span under the request
  const op = sink.events.find((e) => e.name === "agent_step" && e.fields.step === "failure").operationId;
  const trace = buildTrace(sink.events.filter((e) => e.operationId === op), ["t"]);
  const span = trace.spans.find((s) => s.name === "agent.failure");
  assert.ok(span && span.error === "provider_unavailable");
  assert.ok(trace.spans.some((s) => s.name === "agent.followup"));
});

test("the ops and event schemas drop free text and unknown fields on agent steps", () => {
  const ops = sanitizeOpsEvent({ name: "agent_step", operationId: "op_abcdefghijklmnopqrstuv", environment: "test", mode: "demo", fields: { step: "result", action: "set_fact", outcome: "applied", message: "hello", value: "2024-10-11", count: 1.5, code: "has space" } });
  assert.deepEqual(ops.event.fields, { step: "result", action: "set_fact", outcome: "applied" });
  assert.equal(ops.dropped, 4);
  assert.deepEqual(sanitizeEvent({ type: "agent_action", fields: { action: "set_fact", result: "applied", code: "x_y", value: "private" } }).fields, { action: "set_fact", result: "applied", code: "x_y" });
  assert.deepEqual(sanitizeEvent({ type: "agent_plan", fields: { source: "rules", outcome: "ok", actions: 2, reply: "text" } }).fields, { source: "rules", outcome: "ok", actions: 2 });
  assert.deepEqual(sanitizeEvent({ type: "agent_action", fields: { action: "format_disk", result: "applied" } }).fields, { result: "applied" });
});

test("an explicit month beside a day is used: 'the 12th in November' is November 12, not October", () => {
  assert.deepEqual(findDate("the 12th in November", 2024, 10), { iso: "2024-11-12", real: true });
  assert.deepEqual(findDate("the 12th of Nov 2025", 2024, 10), { iso: "2025-11-12", real: true });
  assert.deepEqual(askOn("Fix the date to the 12th in November and make it moodier").actions, [...setDate("2024-11-12"), moodier]);
});

test("more than one candidate date asks instead of picking the first, and keeps the other asks", () => {
  for (const two of ["12 Oct 2024 or the 13th", "2024-10-12 or 2024-10-13", "the 12th and the 13th"]) {
    assert.equal(findDate(two, 2024, 10), null, two);
    const plan = askOn(`Fix the date to ${two} and make it moodier`);
    assert.deepEqual(plan.actions.map((a) => a.type), ["remix_art", "ask_user"], two);
  }
  assert.deepEqual(answerOn(askOn("fix the date"), "12 Oct 2024 or the 13th and make it moodier").actions.map((a) => a.type), ["remix_art", "ask_user"]);
});

test("a topic-changing instruction is never the literal answer to a pending venue, title, subtitle or note question", () => {
  const typed = (field) => ({ field, question: "q?" });
  for (const field of ["venue", "title", "subtitle", "note"]) {
    for (const msg of ["fix the date to 2024-10-12", "fix the date to the 12th or 13th", "switch to letterpress and remix the art"]) {
      const plan = planDemo(request({ message: msg, pending: typed(field), state: on1011 }));
      assert.ok(plan.actions.length > 0, `${field} / ${msg}`);
      assert.ok(!plan.actions.some((a) => (a.type === "set_text" || (a.type === "set_fact" && a.field === "venue")) && /fix the date/i.test(a.value)), `${field} / ${msg} must not be written as the answer`);
    }
    assert.deepEqual(planDemo(request({ message: "fix the date to 2024-10-12", pending: typed(field), state: on1011 })).actions, setDate("2024-10-12"));
  }
});

test("a literal answer that merely contains a field word is still the answer to the pending question", () => {
  const typed = (field) => ({ field, question: "q?" });
  const reply = (field, message) => planDemo(request({ message, pending: typed(field), state: on1011 }));
  assert.deepEqual(reply("venue", "The Venue").actions, [{ type: "set_fact", field: "venue", value: "The Venue" }]);
  assert.deepEqual(reply("venue", "Venue77").actions, [{ type: "set_fact", field: "venue", value: "Venue77" }]);
  assert.deepEqual(reply("venue", "Venue 9").actions, [{ type: "set_fact", field: "venue", value: "Venue 9" }]);
  assert.deepEqual(reply("title", "The Title Bar").actions, [{ type: "set_text", field: "title", value: "The Title Bar" }]);
  assert.deepEqual(reply("subtitle", "Date Night").actions, [{ type: "set_text", field: "subtitle", value: "Date Night" }]);
  // a real instruction still wins
  assert.deepEqual(reply("venue", "make it moodier").actions, [moodier]);
  assert.deepEqual(reply("title", "please fix the date to 2024-10-12").actions, setDate("2024-10-12"));
});

test("'next month' / 'last month' bind to the day wherever they sit in the clause", () => {
  for (const phrase of ["next month, on the 12th", "the 12th, next month", "on the 12th of next month", "12th next month", "next month the 12th", "the 12th of the next month"]) {
    assert.deepEqual(findDate(phrase, 2024, 10), { iso: "2024-11-12", real: true }, phrase);
    assert.deepEqual(askOn(`Fix the date to ${phrase} and make it moodier`).actions, [...setDate("2024-11-12"), moodier], phrase);
  }
  assert.deepEqual(findDate("last month, on the 12th", 2024, 10), { iso: "2024-09-12", real: true });
  assert.deepEqual(findDate("the 12th, previous month", 2024, 1), { iso: "2023-12-12", real: true });
  // cannot be bound with confidence: ask
  for (const vague of ["next month, the 12th of last month", "the 12th next month or the month after", "next month and the 12th, make it moodier next month"]) {
    assert.equal(findDate(vague, 2024, 10), null, vague);
  }
});

test("a year qualifier next to a named month is honoured, and never dropped silently", () => {
  assert.deepEqual(findDate("the 12th in November next year", 2024, 10), { iso: "2025-11-12", real: true });
  assert.deepEqual(findDate("the 12th of November last year", 2024, 10), { iso: "2023-11-12", real: true });
  assert.deepEqual(findDate("12 Nov next year", 2024, 10), { iso: "2025-11-12", real: true });
  assert.deepEqual(findDate("November 12, last year", 2024, 10), { iso: "2023-11-12", real: true });
  assert.deepEqual(findDate("the 12th in November this year", 2024, 10), { iso: "2024-11-12", real: true });
  assert.deepEqual(findDate("the 12th in November 2026", 2024, 10), { iso: "2026-11-12", real: true });
  assert.deepEqual(askOn("Fix the date to the 12th in November next year and make it moodier").actions, [...setDate("2025-11-12"), moodier]);
  for (const vague of ["the 12th in November sometime next year or so", "12 Nov 2024 next year", "12 Oct 2024 next month", "the 12th in November, next week"]) {
    assert.equal(findDate(vague, 2024, 10), null, vague);
  }
});

test("leading politeness or discourse words never hide an instruction while a field question is pending", () => {
  const reply = (field, message) => planDemo(request({ message, pending: { field, question: "q?" }, state: on1011 }));
  for (const field of ["venue", "title", "subtitle", "note"]) {
    for (const [msg, want] of [
      ["Actually, fix the date: 2024-10-12", "2024-10-12"],
      ["Hi, can you fix the date 2024-10-12", "2024-10-12"],
      ["Hey, please set the date to 2024-10-12", "2024-10-12"],
      ["OK so change the date to 12 Oct 2024", "2024-10-12"],
      ["Sorry, the date was 2024-10-12", "2024-10-12"],
      ["um could you update the date: 2024-10-12", "2024-10-12"],
      ["well, and then fix the date to 2024-10-12", "2024-10-12"],
    ]) assert.deepEqual(reply(field, msg).actions, setDate(want), `${field} / ${msg}`);
  }
  assert.deepEqual(reply("venue", "The Venue").actions, [{ type: "set_fact", field: "venue", value: "The Venue" }]);
  assert.deepEqual(reply("venue", "Venue77").actions, [{ type: "set_fact", field: "venue", value: "Venue77" }]);
  assert.deepEqual(reply("subtitle", "Date Night").actions, [{ type: "set_text", field: "subtitle", value: "Date Night" }]);
  assert.deepEqual(reply("title", "The Title Bar").actions, [{ type: "set_text", field: "title", value: "The Title Bar" }]);
});

test("the four more-thing cases", () => {
  const reply = (field, message) => planDemo(request({ message, pending: { field, question: "q?" }, state: on1011 }));
  for (const field of ["venue", "title", "subtitle", "note"]) {
    for (const msg of ["One more thing, fix the date: 2024-10-12", "One more thing and fix the date: 2024-10-12", "Before we continue, set the date: 2024-10-12", "Thanks; update the date: 2024-10-12"]) {
      assert.deepEqual(reply(field, msg).actions, setDate("2024-10-12"), `${field} / ${msg}`);
    }
  }
});

test("the composed instruction patterns really carry word-boundary and whitespace escapes (a cooked backspace would never match)", () => {
  const bs = String.fromCharCode(92);
  assert.ok(INSTRUCTION.source.includes(bs + "b") && INSTRUCTION.source.includes(bs + "s"), INSTRUCTION.source);
  assert.equal(INSTRUCTION.test("Thanks; update the date"), true);
  assert.equal(INSTRUCTION.test("The Venue"), false);
  assert.equal(namesOtherField("One more thing, fix the date: 2024-10-12", "venue"), true);
  assert.equal(namesOtherField("the date was 2024-10-12", "venue"), true);
  assert.equal(namesOtherField("Date Night", "subtitle"), false);
  assert.equal(namesOtherField("fix the date", "date"), false);
});

test("a pending date answer that is date-like but unresolvable keeps the date ask beside the other actions", () => {
  const d1 = askOn("fix the date");
  for (const msg of ["12 Nov 2024 next year and make it moodier and show the back", "12 Oct 2024 next month and make it moodier and show the back"]) {
    const plan = answerOn(d1, msg);
    assert.deepEqual(plan.actions.map((a) => a.type), ["remix_art", "show_back", "ask_user"], msg);
    assert.equal(plan.actions[2].field, "date");
  }
});
