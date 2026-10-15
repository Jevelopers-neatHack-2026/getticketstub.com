import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// useProgress lifecycle, under the real React hooks (react-dom/client on a bare container: the harness renders no
// DOM nodes). The screen pieces progress.tsx imports for its components (CSS module, Desk, announce) are stubbed;
// the hook under test is the real source. Only timeout APIs are mocked, per test: slow/unknown transitions
// advance inside React act(), never by sleeping with a load-dependent wall-clock margin (Refs #88).

const src = new URL("../src/", import.meta.url);
const stub = (code) => ({ url: `data:text/javascript,${encodeURIComponent(code)}`, shortCircuit: true });
const tsFile = (url) => [".ts", ".tsx"].map((e) => new URL(`${url.href}${e}`)).find((u) => existsSync(fileURLToPath(u)));

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(".module.css")) return stub("export default new Proxy({}, { get: (_, k) => String(k) });");
    if (specifier === "@/customer/a11y/announce") return stub("export const useAnnounce = () => {};");
    if (specifier === "@/customer/desk/Desk") return stub("export const PaperButton = () => null; export const TearLink = () => null;");
    if (specifier.startsWith("@/")) {
      const u = tsFile(new URL(specifier.slice(2), src));
      if (u) return { url: u.href, shortCircuit: true };
    }
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      const u = tsFile(new URL(specifier, context.parentURL));
      if (u) return { url: u.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && /\.tsx?$/.test(new URL(url).pathname)) {
      return {
        format: "module", shortCircuit: true,
        source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
          fileName: fileURLToPath(url),
        }).outputText,
      };
    }
    return nextLoad(url, context);
  },
});

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// the few window members react-dom touches when it commits to a container with no real DOM behind it
globalThis.window = { event: undefined, document: { activeElement: null }, HTMLIFrameElement: class {} };
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { useProgress } = await import("@/customer/feedback-messages/progress");
const { act, createElement: h } = React;

const SLOW = 15;
const UNKNOWN = 40;
/** A promise settled by hand: the stand-in for one in-flight request. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

const roots = [];
/** Mounts a component that exposes the latest hook value as `.current`. */
function mount() {
  const out = { current: null };
  function Probe() {
    out.current = useProgress({ slowMs: SLOW, unknownMs: UNKNOWN });
    return null;
  }
  const container = { nodeType: 1, namespaceURI: "http://www.w3.org/1999/xhtml", tagName: "DIV", ownerDocument: { nodeType: 9, addEventListener() {}, removeEventListener() {} }, addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {} };
  const root = createRoot(container);
  roots.push(root);
  return { out, root, render: () => act(() => root.render(h(Probe))), unmount: () => act(() => root.unmount()) };
}
/** Starts a run and records what the caller receives, so a test can tell "not yet" from "undefined". */
function start(out, fn) {
  const seen = { settled: false, value: "unset" };
  let p;
  act(() => {
    p = out.current.run(fn).then((v) => ((seen.settled = true), (seen.value = v)));
  });
  return { seen, done: p };
}
const settle = async (fn) => { await act(async () => { await fn(); }); };

const advance = async (t, ms) => { await settle(() => t.mock.timers.tick(ms)); };

beforeEach((t) => {
  // MockTimers also replaces clearTimeout. React's own asynchronous act scheduling remains real.
  t.mock.timers.enable({ apis: ["setTimeout"] });
});
afterEach(async (t) => {
  try {
    for (const r of roots.splice(0)) await act(() => { try { r.unmount(); } catch {} });
  } finally {
    // Keep the fake clock active until unmount has cleared the hook's timers, including on assertion failure.
    t.mock.timers.reset();
  }
});

test("a single run resolves with its value and ends done", async () => {
  const m = mount();
  await m.render();
  const d = deferred();
  const r = start(m.out, () => d.promise);
  assert.equal(m.out.current.state.phase, "sending");
  assert.equal(m.out.current.busy, true);
  await settle(async () => { d.resolve("ok"); await r.done; });
  assert.equal(r.seen.value, "ok");
  assert.equal(m.out.current.state.phase, "done");
});

test("a failure keeps its typed code and resolves undefined", async () => {
  const m = mount();
  await m.render();
  const d = deferred();
  const r = start(m.out, () => d.promise);
  await settle(async () => { d.reject({ code: "signin_expired" }); await r.done; });
  assert.equal(r.seen.value, undefined);
  assert.deepEqual(m.out.current.state, { phase: "failed", code: "signin_expired" });
});

test("a superseded run's successful value is suppressed; the newer run wins", async () => {
  const m = mount();
  await m.render();
  const first = deferred();
  const second = deferred();
  const a = start(m.out, () => first.promise);
  const b = start(m.out, () => second.promise);
  await settle(async () => { first.resolve("old"); await a.done; });
  assert.equal(a.seen.value, undefined, "the old run must not hand its value to the caller");
  assert.equal(m.out.current.state.phase, "sending", "and must not move the state");
  await settle(async () => { second.resolve("new"); await b.done; });
  assert.equal(b.seen.value, "new");
  assert.equal(m.out.current.state.phase, "done");
});

