"use client";
// Sound + haptic feedback for the studio.
//
// The engine follows cuelume's approach (https://cuelume.dev, MIT, Copyright (c) 2026 Daniel Belyi):
// every layer swells in along a straight line and dies away exponentially, so nothing has a hard
// transient; tones are struck objects whose higher modes die first; knocks are sines struck sharp
// that drop to pitch in 18 ms; noise is always filtered, nothing is centred above 5 kHz; every cue
// rings faintly into one shared short room behind a limiter; each cue plays one voice at a time;
// frequent cues vary a little per strike and lighten when repeated fast. The recipes are ours: a
// paper desk palette (card, rubber, cork, foil) instead of cuelume's glass and wood.
//
// Pick a cue by its job, not its sound:
//   tap     paper button, tool        select  tab, tag, chip (alias: tick)
//   toggle  switch                    open / close  sheet, popover
//   drop    something set down        success  it worked (alias: done)
//   stamp   the main action           flick   foil / holo catching light
//   flip    a stub turning over       tear    the stub tearing off
//   pin     pinned to the wall        print   printer running (stopPrint ends it)
//
// Sound is ON by default; the muted flag persists in localStorage (guarded). The AudioContext is
// created lazily during a user activation, so nothing throws or queues before the first gesture.
import { useCallback, useSyncExternalStore } from "react";

export type Cue = "tap" | "select" | "tick" | "toggle" | "open" | "close" | "drop" | "success" | "done" | "stamp" | "flick" | "flip" | "tear" | "pin" | "print" | "remix";
export type Emphasis = "subtle" | "normal" | "strong";
export interface PlayOptions {
  emphasis?: Emphasis;
  /** select: a later option sits a little higher. toggle: "back" is switching off. */
  direction?: "forward" | "back";
  volume?: number;
  /** print: the feed bursts (seconds from now) the stub animates with, so the ticks match the paper. */
  schedule?: PrintBurst[];
  /** print: audition a printer voice instead of the device's chosen one. */
  voice?: PrintVoice;
}

/** One run of the paper feed: it starts at `at` and steps the paper through for `dur` seconds. */
export interface PrintBurst {
  at: number;
  dur: number;
}

const MUTE_KEY = "ticketstub.muted";

// ---------- muted state ----------
let muted: boolean = (() => {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
})();
const listeners = new Set<() => void>();

