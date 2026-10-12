// Runtime for SVG stub templates (see contract.ts). Browser only: it needs the DOM to parse the
// template and to measure text.
//
//   const svg = prepareStub(templateText, data, { uid: "s1", mode: "screen" });
//   host.replaceChildren(svg);
//   await layoutStub(svg); // after mount: fonts load, then text fits and wraps
//
// prepare: namespace ids, fill slots, generate barcode/QR, paint foil + holo for the mode.
// layout: fit and wrap text (needs real glyph metrics, so it runs once the node is in the page).
import type { Metal, SlotKey, StubData } from "./contract";
import { hashSeed, rng } from "../rng";

const SVG_NS = "http://www.w3.org/2000/svg";
export type StubMode = "screen" | "print";

export interface PrepareOptions {
  uid: string; // unique per stub on the page
  mode?: StubMode;
}

/* ---------------------------------------------------------------- slot values */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n: number) => String(n).padStart(2, "0");

export function slotValues(d: StubData): Record<SlotKey, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(d)) if (typeof v === "string") out[k] = v;
  const people = d.people ?? [];
  people.slice(0, 5).forEach((p, i) => (out[`people${i + 1}`] = p));
  out.peopleAll = people.join(", ");
  if (d.dateISO) {
    const [y, m, day] = d.dateISO.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, day));
    const mon = MONTHS[m - 1];
    out.date = `${day} ${mon.slice(0, 3).toUpperCase()} ${y}`;
    out.dateLong = `${DAYS[dt.getUTCDay()]}, ${mon} ${day}, ${y}`;
    out.dateDots = `${y}.${pad(m)}.${pad(day)}`;
    out.dateShort = `${pad(day)}.${pad(m)}.${String(y).slice(2)}`;
    out.day = pad(day);
    out.month = mon.slice(0, 3).toUpperCase();
    out.monthLong = mon;
    out.year = String(y);
    out.weekday = DAYS[dt.getUTCDay()].slice(0, 3).toUpperCase();
  }
  out.place = [d.venue, d.city].filter(Boolean).join(", ");
  out.seatLine = [d.section && `SEC ${d.section}`, d.row && `ROW ${d.row}`, d.seat && `SEAT ${d.seat}`].filter(Boolean).join(" · ");
  out.categoryLabel = d.category.toUpperCase();
  out.serial = d.serial ?? String(100000000 + (hashSeed(d.title + (d.dateISO ?? "")) % 899999999));
  out.edition = d.edition ?? `No. ${out.serial.slice(-4)}`;
  // presence flags for data-show-if / data-hide-if (not printable text)
  out.art = d.art?.src ? "1" : "";
  out.art2 = d.art2?.src ? "1" : "";
  return out as Record<SlotKey, string>;
}

/* ---------------------------------------------------------------- metals */

const METAL_STOPS: Record<Exclude<Metal, "ink">, string[]> = {
  gold: ["#8a6a2e", "#c9a24f", "#f8eab6", "#c39445", "#9c7633", "#e6c77c", "#fff7da", "#b08238"],
  copper: ["#7e4326", "#b4693e", "#f4c19a", "#a2582f", "#8a4524", "#d58a5a", "#ffe0c6", "#a65c34"],
  silver: ["#7d828a", "#b7bcc4", "#f6f8fa", "#9ca2aa", "#8a9098", "#d9dde2", "#ffffff", "#a7adb5"],
  red: ["#7a0e10", "#b3161b", "#ff7a6b", "#9a1216", "#850d10", "#d8312c", "#ffb0a2", "#a8171b"],
  rose: ["#8f5c59", "#c98f88", "#f9ddd5", "#b37870", "#9c6762", "#e3b2a8", "#fff3ee", "#b98680"],
};
/** The colour light catches on each metal (the sheen and tilt lift): white on red foil reads pink. */
const METAL_GLINT: Record<Exclude<Metal, "ink">, string> = { gold: "#fff1c2", copper: "#ffd6b8", silver: "#ffffff", red: "#ff4d55", rose: "#ffe4dc" };
const METAL_FLAT: Record<Metal, string> = { gold: "#b8914a", copper: "#b4693e", silver: "#9aa0a8", red: "#b3161b", rose: "#c98f88", ink: "#17140f" };

