# Product spec

Status: design phase (neatHack 2026). Every decision below was confirmed with the team in the design Q&A on 2026-10-09 and 2026-10-10.

> **For the 48-hour hackathon build, [`alignment.md`](alignment.md) takes precedence.** The input is an event URL first (screenshot drop is a stretch goal), a ChatKit side chat drives the agent, and only art changes create a new `DesignVersion`.

**The principle that overrides the rest: almost no form fields.** The only typed input that's ever required is a search query, and only when ingestion fails. Everything else is tap, swipe, drag or confirm. Two places allow optional free text: the remix prompt (hidden behind "more") and the note on the back of the stub.

## A. Product

| Decision | Choice |
|---|---|
| Who it's for | **Fans and organizers equally.** One engine: templates with variable data, plus single-stub mode. |
| Revenue | **The studio is free and leads to physical print.** Digital $9, card $29, print $49, framed $89. Organizer runs from $8/stub at 50+. |
| Outputs | Physical print (card, print, framed, with foil and holo finishes), an animated share card, an Apple/Google Wallet pass, PNG/SVG download. |
| Collection | **A core feature.** A persistent corkboard wall of every stub, which needs light accounts (magic link). There's also a public collection page. |
| Rights | Artist and venue names appear as text only, and the art is "inspired by" the event. Official artwork is allowed only when an organizer deal licenses it (B2B). |
| Positioning | Beat our own current TicketStub builder on UX and take on the wider keepsake market (Minted, Shutterfly, Artifact Uprising). |

## B. Studio capabilities

| Decision | Choice |
|---|---|
| Getting data in | **One "drop anything" zone is the hero.** It takes a screenshot, PDF, forwarded email or wallet pass, which is parsed by OCR plus an LLM. Event search with autocomplete is the fallback. |
| Design freedom | **Curated styles, direct edits on the stub, and a generative remix.** |
| Editable on the stub | Text, type and palette; photo and memory layer; shape and perforation; barcode/QR style; finish simulation (foil, holo, emboss). |
| Missing data | **Smart chips.** A field shows only if it's known, and the layout reflows so a sparse stub still looks intentional. A ghost "+" chip adds a field. |
| Low-confidence data | **The uncertain chip pulses on the stub.** Tapping it shows the top 2–3 guesses as chips. No text field. |
| Social | Matching stubs for the people you went with (you make the set, or they claim their own seat by link), gifting, and a public collection page. No co-editing. |
| Organizer mode | **Both paths.** The organizer designs in the same studio, locks brand elements and merges a CSV or guest list; attendees can also claim and personalize within those locks. |
| Realism | **Full tactile treatment:** paper grain, a 3D flip to the back, gyro or mouse tilt for foil, and a perforation tear. |
| Style families | Classic, Letterpress, Risograph, Minimal, and **Researched** (AI-generated from event research). See `stub-system.md`. |
| AI research | A sub-agent looks up tour and era visuals, venue and city character, night-of facts (weather, openers, setlist), and genre aesthetics. The user sees this as a "digging" moment while the stub prints. |
| Back of the stub | Setlist with a star on your favorite song, a handwritten-style note, who you were with (linked to their matching stubs), a QR code to the memory page, and the TicketStub stamp. |

## C. Flow and feel

| Decision | Choice |
|---|---|
| First run | **Straight to a built stub.** Drop a file, a printing reveal plays, and you land on a finished stub. No wizard. |
| Editing | **Tap to edit, with a floating toolbar** beside the selected element. A bottom sheet holds deeper options on mobile. |
| Exploring styles | **Both.** Swipe the stub to deal the next style (with a history strip to go back); long-press to open a grid of variants. |
| Remix input | Vibe chips (neon, risograph, 70s, minimal, from my photo). A free-text prompt is hidden behind "more". |
| Commerce | **Both.** The material toggle (Digital / Card / Print / Framed) is always on the stub and re-renders it on that stock with its price; the tear-off is the moment you check out. |
| Finishing | **Tear, then pin to the wall.** Drag along the perforation, the stub flies to the corkboard, and a sheet offers Share / Print / Wallet. |
| Tone | Tactile and skeuomorphic: paper by day, foil by night (see the brand kit). |
| Senses | Haptics, gyro tilt, and sound from cuelume.dev. **Sound is on by default**, with a visible mute toggle. |
| Platform | **Mobile-first.** Desktop is a scaled-up layout. |
| Account | No account to create. A magic link appears when you save to your wall or check out. |
| Collection wall | A corkboard: stubs pinned at slight angles, drag to rearrange. |

## D. Editor and screens (decided 2026-10-10)