function setMutedState(m: boolean) {
  muted = m;
  try {
    window.localStorage.setItem(MUTE_KEY, m ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
  if (m) stopPrint();
  listeners.forEach((l) => l());
}

export function isMuted(): boolean {
  return muted;
}

export function useMuted(): [boolean, (m: boolean) => void] {
  const value = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => muted,
    () => false,
  );
  const set = useCallback((m: boolean) => setMutedState(m), []);
  return [value, set];
}

// ---------- recipes ----------
interface Base {
  attack: number;
  decay: number;
  peak: number;
  offset?: number;
  glideTo?: number;
  glideTime?: number;
  /** The lowest emphasis that plays this layer: "normal" layers are ornament subtle leaves out. */
  from?: Emphasis;
}
interface ToneLayer extends Base {
  kind: "tone";
  frequency: number;
}
interface NoiseLayer extends Base {
  kind: "noise";
  filter: BiquadFilterType;
  frequency: number;
  q?: number;
}
type Layer = ToneLayer | NoiseLayer;
interface Recipe {
  gain: number;
  layers: Layer[];
  vary?: { pitch: number; level: number };
  /** Room send against the default: results land a little further into the room. */
  room?: number;
}

/** Lowpass Q in dB for a flat corner. */
const FLAT = -3;
const LANDED = 2;

/** A small hollow body answering a tap: a sine struck sharp, dropping to pitch in 18 ms. */
const knock = (frequency: number, decay: number, peak: number, more: Partial<ToneLayer> = {}): ToneLayer => ({
  kind: "tone",
  frequency: frequency * 1.6,
  glideTo: frequency,
  glideTime: 0.018,
  attack: 0.001,
  decay,
  peak,
  ...more,
});

/** Free bar (foil, metal): modes at 1, 2.76, 5.40. Marimba bar: 1, 3.99. */
const BAR: [number, number][] = [
  [1, 1],
  [2.76, 0.3],
  [5.4, 0.1],
];
const MALLET: [number, number][] = [
  [1, 1],
  [3.99, 0.2],
];

/** A struck note: one sine per mode, each dying in proportion to 1/ratio, nothing above 5 kHz. */
function struck(frequency: number, decay: number, peak: number, material: [number, number][], more: Partial<ToneLayer> = {}): ToneLayer[] {
  return material
    .filter(([ratio]) => frequency * ratio <= 5000)
    .map(([ratio, level], mode) => ({
      kind: "tone" as const,
      frequency: frequency * ratio,
      attack: 0.003,
      decay: Math.max(0.015, decay / ratio),
      peak: peak * level,
      ...(mode > 0 && !more.from ? { from: "normal" as const } : {}),
      ...more,
    }));
}

/** Felt or rubber meeting the object: a few ms of low-passed noise at the material's hardness. */
const contact = (hardness: number, peak: number, more: Partial<NoiseLayer> = {}): NoiseLayer => ({
  kind: "noise",
  filter: "lowpass",
  frequency: hardness,
  q: FLAT,
  attack: 0.001,
  decay: 0.003,
  peak,
  ...more,
});

const noise = (filter: BiquadFilterType, frequency: number, attack: number, decay: number, peak: number, more: Partial<NoiseLayer> = {}): NoiseLayer => ({
  kind: "noise",
  filter,
  frequency,
  attack,
  decay,
  peak,
  ...more,
});

const RECIPES: Record<Exclude<Cue, "tick" | "done" | "tear" | "remix">, Recipe> = {
  /** Card stock pressed onto the desk: a soft contact, the board's knock, the paper's body. */
  tap: {
    gain: 0.4,
    layers: [
      contact(2400, 0.035),
      knock(240, 0.026, 0.03),
      noise("bandpass", 900, 0.002, 0.018, 0.035, { q: 1.2, from: "normal" }),
      knock(120, 0.04, 0.016, { from: "strong" }),
    ],
    vary: { pitch: 0.015, level: 0.12 },
  },
  /** A crisp detent over a small wooden knock: tabs, tags, picks. */
  select: {
    gain: 0.3,
    layers: [noise("bandpass", 2800, 0.001, 0.008, 0.14, { q: 2.2, from: "normal" }), knock(415, 0.016, 0.03), knock(208, 0.025, 0.025, { from: "strong" })],
    vary: { pitch: 0.01, level: 0.08 },
  },
  /** A paper slider snapping over. Switching off knocks upward. */
  toggle: {
    gain: 0.24,
    layers: [
      noise("bandpass", 1830, 0.001, 0.016, 0.11, { q: 1.6 }),
      knock(330, 0.03, 0.045),
      noise("bandpass", 3150, 0.001, 0.012, 0.07, { q: 1.6, from: "normal" }),
      knock(165, 0.03, 0.025, { from: "strong" }),
    ],
  },
  /** A sheet of paper drawn up: air rising with a light note inside it. */
  open: {
    gain: 0.32,
    layers: [
      noise("bandpass", 520, 0.05, 0.08, 0.15, { q: 1.3, glideTo: 1300, glideTime: 0.12 }),
      { kind: "tone", frequency: 587.33, attack: 0.05, decay: 0.12, peak: 0.012 },
      { kind: "tone", frequency: 1174.66, attack: 0.05, decay: 0.05, peak: 0.004, from: "normal" },
      noise("lowpass", 280, 0.04, 0.1, 0.08, { q: 0.7, from: "strong" }),
    ],
  },
  /** The sheet falling back: air falling over a damped low note. */
  close: {
    gain: 0.26,
    layers: [
      noise("bandpass", 1300, 0.02, 0.06, 0.2, { q: 1.4, glideTo: 520, glideTime: 0.07 }),
      { kind: "tone", frequency: 261.63, attack: 0.003, decay: 0.08, peak: 0.018 },
      noise("bandpass", 350, 0.001, 0.03, 0.16, { q: 2, from: "normal" }),
    ],
  },
  /** A card set down on paper: a soft thud, the board's knock, a breath of edge. */
  drop: {
    gain: 0.36,
    layers: [
      noise("lowpass", 700, 0.004, 0.06, 0.22, { q: FLAT }),
      knock(150, 0.05, 0.03),
      noise("bandpass", 1800, 0.002, 0.012, 0.035, { q: 1, from: "normal" }),
      knock(90, 0.07, 0.02, { from: "strong" }),
    ],
    vary: { pitch: 0.02, level: 0.12 },
  },
  /** One soft felt chord, C G E spread wide: it worked. */
  success: {
    gain: 0.56,
    layers: [contact(1500, 0.04), ...struck(523.25, 0.26, 0.022, MALLET), ...struck(783.99, 0.3, 0.02, MALLET), ...struck(1318.51, 0.24, 0.014, MALLET), ...struck(261.63, 0.36, 0.02, MALLET, { from: "strong" })],
    room: LANDED,
  },
  /** A rubber stamp: a linear 6 ms swell of rubber thump (never a click), the desk's low knock, then the stamp lifting off. */
  stamp: {
    gain: 0.42,
    layers: [
      noise("lowpass", 450, 0.006, 0.07, 0.3, { q: FLAT }),
      knock(110, 0.08, 0.05),
      noise("bandpass", 260, 0.003, 0.05, 0.16, { q: 1.5, from: "normal" }),
      noise("bandpass", 1600, 0.01, 0.03, 0.025, { q: 1, offset: 0.075, from: "normal" }),
      knock(70, 0.1, 0.03, { from: "strong" }),
    ],
    vary: { pitch: 0.02, level: 0.1 },
    room: 1.4,
  },
  /** Foil catching the light: a small metal bar struck very softly, with a breath of air. */
  flick: {
    gain: 0.4,
    layers: [
      contact(2500, 0.012),
      ...struck(1567.98, 0.22, 0.011, BAR),
      { kind: "tone", frequency: 1570.4, attack: 0.003, decay: 0.18, peak: 0.005 },
      noise("bandpass", 2200, 0.04, 0.14, 0.025, { q: 1.4, glideTo: 3400, glideTime: 0.18, from: "normal" }),
    ],
    vary: { pitch: 0.01, level: 0.1 },
    room: 1.5,
  },
  /** A stub turning over: air passing, then the card landing on its other face. */
  flip: {
    gain: 0.34,
    layers: [
      noise("bandpass", 450, 0.09, 0.1, 0.15, { q: 1.1, glideTo: 1200, glideTime: 0.18 }),
      knock(200, 0.03, 0.026, { offset: 0.2 }),
      noise("lowpass", 900, 0.003, 0.03, 0.09, { q: FLAT, offset: 0.2, from: "normal" }),
    ],
    vary: { pitch: 0.02, level: 0.1 },
  },
  /** A push pin: the steel head's tiny ring, then the press into cork. */
  pin: {
    gain: 0.42,
    layers: [...struck(2093, 0.05, 0.007, BAR), knock(170, 0.04, 0.04), noise("lowpass", 500, 0.003, 0.05, 0.18, { q: FLAT }), knock(95, 0.06, 0.02, { from: "strong" })],
    vary: { pitch: 0.015, level: 0.1 },
  },
  /** The printer waking: one soft motor click. The feed itself is the tick run in startPrint. */
  print: {
    gain: 0.18,
    layers: [knock(150, 0.03, 0.05), noise("lowpass", 900, 0.002, 0.03, 0.08, { q: FLAT })],
  },
};

/** Remix: a short shuffle and riffle, cards flicking off the thumb one after another, then squared up. */
function remixRecipe(): Recipe {
  const cards: Layer[] = [];
  const count = 9;
  for (let i = 0; i < count; i++) {
    const at = i * 0.032 + Math.random() * 0.006;
    cards.push(noise("bandpass", 1500 + Math.random() * 700, 0.002, 0.018, 0.05 * (0.7 + 0.3 * Math.sin((i / count) * Math.PI)), { q: 1.8, offset: at }));
    cards.push(knock(300 + Math.random() * 60, 0.012, 0.006, { offset: at }));
  }
  const end = count * 0.032 + 0.03;
  return {
    gain: 0.34,
    layers: [...cards, noise("lowpass", 700, 0.004, 0.06, 0.12, { q: FLAT, offset: end }), knock(170, 0.04, 0.03, { offset: end })],
    vary: { pitch: 0.03, level: 0.1 },
  };
}

/** The tear is built per play: a run of paper fibres giving way, over the sheet's body, then the release. */
function tearRecipe(): Recipe {
  const grains: Layer[] = [];
  const count = 14;
  for (let i = 0; i < count; i++) {
    grains.push(noise("bandpass", 1100 + Math.random() * 1300, 0.003, 0.012 + Math.random() * 0.008, 0.03 + (i / count) * 0.03, { q: 1.6, offset: i * 0.011 + Math.random() * 0.004 }));
  }
  return {
    gain: 0.42,
    layers: [
      ...grains,
      noise("bandpass", 600, 0.03, 0.14, 0.07, { q: 1, glideTo: 1400, glideTime: 0.16 }),
      noise("lowpass", 1200, 0.002, 0.04, 0.1, { q: FLAT, offset: 0.17 }),
      knock(180, 0.03, 0.02, { offset: 0.17 }),
    ],
    vary: { pitch: 0.03, level: 0.1 },
  };
}

const ALIAS: Partial<Record<Cue, Cue>> = { tick: "select", done: "success" };
const CADENCE = new Set<Cue>(["tap", "select", "toggle", "flick"]);

// ---------- engine ----------
let ctx: AudioContext | null = null;
let output: GainNode | null = null;
let room: AudioNode | null = null;
let noiseBuf: AudioBuffer | null = null;
const NOISE_SECONDS = 2;
const OUTPUT_GAIN = 4;
const ROOM_SEND = 0.08;

function userActive(): boolean {
  const ua = (navigator as Navigator & { userActivation?: { isActive: boolean; hasBeenActive: boolean } }).userActivation;
  return ua ? ua.isActive || ua.hasBeenActive : true;
}

/** A short, dense room: 8 ms to the nearest wall, 250 ms to silence, walls low-passed at 3.5 kHz. */
function buildRoom(c: AudioContext, out: AudioNode): AudioNode {
  const seconds = 0.25;
  const len = Math.max(1, Math.floor(seconds * c.sampleRate));
  const ir = c.createBuffer(2, len, c.sampleRate);
  const fall = (60 / 20) * Math.LN10;
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    let energy = 0;
    for (let i = 0; i < len; i++) {
      const t = i / c.sampleRate;
      d[i] = t < 0.008 ? 0 : (Math.random() * 2 - 1) * Math.exp((-fall * t) / seconds);
      energy += d[i] * d[i];
    }
    const scale = energy > 0 ? 1 / Math.sqrt(energy) : 0;
    for (let i = 0; i < len; i++) d[i] *= scale;
  }
  const conv = c.createConvolver();
  conv.normalize = false;
  conv.buffer = ir;
  const walls = c.createBiquadFilter();
  walls.type = "lowpass";
  walls.frequency.value = 3500;
  walls.Q.value = FLAT;
  walls.connect(conv).connect(out);
  return walls;
}

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (ctx) return ctx;
  if (!userActive()) return null;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
  } catch {
    return null;
  }
  output = ctx.createGain();
  output.gain.value = OUTPUT_GAIN;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -8;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.08;
  output.connect(limiter).connect(ctx.destination);
  room = buildRoom(ctx, output);
  const len = Math.floor(NOISE_SECONDS * ctx.sampleRate);
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return ctx;
}

