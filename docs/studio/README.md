# Ticket studio design

The customer-facing studio: give it an event (URL now, ticket screenshot later), watch the research agent dig up the night, then shuffle styles, edit, tilt the foil, tear it off and pin it to your wall.

This directory records design intent and reference studies. Use the [application status](../../README.md#status) and [implemented studio module](../../src/customer/studio/README.md) for current behavior; a proposal in these documents is not an implementation or release receipt.

Start with **[`alignment.md`](alignment.md)**. It maps this design onto the architecture kit's contracts and work packages, and lists the gaps to raise.

| Doc | Contents |
|---|---|
| [`alignment.md`](alignment.md) | Studio ↔ architecture decisions, which repo owns each piece, contract gaps |
| [`product-spec.md`](product-spec.md) | Every product, studio, flow, editor, demo and print decision, with dates |
| [`flow.md`](flow.md) | Screen-by-screen flow and gestures, the tear moment, organizer mode |
| [`stub-system.md`](stub-system.md) | Art / live type / material layers, event data, shapes, the five style editions, the art prompt template, finish tiers |
| [`research/holo-foil-technique.md`](research/holo-foil-technique.md) | On-screen foil and holo rendering (adapted from coven-cave) and the anti-pop rules |
| [`research/ticketstub-teardown.md`](research/ticketstub-teardown.md) | What the current builder does and what we're fixing |
| [`research/prompt-library.md`](research/prompt-library.md) | Image prompts behind the references, with lessons learned |
| [`references/`](references/README.md) | Curated reference images (WebP) by edition, back side and finish |

Brand (logo, tokens, voice, motion, foil rules): [brand-kit](https://github.com/Jevelopers-neatHack-2026/brand-kit).

**The principle:** almost no form fields. The only required typed input is the event link or a search; everything else is tap, swipe, drag or confirm.
