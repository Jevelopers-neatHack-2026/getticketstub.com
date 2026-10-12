# Holo foil technique — borrowed from coven-cave

Source: `lmvdz/coven-cave`, branch `feat/cave-3rz-conjure-flow` (familiar "conjure" cards).
Key files: `src/lib/foil/{field,plate,browser}.ts`, `src/styles/familiar-card.css`,
`src/components/familiar-card-preview.tsx`, `src/components/scry-glitch.tsx`.
Status: design reference. Nothing is built yet.

Visual references: `references/finish-holo/`, and the brand-mark references in the brand-kit repo.

## Core idea: "fixed structure, moving colour"

Real stamped foil has a pattern that stays put while its colour shifts with the light. coven-cave reproduces that with:

1. **A greyscale plate.** It's computed once per artwork as a PNG data URL and exposed as `--holo-tex`.
   - White means foil and black means plain paper.
   - It's built from a halftone carrier multiplied by a specular mask taken from the art.
   - The mask threshold is solved from a histogram so that about 6% of the card is foil.
2. **A rainbow spectrum.** A `repeating-linear-gradient` at 118° runs through red, orange, yellow, green, cyan, violet and back to red. It's multiplied into the plate (`background-blend-mode: multiply`), so the black areas stay plain.
3. **A foil layer.** It sits over the art with `mix-blend-mode: screen`.
   - Only the spectrum's `background-position` follows the pointer: `--fx*1.7px` horizontally and `--fy*0.6px` vertically.
   - The plate does not move.
4. **A glare layer.** A white `radial-gradient` at `--px`/`--py` with `mix-blend-mode: overlay`.
5. **Brightness.** `--glow` (0 at rest, 1 while tracking) scales the opacity of both layers: `0.42 + glow*0.52`.

## Mapping onto the stub's finishes

| Ticket finish | Plate |
|---|---|
| **Foil title only** (Glasgow gold, "Ts" mark) | A text raster (white glyphs on black) from the live-type layer, over a flat carrier. The type engine already has the glyphs, so it can produce this plate directly. |
| **Full holo stock** | A full-bleed halftone plate with no mask |
| **Spot holo on art** (lamplight, windows) | The specular mask from the generated art, exactly as coven-cave does it |
| **Emboss / deboss** | Not in coven-cave. Needs a new lighting layer driven by the same `--px`/`--py` |

Brand fit: swap the generic rainbow for the **copper → orange → cyan** brand gradient seen in the TS stamp and in the holo macro references. Keep the full rainbow for the holographic stock option only.

## Don't copy: how coven-cave turns the glow on

coven-cave sets `--glow` straight to 1 in its pointer handler and switches the card's `transition` from 380 ms to 80 ms linear while tracking. On a stamp this makes the foil **pop in** on the first move and the tilt snap toward the pointer. We shipped exactly that on the first brand board.

What we do instead (brand-kit `docs/material-foil.md`, "Rules: foil must never pop"):
- Ease light position, tilt and glow every frame with time-based exponential smoothing (τ: tilt 110 ms, light 90 ms, glow in 400 ms, glow out 600 ms; dt clamped to 50 ms).
- Keep a resting glow of 0.1, never 0.
- Use one motion model; no transition switching.
- Caps: brand sheen 0.5 (`overlay`; 0.32 with `soft-light` was too subtle), glare 0.3 (`overlay`). Never `color-dodge`. Rainbow only on holo stock.
- Acceptance: at most 0.02 sheen opacity change per frame at 60 Hz.

## Interaction model to borrow

- **Pointer tilt:** limited to ±11°. Ignore coven-cave's 80/380 ms transition switch; ease it instead (see above).
- **Flip to the back side:** the card's back face is `rotateY(180deg)`, inside `perspective: 1400px` with `preserve-3d`.
- **Drag-spin with spring physics:** stiffness 0.055 and damping 0.9, stepped at a fixed 60 Hz so it settles the same way on any display. Includes a 6 px slop to tell a tap from a drag, and arrow-key impulses.
- **"Hunting" sweep:** the spectrum moves on a 2.6 s loop while waiting. Reuse it as the "printing / researching" state.
- **Glitch shutter finale:** 320 ms with RGB split. Adapt it into the moment the stub finishes printing; it only fires on a real state transition.

## Gaps to design ourselves

- **No gyroscope support.** This is mobile-first, so we need `deviceorientation`, the iOS permission prompt (it needs a user gesture — tying it to the first tap on the stub works well), smoothing, and a tilt-to-light mapping.
- **No rAF throttling or `will-change`** on the card itself.
- **No emboss, parallax depth, tear or perforation physics.**

## Gotchas (from comments and tests)

- **No `backface-visibility`.** Blend layers flatten the 3D context, which culls the wrong face. Swap the faces with `visibility` after a 190 ms delay, timed for when the card is edge-on.
- **WebKit tiling bug.** WebKit drops `background-blend-mode` on tiled layers. Oversize the layer by a bleed (260 px) with `no-repeat`, and keep that bleed larger than the maximum pan.
- **Opacity and blend.** Never put both on the same element.
- **Compositing cost.** `isolation: isolate` on the card took a 2x display from 27 to 55 fps. The cost was compositing, not JS.
- **Antialiasing.** Halftones must stay antialiased, or the edges crawl while tilting. Don't make them denser by downsampling.
- **Seeding.** Seed plates from identity, so the same stub always gets the same foil pattern. That suits printing, because the preview matches the physical card.
- **Failure handling.** A plate failure must never hide the base art.
- **Reduced motion.** Freeze a still sheen at `--glow: 0.55`, with no hover and no glitch.