/** Straight swell (heard from its first moment), exponential fall. */
function envelope(p: AudioParam, l: Layer, t: number) {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(l.peak, t + l.attack);
  p.exponentialRampToValueAtTime(0.0001, t + l.attack + l.decay);
}

function glide(p: AudioParam, l: Layer, t: number) {
  p.setValueAtTime(l.frequency, t);
  if (l.glideTo !== undefined) p.exponentialRampToValueAtTime(l.glideTo, t + (l.glideTime ?? l.attack + l.decay));
}

function renderLayer(c: AudioContext, dest: AudioNode, l: Layer, t: number) {
  const g = c.createGain();
  envelope(g.gain, l, t);
  const end = t + l.attack + l.decay + 0.05;
  if (l.kind === "tone") {
    const o = c.createOscillator();
    o.type = "sine";
    glide(o.frequency, l, t);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(end);
  } else {
    const src = c.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = l.filter;
    glide(f.frequency, l, t);
    if (l.q !== undefined) f.Q.value = l.q;
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * NOISE_SECONDS); // a different stretch of noise every time
    src.stop(end);
  }
}

const RANK: Record<Emphasis, number> = { subtle: 0, normal: 1, strong: 2 };
const EMPHASIS: Record<Emphasis, { level: number; length: number; bright: number; pitch: number }> = {
  subtle: { level: 0.8, length: 0.85, bright: 0.75, pitch: 1 },
  normal: { level: 1, length: 1, bright: 1, pitch: 1 },
  strong: { level: 1.08, length: 1.2, bright: 1.1, pitch: 0.98 },
};
const nudge = (amount: number) => 1 + (Math.random() * 2 - 1) * amount;
const voices = new Map<Cue, GainNode>();
const lastAt = new Map<Cue, number>();

