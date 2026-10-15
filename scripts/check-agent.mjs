// GT-04 agent journey, run in a real headless Chrome over the DevTools protocol against a production build in fixture mode.
//   node scripts/check-agent.mjs <base-url> [evidence-dir]
// Run through `npm run verify:product -- --suite agent --mode fixture --evidence-dir <dir>`.
// One journey, at a phone width and again at a desktop width (a different demo stub each time):
//   research (the demo stub's facts) -> ask the agent to fix a fact -> the proposal changes nothing -> Apply -> the stub
//   has the correction and the agent's follow-up says what happened -> ask for a style change and a remix -> Apply all ->
//   a revised stub (new versions, new edition) -> a forced art failure -> the stub is unchanged and the agent offers
//   procedural art or a retry -> Apply the fallback -> recovered. Also: an invalid date is asked about, never proposed,
//   and Apply works from the keyboard.
// A separate synthetic conflict input exercises direct date choices, truthful refusal and valid-answer recovery.
// The suite runs in fixture mode: no provider, no network (Chrome resolves loopback only). Screenshots go to
// AGENT_SHOTS (when set) and to the evidence dir. A missing Chrome or a step that does not happen exits nonzero.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchBrowser, chromePath } from "./lib/cdp.mjs";
import { clickVisibleButton } from "./lib/visible-pointer.mjs";
import { checkVisiblePointerControls } from "./lib/visible-pointer-controls.mjs";

const base = (process.argv[2] ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const evidenceDir = process.argv[3] ? resolve(process.argv[3]) : null;
const shotDirs = [process.env.AGENT_SHOTS, evidenceDir && join(evidenceDir, "agent-screenshots")].filter(Boolean).map((d) => resolve(d));
for (const d of shotDirs) mkdirSync(d, { recursive: true });

let failed = 0;
let passed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evidence = { chrome: chromePath(), base, journeys: [] };

const browser = await launchBrowser();
try {
  evidence.pointerControls = await checkVisiblePointerControls(browser, check);
  const journeys = [
    { name: "phone", width: 390, height: 844, demo: "pale", id: "demo-pale", dateText: "Fix the date to 11 Oct 2024", dateISO: "2024-10-11", dateWords: "11 Oct 2024" },
    { name: "desktop", width: 1440, height: 900, demo: "harbour", id: "demo-harbour", dateText: "Fix the date to 15 Sep 2024", dateISO: "2024-09-15", dateWords: "15 Sep 2024" },
  ];
  for (const j of journeys) {
    await journey(j);
    await alternativeJourney(j);
  }
} catch (e) {
  check("the agent journey ran to the end", false, e instanceof Error ? e.stack : String(e));
} finally {
  await browser.close();
}
if (evidenceDir) {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, "agent-journey.json"), JSON.stringify({ ...evidence, passed, failed }, null, 2));
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