| Decision | Choice |
|---|---|
| Platforms | **Mobile first, always with a desktop version.** Organizer mode is the deliberate exception: desktop first, with mobile for review and the per-attendee preview. |
| Edit controls | **The toolbar does quick edits; the inspector does the rest.** The floating toolbar has 3–4 one-tap actions. Deeper options go in the bottom sheet (mobile) or the right inspector (desktop). |
| Layout freedom | **Snap to slots.** Each style defines 3–5 positions per element; dragging snaps between them, and resizing steps through 3 sizes. A stub can't end up looking broken. |
| Printing wait (5–8 s) | **Watch, and tap facts to keep them.** Tapping a drifting fact card pins it to the stub, which is the first edit. "Skip" appears after 3 s. |
| Wall tap | **Lift and flip.** The stub lifts off the corkboard and can be flipped and tilted, with Open (memory page), Edit, Share and Print. |
| Memory page | Add photos; the people who were there (their matching stubs); event-specific content (setlist for concerts, score and moments for games). |
| Checkout | **Both:** a one-sheet buy now (Apple/Google Pay first, email only without Pay, magic link to the pay email), plus "Add to cart" for matching sets and several stubs. |
| Event types at launch | Concerts and festivals, sports games, theatre/comedy/shows, and a generic type (weddings, conferences, museums). |
| Game data | **Final score and moments.** Team names as text (no logos), a big final score, and 3–5 key moments (scorer, minute) from a sports data API, with tap-to-star like the setlist. |

| Unclaimed seat in a set | **The buyer decides.** After 7 days the buyer is nudged to print it with the seat number only, gift it by name, or drop it for a refund. |
| Memory page privacy | **Unlisted link by default.** Anyone with the link or the printed QR can view it; it isn't indexed. Friends appear on each other's pages only if both opt in. |
| Onboarding | **Teach in place, no tutorial.** The first stub demos each gesture once: a wiggle hints swipe, a peeling corner hints flip, and the perforation pulses at the end. |
| Sharing | **A still image with a link** to the memory page, in two sizes: tall 9:16 for Instagram/TikTok stories, wide 1200 × 630 as the preview in chats and feeds. In person, the printed QR opens the same page. |
| Share landing | **Memory page plus "Make yours".** The friend sees your stub (tilting, flippable) and the page, with a button to make their own from their ticket. |
| Yearly recap | "Your year in stubs" (Wrapped-style): later, not in the hackathon demo. |

### Back-side and memory content by event type

| Type | Main block | Extra |
|---|---|---|
| Concert / festival | Setlist (starred favorite) | Openers, tour, weather |
| Sports game | Final score and key moments (starred) | Teams, section, weather |
| Theatre / comedy / show | Cast or performer | Show run ("performance 41 of 120"), seat |
| Generic | Title, date, place | People, a short program or agenda |

Every type gets photos, the note, friends, the QR code to the memory page, and the Ts stamp.

## E. Demo, print and research (decided 2026-10-10)

| Decision | Choice |
|---|---|
| Demo format | **A pre-recorded video, 2–3 minutes.** The hackathon is online, so everything is digital. |
| Demo device | Both layouts are built; we film whichever shows best and rehearse on both. On desktop, mouse hover shows the tilt and foil, and we say that phones use the gyro. |
| Demo event | **The hackathon itself: a neatHack 2026 stub.** |
| Judges' stubs | **Both a QR code at the end of the video and a link in the chat.** Each judge claims a seat in the neatHack matching set and opens their own stub and memory page on their phone. |
| Research for generic events | **Who was there** (teams, attendee count, sponsors as text) and **what happened** (agenda, theme or prompt, winners filled in later). |
| Print sizes at launch | Classic stub 2 × 5.5 in, postage stamp 2 × 3 in, framed print 8 × 10, with foil and holo finishes as upgrades. |
| Print partner | **A print-on-demand service with an API** for cards and framed prints. Foil and holo come from a specialist added later. |
| Research agent budget | **Free APIs plus one LLM call:** Setlist.fm, Open-Meteo, a sports data API, and Wikipedia/Wikidata for venues. One LLM call writes the facts and the art prompt, plus one image generation. Target: under $0.05 per stub. |

## Hackathon demo must-haves

1. Drop a file and get a stub instantly, with a real parse.
2. Swipe through styles and remix.
3. Tactile preview: tilt, foil, flip and tear.
4. Collection wall and sharing.

## Open tensions

- **Organizer locks vs remix.** On a claimed stub, locks must override remix and style shuffle, or organizer branding breaks.
- **Swiping vs dragging elements.** On mobile, swiping to shuffle styles can collide with dragging elements. Swipe should work only on the stub's edge or background; taps on an element go to edit.
