// Procedural, text-free art per edition, deterministic from the art seed.
// Returns CSS `background` values (one per layer). Risograph returns two layers (pink, teal)
// that StubView multiplies together for the overprint look.
import type { Edition } from "../types";
import { rng } from "./rng";

const pct = (n: number) => `${n.toFixed(1)}%`;

function disc(x: number, y: number, r: number, color: string, soft = 0.6): string {
  return `radial-gradient(circle at ${pct(x)} ${pct(y)}, ${color} 0 ${pct(r)}, transparent ${pct(r + soft)})`;
}
function glow(x: number, y: number, r: number, color: string): string {
  return `radial-gradient(circle at ${pct(x)} ${pct(y)}, ${color}, transparent ${pct(r)})`;
}

// Event-type motifs ride in the seed so StubView (which only passes the seed) can paint them:
// a motif seed is MOTIF_BASE + motif * 1e8 + n. Remix seeds stay under 2^31, so they never collide.
export type Motif = "city" | "stadium" | "grid";
const MOTIF_BASE = 3_000_000_000;
const MOTIFS: Motif[] = ["city", "stadium", "grid"];

export function motifSeed(motif: Motif, n: number): number {
  return MOTIF_BASE + MOTIFS.indexOf(motif) * 100_000_000 + (Math.abs(Math.floor(n)) % 100_000_000);
}

function motifOf(seed: number): Motif {
  if (seed < MOTIF_BASE) return "city";
  return MOTIFS[Math.floor((seed - MOTIF_BASE) / 100_000_000)] ?? "city";
}

const rgb = (c: string, a: number) => `rgb(${c} / ${a.toFixed(2)})`;
const INK = "20 32 28";
const CYAN = "124 198 210";
const AMBER = "233 161 75";
const ORANGE = "228 87 46";
const CREAM = "244 236 221";

/** Painted tooth: a fine, quiet noise over everything so the gradients read as pigment, not CSS. */
const GRAIN_SVG = `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.96 0 0 0 0 0.92 0 0 0 0 0.86 0 0 0 0.55 -0.2'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>`;
// base64, so the nested url(#n) is not visible to the PNG export, which would fetch it as /%23n and drop the art
const GRAIN = `url("data:image/svg+xml;base64,${btoa(GRAIN_SVG)}") 0 0 / 160px`;

/** background-position percentages are relative to the leftover space, so convert an absolute offset. */
const at = (offset: number, size: number) => (size >= 100 ? "0%" : pct((offset / (100 - size)) * 100));
/** A box of paint at an absolute percentage position and size. `image` is any CSS image. */
const place = (image: string, x: number, y: number, w: number, h: number) => `${image} ${at(x, w)} ${at(y, h)} / ${pct(w)} ${pct(h)} no-repeat`;
/** A flat rectangle of colour. */
const block = (x: number, y: number, w: number, h: number, paint: string) => place(`linear-gradient(${paint})`, x, y, w, h);
const flat = (c: string) => `${c}, ${c}`;
/** A wedge of light from a point: floodlight beams. 180deg points straight down. */
function beam(x: number, y: number, angle: number, spread: number, color: string): string {
  return `conic-gradient(from ${Math.round(angle - spread / 2)}deg at ${pct(x)} ${pct(y)}, transparent 0deg, ${color} ${(spread / 2).toFixed(1)}deg, transparent ${spread}deg, transparent 360deg)`;
}

type Range = (a: number, b: number) => number;