/** Fast repeats (under 70 ms) play fully lightened; slower than 220 ms, not at all. */
function cadence(cue: Cue) {
  const now = performance.now();
  const since = now - (lastAt.get(cue) ?? -Infinity);
  lastAt.set(cue, now);
  if (!CADENCE.has(cue)) return { level: 1, length: 1, tail: 1 };
  const speed = Math.min(1, Math.max(0, (220 - since) / 150));
  return { level: 1 - 0.22 * speed, length: 1 - 0.25 * speed, tail: 1 - 0.8 * speed };
}

function render(c: AudioContext, cue: Cue, opts: PlayOptions) {
  const recipe = cue === "tear" ? tearRecipe() : cue === "remix" ? remixRecipe() : RECIPES[cue as keyof typeof RECIPES];
  if (!recipe) return;
  const now = c.currentTime + 0.004;
  const emphasis = opts.emphasis ?? "normal";
  const shape = EMPHASIS[emphasis];
  const cad = cadence(cue);
  const strike = recipe.vary ? { pitch: nudge(recipe.vary.pitch), force: nudge(recipe.vary.level) } : { pitch: 1, force: 1 };
  const dir = opts.direction === "back" ? -1 : opts.direction === "forward" ? 1 : 0;
  const pitch = shape.pitch * strike.pitch * (cue === "select" ? 1 + 0.05 * dir : 1);

  const master = c.createGain();
  master.gain.value = recipe.gain * (opts.volume ?? 1);
  master.connect(output!);
  const send = c.createGain();
  send.gain.value = ROOM_SEND * (recipe.room ?? 1);
  master.connect(send).connect(room!);

  // one voice per cue: a new play releases the last instead of stacking on it
  const last = voices.get(cue);
  if (last) {
    last.gain.setValueAtTime(last.gain.value, now);
    last.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
  }
  voices.set(cue, master);

  let end = 0;
  for (const base of recipe.layers) {
    if (RANK[emphasis] < RANK[base.from ?? "subtle"]) continue;
    const bright = base.frequency >= 2500 ? shape.bright : 1;
    const tail = (base.offset ?? 0) > 0 ? cad.tail : 1;
    const tune = base.kind === "tone" && recipe.vary ? nudge(0.005) : base.kind === "noise" ? strike.force : 1;
    let l: Layer = {
      ...base,
      frequency: base.frequency * pitch * tune,
      glideTo: base.glideTo !== undefined ? base.glideTo * pitch * tune : undefined,
      peak: base.peak * shape.level * strike.force * cad.level * bright * tail,
      decay: base.decay * shape.length * cad.length * (recipe.vary ? nudge(0.1) : 1),
    };
    // switching off: the knock rises instead of falling
    if (cue === "toggle" && dir < 0 && l.glideTo !== undefined) l = { ...l, frequency: l.glideTo, glideTo: l.frequency };
    const t = now + (l.offset ?? 0);
    renderLayer(c, master, l, t);
    end = Math.max(end, (l.offset ?? 0) + l.attack + l.decay + 0.1);
  }
  setTimeout(() => {
    if (voices.get(cue) === master) voices.delete(cue);
    master.disconnect();
    send.disconnect();
  }, end * 1000);
}