async function journey(j) {
  const T = (s) => `${j.name} @${j.width}: ${s}`;
  const page = await browser.newPage({ width: j.width, height: j.height, desktop: j.width >= 960 });
  const log = { name: j.name, width: j.width, steps: [], pointerActions: [] };
  evidence.journeys.push(log);
  const shot = async (name) => {
    for (const d of shotDirs) await page.screenshot(join(d, `agent-${j.width}-${name}.png`));
  };
  const stubNow = () => page.eval(`(() => { const w = JSON.parse(localStorage.getItem("ticketstub.wall.v1") || "[]"); const s = w.find((x) => x.id === ${JSON.stringify(j.id)}); if (!s) return null; const v = s.versions.find((x) => x.id === s.currentVersionId) || s.versions[0]; return { versions: s.versions.length, edition: v.edition, art: v.art.kind, dateISO: s.event.dateISO, corrections: (s.corrections || []).length, material: s.material, finish: s.finish }; })()`);
  const snap = async (label) => {
    const s = await stubNow();
    log.steps.push({ label, stub: s });
    return s;
  };
  /** A real mouse click on the first visible, enabled button whose text starts with `text`, inside `scope`. */
  const tap = async (text, scope = `[role="dialog"]`) => {
    const receipt = await clickVisibleButton(page, { text, scope });
    log.pointerActions.push({ text, scope, ...receipt });
    return receipt.clicked;
  };
  /** Tap the Apply button on the chip whose label contains `label`. */
  const applyFor = async (label) => {
    const receipt = await clickVisibleButton(page, { chipLabel: label });
    log.pointerActions.push({ chipLabel: label, ...receipt });
    return receipt.clicked;
  };
  const say = async (text) => {
    const ok = await page.eval(`(() => { const el = document.querySelector('[role="dialog"] form input'); if (!el) return false; el.focus(); el.select?.(); return true; })()`);
    if (!ok) return false;
    await page.type(text);
    return tap("Send");
  };
  const dialogText = () => page.eval(`document.querySelector('[role="dialog"]')?.innerText ?? ""`);
  const agentMessages = () => page.eval(`[...document.querySelectorAll('[role="dialog"] [class*="agent"]')].map((e) => e.innerText)`);
  const hasMessage = (re) => page.waitFor(`[...document.querySelectorAll('[role="dialog"] [class*="agent"]')].some((e) => /${re}/.test(e.innerText))`, 12000);
  const chips = () => page.eval(`[...document.querySelectorAll('[role="dialog"] li[data-status], [role="dialog"] ul[aria-label="Proposed changes"] li')].map((e) => ({ text: e.innerText.replace(/\\s+/g, " ").trim(), status: e.dataset.status || "pending" }))`);
  const idle = () => page.waitFor(`!/Thinking|Remixing|Adding procedural|Checking what happened/.test(document.querySelector('[role="dialog"]')?.innerText ?? "")`, 12000);

  // research: the demo stub arrives with its researched facts, the way a person starts
  await page.goto(`${base}/new?demo=${j.demo}`, { settle: 300 });
  check(T(`research: the ${j.demo} demo stub is on the desk`), await page.waitFor(`location.pathname === "/studio/${j.id}"`, 40000), await page.eval("location.pathname"));
  await page.waitFor(`document.querySelector("figure[data-edition]")`, 15000);
  await sleep(1200);
  const before = await snap("opened");
  check(T("the stub has its researched facts and one version"), before && before.versions >= 1 && before.corrections === 0, JSON.stringify(before));

  // open the agent
  const opened = (await tap("Ask", "button")) || (await tap("Ask", "[role=toolbar]"));
  check(T("the Ask button opens the agent"), opened && (await page.waitFor(`document.querySelector('[role="dialog"] form input')`, 6000)), await page.eval("document.body.innerText.slice(0, 200)"));
  await sleep(900);
  await shot("01-open");

  // correction: ask, see a proposal that changes nothing, then apply it
  check(T("ask the agent to fix the date"), await say(j.dateText));
  check(T("the agent proposes the change as a chip with Apply"), await page.waitFor(`/Set the date to ${j.dateWords}/.test(document.querySelector('[role="dialog"]')?.innerText ?? "")`, 12000), await dialogText());
  await idle();
  const proposed = await snap("proposed");
  check(T("a proposal changes nothing until the owner applies it"), proposed.dateISO === before.dateISO && proposed.corrections === 0 && proposed.versions === before.versions, JSON.stringify(proposed));
  await shot("02-proposed");
  check(T("tap Apply on the date change"), await tap("Apply"));
  check(T("the agent's follow-up says what actually happened"), await hasMessage(`Done: date set to ${j.dateWords}`), await dialogText());
  await idle();
  const fixed = await snap("date applied");
  check(T("the stub has the new date, recorded as a correction"), fixed.dateISO === j.dateISO && fixed.corrections === before.corrections + 1, JSON.stringify(fixed));
  check(T("the chip says Applied"), (await chips()).some((c) => c.status === "applied"), JSON.stringify(await chips()));
  await shot("03-applied");

  // revised result: a style change and a remix, applied together
  check(T("ask for letterpress and a remix"), await say("Switch to letterpress and remix the art"));
  check(T("the agent proposes two actions and Apply all"), await page.waitFor(`/Apply all 2/.test(document.querySelector('[role="dialog"]')?.innerText ?? "")`, 12000), await dialogText());
  await idle();
  check(T("tap Apply all"), await tap("Apply all"));
  check(T("the follow-up names the style and the art"), await hasMessage("style switched to Letterpress; art remixed"), await dialogText());
  await idle();
  const revised = await snap("revised");
  check(T("revised result: the edition changed and the version count went up"), revised.edition === "letterpress" && revised.versions >= fixed.versions + 2, JSON.stringify(revised));
  check(T("the earlier correction is kept"), revised.corrections === fixed.corrections && revised.dateISO === j.dateISO, JSON.stringify(revised));
  await shot("04-revised");

  // controlled failure: the art provider fails; the stub is unchanged and the agent offers a fallback
  check(T("ask for a remix that is set to fail"), await say("Simulate an art failure"));
  check(T("the agent proposes the remix and says it is set to fail"), await page.waitFor(`/set to fail/.test(document.querySelector('[role="dialog"]')?.innerText ?? "")`, 12000), await dialogText());
  await idle();
  check(T("apply the remix that fails"), await tap("Apply"));
  check(T("the failure is reported and the agent offers procedural art or a retry"), await hasMessage("The art was not remixed"), await dialogText());
  await idle();
  const failedState = await snap("art failed");
  check(T("a failed action leaves the stub unchanged"), failedState.versions === revised.versions && failedState.art === revised.art, JSON.stringify(failedState));
  const failChips = await chips();
  check(T("the failed chip says Failed"), failChips.some((c) => c.status === "failed"), JSON.stringify(failChips));
  const text = await dialogText();
  check(T("the follow-up offers both the fallback and a retry"), /Use procedural art/.test(text) && /Remix the art/.test(text), text.slice(-400));
  await shot("05-failed");

  // recovery: apply the fallback
  check(T("tap Apply on Use procedural art"), await applyFor("Use procedural art"));
  check(T("recovered: the follow-up confirms procedural art"), await hasMessage("Recovered"), await dialogText());
  await idle();
  const recovered = await snap("recovered");
  check(T("the stub has a new procedural version"), recovered.versions === failedState.versions + 1 && recovered.art === "procedural", JSON.stringify(recovered));
  await shot("06-recovered");

  // validation: an impossible date is asked about, never proposed
  const sentBefore = (await agentMessages()).length;
  check(T("ask for an impossible date"), await say("fix the date to 2024-02-31"));
  check(T("the agent asks instead of proposing it"), await page.waitFor(`/not a real calendar date/.test(document.querySelector('[role="dialog"]')?.innerText ?? "")`, 12000), await dialogText());
  await idle();
  const last = await page.eval(`(() => { const m = [...document.querySelectorAll('[role="dialog"] [class*="agent"]')].pop(); return { chips: m.querySelectorAll('ul[aria-label="Proposed changes"] li').length, text: m.innerText }; })()`);
  check(T("no change is proposed for it"), last.chips === 0 && (await agentMessages()).length > sentBefore, JSON.stringify(last));
  const same = await snap("invalid date asked");
  check(T("the stub still has the date from before"), same.dateISO === j.dateISO && same.versions === recovered.versions, JSON.stringify(same));

  // keyboard: Apply is a real button, reached and pressed without a mouse
  check(T("ask to show the back"), await say("show me the back"));
  check(T("the agent proposes it"), await page.waitFor(`/Show the back/.test(document.querySelector('[role="dialog"]')?.innerText ?? "")`, 12000), await dialogText());
  await idle();
  const focused = await page.eval(`(() => { const b = [...document.querySelectorAll('[role="dialog"] ul[aria-label="Proposed changes"] button')].pop(); if (!b) return false; b.focus(); return document.activeElement === b; })()`);
  check(T("the Apply button takes keyboard focus"), focused);
  await page.key("Enter");
  check(T("Enter applies it: the sheet closes on the back of the stub"), await page.waitFor(`!document.querySelector('[role="dialog"]')`, 6000));
  await shot("07-back");

  check(T("no page errors and no failed requests"), page.consoleErrors.length === 0 && page.failed.length === 0, JSON.stringify({ errors: page.consoleErrors.slice(0, 3), failed: page.failed.slice(0, 3) }));
  await page.close();
}

