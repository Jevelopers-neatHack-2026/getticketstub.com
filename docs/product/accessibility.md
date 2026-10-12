# Accessibility (GT-11)

What the studio does for keyboard, screen reader, reduced motion, small screens and contrast, what was checked and how, and what has not been checked.
This is evidence for GitHub issue GT-11 (getticketstub.com #18). It is not a claim of WCAG conformance: one automated scan and one person's keyboard pass cannot make one.

The app is always cream paper (there is no dark theme), so every check below is against `--desk-paper`, `-raised` and `-sunk`.

## How to run the automated checks

```sh
npm run verify:product -- --suite a11y --mode fixture --evidence-dir out/gt-evidence
```

`--suite accessibility` is the same suite (GT-11 names it that way). It serves the production build on a loopback port, starts its own headless Chrome (or Edge, or `CHROME_PATH`) with a throwaway profile that resolves loopback hosts only, and runs `scripts/check-a11y.mjs`. It needs a build first (`npm run build`). The evidence file lists every check; `a11y-detail.json` next to it holds the full axe results, the exceptions with their reasons, the overflow measurements and the tab walks.

| Check | What it does | Fails the run when |
| --- | --- | --- |
| Contrast | Reads the tokens from `src/customer/desk/desk.css` and computes WCAG ratios on paper, raised and sunk (`scripts/lib/contrast.mjs`) | Any ratio is under 4.5:1 (text) or 3:1 (focus ring, control edge, marks, disabled label) |
| axe-core 4.14 | Injected over the DevTools protocol on `/make`, `/wall`, `/studio/demo-pale`, `/checkout/demo-pale`, `/cart`, `/help`, `/account`, `/privacy` at 390 and 1280 px, tags wcag2a, wcag2aa, wcag21a/aa, wcag22aa, best-practice | A serious or critical violation. Minor and moderate ones are recorded as evidence. |
| Overflow | Same pages at 320, 640, 200% zoom (640 px at device scale 2) and 200% text (390 px, root font size doubled): `scrollWidth` against `clientWidth`, plus every button, link and field must sit inside the screen edge, because `overflow-x: clip` would otherwise hide a cut-off action | Any horizontal overflow, or any control cut off |
| Keyboard | Tab walk of six screens: first stop is the skip link, every stop has a visible focus ring (outline, or a change in its own paint, read with transitions off) and a name | A stop without a ring or a name |
| Dialogs | Cart, Facts sheet, Versions sheet, wall lamp, sign-in sheet: focus moves in, Tab and Shift+Tab never leave, Esc closes, focus returns to the opener | Any of the three fails |
| Critical path | Style by Enter, flip by Space, finish by arrow keys, pick a stub field and reach its toolbar, tear by keyboard (strip, handle, arrows, Esc, Enter), move a wall stub with arrows, lift it, zoom and fullscreen reachable | Any step fails |
| Reduced motion | With `prefers-reduced-motion: reduce` emulated: no running animation longer than 300 ms or looping on every page, the printing feed and shimmer do not run and all facts show at once, a holo stub does not tilt (with a motion-allowed control proving the probe can see a tilt), no stub flies to the cart | Any of those |

Named exceptions (recorded, with reasons, in the evidence): `label-content-name-mismatch` on a wall stub button, and `target-size` on the in-place edit buttons printed on a stub. See "Known limits".

Chrome and Edge on this machine follow the OS "reduce motion" setting, so the harness always sets the media feature itself (`reduce` or `no-preference`), and a run never depends on the machine.

## Manual checklist: what was verified by keyboard

Browser: Chrome 154.0.8037.98 (headless, Windows 11), driven by real key events (`Input.dispatchKeyEvent`), against `next dev` while building and `next start` for the recorded runs. Viewports: 320, 375 (checked by width logic and the 390 run, not captured separately), 390, 640, 768 (layout breakpoints are 960 and 56 px rail, nothing changes at 768), 1280, plus 200% zoom emulated as 640 px at device scale 2. Screenshots of the focus states and the 320 px views are in the session scratchpad `a11y/` folder.

| Path | Result |
| --- | --- |
| Skip link | First Tab stop on every screen, lands as a paper tag, moves focus to `#content` so the next Tab starts inside the page |
| /make | Tab reaches the field, Paste, Make my stub, the three demo tags, Search; a failed read returns focus to the field with the message described by `aria-describedby` and the field `aria-invalid` |
| Printing | Lines are buttons with `aria-pressed`; the auto-advance waits while focus is on a line; "Skip to the stub" is a button; headline and failures go through the one live region |
| Editor | Style dots (Enter), left and right arrows deal a style from anywhere, F flips, Flip tool (Space), material and finish radios roving with arrow keys, stub fields are buttons (Enter picks, a toolbar appears after the stub in Tab order, Esc deselects), Facts and Versions sheets, tear |
| Fact correction | Facts sheet: Fix, Add, Keep, Undo are named for their fact ("Fix Weather"); typed answer field is labelled and required; chip on the stub opens the same question in a sheet |
| Versions | Select and Compare are separate buttons, "Select version a1b2 / Version a1b2 is selected"; the selected version is stated at the top of the sheet and in the tray note |
| Tear | Tray strip, Enter, focus on the handle (a slider), arrows tear a little, Enter or Space finishes, Esc and "Back to styling" return focus to the strip. "Or tear it off for me" does the same without a drag. |
| Wall | Each stub is a button: Enter lifts it, arrow keys move it 12 px (Shift 48), Escape or "Pin it back" pins it back and returns focus to the stub; `+` `-` `0` `F` and the arrow keys on the cork; zoom, fit and fullscreen buttons; in fullscreen a sound switch is added to the controls |
| Checkout and cart | Mini cart is a dialog that holds focus and returns it; receipt email is a labelled field with its error tied to it; paying with a bad address returns focus to the field |
| Sign-in sheet | Opens with focus in the email field, Tab stays inside, Esc returns focus to the control that opened it (the opener is remembered even when the field has `autoFocus`) |
| Phone drawer | The 56 px rail opens a drawer; the page behind is `inert` while it is open; Esc closes it |

## Screen reader behaviour (designed for, not heard)

- One polite live region per screen (`LiveRegion` in `NavFrame`). Messages stay visible as text; a message marked `data-announce` is spoken when it appears or changes, `data-announce="added"` for the agent log (only what was added), `data-announce="change"` for a line that is always there (spoken only when it changes). The earlier scattering of about 40 `role="status"`, `role="alert"` and `aria-live` regions is gone; error boundaries keep their own `role="alert"` because they replace the screen.
- Fields: `Field` takes `error`, `hint`, `required`; it sets `aria-invalid` and `aria-describedby` (error first, then hint); the error text is also announced.
- Provenance in words: a printer's mark is `role="img"` with a text alternative ("Live source", "Simulated", "Not known yet"); every screen that uses marks has the one-line legend.
- The stub: name is "The Pale Hours, researched edition stub", and its description (when, where, kept facts, unsure facts, finish, front or back) hangs from `aria-describedby`.
- Selected version: `aria-current` on the row, "Version a1b2 is selected" on the disabled Select button, the section "Selected for print", and a spoken confirmation after a change.
- Style change, flip, wall nudge, tear and the "expired link" slip are all announced through the same region.
- Camera and canvas: the wall's board and the editor's cutting mat are labelled groups whose label lists the keys; the phone stage's label names the swipe, the arrow keys, F and hold-for-all-styles.

## Reduced motion and sound

- Global: with the preference set, every CSS animation and transition runs for 0.01 ms, once, with no delay, so nothing loops and nothing travels (`src/app/globals.css`; the previous rule left infinite animations flickering at 0.01 ms).
- Script-driven motion asks the media query itself: printing feed (no WAAPI feed, all facts at once, 800 ms dwell), tilt and foil light (static glow), tear (260 ms hand-off, no fly-away), camera glide (both cameras jump), cart flight (skipped), print run, the landing paste-to-print feed.
- No flashes: nothing blinks or strobes; the only loops are slow pulses (1.1 s and slower), and the preference turns those off too.
- Sound: the sound switch is the last row of the sidebar rail on every screen, and is repeated in the wall's fullscreen controls (fullscreen hides the sidebar). It says "Sound on. Press to turn it off" (state in words, not a pressed toggle). Every cue has a visual twin: the printer ticks with the feed and the receipt, stamp with the stamped label ("Kept", "Ordered"), tear with the strip going, pin with the pin pressed in, success and error with text in the live region. No sound carries information alone.

## Contrast: before and after

Ratios against paper `#f4ecdd`, raised `#fbf6ec`, sunk `#ebe1cf`. Need 4.5:1 for text, 3:1 for focus rings, control edges and marks.

| Colour and use | Before (paper, raised, sunk) | After (paper, raised, sunk) |
| --- | --- | --- |
| Ink text | 15.65, 17.05, 14.17 | unchanged |
| Soft ink: labels, hints | 5.53, 5.73, 5.30 | unchanged |
| Placeholder (soft ink at an extra 0.7 opacity) | 2.99, 3.04, 2.93 fail | 5.53, 5.73, 5.30: the extra opacity is gone (4 stylesheets) |
| Swatch price (soft ink at 0.7) | 2.99, 3.04, 2.93 fail | 5.53, 5.73, 5.30 |
| Tag count (ink at 0.6) | 4.55, 4.68, 4.39 (sunk fails) | 15.65, 17.05, 14.17 |
| Control edge: input line, paper button, tag, switch slot | `--desk-rule-strong` 2.66, 2.70, 2.61 fail | new `--desk-edge` 3.89, 3.98, 3.77 |
| Focus ring on inputs (orange underline) | 3.14, 3.42, 2.84 fail | new `--desk-focus` (ink) 15.65, 17.05, 14.17 |
| Error and stamped text (orange) | 3.14, 3.42, 2.84 fail | new `--desk-error` (the stamp's ledge colour) 5.34, 5.82, 4.83 |
| Printer's mark (copper) | 3.56, 3.88, 3.22 | unchanged |
| Disabled label (ink at 0.55) | 3.89, 3.98, 3.77 | unchanged, now one token `--desk-disabled-alpha` |
| Ink label on the orange stamp | 4.99 | unchanged |

`--desk-rule-strong` stays for perforations and decoration, which carry no meaning. The orange stamp is still the colour of the main action and its border; it is no longer used as text or as the only focus signal.

## What GT-11.x has and lacks

| Item | Has | Lacks |
| --- | --- | --- |
| 11.1 keyboard | Whole critical path above, skip link, ink focus ring on every control (a two-tone ring on art, a thick notch edge on tags), dialogs that hold and return focus, roving tabindex on tabs and finish, arrow-key nudging on the wall, a tear without a drag | A real screen reader pass; focus restore after a navigation by a route change is whatever the browser does; the style dots and the "Dismiss this note" button are 30 to 32 px (above the 24 px AA minimum, under the 44 px target we use elsewhere) |
| 11.2 screen reader | One live region, required and invalid fields, stub name and description, provenance in words, selected version, async progress and failure in words, version comparison with a text list of changes | Never heard in VoiceOver, NVDA or TalkBack; the order and wording of announcements is designed, not tested by ear |
| 11.3 reduced motion and sound | Non-animated path for printing feed, foil and holo, tilt, tear, fly-to-wall (the tear hand-off), card deals, camera eases, cart flight; sound controls visible; no audio-only information | Gift unwrap is CSS only and covered by the global rule, not by a dedicated check. The host-owned landing in `src/customer/landing/` arrived in PR #104 after this checklist's earlier motion evidence; this matrix does not claim a dedicated landing motion review or owner acceptance. |
| 11.4 widths | 320, 640, 200% zoom and 200% text on eight pages, long links and errors wrap, nothing cut off | 375 and 768 were not captured as their own runs; 200% zoom is emulated, not a real browser zoom; orientation change not tested |
| 11.5 contrast | Table above, run on every check | Contrast of the stub's own artwork and printed type is the design, not checked; no forced-colours or high-contrast pass |
| 11.6 automated and manual | `a11y` suite, evidence file, this checklist | Real device, touch and screen reader recordings; no owner has accepted the evidence |

## Known limits

- The in-place edit buttons on a stub scale with the stub, so on a phone a small line (a subtitle, 12 px tall at 390 px) is under 24 px. axe flags it and the suite records it as an exception. The same fields are reachable from 44 px controls only for facts (Facts sheet) and on desktop (Inspector); on a phone a title or subtitle can only be changed by picking it on the stub.
- A wall stub is a picture of a ticket, so its printed words are artwork. The button's name starts with the event title and date; axe's label-in-name rule is excepted for it.
- Dynamic pages that need an account (sign-in, claim, organizer) were checked for keyboard and focus only on the sign-in sheet.
- Headless Chrome only. Safari and Firefox focus rules differ (Safari does not focus buttons on click, which the opener-restore code allows for).
- Needs a real screen reader and a real phone: VoiceOver on iOS (swipe order through the stub and the sheets), TalkBack, NVDA with Firefox, the drawer on a real 320 px phone, the tear with a screen reader's touch exploration.