// ---------- printer: a thermal head feeding the paper through ----------
// Never a drone: the printer only sounds while paper moves, in runs (one per printed band) with rests
// between. Three voices to audition on /parts; the choice is kept per device.
//   chatter  a receipt printer: each printed line is a short buzzy "zzt" from the stepper, ~14 lines a second
//   ticks    a quiet head stepping: tiny dry ticks, ~38 a second
//   roller   the softest: paper sliding over a rubber roller, no tone at all, a click at each start and stop
export type PrintVoice = "chatter" | "ticks" | "roller";
export const PRINT_VOICES: PrintVoice[] = ["chatter", "ticks", "roller"];
const VOICE_KEY = "ticketstub.printVoice";
let printNodes: { gain: GainNode; stop: (t: number) => void } | null = null;
/** Bumped by every print request and every stopPrint, so a print still waiting on resume() can tell it was cancelled. */
let printGen = 0;
const PRINT_LEVEL = 0.035;
/** An unscheduled print (no feed schedule given) stops itself after this long, whatever happens. */
const PRINT_MAX_S = 8;

export function getPrintVoice(): PrintVoice {
  try {
    const v = window.localStorage.getItem(VOICE_KEY) as PrintVoice | null;
    return v && PRINT_VOICES.includes(v) ? v : "chatter";
  } catch {
    return "chatter";
  }
}
export function setPrintVoice(v: PrintVoice): void {
  try {
    window.localStorage.setItem(VOICE_KEY, v);
  } catch {
    /* per-device preference only */
  }
}