test("a superseded run's failure neither moves the state nor throws", async () => {
  const m = mount();
  await m.render();
  const first = deferred();
  const second = deferred();
  const a = start(m.out, () => first.promise);
  const b = start(m.out, () => second.promise);
  await settle(async () => { first.reject({ code: "network" }); await a.done; });
  assert.equal(a.seen.value, undefined);
  assert.equal(m.out.current.state.phase, "sending");
  await settle(async () => { second.resolve(1); await b.done; });
  assert.equal(m.out.current.state.phase, "done");
});

test("reset suppresses the in-flight run's value and returns to idle", async (t) => {
  const m = mount();
  await m.render();
  const d = deferred();
  const r = start(m.out, () => d.promise);
  await act(() => m.out.current.reset());
  await advance(t, UNKNOWN + 20);
  assert.equal(m.out.current.state.phase, "idle");
  await settle(async () => { d.resolve("late"); await r.done; });
  assert.equal(r.seen.value, undefined);
  assert.equal(m.out.current.state.phase, "idle");
});

test("unmount invalidates the in-flight run: its value is suppressed and no timer fires", async (t) => {
  const m = mount();
  await m.render();
  const d = deferred();
  const r = start(m.out, () => d.promise);
  await m.unmount();
  d.resolve("after-unmount");
  await r.done;
  assert.equal(r.seen.value, undefined, "an unmounted screen's caller must not act on the answer");
  await advance(t, UNKNOWN + 20); // timers were cleared: nothing throws or updates
});

test("a late success after the unknown timeout is still returned and moves to done", async (t) => {
  const m = mount();
  await m.render();
  const d = deferred();
  const r = start(m.out, () => d.promise);
  await advance(t, SLOW - 1);
  assert.equal(m.out.current.state.phase, "sending");
  await advance(t, 1);
  assert.equal(m.out.current.state.phase, "slow");
  assert.equal(m.out.current.busy, true);
  await advance(t, UNKNOWN - SLOW - 1);
  assert.equal(m.out.current.state.phase, "slow");
  await advance(t, 1);
  assert.deepEqual(m.out.current.state, { phase: "unknown", code: "timeout" });
  assert.equal(m.out.current.busy, false);
  assert.equal(r.seen.settled, false, "unknown is not a fabricated request result");
  await settle(async () => { d.resolve("it did go through"); await r.done; });
  assert.equal(r.seen.value, "it did go through");
  assert.equal(m.out.current.state.phase, "done");
});

test("a late failure after the unknown timeout moves to failed with its code", async (t) => {
  const m = mount();
  await m.render();
  const d = deferred();
  const r = start(m.out, () => d.promise);
  await advance(t, UNKNOWN);
  assert.equal(m.out.current.state.phase, "unknown");
  await settle(async () => { d.reject({ code: "network" }); await r.done; });
  assert.equal(r.seen.value, undefined);
  assert.equal(m.out.current.state.phase, "failed");
});

test("the timers belong to the current run only", async (t) => {
  const m = mount();
  await m.render();
  const first = deferred();
  const second = deferred();
  const offset = Math.floor(SLOW / 2);
  const a = start(m.out, () => first.promise);
  await advance(t, offset);
  const b = start(m.out, () => second.promise);

  await advance(t, SLOW - offset); // old run's slow deadline, before the current run's deadline
  assert.equal(m.out.current.state.phase, "sending", "the old slow timer must not advance the new run");
  await settle(async () => { first.resolve("old"); await a.done; });
  assert.equal(a.seen.value, undefined);
  assert.equal(m.out.current.state.phase, "sending", "stale completion must not move state or clear the new timers");

  await advance(t, offset - 1);
  assert.equal(m.out.current.state.phase, "sending", "the current slow timer must not fire early");
  await advance(t, 1);
  assert.equal(m.out.current.state.phase, "slow", "the current slow timer must still fire on time");

  await advance(t, UNKNOWN - SLOW - offset); // old run's unknown deadline
  assert.equal(m.out.current.state.phase, "slow", "the old unknown timer must not advance the new run");
  await advance(t, offset - 1);
  assert.equal(m.out.current.state.phase, "slow", "the current unknown timer must not fire early");
  await advance(t, 1);
  assert.deepEqual(m.out.current.state, { phase: "unknown", code: "timeout" });
  assert.equal(b.seen.settled, false);

  await settle(async () => { second.resolve("new"); await b.done; });
  assert.equal(b.seen.value, "new");
  assert.equal(m.out.current.state.phase, "done");
  await advance(t, UNKNOWN);
  assert.equal(m.out.current.state.phase, "done", "completed state stays final after later clock advances");
});