const HOLO_STOPS: Record<string, string[]> = {
  pastel: ["#ffb3dc", "#c3b5ff", "#9fe2ff", "#b9ffd9", "#fff6a8", "#ffc8a8", "#ffb3dc"],
  deep: ["#1b2a8f", "#2f7bff", "#19d3c5", "#9cff57", "#ffd23f", "#ff7a1a", "#e2205b", "#5b1fb5", "#1b2a8f"],
  silver: ["#d9dee6", "#f6d5e6", "#d4f1f6", "#eef7d2", "#f8e6cf", "#e2d9f7", "#d9dee6"],
};

/* ---------------------------------------------------------------- helpers */

const el = <K extends keyof SVGElementTagNameMap>(doc: Document, tag: K, attrs: Record<string, string | number> = {}) => {
  const n = doc.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

function gradient(doc: Document, id: string, stops: string[], attrs: Record<string, string | number>) {
  const g = el(doc, "linearGradient", { id, ...attrs });
  stops.forEach((c, i) => g.appendChild(el(doc, "stop", { offset: (i / (stops.length - 1)).toFixed(3), "stop-color": c })));
  return g;
}

/** Prefix every id and every #id reference so stubs can share a page. */
function namespaceIds(root: SVGSVGElement, uid: string) {
  const ids = new Set<string>();
  root.querySelectorAll("[id]").forEach((n) => {
    ids.add(n.id);
    n.id = `${uid}-${n.id}`;
  });
  if (!ids.size) return;
  const re = /url\(\s*#([^)\s]+)\s*\)/g;
  root.querySelectorAll("*").forEach((n) => {
    for (const a of Array.from(n.attributes)) {
      if ((a.name === "href" || a.name === "xlink:href") && a.value.startsWith("#") && ids.has(a.value.slice(1))) {
        n.setAttribute(a.name, `#${uid}-${a.value.slice(1)}`);
      } else if (a.value.includes("url(")) {
        n.setAttribute(a.name, a.value.replace(re, (m, id) => (ids.has(id) ? `url(#${uid}-${id})` : m)));
      }
    }
  });
}

/** Shared defs every template may reference: #ts-grain (dark specks), #ts-grain-light, #ts-fibre. */
function sharedDefs(doc: Document): SVGDefsElement {
  const defs = el(doc, "defs");
  defs.innerHTML = `
    <filter id="ts-grain" x="0" y="0" width="1" height="1" filterUnits="objectBoundingBox">
      <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" result="n"/>
      <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1.6 0 0 0 -0.62"/>
      <feComposite in2="SourceGraphic" operator="in"/>
    </filter>
    <filter id="ts-grain-light" x="0" y="0" width="1" height="1" filterUnits="objectBoundingBox">
      <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="11" result="n"/>
      <feColorMatrix in="n" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  1.6 0 0 0 -0.62"/>
      <feComposite in2="SourceGraphic" operator="in"/>
    </filter>
    <filter id="ts-fibre" x="0" y="0" width="1" height="1" filterUnits="objectBoundingBox">
      <feTurbulence type="fractalNoise" baseFrequency="0.012 0.5" numOctaves="3" seed="3" result="n"/>
      <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0.9 0 0 0 -0.38"/>
      <feComposite in2="SourceGraphic" operator="in"/>
    </filter>`;
  return defs;
}

/* ---------------------------------------------------------------- barcode / QR */

function drawBarcode(doc: Document, g: Element, serial: string) {
  const w = Number(g.getAttribute("data-w") ?? 200);
  const h = Number(g.getAttribute("data-h") ?? 40);
  const color = g.getAttribute("data-color") ?? "currentColor";
  const r = rng(hashSeed(serial));
  const widths: number[] = [];
  // guard bars, then serial-seeded bar/space runs, then guard
  const pushRun = (n: number) => widths.push(n);
  [1, 1, 1].forEach(pushRun);
  while (widths.reduce((a, b) => a + b, 0) < 92) pushRun(1 + Math.floor(r() * 3.2));
  [1, 1, 1].forEach(pushRun);
  const total = widths.reduce((a, b) => a + b, 0);
  const unit = w / total;
  let x = 0;
  widths.forEach((wd, i) => {
    if (i % 2 === 0) g.appendChild(el(doc, "rect", { x: (x * unit).toFixed(2), y: 0, width: (wd * unit * 0.92).toFixed(2), height: h, fill: color }));
    x += wd;
  });
}

function drawQr(doc: Document, g: Element, serial: string) {
  const size = Number(g.getAttribute("data-size") ?? 80);
  const color = g.getAttribute("data-color") ?? "currentColor";
  const N = 25;
  const m = size / N;
  const r = rng(hashSeed(`qr:${serial}`));
  const finder = (x: number, y: number) => x >= 0 && x < 7 && y >= 0 && y < 7;
  const isFinderArea = (x: number, y: number) => (x < 8 && y < 8) || (x > N - 9 && y < 8) || (x < 8 && y > N - 9);
  let d = "";
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      if (isFinderArea(x, y)) continue;
      if ((x === 6 || y === 6) ? (x + y) % 2 === 0 : r() < 0.48) d += `M${x * m} ${y * m}h${m}v${m}h${-m}z`;
    }
  for (const [ox, oy] of [[0, 0], [N - 7, 0], [0, N - 7]]) {
    for (let y = 0; y < 7; y++)
      for (let x = 0; x < 7; x++) {
        const ring = x === 0 || y === 0 || x === 6 || y === 6;
        const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        if (finder(x, y) && (ring || core)) d += `M${(ox + x) * m} ${(oy + y) * m}h${m}v${m}h${-m}z`;
      }
  }
  g.appendChild(el(doc, "path", { d, fill: color }));
}

/* ---------------------------------------------------------------- finishes */

function paintFoil(doc: Document, root: SVGSVGElement, defs: SVGDefsElement, uid: string, mode: StubMode, W: number, H: number) {
  const metal = (root.getAttribute("data-foil") ?? "gold") as Metal;
  const layers = Array.from(root.querySelectorAll('[data-layer="foil"]'));
  if (!layers.length || metal === "ink") return;
  let paint = METAL_FLAT[metal];
  if (mode === "screen") {
    // one continuous metal across the stub, so a foil line reads as one sheet of foil
    defs.appendChild(gradient(doc, `${uid}-metal`, METAL_STOPS[metal], { gradientUnits: "userSpaceOnUse", x1: 0, y1: 0, x2: 70, y2: 300, spreadMethod: "reflect" }));
    // sheen: a soft wide glow with a brighter core, as a diagonal band (centred at x = W/2 before the light moves it)
    const sheen = el(doc, "linearGradient", { id: `${uid}-sheen`, gradientUnits: "userSpaceOnUse", x1: W / 2 - 160, y1: H / 2 - 40, x2: W / 2 + 160, y2: H / 2 + 40 });
    [[0, 0], [0.22, 0.18], [0.42, 0.7], [0.5, 1], [0.58, 0.7], [0.78, 0.18], [1, 0]].forEach(([o, a]) =>
      sheen.appendChild(el(doc, "stop", { offset: o, "stop-color": METAL_GLINT[metal as Exclude<Metal, "ink">], "stop-opacity": a })),
    );
    defs.appendChild(sheen);
    paint = `url(#${uid}-metal)`;
  }
  layers.forEach((layer, i) => {
    const repaint = (n: Element) => {
      if (n.closest("[data-ink]")) return; // flat ink inside a foil group (labels and the like)
      for (const prop of ["fill", "stroke"]) {
        const v = n.getAttribute(prop);
        if (v && v !== "none") n.setAttribute(prop, paint);
      }
    };
    repaint(layer);
    layer.querySelectorAll("*").forEach(repaint);
    if (!layer.hasAttribute("fill") && !layer.querySelector("[fill]")) layer.setAttribute("fill", paint);
    if (mode !== "screen") return;
    // sheen: a bright band, masked to the foil shapes, that travels with the light (--lx from useTilt).
    // The mask is filled by syncFoilMasks after layout, once the text has its final size.
    layer.setAttribute("data-foil-mask", `${uid}-foilmask${i}`);
    defs.appendChild(el(doc, "mask", { id: `${uid}-foilmask${i}`, maskUnits: "userSpaceOnUse", x: 0, y: 0, width: W, height: H }));
    const g = el(doc, "g", { mask: `url(#${uid}-foilmask${i})`, "data-finish": "sheen", "pointer-events": "none" });
    const band = el(doc, "rect", { x: -W, y: -H * 0.2, width: W * 3, height: H * 1.4, fill: `url(#${uid}-sheen)` });
    // light at 50% puts the band mid-stub; 0..100% sweeps it edge to edge. Quiet at rest, bright when tilted.
    band.setAttribute("style", "transform: translate(calc((var(--lx, 38%) - 50%) * 1.1), calc((var(--ly, 30%) - 50%) * 0.5)); mix-blend-mode: screen; opacity: calc(0.12 + var(--glow, 0.1) * 0.8)");
    // and a broad lift: all foil catches more light as the stub tilts, wherever the band is
    const lift = el(doc, "rect", { x: 0, y: 0, width: W, height: H, fill: METAL_GLINT[metal as Exclude<Metal, "ink">] });
    lift.setAttribute("style", "mix-blend-mode: soft-light; opacity: calc(var(--glow, 0.1) * 0.35)");
    g.append(lift, band);
    layer.after(g);
  });
}

function paintHolo(doc: Document, root: SVGSVGElement, defs: SVGDefsElement, uid: string, mode: StubMode, W: number, H: number) {
  const layers = Array.from(root.querySelectorAll('[data-layer="holo"]'));
  if (!layers.length) return;
  const style = root.getAttribute("data-holo") ?? "pastel";
  const stops = HOLO_STOPS[style] ?? HOLO_STOPS.pastel;
  const span = Math.max(W, H);
  defs.appendChild(gradient(doc, `${uid}-spectrum`, stops, { gradientUnits: "userSpaceOnUse", x1: 0, y1: 0, x2: span * 0.9, y2: span * 0.5, spreadMethod: "reflect" }));
  if (mode === "screen") {
    defs.insertAdjacentHTML(
      "beforeend",
      `<filter id="${uid}-oil" x="-10%" y="-10%" width="120%" height="120%" filterUnits="objectBoundingBox">
         <feTurbulence type="fractalNoise" baseFrequency="${(2.2 / span).toFixed(5)}" numOctaves="3" seed="${hashSeed(uid) % 97}" result="t"/>
         <feDisplacementMap in="SourceGraphic" in2="t" scale="${(span * 0.45).toFixed(0)}" xChannelSelector="R" yChannelSelector="G"/>
       </filter>
       <filter id="${uid}-flake" x="0" y="0" width="1" height="1" filterUnits="objectBoundingBox">
         <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="1" seed="5" result="n"/>
         <feColorMatrix in="n" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  3.4 0 0 0 -2.15"/>
         <feComposite in2="SourceGraphic" operator="in"/>
       </filter>
       <linearGradient id="${uid}-holosheen" gradientUnits="userSpaceOnUse" x1="${W / 2 - 160}" y1="${H / 2 - 40}" x2="${W / 2 + 160}" y2="${H / 2 + 40}">
         <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.4" stop-color="#fff" stop-opacity="0.55"/><stop offset="0.5" stop-color="#fff" stop-opacity="1"/><stop offset="0.6" stop-color="#fff" stop-opacity="0.55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
       </linearGradient>
       <radialGradient id="${uid}-hotspot" gradientUnits="objectBoundingBox" cx="0.5" cy="0.5" r="0.5">
         <stop offset="0" stop-color="#fff" stop-opacity="0.75"/><stop offset="0.45" stop-color="#fff" stop-opacity="0.18"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
       </radialGradient>`,
    );
  }
  layers.forEach((layer, i) => {
    const mask = el(doc, "mask", { id: `${uid}-holomask${i}`, maskUnits: "userSpaceOnUse", x: 0, y: 0, width: W, height: H });
    while (layer.firstChild) mask.appendChild(layer.firstChild);
    defs.appendChild(mask);
    const g = el(doc, "g", { mask: `url(#${uid}-holomask${i})`, "pointer-events": "none" });
    if (mode === "screen") {
      const film = el(doc, "rect", { x: -W * 1.5, y: -H * 1.5, width: W * 4, height: H * 4, fill: `url(#${uid}-spectrum)`, filter: `url(#${uid}-oil)` });
      film.setAttribute("style", "transform: translate(calc((var(--lx, 38%) - 50%) * -1.6), calc((var(--ly, 30%) - 50%) * -1.1))");
      const flake = el(doc, "rect", { x: 0, y: 0, width: W, height: H, fill: "#fff", filter: `url(#${uid}-flake)` });
      flake.setAttribute("style", "mix-blend-mode: screen; opacity: calc(0.22 + var(--glow, 0.1) * 0.5)");
      const hot = el(doc, "rect", { x: -W * 0.45, y: -H * 0.45, width: W * 0.9, height: H * 0.9, fill: `url(#${uid}-hotspot)` });
      // deep film washes out under a strong white pool, so it gets a quieter hotspot
      const hotRest = style === "deep" ? "0.12 + var(--glow, 0.1) * 0.4" : "0.35 + var(--glow, 0.1) * 0.65";
      hot.setAttribute("style", `transform: translate(var(--lx, 38%), var(--ly, 30%)); mix-blend-mode: soft-light; opacity: calc(${hotRest})`);
      // a bright band that sweeps with the light, like the foil sheen
      const band = el(doc, "rect", { x: -W, y: -H * 0.2, width: W * 3, height: H * 1.4, fill: `url(#${uid}-holosheen)` });
      band.setAttribute("style", "transform: translate(calc((var(--lx, 38%) - 50%) * 1.1), calc((var(--ly, 30%) - 50%) * 0.5)); mix-blend-mode: soft-light; opacity: calc(0.1 + var(--glow, 0.1) * 0.85)");
      g.append(film, flake, hot, band);
    } else {
      // holo is a screen-only finish: in print the film area is plain pearl stock
      g.appendChild(el(doc, "rect", { x: 0, y: 0, width: W, height: H, fill: root.getAttribute("data-holo-print") ?? "#ece8e1" }));
    }
    layer.appendChild(g);
  });
}

/* ---------------------------------------------------------------- prepare */

export function prepareStub(templateText: string, data: StubData, opts: PrepareOptions): SVGSVGElement {
  const mode = opts.mode ?? "screen";
  const parsed = new DOMParser().parseFromString(templateText, "image/svg+xml");
  const err = parsed.querySelector("parsererror");
  if (err) throw new Error(`stub template does not parse: ${err.textContent?.slice(0, 200)}`);
  const root = document.importNode(parsed.documentElement, true) as unknown as SVGSVGElement;
  const doc = document;
  const [, , W, H] = (root.getAttribute("viewBox") ?? "0 0 400 1100").split(/[\s,]+/).map(Number);

  const values = slotValues(data);
  const defs = sharedDefs(doc);
  root.insertBefore(defs, root.firstChild);

  // text slots
  root.querySelectorAll("text[data-slot], tspan[data-slot]").forEach((n) => {
    const key = n.getAttribute("data-slot") as SlotKey;
    let v = values[key] || n.getAttribute("data-default") || "";
    if (!v) {
      n.setAttribute("display", "none");
      return;
    }
    const cs = n.getAttribute("data-case");
    if (cs === "upper") v = v.toUpperCase();
    if (cs === "lower") v = v.toLowerCase();
    n.textContent = `${n.getAttribute("data-prefix") ?? ""}${v}${n.getAttribute("data-suffix") ?? ""}`;
  });
  // conditional groups: data-show-if="seat row" hides unless every listed slot has a value
  root.querySelectorAll("[data-show-if]").forEach((n) => {
    const keys = (n.getAttribute("data-show-if") ?? "").split(/\s+/).filter(Boolean) as SlotKey[];
    if (keys.some((k) => !values[k])) n.setAttribute("display", "none");
  });
  // data-hide-if="seat": the inverse — hidden when any listed slot HAS a value (for fallback layouts)
  root.querySelectorAll("[data-hide-if]").forEach((n) => {
    const keys = (n.getAttribute("data-hide-if") ?? "").split(/\s+/).filter(Boolean) as SlotKey[];
    if (keys.some((k) => values[k])) n.setAttribute("display", "none");
  });
  // images
  root.querySelectorAll("image[data-slot]").forEach((n) => {
    const key = n.getAttribute("data-slot") as "art" | "art2";
    const src = data[key]?.src;
    if (src) n.setAttribute("href", src);
    else if (!n.getAttribute("href")) n.setAttribute("display", "none");
  });
  root.querySelectorAll('[data-slot="barcode"]').forEach((g) => drawBarcode(doc, g, values.serial));
  root.querySelectorAll('[data-slot="qr"]').forEach((g) => drawQr(doc, g, values.serial));

  namespaceIds(root, opts.uid);
  paintHolo(doc, root, defs, opts.uid, mode, W, H);
  paintFoil(doc, root, defs, opts.uid, mode, W, H);

  // dieline clips everything; it is not drawn on screen
  const die = root.querySelector('[data-layer="dieline"]') as SVGElement | null;
  if (die) {
    const shape = (die.tagName.toLowerCase() === "g" ? die.querySelector("path,rect") : die) as SVGElement | null;
    if (shape) {
      const clip = el(doc, "clipPath", { id: `${opts.uid}-die` });
      const c = shape.cloneNode(true) as SVGElement;
      c.removeAttribute("data-layer");
      clip.appendChild(c);
      defs.appendChild(clip);
      const body = el(doc, "g", { "clip-path": `url(#${opts.uid}-die)` });
      Array.from(root.childNodes).forEach((n) => {
        if (n !== defs && n !== die) body.appendChild(n);
      });
      root.appendChild(body);
    }
    die.setAttribute("display", "none");
  }

  // data-screen-only: decoration that simulates a finish (extra sheen, film texture) is dropped in print
  if (mode === "print") root.querySelectorAll("[data-screen-only]").forEach((n) => n.remove());
  root.setAttribute("data-mode", mode);
  root.removeAttribute("width");
  root.removeAttribute("height");
  root.setAttribute("preserveAspectRatio", "xMidYMid meet");
  if (!root.getAttribute("role")) root.setAttribute("role", "img");
  root.setAttribute("aria-label", [data.title, values.date, data.venue].filter(Boolean).join(", "));
  return root;
}

/* ---------------------------------------------------------------- layout (after mount) */

function syncFoilMasks(root: SVGSVGElement) {
  root.querySelectorAll("[data-foil-mask]").forEach((layer) => {
    const mask = root.querySelector(`[id="${layer.getAttribute("data-foil-mask")}"]`);
    if (!mask) return;
    const clone = layer.cloneNode(true) as Element;
    const whiten = (n: Element) => {
      n.removeAttribute("id");
      const ink = !!n.closest("[data-ink]");
      for (const prop of ["fill", "stroke"]) {
        const v = n.getAttribute(prop);
        if (v && v !== "none") n.setAttribute(prop, ink ? "#000" : "#fff");
      }
    };
    whiten(clone);
    clone.querySelectorAll("*").forEach(whiten);
    clone.removeAttribute("data-layer");
    clone.removeAttribute("data-foil-mask");
    mask.replaceChildren(clone);
  });
}
const inDefs = (n: Element) => !!n.closest("defs, mask, clipPath");
const hidden = (n: Element) => !!n.closest('[display="none"]');

/** Set a text's size, scaling its letter-spacing with it so fitted text keeps its tracking proportion. */
function setSize(n: SVGTextElement, size: number) {
  const base = Number(n.dataset.baseSize ?? (n.dataset.baseSize = String(fontSizeOf(n))));
  const ls = n.getAttribute("letter-spacing");
  if (ls && n.dataset.baseLs === undefined) n.dataset.baseLs = ls;
  if (n.dataset.baseLs !== undefined) n.setAttribute("letter-spacing", ((parseFloat(n.dataset.baseLs) * size) / base).toFixed(3));
  n.setAttribute("font-size", size.toFixed(2));
}

function fontSizeOf(n: SVGTextElement): number {
  const a = n.getAttribute("font-size");
  if (a) return parseFloat(a);
  return parseFloat(getComputedStyle(n).fontSize) || 16;
}

function wrapInto(n: SVGTextElement, words: string[], width: number, maxLines: number, leading: number, x: string, size: number): boolean {
  n.textContent = "";
  const lines: string[] = [];
  const probe = document.createElementNS(SVG_NS, "tspan");
  n.appendChild(probe);
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    probe.textContent = next;
    if (probe.getComputedTextLength() <= width || !cur) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  // check every line fits (a single long word may not)
  let fits = lines.length <= maxLines;
  if (fits)
    for (const l of lines) {
      probe.textContent = l;
      if (probe.getComputedTextLength() > width + 0.5) fits = false;
    }
  const shown = lines.slice(0, maxLines);
  if (lines.length > maxLines) {
    // ellipsize the last line, dropping words until line + "…" fits
    let last = shown[maxLines - 1];
    const ell = (t: string) => `${t.replace(/[\s,.;:&–-]+$/, "")}…`;
    probe.textContent = ell(last);
    while (last.includes(" ") && probe.getComputedTextLength() > width) {
      last = last.slice(0, last.lastIndexOf(" "));
      probe.textContent = ell(last);
    }
    shown[maxLines - 1] = ell(last);
  }
  n.textContent = "";
  const anchor = n.getAttribute("data-anchor");
  shown.forEach((l, i) => {
    const t = document.createElementNS(SVG_NS, "tspan");
    t.setAttribute("x", x);
    // y is the first baseline (top), the last baseline (bottom), or the block's middle baseline (middle)
    const span = (shown.length - 1) * leading * size;
    const first = anchor === "bottom" ? -span : anchor === "middle" ? -span / 2 : 0;
    t.setAttribute("dy", String(i === 0 ? first : leading * size));
    t.textContent = l;
    // data-justify: every line but the last is spaced out to the full width
    if (n.hasAttribute("data-justify") && i < shown.length - 1 && l.includes(" ")) {
      t.setAttribute("textLength", String(width));
      t.setAttribute("lengthAdjust", "spacing");
    }
    n.appendChild(t);
  });
  return fits;
}

export async function layoutStub(root: SVGSVGElement): Promise<void> {
  if (typeof document !== "undefined" && document.fonts) {
    const fams = new Set<string>();
    root.querySelectorAll("text").forEach((t) => {
      const f = t.getAttribute("font-family") ?? getComputedStyle(t).fontFamily;
      const w = t.getAttribute("font-weight") ?? "400";
      const s = t.getAttribute("font-style") ?? "normal";
      if (f) fams.add(`${s} ${w} 40px ${f.split(",")[0].trim()}`);
    });
    await Promise.all([...fams].map((f) => document.fonts.load(f).catch(() => undefined)));
    await document.fonts.ready;
  }
  root.querySelectorAll<SVGTextElement>("text[data-wrap]").forEach((n) => {
    if (hidden(n) || inDefs(n)) return;
    const text = n.textContent ?? "";
    const width = Number(n.getAttribute("data-wrap"));
    const maxLines = Number(n.getAttribute("data-lines") ?? 2);
    const leading = Number(n.getAttribute("data-leading") ?? 1.15);
    const x = n.getAttribute("x") ?? "0";
    const base = fontSizeOf(n);
    const min = Number(n.getAttribute("data-min") ?? base * 0.5);
    const words = text.split(/\s+/).filter(Boolean);
    let size = base;
    for (let i = 0; i < 40; i++) {
      setSize(n, size);
      if (wrapInto(n, words, width, maxLines, leading, x, size) || size <= min) break;
      size = Math.max(min, size * 0.92);
    }
  });
  root.querySelectorAll<SVGTextElement>("text[data-fit]:not([data-wrap])").forEach((n) => {
    if (hidden(n) || inDefs(n)) return;
    const max = Number(n.getAttribute("data-fit"));
    const base = fontSizeOf(n);
    const min = Number(n.getAttribute("data-min") ?? base * 0.4);
    let size = base;
    for (let i = 0; i < 6; i++) {
      setSize(n, size);
      const len = n.getComputedTextLength();
      if (len <= max || size <= min) break;
      size = Math.max(min, (size * max) / len) * 0.995;
    }
  });
  // data-fit-group="x": every text in the group takes the smallest fitted size, so a block reads as one
  const groups = new Map<string, SVGTextElement[]>();
  root.querySelectorAll<SVGTextElement>("text[data-fit-group]").forEach((n) => {
    if (hidden(n) || inDefs(n)) return;
    const k = n.getAttribute("data-fit-group")!;
    groups.set(k, [...(groups.get(k) ?? []), n]);
  });
  groups.forEach((ns) => {
    const min = Math.min(...ns.map(fontSizeOf));
    ns.forEach((n) => setSize(n, min));
  });
  syncFoilMasks(root);
  root.setAttribute("data-ready", "1");
}

/** Cached template fetch. */
const cache = new Map<string, Promise<string>>();
export function loadTemplate(id: string, face: "front" | "back"): Promise<string> {
  const key = `${id}/${face}`;
  if (!cache.has(key)) cache.set(key, fetch(`/stubs/${id}/${face}.svg`, { cache: "no-store" }).then((r) => {
    if (!r.ok) throw new Error(`no template ${key}`);
    return r.text();
  }));
  return cache.get(key)!;
}
export function clearTemplateCache() {
  cache.clear();
}
