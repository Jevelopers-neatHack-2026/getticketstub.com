# Wireframe coverage

Every scenario decided in `product-spec.md` and `alignment.md`, and the wireframe screens that blueprint it. All screens are lo-fi and mobile first, with a desktop version of each (organizer mode is the one deliberate desktop-first exception). They live on the [Ticket Studio Editor Wireframe](https://claude.ai/artifact/UtqYmCtBT1Chnh9bGEJ2d9) canvas (private link; needs team access).

On that canvas, **0 · Flow map** shows every screen and the gesture or event that connects it. Screens with a Play button are linked into a clickable prototype: start at *Link input* (phone) or *Link input, desktop*.

| Scenario | Phone | Desktop |
|---|---|---|
| **Input** | | |
| Paste an event link (primary) | UrlPhone | UrlDesktop |
| Drop a screenshot / email / PDF (stretch) | DropPhone | DropDesktop |
| Search for your show (fallback) | SearchPhone | SearchDesktop |
| **Printing** | | |
| Printing reveal, research fact cards, tap to keep, Skip | PrintingPhone | PrintingDesktop |
| First-stub gesture hints (wiggle, peel, pulse, once each) | OnboardingPhone | OnboardingDesktop |
| **Editor** | | |
| Editor at rest (chips, styles strip, material toggle, CTA) | Main | Desktop |
| Element selected: toolbar for quick edits, sheet or inspector for deep ones | Selected | Desktop |
| Fix an unsure fact (2–3 guesses, "None of these" → search) | ChipPhone | ChipDesktop |
| Swipe styles; long-press for all 5 styles | GridPhone | GridDesktop |
| Remix the art (vibe chips, new design version, keeps text) | RemixPhone | RemixDesktop |
| Agent side chat (facts with sources, unsure facts, describe it) | ChatPhone | ChatDesktop |
| Flip to the back (concert) | Back | BackDesktop |
| Back by event type: game, show, generic | BackTypesPhone | BackTypesDesktop |
| Material preview on stock (card, print, framed; matte, foil, holo; sizes) | MaterialPhone | MaterialDesktop |
| Friends: matching set, made by you or claimed by link | FriendsPhone | FriendsDesktop |
| Gift a stub (digital or shipped print, note, "wrap it") | GiftPhone | GiftDesktop |
| **Finish and keep** | | |
| Tear to finish → Share / Print / Wallet | TearPhone | TearDesktop |
| Wallet pass (add, plus the pass itself) | WalletPhone | WalletDesktop |
| Corkboard wall, lift a stub (Open / Edit / Share / Print) | WallPhone | WallDesktop |
| Empty wall (first visit) and "check your email" magic link | EmptyWallPhone | EmptyWallDesktop |
| Public wall (unlisted link; owner banner) | PublicWallPhone | PublicWallDesktop |
| Memory page: photos, who was there, event content by type | MemoryPhone (game) | MemoryDesktop (concert) |
| **Share** | | |
| Share sheet: story 9:16, link preview 1200×630, QR | SharePhone | ShareDesktop |
| Friend's landing: tilt and flip the stub, "Make yours", claim | LandingPhone | LandingDesktop |
| Judge claim (neatHack 2026 matching set, Google/Apple, no typing) | ClaimPhone | ClaimDesktop |
| **Buy** | | |
| Buy now sheet (Pay first, email only without Pay, magic link) | CheckoutPhone | CheckoutDesktop |
| Cart with a matching set and an unclaimed seat | CartPhone | CartDesktop |
| Unclaimed seat after 7 days: print seat-only, gift, or refund | UnclaimedPhone | UnclaimedDesktop |
| **Organizer** (desktop first) | | |
| Design, lock, guest list, columns matched, page through attendees, publish | OrganizerPhone (review) | OrganizerDesktop |
| Attendee opens the claim link, personalizes inside the locks | AttendeeClaimPhone | AttendeeClaimDesktop |
| **Errors** | | |
| Can't read link · research slow · art failed | ErrorsPhone | ErrorsDesktop |

## Not wireframed, on purpose

- **Yearly recap ("your year in stubs"):** decided for later, not the hackathon.
- **Sound, haptics, reduced motion:** behaviour, not screens. Specified in brand-kit `docs/motion-sound-haptics.md`.
- **Foil and tilt rendering:** behaviour. Specified in brand-kit `docs/material-foil.md` and `research/holo-foil-technique.md`.