/** Conflicting source answers are synthetic inputs; every choice and observed result uses the actual UI. */
async function alternativeJourney(j) {
  const T = (s) => `${j.name} @${j.width}, date alternatives: ${s}`;
  const page = await browser.newPage({ width: j.width, height: j.height, desktop: j.width >= 960 });
  const log = { name: `${j.name} date alternatives`, width: j.width, inputMode: "synthetic conflicting source answers", steps: [], pointerActions: [] };
  evidence.journeys.push(log);
  const scope = '[role="dialog"] [role="group"][aria-label="Alternatives"]';
  const tap = async (text, target = scope) => {
    const receipt = await clickVisibleButton(page, { text, scope: target });
    log.pointerActions.push({ text, scope: target, ...receipt });
    return receipt.clicked;
  };
  const stored = () => page.eval(`JSON.stringify(JSON.parse(localStorage.getItem("ticketstub.wall.v1") || "[]").find((s) => s.id === ${JSON.stringify(j.id)}))`);
  const messages = () => page.eval(`[...document.querySelectorAll('[role="dialog"] [class*="msg"][class*="agent"]')].map((e) => e.innerText)`);
  const replyVisible = () => page.waitFor(`(() => {
    const list = document.querySelector('[role="dialog"] [data-announce="added"]');
    const reply = [...document.querySelectorAll('[role="dialog"] [class*="msg"][class*="agent"]')].at(-1);
    if (!list || !reply) return false;
    const viewport = list.getBoundingClientRect(), box = reply.getBoundingClientRect();
    return box.height > 0 && box.top >= viewport.top && box.bottom <= viewport.bottom;
  })()`, 6000);
  try {
    await page.goto(`${base}/studio/${j.id}`, { settle: 300 });
    check(T("the current local fixture is available"), await page.waitFor('document.querySelector("figure[data-edition]")', 15000));
    const seeded = await page.eval(`(() => {
      const wall = JSON.parse(localStorage.getItem("ticketstub.wall.v1") || "[]");
      const stub = wall.find((s) => s.id === ${JSON.stringify(j.id)});
      if (!stub) return false;
      stub.event.dateISO = "2024-02-28";
      stub.event.facts = stub.event.facts.filter((f) => f.id !== "date").map((f) => { const { alternatives, ...rest } = f; return rest; });
      stub.event.facts.unshift({ id: "date", label: "28 Feb", value: "2024-02-28", source: "synthetic regression fixture", confidence: 0.4, provenance: "simulated", kept: true, alternatives: ["2024-02-31", "2024-13-01", "2024-02-29"] });
      stub.corrections = [];
      localStorage.setItem("ticketstub.wall.v1", JSON.stringify(wall));
      return true;
    })()`);
    check(T("seed only the explicitly synthetic conflict input"), seeded);
    await page.goto(`${base}/studio/${j.id}`, { settle: 300 });
    await page.waitFor('document.querySelector("figure[data-edition]")', 15000);
    const opened = (await tap("Ask", "button")) || (await tap("Ask", "[role=toolbar]"));
    check(T("open the actual Ask sheet"), opened && await page.waitFor(`document.querySelector(${JSON.stringify(scope)})`, 6000));
    const labels = await page.eval(`[...document.querySelectorAll(${JSON.stringify(scope + " button")})].map((e) => e.innerText.trim())`);
    check(T("an impossible day is shown literally, without normalizing it to another date"), labels[0] === "2024-02-31", JSON.stringify(labels));
    check(T("an impossible month is shown literally"), labels[1] === "2024-13-01", JSON.stringify(labels));

    for (const [index, value] of ["2024-02-31", "2024-13-01"].entries()) {
      const before = await stored();
      const messageCount = (await messages()).length;
      // The first pointer selects the same source choice even when the defective UI normalizes its label.
      check(T(`click the actual ${value} choice`), await tap(index === 0 ? null : value));
      const replied = await page.waitFor(`document.querySelectorAll('[role="dialog"] [class*="msg"][class*="agent"]').length > ${messageCount}`, 6000);
      const reply = (await messages()).at(-1) ?? "";
      check(T(`${value} gets a truthful refusal and a valid-date recovery instruction`), replied && /not changed/i.test(reply) && /real calendar date/i.test(reply) && !/Fixed\./.test(reply), reply);
      check(T(`${value} reply becomes visible in the actual conversation viewport`), await replyVisible());
      const after = await stored();
      check(T(`${value} changes no local event, history, version or save metadata`), after === before);
      log.steps.push({ input: value, outcome: /not changed/i.test(reply) ? "refusal" : "unexpected reply", reply, unchanged: after === before });
    }

    const beforeValid = JSON.parse(await stored());
    const messageCount = (await messages()).length;
    check(T("choose a valid leap-day answer after both refusals"), await tap("29 Feb"));
    const replied = await page.waitFor(`document.querySelectorAll('[role="dialog"] [class*="msg"][class*="agent"]').length > ${messageCount}`, 6000);
    const reply = (await messages()).at(-1) ?? "";
    check(T("a successful correction reports the accepted date"), replied && /Fixed\. 29 Feb is on your stub\./.test(reply), reply);
    check(T("the recovery reply becomes visible in the actual conversation viewport"), await replyVisible());
    const afterValid = JSON.parse(await stored());
    check(T("only the accepted answer is appended to correction history"), afterValid.event.dateISO === "2024-02-29" && afterValid.corrections.length === beforeValid.corrections.length + 1 && afterValid.corrections.at(-1).original.value === "2024-02-28" && afterValid.corrections.at(-1).corrected.value === "2024-02-29");
    check(T("answer recovery preserves every existing artwork version"), JSON.stringify(afterValid.versions) === JSON.stringify(beforeValid.versions) && afterValid.currentVersionId === beforeValid.currentVersionId);
    log.steps.push({ input: "2024-02-29", outcome: afterValid.event.dateISO === "2024-02-29" ? "accepted" : "unexpected result", reply, dateISO: afterValid.event.dateISO, corrections: afterValid.corrections.length });
    for (const d of shotDirs) await page.screenshot(join(d, `agent-${j.width}-08-alternative-recovery.png`));
    check(T("no page errors and no failed requests"), page.consoleErrors.length === 0 && page.failed.length === 0, JSON.stringify({ errors: page.consoleErrors.slice(0, 3), failed: page.failed.slice(0, 3) }));
  } finally {
    await page.close();
  }
}
