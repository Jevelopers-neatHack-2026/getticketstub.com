# Image prompt library

These are the Midjourney prompts behind `references/`, with notes on what worked. All events are fictional, so no real marks show up.

## Stub art by edition

**Classic thermal (second pass).** This captures the look, but Midjourney added real Ticketmaster logos, so the output is internal only. Next time describe a "1990s computerized box-office ticket" and don't name the vendor.
```
Flat lay of a real 1990s computerized box-office thermal concert ticket, glossy thin card, faint blue-and-pink security wave pattern, black dot-matrix printed rows of event info, perforated stub on the left, slightly faded thermal ink, small coffee ring, overhead soft daylight, documentary product photo --ar 3:1 --style raw
```

**Letterpress**
```
1970s letterpress concert ticket stub on thick cream cotton card stock, two-color print in burnt orange and deep brown, deep debossed type impression, slightly misregistered ink, rubber-stamped date "JUN 3 1977" in red at an angle, decorative border with art-deco corners, admit-one style layout, perforated edge, text "MOONLIGHT ORCHARD — THE GRANADA THEATRE", macro photograph showing paper texture and ink squash, natural window light
```

**Risograph**
```
Concert ticket stub designed like a risograph gig poster, bold fluorescent pink and teal overprint with visible grain and misregistration, abstract illustration of a crowd and stage lights, chunky condensed display type "STATIC BLOOM — LIVE AT THE FOUNDRY", minimal secondary info in small caps, perforated stub on the right, printed on uncoated off-white paper, flat lay photo with soft shadow, zine aesthetic
```

**Minimal**
```
Minimalist Swiss-style event ticket stub, strict grid, oversized Helvetica-like numerals "12.10", small precise metadata in a single column, lots of whitespace, single accent color (signal orange) on bone-white heavy matte stock, thin hairline rules, small QR code bottom corner, perforation with clean circular holes, museum-quality product photography, soft diffused light, subtle emboss on the title "NORTHERN LINES"
```

**Researched (whole stub).** The output came out shaped like a postage stamp without being asked, and the AI text was garbled ("MANCTOM"), which is why we split art from type.
```
Commemorative concert ticket stub inspired by a rainy autumn night in Glasgow, an indie-folk band's second album era with muted moss green and fog grey, Victorian sandstone concert hall architecture, illustrated motifs of rain streaks, stone arches, a lone streetlamp, typography mood hand-cut serif, slightly weathered, foil-stamped detail on the title, small printed facts along the edge "NIGHT 2 OF 3 · 7°C · RAIN", perforated stub, premium card stock, editorial product photo
```

**Researched art layer (final).** This produces clean text-free art with real rain. The hero result is `researched-art-layer-hero.webp`.
```
Illustration only, no text, no letters: rainy night in Glasgow, Victorian sandstone concert hall with glowing arched windows, lone streetlamp, figure with orange umbrella, moss green and amber palette, heavy rain streaks, wet reflective pavement, painterly vintage travel-poster style, vertical composition with empty dark space at top for a title --ar 2:3 --no text, letters, typography, snow, snowflakes
```

## Back side and finishes

```
Back side of a premium concert ticket stub on cream card stock: handwritten-style setlist in pen with one song circled and starred, a short handwritten note "you screamed every word — 10.12", three small circular friend avatars with names, a small printed QR code labeled "memories", tiny "TicketStub" wordmark at the bottom, perforated edge, top-down product photo, warm light, tactile paper grain
```
```
Close-up macro of a concert ticket stub with [holographic foil title / gold hot-foil stamping / blind emboss / glossy spot UV over matte], tilted 30 degrees catching light, rainbow refraction, shallow depth of field, studio product photography, black background
```

## App screen prompts (not generated yet)

Add this suffix to every screen prompt:
```
— mobile app UI mockup, iPhone frame, tactile skeuomorphic design, warm paper textures, soft realistic shadows, physical-object feel like Teenage Engineering meets a stationery store, clean minimal UI chrome, high-fidelity Dribbble shot
```

| Screen | Prompt core |
|---|---|
| Drop zone | Empty state: a large dashed drop area shaped like a blank ticket stub on a textured desk, label "Drop a ticket, screenshot, or email", a search pill, faded stubs peeking from the bottom |
| Printing | A stub emerging from a thermal-printer slot, half printed, paper fact cards drifting around it ("Night 2 of the tour", "7°C, light rain", "Opener: Velvet Coast") |
| Editor | A finished stub on the desk, the artist name selected with a floating toolbar, a shimmering low-confidence date chip, a ghost "+ seat" chip, and a material switcher with prices |
| Shuffle | Stub variants fanned like cards with the top one mid-swipe, plus vibe chips and a dice button |
| Material | The stub as a framed print on a wall with holo shimmer, a Digital/Card/Print/Framed control, and "Add to cart — $89" |
| Tear | A finger dragging along the perforation, the stub half torn with paper fibers, a corkboard below |
| Wall | A corkboard of mixed-style stubs pinned at angles, with the header "My shows — 47 nights, 12 cities" |
| Matching | Four matching stubs, two claimed with avatars and two ghosted with "Send claim link" |
| Organizer | A desktop UI with a locked brand stub, a guest-list CSV panel, and a "Seat A12 — Priya, 1 / 240" preview |
