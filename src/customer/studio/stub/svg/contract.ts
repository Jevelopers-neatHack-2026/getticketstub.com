// SVG stub templates: the contract between a template file and the runtime that fills it.
//
// A template is two plain SVG files, public/stubs/<id>/front.svg and back.svg, drawn at the
// stub's physical size (1 unit = 1/200 in, so a 2 x 5.5 in stub is viewBox 0 0 400 1100).
// Designers edit them like any SVG; the runtime only touches elements that carry data-* hooks.
//
// Layers, bottom to top (each a <g data-layer="...">, all optional except dieline):
//   paper    stock colour, texture, printed fields
//   art      the event picture; <image data-slot="art"> is filled with StubData.art
//   holo     WHITE shapes = where the holographic film sits. Screen only; print gets a flat spectrum.
//   ink      type, rules, barcode, QR
//   foil     shapes drawn in foil. Fill/stroke them with "currentColor" or anything: the runtime
//            repaints them with the template's metal (data-foil on <svg>). Print gets a flat ink.
//            An element marked data-ink inside a foil group keeps its own flat colour (labels etc.).
//   dieline  one <path>: the cut shape. It clips the whole stub on screen and is the cut line in print.
//
// Slots:
//   <text data-slot="title">          text from StubData (see SlotKey); keeps its tspan-free text
//     data-fit="320"                  shrink the font until the text is at most 320 units wide
//     data-min="18"                   smallest font size fit may use (default 40% of the size)
//     data-wrap="320" data-lines="3"  wrap into at most 3 lines of 320 units (line height data-leading, em)
//     data-anchor="bottom|middle"     with data-wrap: y is the last line's baseline, or the block's centre
//     data-justify                    with data-wrap: justify every line but the last
//     data-case="upper|lower"         change case
//     data-prefix / data-suffix       literal text around the value
//     data-default="—"                text to show when the value is empty (otherwise the element is hidden)
//     data-fit-group="cast"           after fitting, every text in the group takes the group's smallest size
//   <any data-show-if="seat row">     hidden unless every listed slot has a value
//   <any data-hide-if="seat row">     hidden when any listed slot has a value (fallback layouts)
//                                     "art" / "art2" work here as presence flags (no-art layouts)
//   <image data-slot="art">           href <- StubData.art.src; data-slot="art2" for a second image
//   <g data-slot="barcode" data-w data-h data-color?>  bars generated from the serial
//   <g data-slot="qr" data-size data-color?>           a keepsake QR-style mark from the serial
//
//   <any data-screen-only>            removed in print mode (finish simulations: extra sheen, film texture)
//
// Gotcha: a blend mode inside a masked/clipped group only blends with that group's own contents;
// put the mask/clip on the blended element itself when it must blend with the stub below.
//
// Ids inside a template are namespaced at render time, so several stubs can share a page.

export type StubCategory = "concert" | "sport" | "theater" | "festival" | "film" | "other";

export interface StubData {
  category: StubCategory;
  title: string; // the headline: artist, show, matchup
  subtitle?: string; // tour, competition, production
  kicker?: string; // small overline, e.g. "Live at", "Opening night"
  people?: string[]; // cast, line-up, starting five
  tagline?: string; // one memorable line
  venue?: string;
  city?: string;
  dateISO?: string; // yyyy-mm-dd
  time?: string; // "19:30"
  doors?: string;
  section?: string;
  row?: string;
  seat?: string;
  gate?: string;
  price?: string;
  serial?: string; // printed number; also seeds barcode/QR
  edition?: string; // "No. 0042"
  admit?: string; // "Admit one", or a guest's name
  note?: string; // personal line written by the fan
  home?: string;
  away?: string;
  score?: string; // "102 - 99"
  art?: { src: string; alt?: string };
  art2?: { src: string; alt?: string };
}

/** Every key a text slot can ask for: StubData strings plus derived formats. */
export type SlotKey =
  | Exclude<keyof StubData, "category" | "people">
  | "people1" | "people2" | "people3" | "people4" | "people5" | "peopleAll"
  | "date" // 10 AUG 2026
  | "dateLong" // Monday, August 10, 2026
  | "dateDots" // 2026.08.10
  | "dateShort" // 10.08.26
  | "day" // 10
  | "month" // AUG
  | "monthLong" // August
  | "year" // 2026
  | "weekday" // MON
  | "place" // venue, city
  | "seatLine" // SEC 104 · ROW C · SEAT 7
  | "categoryLabel"; // CONCERT

export type Orientation = "portrait" | "landscape";
export type Metal = "gold" | "copper" | "silver" | "red" | "rose" | "ink";

export interface TemplateMeta {
  id: string;
  name: string;
  direction: "cinema" | "holo" | "festival" | "editorial";
  blurb: string;
  orientation: Orientation;
  width: number; // viewBox units, 200 per inch
  height: number;
  metal: Metal;
  holo: boolean; // has a holo layer
  fonts: string[]; // Google Fonts families the template uses
  /** Which categories it suits best; all templates accept any data. */
  bestFor: StubCategory[];
}

/** Google Fonts families the templates may use (served from public/stubs/fonts). Keep this list short. */
export const STUB_FONTS: Record<string, string> = {
  "Fraunces": "Fraunces:opsz,wght@9..144,300..900",
  "Inter Tight": "Inter+Tight:wght@300..800",
  "Oswald": "Oswald:wght@300..700",
  "Barlow Condensed": "Barlow+Condensed:wght@400;500;600;700;800",
  "Space Grotesk": "Space+Grotesk:wght@300..700",
  "JetBrains Mono": "JetBrains+Mono:wght@300..700",
  "Cormorant Garamond": "Cormorant+Garamond:ital,wght@0,400..700;1,400..700",
  "Bodoni Moda": "Bodoni+Moda:ital,opsz,wght@0,6..96,400..900;1,6..96,400..900",
  "Unbounded": "Unbounded:wght@300..900",
  "Archivo Black": "Archivo+Black",
  "Big Shoulders Display": "Big+Shoulders+Display:wght@400..900",
  "DM Serif Display": "DM+Serif+Display:ital@0;1",
  "Syne": "Syne:wght@400..800",
  "Zen Kaku Gothic New": "Zen+Kaku+Gothic+New:wght@400;500;700;900",
  "Chakra Petch": "Chakra+Petch:wght@400;500;600;700",
};

/** The template fonts, self-hosted (public/stubs/fonts, latin + latin-ext) so stubs render offline and on one origin. */
export function stubFontsHref(): string {
  return "/stubs/fonts/fonts.css";
}
