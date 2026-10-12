# Stub system

How a stub is built, and the five editions. The master brand (app UI) lives in the [brand-kit](https://github.com/Jevelopers-neatHack-2026/brand-kit). **The stub is the user's artwork, so editions have their own palettes and type.** The only brand elements that appear on a stub are the Ts stamp on the back and the foil material.

## Layer model

Every stub has three layers. AI never renders text; that rule is what makes tap-to-edit, style swiping and organizer locks possible.

| Layer | Contents | Made by |
|---|---|---|
| **1. Art** | Illustration, texture, photo, pattern. No letters. | The edition's own generator: CSS/SVG patterns for Classic and Minimal, image generation for Researched and remixes, the user's photo |
| **2. Live type** | Every piece of event data, set as real text in the edition's fonts | The type engine (layout templates and smart chips) |
| **3. Material** | Paper grain, foil, holo, emboss, perforation, shadow | Shaders driven by tilt; see `research/holo-foil-technique.md` |

## Event data

Fields (all optional except the title): `artist`, `tour`, `venue`, `city`, `date`, `doors`, `section`, `row`, `seat`, `price`, `barcode`, `openers[]`, `setlist[]`, `weather`, `nightOfRun` (2 of 3), `with[]` (friends), `note`, `photo`.

- **Sparse data still looks intentional.** Each edition defines a fallback composition for a stub with only a title and date. Example: Minimal turns into big date numerals plus the title, as in the "12.10 / NORTHERN LINES" reference.
- **Low-confidence fields** are carried as `{ value, confidence, alternatives[] }`. Anything under 0.8 renders as a pulsing chip.

## Shapes

| Shape | Used by |
|---|---|
| Horizontal stub with a side tear-off and notches | Classic, Risograph |
| Horizontal with a semicircle side notch | Minimal |
| Vertical with scalloped ends | Minimal (vertical variant) |
| Postage stamp (portrait, perforated all round) | Researched, back side |
| Admit-one with corner notches and a decorative border | Letterpress |

Perforation is a parameter on every shape: bite radius, pitch, and which edges are tearable.

## Editions

The palettes below are starting points taken from the references in `references/editions/`.

| Edition | Palette | Type | Art layer | Signature | Reference |
|---|---|---|---|---|---|
| **Classic** | Pale cyan security wave, cream stock, black dot-matrix, red frame line | Monospace dot-matrix | Procedural security wave, coffee-ring aging | Thermal fade, barcode | `classic-01.webp` (Ticketmaster-logo references are internal only) |
| **Letterpress** | Cream cotton, burnt orange and brown, red rubber stamp | Condensed slab or wood type | Paper texture, deboss | Angled date stamp, art-deco corners | `letterpress-01/02.webp` |
| **Risograph** | Fluorescent pink and teal overprint, off-white | Heavy condensed display, knocked out of the art | Two-colour riso illustration with grain and misregistration | Overprint offset | `risograph-01/02.webp` |
| **Minimal** | Bone white, one signal-orange block | Swiss grotesk, huge numerals | None, or one flat colour field | Date as hero numerals | `minimal-01/02.webp` |
| **Researched** | Taken from research (Glasgow: moss, amber lamplight, one orange accent) | Serif with foil title, small-caps fact line | Generated painterly scene (see the prompt template) | Night-of facts line, stamp edge | `researched-*.webp` |

## Researched art: prompt template

```
Illustration only, no text, no letters: {weather} {time of day} in {city}, {venue architecture},
{light sources}, lone figure with {orange accent object}, {palette from research},
painterly vintage travel-poster style, vertical composition with empty dark sky in the top third
--ar 2:3 --no text, letters, typography{, weather opposites}
```

Rules (from the Glasgow tests):
1. **Facts are constraints.** If the facts say "rain", add the opposites to the negative prompt (`--no snow, snowflakes`). The first batch drew snow until we did this.
2. **One accent in Ticket Orange.**
3. **Leave empty space for type**, matched to the shape: the top third for portrait stubs, a side column for a sideways fact line.
4. **No real marks or likenesses.**

## Back side

The layout follows `references/back-side/`: the setlist at the top left with a starred favorite, the note in a handwritten-style italic, friend avatars at the top right, the QR code at the bottom right, and the Ts stamp at the bottom.

## Finishes by material tier

| Tier | Finishes available |
|---|---|
| Digital $9 | Animated foil in the share card and wallet pass |
| Card $29 | Matte stock, one foil element |
| Print $49 | Choice of stock, foil title. Holo is a screen preview only and is not printed, see [capabilities](../product/capabilities.md) |
| Framed $89 | Print plus mat and frame. Holo is a screen preview only and is not printed, see [capabilities](../product/capabilities.md) |