function startPrint(c: AudioContext, schedule?: PrintBurst[], voiceOpt?: PrintVoice) {
  if (printNodes) stopPrint();
  const voice = voiceOpt ?? getPrintVoice();
  const t0 = c.currentTime;
  const gain = c.createGain();
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(PRINT_LEVEL, t0 + 0.08);
  gain.connect(output!);
  const send = c.createGain();
  send.gain.value = ROOM_SEND * 0.6;
  gain.connect(send).connect(room!);

  // the paper: quiet band-limited noise, only while a run is feeding
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const f = c.createBiquadFilter();
  f.type = voice === "roller" ? "lowpass" : "bandpass";
  f.frequency.value = voice === "roller" ? 900 : 2200;
  f.Q.value = voice === "roller" ? FLAT : 0.7;
  const paper = c.createGain();
  paper.gain.value = 0;
  src.connect(f).connect(paper).connect(gain);
  src.start(t0, Math.random() * NOISE_SECONDS);
  const paperLevel = voice === "roller" ? 0.22 : voice === "chatter" ? 0.05 : 0.06;

  const tick = (t: number, force: number) => {
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.5 * force, t + 0.0015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
    const n = c.createBufferSource();
    n.buffer = noiseBuf;
    const bp = c.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1700 + Math.random() * 900;
    bp.Q.value = 2.2;
    n.connect(bp).connect(g).connect(gain);
    n.start(t, Math.random() * NOISE_SECONDS);
    n.stop(t + 0.02);
  };
  const knockAt = (t: number, freq: number, peak: number) => {
    const k = c.createOscillator();
    k.frequency.setValueAtTime(freq * 1.6, t);
    k.frequency.exponentialRampToValueAtTime(freq, t + 0.018);
    const kg = c.createGain();
    kg.gain.setValueAtTime(0, t);
    kg.gain.linearRampToValueAtTime(peak, t + 0.002);
    kg.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    k.connect(kg).connect(gain);
    k.start(t);
    k.stop(t + 0.06);
  };
  // one printed line: the stepper's short buzz, softened through a band so it is grain, not a whine
  const line = (t: number, force: number) => {
    const len = 0.034 + Math.random() * 0.01;
    const o = c.createOscillator();
    o.type = "square";
    o.frequency.setValueAtTime(430 + Math.random() * 60, t);
    const bp = c.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1300;
    bp.Q.value = 0.9;
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 3200;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.09 * force, t + 0.004);
    g.gain.setValueAtTime(0.09 * force, t + len - 0.008);
    g.gain.linearRampToValueAtTime(0, t + len);
    o.connect(bp).connect(lp).connect(g).connect(gain);
    o.start(t);
    o.stop(t + len + 0.01);
    tick(t, 0.5 * force);
  };

  const run = (at: number, dur: number) => {
    paper.gain.setValueAtTime(0, at);
    paper.gain.linearRampToValueAtTime(paperLevel, at + 0.04);
    paper.gain.setValueAtTime(paperLevel, at + dur);
    paper.gain.linearRampToValueAtTime(0, at + dur + 0.05);
    if (voice === "roller") {
      knockAt(at, 210, 0.05);
      knockAt(at + dur, 160, 0.04);
      return;
    }
    const every = voice === "chatter" ? 1 / 14 : 1 / 38;
    for (let t = at; t < at + dur; t += every * (0.94 + Math.random() * 0.12)) {
      if (voice === "chatter") line(t, 0.8 + Math.random() * 0.2);
      else tick(t, 0.75 + Math.random() * 0.25);
    }
  };

  // Given the stub's own feed bursts, sound exactly with the paper. Otherwise feed in loose runs
  // (0.25-0.7 s, then a 0.12-0.4 s rest) until stopPrint, and never longer than PRINT_MAX_S.
  let timer = 0;
  let cap = 0;
  if (schedule?.length) {
    for (const b of schedule) run(t0 + b.at, b.dur);
  } else {
    let next = t0 + 0.06;
    timer = window.setInterval(() => {
      const horizon = c.currentTime + 0.25;
      while (next < horizon) {
        const dur = 0.25 + Math.random() * 0.45;
        run(next, dur);
        next += dur + 0.12 + Math.random() * 0.28;
      }
    }, 60);
    cap = window.setTimeout(stopPrint, PRINT_MAX_S * 1000);
  }

  printNodes = {
    gain,
    stop: (at) => {
      window.clearInterval(timer);
      window.clearTimeout(cap);
      try {
        src.stop(at);
      } catch {
        /* already stopped */
      }
      window.setTimeout(() => {
        gain.disconnect();
        send.disconnect();
      }, Math.max(0, (at - c.currentTime) * 1000 + 100));
    },
  };
}