/** Floodlit stadium at night: lamps, beams, two tiers of crowd, grass mown in converging stripes. */
function stadium(R: Range): string {
  const layers: string[] = [GRAIN, `radial-gradient(120% 90% at 50% 46%, transparent 50%, rgb(8 12 10 / 0.62))`];
  const horizon = R(54, 58);
  const grassTop = horizon + 4;
  const grassH = 100 - grassTop;
  // pitch markings: halfway line and centre circle, flattened to sit on the grass
  layers.push(`radial-gradient(ellipse 17% 6% at 50% ${pct(grassTop + grassH * 0.42)}, transparent 0 80%, ${rgb(CREAM, 0.4)} 85% 100%, transparent 101%)`);
  layers.push(block(0, grassTop + grassH * 0.42, 100, 0.55, flat(rgb(CREAM, 0.3))));
  // lamp light pooling on the grass, then stripes that converge toward the far end
  layers.push(place(`radial-gradient(ellipse 80% 30% at 50% 0%, ${rgb(CYAN, 0.3)}, transparent)`, 0, grassTop, 100, grassH));
  layers.push(place(`repeating-conic-gradient(from 90deg at 50% -70%, ${rgb(CREAM, 0.07)} 0 3deg, transparent 3deg 6deg)`, 0, grassTop, 100, grassH));
  layers.push(place(`linear-gradient(180deg, #2f5240, #1f3a2c 55%, #122419)`, 0, grassTop, 100, grassH));
  // crowd: warm specks packed along the tiers
  for (let i = 0; i < 120; i++) {
    const row = i % 3;
    layers.push(disc(R(2, 98), R(horizon - 18 + row * 7, horizon - 10 + row * 7), R(0.4, 0.8), rgb(i % 6 ? AMBER : i % 2 ? CREAM : ORANGE, R(0.3, 0.75)), 0.55));
  }
  // stands: a dark bowl in two tiers, deeper toward the back, with a rim of light on the top edge
  layers.push(place(`linear-gradient(180deg, #0c1411, #16231e)`, 0, horizon - 6, 100, 10));
  layers.push(place(`linear-gradient(180deg, #0f1814, #1a2923)`, 0, horizon - 20, 100, 15));
  layers.push(block(0, horizon - 21, 100, 0.8, flat(rgb(CYAN, 0.28))));
  // floodlight towers, lamps and beams
  [R(7, 13), R(26, 34), R(66, 74), R(87, 93)].forEach((x) => {
    const top = R(10, 20);
    layers.push(block(x - 0.4, top, 0.8, horizon - top - 16, flat("#0b110e")));
    layers.push(disc(x, top, 1.5, rgb("255 250 235", 1), 1.4));
    layers.push(glow(x, top, R(20, 28), rgb(CYAN, 0.4)));
    layers.push(beam(x, top, 180 + (50 - x) * 0.8, R(18, 26), rgb("225 242 246", 0.26)));
  });
  // a thread of warm haze where the city meets the bowl, then the night sky
  layers.push(`radial-gradient(ellipse 90% 18% at 50% ${pct(horizon - 20)}, ${rgb(ORANGE, 0.2)}, transparent)`);
  layers.push(`linear-gradient(180deg, #0c1512, #14231f 35%, #264038 ${pct(horizon - 22)}, #14201c)`);
  return layers.join(", ");
}

/** Screens glowing in the dark over a perspective floor grid: a hackathon at 3am. */
function gridNight(R: Range, r: () => number): string {
  const layers: string[] = [GRAIN, `radial-gradient(120% 90% at 50% 40%, transparent 50%, rgb(8 12 10 / 0.55))`];
  const horizon = R(60, 66);
  const floor = 100 - horizon;
  // floor grid: lines fan out from the vanishing point, rows open up toward the viewer
  layers.push(place(`repeating-conic-gradient(from 90deg at 50% 0%, ${rgb(CYAN, 0.34)} 0 0.5deg, transparent 0.5deg 7deg)`, 0, horizon, 100, floor));
  [1.2, 3.4, 6.6, 11, 17, 25, 36].forEach((d) => layers.push(block(0, horizon + (d / 36) * floor * 0.98, 100, 0.45, flat(rgb(CYAN, 0.28 + d / 120)))));
  layers.push(place(`linear-gradient(180deg, transparent, #0c1512)`, 0, horizon, 100, floor));
  // screens: a cluster of lit panels, one warm
  const count = 4 + Math.floor(r() * 2);
  for (let i = 0; i < count; i++) {
    const w = R(14, 26);
    const h = R(9, 17);
    const x = R(6, 94 - w);
    const y = R(horizon - 36, horizon - 9 - h * 0.4);
    const hue = i === 0 ? ORANGE : CYAN;
    layers.push(place(`linear-gradient(${rgb("255 255 255", 0.2)}, transparent 40%)`, x, y, w, h));
    layers.push(block(x, y, w, h, `180deg, ${rgb(hue, 0.8)}, ${rgb(hue, 0.3)}`));
    layers.push(glow(x + w / 2, y + h / 2, R(20, 30), rgb(hue, 0.3)));
  }
  // light pooling on the floor, far stars, the night itself
  layers.push(`radial-gradient(ellipse 60% 12% at 50% ${pct(horizon)}, ${rgb(ORANGE, 0.34)}, transparent)`);
  for (let i = 0; i < 14; i++) layers.push(disc(R(4, 96), R(3, horizon - 40), R(0.2, 0.45), rgb(CREAM, R(0.35, 0.8)), 0.4));
  layers.push(`linear-gradient(180deg, #0a1210, #12201c 55%, #1c2e29 ${pct(horizon)}, #0c1512)`);
  return layers.join(", ");
}

