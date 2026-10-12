import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// useProgress lifecycle, under the real React hooks (react-dom/client on a bare container: the harness renders no
// DOM nodes). The screen pieces progress.tsx imports for its components (CSS module, Desk, announce) are stubbed;
// the hook under test is the real source. Timers are real but tiny: slowMs/unknownMs are passed in.

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

afterEach(async () => {
  for (const r of roots.splice(0)) await act(() => { try { r.unmount(); } catch {} });
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

test("reset suppresses the in-flight run's value and returns to idle", async () => {
  const m = mount();
  await m.render();
  const d = deferred();
  const r = start(m.out, () => d.promise);
  await act(() => m.out.current.reset());
  assert.equal(m.out.current.state.phase, "idle");
  await settle(async () => { d.resolve("late"); await r.done; });
  assert.equal(r.seen.value, undefined);
  assert.equal(m.out.current.state.phase, "idle");
});

test("unmount invalidates the in-flight run: its value is suppressed and no timer fires", async () => {
  const m = mount();
  await m.render();
  const d = deferred();
  const r = start(m.out, () => d.promise);
  await m.unmount();
  d.resolve("after-unmount");
  await r.done;
  assert.equal(r.seen.value, undefined, "an unmounted screen's caller must not act on the answer");
  await sleep(UNKNOWN + 20); // timers were cleared: nothing throws or updates
});

test("a late success after the unknown timeout is still returned and moves to done", async () => {
  const m = mount();
  await m.render();
  const d = deferred();
  const r = start(m.out, () => d.promise);
  await settle(() => sleep(SLOW + 10));
  assert.equal(m.out.current.state.phase, "slow");
  await settle(() => sleep(UNKNOWN));
  assert.deepEqual(m.out.current.state, { phase: "unknown", code: "timeout" });
  await settle(async () => { d.resolve("it did go through"); await r.done; });
  assert.equal(r.seen.value, "it did go through");
  assert.equal(m.out.current.state.phase, "done");
});

test("a late failure after the unknown timeout moves to failed with its code", async () => {
  const m = mount();
  await m.render();
  const d = deferred();
  const r = start(m.out, () => d.promise);
  await settle(() => sleep(UNKNOWN + 20));
  assert.equal(m.out.current.state.phase, "unknown");
  await settle(async () => { d.reject({ code: "network" }); await r.done; });
  assert.equal(r.seen.value, undefined);
  assert.equal(m.out.current.state.phase, "failed");
});

test("the timers belong to the current run only", async () => {
  const m = mount();
  await m.render();
  const first = deferred();
  const second = deferred();
  start(m.out, () => first.promise);
  await settle(() => sleep(SLOW / 2));
  start(m.out, () => second.promise);
  await settle(() => sleep(SLOW / 2 + 5)); // the first run's slow timer would have fired by now
  assert.equal(m.out.current.state.phase, "sending");
});
