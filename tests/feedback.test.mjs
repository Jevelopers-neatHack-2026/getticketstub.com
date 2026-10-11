import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { registerHooks } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Load the studio's sound engine outside the browser, against a fake Web Audio graph.
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && new URL(url).pathname.endsWith(".ts")) return {
      format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    };
    return nextLoad(url, context);
  },
});

const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {} });
const node = (extra = {}) => ({ connect: (n) => n, disconnect() {}, ...extra });
let sources = [];
let resumes = [];
class FakeAudioContext {
  static last = null;
  state = "suspended";
  currentTime = 0;
  sampleRate = 100;
  destination = node();
  constructor() { FakeAudioContext.last = this; }
  resume() { return new Promise((resolve) => resumes.push(() => { this.state = "running"; resolve(); })); }
  createGain() { return node({ gain: param() }); }
  createDynamicsCompressor() { return node({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }); }
  createConvolver() { return node(); }
  createBiquadFilter() { return node({ type: "", frequency: param(), Q: param() }); }
  createBuffer(channels, len) { const data = Array.from({ length: channels }, () => new Float32Array(len)); return { getChannelData: (c) => data[c] }; }
  createOscillator() { return this.#source({ type: "", frequency: param() }); }
  createBufferSource() { return this.#source({ buffer: null, loop: false }); }
  #source(extra) {
    const s = node({ started: false, stopped: false, start() { s.started = true; }, stop() { s.stopped = true; }, ...extra });
    sources.push(s);
    return s;
  }
}

const store = new Map();
globalThis.window = {
  AudioContext: FakeAudioContext,
  localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
  setInterval, clearInterval, setTimeout, clearTimeout,
};

const feedback = await import("../src/customer/studio/feedback.ts");
const { play, stopPrint } = feedback;

/** The printer's paper feed: a looping source that is started and never told to stop. */
const liveLoops = () => sources.filter((s) => s.loop && s.started && !s.stopped).length;
const flush = () => new Promise((r) => setImmediate(r));
async function resumeAll() {
  const pending = resumes;
  resumes = [];
  pending.forEach((r) => r());
  await flush();
}
function suspend() {
  if (FakeAudioContext.last) FakeAudioContext.last.state = "suspended";
}

afterEach(() => {
  stopPrint();
  sources = [];
  resumes = [];
});

test("a print started on a running context loops until stopPrint", async () => {
  play("print");
  await resumeAll();
  assert.equal(liveLoops(), 1);
  stopPrint();
  assert.equal(liveLoops(), 0);
});

test("stopPrint while resume is pending prevents the printer from starting later", async () => {
  suspend();
  play("print");
  assert.equal(resumes.length, 1, "play waits on resume()");
  stopPrint(); // the panel closed, or the request finished, before audio woke up
  await resumeAll();
  assert.equal(liveLoops(), 0);
  assert.equal(sources.filter((s) => s.started).length, 0, "not even the wake-up click plays");
});

test("a scheduled print cancelled during resume stays silent too", async () => {
  suspend();
  play("print", { schedule: [{ at: 0.1, dur: 0.2 }] });
  stopPrint();
  await resumeAll();
  assert.equal(liveLoops(), 0);
});

test("a newer print supersedes one still waiting on resume, leaving one loop", async () => {
  suspend();
  play("print");
  play("print");
  await resumeAll();
  assert.equal(liveLoops(), 1);
});

test("an older loop's safety cap does not cancel a newer print waiting on resume", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;
  window.setInterval = setInterval;
  window.clearInterval = clearInterval;
  try {
    play("print"); // context already running from earlier tests
    assert.equal(liveLoops(), 1);
    suspend();
    play("print");
    t.mock.timers.tick(8000); // the first loop's cap fires while the second waits
    assert.equal(liveLoops(), 0);
    await resumeAll();
    assert.equal(liveLoops(), 1, "the newer print still starts");
  } finally {
    stopPrint();
    t.mock.timers.reset();
    Object.assign(window, { setInterval, clearInterval, setTimeout, clearTimeout });
  }
});

test("one-shot cues still play after a cancelled print", async () => {
  suspend();
  play("print");
  stopPrint();
  play("done");
  await resumeAll();
  assert.equal(liveLoops(), 0);
  assert.ok(sources.some((s) => s.started), "the done cue sounds");
});

test("a persisted mute plays nothing, print included", async () => {
  store.set("ticketstub.muted", "1");
  const muted = await import("../src/customer/studio/feedback.ts?muted");
  try {
    assert.equal(muted.isMuted(), true);
    muted.play("print");
    muted.play("done");
    await resumeAll();
    assert.equal(sources.filter((s) => s.started).length, 0);
  } finally {
    muted.stopPrint();
    store.delete("ticketstub.muted");
  }
});

// The remix panel once started the printer loop and never stopped it. Anything that starts the
// printer must also stop it; the remix panel itself plays only one-shot cues.
const SRC = fileURLToPath(new URL("../src", import.meta.url));
const files = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
});

test("every component that starts the printer also stops it", () => {
  const starters = files(SRC).filter((f) => /play\(\s*"print"/.test(readFileSync(f, "utf8")));
  assert.ok(starters.length > 0);
  for (const f of starters) assert.match(readFileSync(f, "utf8"), /stopPrint\(/, `${f} starts the printer without stopping it`);
});

test("the remix panel plays one-shot cues, never the printer loop", () => {
  const remix = readFileSync(join(SRC, "customer/studio/editor/RemixSheet.tsx"), "utf8");
  assert.doesNotMatch(remix, /play\(\s*"print"/);
  assert.match(remix, /play\("remix"\)/);
});