/** Fade the printer out (no-op when not printing). */
export function stopPrint(): void {
  printGen++;
  try {
    if (!ctx || !printNodes) return;
    const t = ctx.currentTime;
    const { gain, stop } = printNodes;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    stop(t + 0.5);
    printNodes = null;
  } catch {
    printNodes = null;
  }
}

/** Play a cue. Safe anywhere, any time: silently does nothing before a gesture or when muted. */
export function play(cue: Cue, opts: PlayOptions = {}): void {
  if (muted || typeof window === "undefined") return;
  const name = ALIAS[cue] ?? cue;
  try {
    const c = getCtx();
    if (!c) return;
    // A print stopped (or replaced) while the context was still resuming must not start late.
    const gen = name === "print" ? ++printGen : 0;
    const go = () => {
      if (muted || c.state !== "running") return;
      if (name === "print" && gen !== printGen) return;
      render(c, name, opts);
      if (name === "print") startPrint(c, opts.schedule, opts.voice);
    };
    if (c.state === "running") go();
    else if (userActive()) c.resume().then(go, () => {});
  } catch {
    /* audio unavailable */
  }
}

/** navigator.vibrate where supported (Android). iOS Safari has none; the sound carries the feedback. */
export function haptic(pattern: number | number[]): void {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(pattern);
  } catch {
    /* not allowed (no gesture yet) */
  }
}