export function proceduralArt(seed: number, edition: Edition): string[] {
  const r = rng(seed * 7919 + edition.length * 101);
  const R = (a: number, b: number) => a + r() * (b - a);

  switch (edition) {
    case "researched": {
      const motif = motifOf(seed);
      if (motif === "stadium") return [stadium(R)];
      if (motif === "grid") return [gridNight(R, r)];
      // night city: dark teal sky, warm window glows, one cyan lamp, one orange accent, rain
      const layers: string[] = [
        GRAIN,
        `repeating-linear-gradient(104deg, rgb(255 255 255 / 0.05) 0 1px, transparent 1px ${Math.round(R(6, 10))}px)`,
        disc(R(55, 80), R(78, 88), R(2.2, 3.2), "#E4572E", 0.4),
        glow(R(60, 80), R(40, 55), R(10, 16), rgb(CYAN, 0.55)),
      ];
      const n = 5 + Math.floor(r() * 4);
      for (let i = 0; i < n; i++) layers.push(glow(R(15, 85), R(35, 80), R(5, 12), rgb(AMBER, R(0.35, 0.75))));
      layers.push(`linear-gradient(180deg, transparent 0 ${pct(R(60, 70))}, rgb(${INK} / 0.9) ${pct(R(70, 76))}, #0f1714)`);
      layers.push(`linear-gradient(${Math.round(R(170, 190))}deg, #14201c, #26302a 55%, #3b4a43)`);
      return [layers.join(", ")];
    }
    case "letterpress": {
      const sx = R(30, 70);
      const sy = R(30, 48);
      const bands = Array.from({ length: 4 }, (_, i) => {
        const y = 58 + i * R(7, 10);
        return `linear-gradient(transparent 0 ${pct(y)}, ${i % 2 ? "#8C5A3C" : "#4A2E1E"} ${pct(y)} ${pct(y + R(2, 5))}, transparent ${pct(y + 5)})`;
      });
      return [
        [
          ...bands,
          disc(sx, sy, R(16, 24), "#C4551F"),
          disc(sx + R(-6, 6), sy + R(-4, 4), R(28, 34), "rgb(217 139 79 / 0.35)"),
          `linear-gradient(180deg, #efdcb6, #e3cfa8)`,
        ].join(", "),
      ];
    }
    case "risograph": {
      const pink: string[] = [];
      const teal: string[] = [];
      for (let i = 0; i < 4; i++) pink.push(disc(R(10, 90), R(10, 90), R(12, 30), "#FF48B0"));
      pink.push(`repeating-linear-gradient(${Math.round(R(20, 70))}deg, #FF48B0 0 6px, transparent 6px 14px)`);
      for (let i = 0; i < 3; i++) teal.push(disc(R(10, 90), R(10, 90), R(14, 34), "#00A7B5"));
      teal.push(disc(R(20, 80), R(20, 80), R(6, 10), "#FFE800"));
      return [pink.join(", ") + ", #fff", teal.join(", ") + ", #fff"];
    }
    case "minimal": {
      const x = R(35, 65);
      const y = R(35, 65);
      return [
        [
          disc(x, y, R(24, 32), "#1A1916", 0.3),
          `linear-gradient(${Math.round(R(0, 180))}deg, transparent 0 49.6%, #1A1916 49.6% 50.4%, transparent 50.4%)`,
          "#D9D4C7",
        ].join(", "),
      ];
    }
    case "classic": {
      const x = R(30, 70);
      const y = R(30, 70);
      return [
        [
          `repeating-radial-gradient(circle at ${pct(x)} ${pct(y)}, #2B4C7E 0 2px, transparent 2px ${Math.round(R(6, 9))}px)`,
          `conic-gradient(from ${Math.round(R(0, 360))}deg at ${pct(x)} ${pct(y)}, #7CC6D2 0 25%, #DDEFF2 0 50%, #7CC6D2 0 75%, #DDEFF2 0)`,
        ].join(", "),
      ];
    }
  }
}
