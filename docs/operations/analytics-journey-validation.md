# Analytics journey validation (issue #39)

**Historical scope:** the recorded 281-check run predates PR [#104](https://github.com/Jevelopers-neatHack-2026/getticketstub.com/pull/104), which changed the host root composition by adding the app-native landing around `StudioStart`. It remains evidence for the build and journeys recorded at the time; it does not exercise or validate the later landing hero, demo controls, cards, or their analytics instrumentation. See the [flow coverage scope note](analytics-flow-coverage.md#scope-note-2026-10-12).

`scripts/check-analytics-journeys.mjs` drives the production build in a real headless Chrome, through the rendered UI,
and checks what the analytics tag would read (`window.dataLayer`) for every customer journey. It complements
`scripts/check-analytics-order.mjs` (33 checks: page-view ordering, warm navigation and remembered consent), which it
does not replace.

```sh
npm ci
npm run build
node scripts/check-analytics-journeys.mjs     # about 3 minutes; exits nonzero on any failure
```

Requirements: Node 22.23.3 (the repo's engine; also verified on 24.15.0), Chrome or Edge (or `CHROME_PATH`), and a
production build in `.next`. `JOURNEYS_TIMEOUT_MS` (default 8 minutes) is a watchdog: a stuck page or server fails
the run rather than hanging CI.

## What it isolates

- **No Google traffic.** The app is configured with the synthetic preview id `G-TEST000000`, never a real property.
  Chrome resolves loopback only (`scripts/lib/cdp.mjs`). The `gtag.js` request is answered locally with an empty
  script, or failed with `BlockedByClient` to play an ad blocker. Every request that leaves loopback is recorded, and
  the run fails if anything other than that one tag request appears.
- **No providers, no mail.** `TICKETSTUB_RUNTIME_MODE=demo`, so research, art and agent use fixtures, and a pasted
  non-demo link is refused (`demo_only`) before any server fetch. `TICKETSTUB_SANDBOX_MAIL=1`: a sign-in link is
  answered with a sandbox dev link and logged on the server, never emailed.
- **No shared state.** The database and the files folder are in a fresh temp directory, deleted afterwards. Chrome
  uses a throwaway profile, and each viewport starts with cleared site storage. Downloads are denied.
- **Synthetic private values.** Every typed name, email, gift note, organizer name, CSV header and cell, CSV and photo
  file name, share token, query and pasted link starts with `zq`. One case-insensitive sweep of the entire dataLayer
  (events, `config`, `set`, `consent`) and of every outbound request URL and body must find none.

## What it checks (281 checks: 140 at the phone size, 141 at desktop)

Everything runs twice: at a phone size (390 × 844, touch emulation, mobile) and a desktop size (1280 × 900). It mixes
warm in-app navigations (sidebar and tool links, plus internal `next/router` pushes, listed below) with hard loads.

**How controls are pressed, and what that does and does not show.** Every control press, including form submit
buttons, goes through one helper. The control is scrolled into view, allowed to settle for 150 ms, re-measured and
hit-tested (`elementFromPoint` must land on it), then pressed with a real pointer event at its centre
(`Input.dispatchMouseEvent`; at the phone size it is dispatched as a mouse event under touch emulation). The studio,
remix, agent, tear, contact-sheet, sidebar-row and submit-button presses must pass that test or the check fails.
Anywhere else, a control that isn't visible and uncovered falls back to a programmatic `element.click()`; each fallback
is printed and counted. The wall's stub lift uses the same pointer click.

In the final run, every press was a real pointer press on a visible, uncovered control: **73 at the phone size and 72 at
desktop, with 0 fallbacks.** At the phone size the sidebar's Wall row was already visible and uncovered at /search, so
the "Open the menu" fallback in the script (opening the drawer first) did not run. Keys are real key events
(`Input.dispatchKeyEvent`: ArrowRight, Enter, Escape). Text is typed with `Input.insertText` (key by key for the search
debounce). Files are attached to the real file inputs (`DOM.setFileInputFiles`). No form is submitted programmatically:
the agent's Send, the sign-in sheet's Email me a link, the claim pages' Claim my stub and the friends/gift forms are
all submitted by pressing their submit buttons.

**Not driven through the UI.** These are deliberate and listed so the evidence isn't overstated:
- **Internal navigation:** `window.next.router.push(...)` moves between screens (e.g. `/wall`, `/search`, `/checkout/:id`,
  `/cart`, `/wallet/:id`, `/gift/:id`, `/organizer`, and the seeded `/s/<token>`, `/u/<token>` and `/claim/g/<token>`
  links). This is the same client-side navigation a link triggers, used to reach a screen warm. It is not a person
  pressing a link.
- **Hard loads:** `Page.navigate` opens a URL fresh (first visit, reloads after a choice or withdrawal, the gift link,
  the server share link, the copied claim and attendee links, the landing page).
- **Browser stand-ins set in the page:** `navigator.share` is removed (no share sheet, so copy is used) or replaced
  with one that resolves or rejects with `AbortError`. `Date.now` is moved 16 minutes on for the quote expiry. The
  clipboard is read back to recover the copied server link, and `localStorage` is read to confirm the torn stub.
  Downloads are denied and the clipboard is granted (`Browser.*`). Site storage is cleared between journeys.
- **Reading state:** the `dataLayer`, `location.pathname` and field values are read with `Runtime.evaluate`.

This is **analytics coverage at emulated viewport sizes**. It is not a visual, layout or mobile-usability check:
there is no real device, no real touch screen and no on-screen keyboard, and passing does not show that a control is
comfortable to reach or legible. Root's phone checks of the deployed site cover that.

| Journey | Driven through | Asserted |
|---|---|---|
| Consent | the choice card, the Analytics tag | No tag request and no events before a choice. "No thanks" holds across an in-app navigation and a reload. Reopen → Allow: exactly one tag request (synthetic id) and one sanitized `page_view` (`/make`, query dropped). "Turn off analytics": `consent update analytics_storage=denied`, `ga-disable-<id>` set, then nothing more in the dataLayer (in-app navigation and a search). After a reload: no tag request, no events. |
| Blocked tag | Allow with the tag failed | The tag fails closed (disabled, zero events). A full demo creation still reaches the studio, nothing is sent, and there are no page errors. |
| Intake and creation | Make my stub (empty, a private link), the Pale Hours demo tag, Flip | `intake_invalid(empty)`. A link: `intake_submit(link, accepted)` → `creation_start` → `research_complete(error, demo_only)` → `creation_error`, no completion, back on `/make`. The demo: `intake_submit(make, demo, accepted)` → `creation_start` → `reveal_complete` → `creation_complete(created, storage ok)` → `page_view /studio/:id` → `studio_open(ready)`, each exactly once and in that order, with no `research_complete` for a handed-in demo. `studio_flip(button)` once. |
| Studio edits (visible controls) | the style dots (phone) or the styles rail (desktop), ArrowRight (desktop), the stock and finish pickers | `studio_edit(edition=minimal, method dots|rail, stored)`, desktop `studio_edit(edition, keyboard)`, `studio_edit(material=framed, stored)`, `studio_edit(finish=matte, stored)`: exactly one each, named by what changed. |
| Remix and agent (offline fixtures) | Remix tool → Neon → Remix the art; Ask tool → "Add the weather" → a typed question | `studio_panel(remix)`, one `remix_request(sheet, neon)`, one `remix_result(success, procedural, simulated, duration_ms)`: demo art is procedural and labelled simulated, never live. The new art is not counted again as a `studio_edit`. `agent_open(button)`, `agent_suggestion(weather)`, one `agent_message(weather)` answered by `rules` or `pending`. A typed question (seeded private words) is one `agent_message(question, rules)`: the demo runtime has no model (`/api/agent` answers 204). |
| Tear and finish | Tear off and pin to your wall → Back to styling; then again → "Or tear it off for me" (phone) or Enter on the focused handle (desktop) | One `tear_start` + one `tear_cancel`, with nothing torn. Then **exactly one `tear_complete`** (`method` = `auto` on the phone, `keyboard` on desktop, `storage ok`, stamped `/studio/:id`), then `page_view /wall`, then `wall_view`, in that order. **Exactly one `/wall` page view:** the tear lands on `/wall?pinned=<id>`, which the wall replaces with `/wall`, and the runtime counts that as one visit. That needs the runtime's transient-parameter normalization (`runtime.ts`, `TRANSIENT_PARAMS`), which this build includes. The stub is stored as torn on the device. |
| Search | typing key by key, the results list | One `search_results` per settled query (`zero` for an unknown show, `results` for a known one). `select_item(search_results, index 1, demo)`. The existing stub reopens (`intake_submit(reopened)`, no `creation_complete`). |
| Wall and sharing | a pointer click on the pinned stub, the lamp's Share and Page | `wall_stub_open(pointer)`. Share: `server_save(share, saved)` (guest-device snapshot), then one `share(copy, stub, lamp, success)`. Page: `share_landing(memory, valid, visitor, encoded)` on `/s/:token`. |
| Landings | in-app and hard loads of seeded links | Broken `/s/<token>?to=<name>`: `share_landing(invalid)`, location `/s/:token`. Missing `/u/<token>`: `share_landing(public_wall, not_found)`. Wrapped gift link: `page_view` first, `share_landing(gift)`, Tear it open → `gift_unwrap` once. The copied server link on its own device: `share_landing(memory, valid, owner, server)`. |
| Memory page (owner) | Share your stub, Story image | A finished share sheet is `share(native, success)`. A closed sheet (AbortError) is one `share(native, cancel)` and copies nothing. Download: `story_export(download, generated)`, which means the image was made and a download started (downloads are denied in this run). |
| Friends and set claim | Add, mode tabs, Copy link, Add the set to your cart, the claim page and sign-in sheet | `friends_update(add, 1, ok)`, then `mode` twice. `share(copy, invite, friends, success)`. `add_to_cart(friends)` with GA's `items[0]` = closed variant id × 2 seats, labelled sandbox. On the claim link: `claim_view(set, valid)` on `/claim/:set` with no query. A claim with no name is `claim_invalid(name_missing)`, not a claim. Email me a link → `signin_choice(sign_in, claim)` → `sign_in_link(claim, sandbox)`, and never `sign_in_return` or a login. A named claim is `claim_complete(set, claimed, ok)` followed by the `/s/:token` page view. Missing `/claim/g/<token>`: `claim_view(guest, invalid)`. |
| Checkout, cart, quote | material tab, Add to cart, Pay, Remove, a 16-minute clock jump, Refresh the quote, receipt email | One `begin_checkout(sandbox)` after its page view. `product_option(material=card)`. `add_to_cart(checkout)`. Pay with no email: `add_payment_info(sandbox)`, then `sandbox_order(placed, local, storage ok, error_code unauthorized)`: the server needs a receipt email, so the order stays on the device, and that is reported truthfully. `view_cart` (one line), `remove_from_cart(cart)`. Expired quote: one `quote_expired`; Pay is refused (`checkout_invalid(quote_expired)`, no order); then `quote_refresh`. Cart Pay with an email: `begin_checkout(cart)`, `add_payment_info`, `sandbox_order(placed, server, ok)`. |
| Wallet and gift | Wallet tab and Add, Delivery tabs and the Wrap switch, Send the gift | `wallet_option(google)`, then `wallet_select(google, simulated)`. Three `gift_option` changes carry only the choices. Send with no name: `gift_prepare(invalid)`. With a name and a note: `gift_prepare(prepared, link, has_message, storage server)` + `server_save(gift, saved)`; "prepared" is never "delivered". |
| Organizer and attendee | style tag, lock switch, organizer name (typed), Next, CSV file picker, a Seat "None" tag, contact sheet, publish tabs, Share one link, Copy link, Print all, the attendee page and its photo picker | `organizer_step(design, open)` once, after its page view. `organizer_design(edition)`, `(lock_logo)`, and nothing for the typed name. `organizer_step(guests, nav)`. The CSV is counted, never read: `organizer_csv(file, parsed, 4 rows, 3 columns)`. `organizer_mapping(auto)`, then `(manual)`. `organizer_check(4 rows, 1 missing name)`. `organizer_contact_select(inspect, rank 2, of 3)`. `organizer_publish(links, local, 3)`. `share(claim_link, organizer)`. The print run: `sandbox_order(organizer_print, placed, local, ok)`, local because there is no account email. Attendee: `claim_view(organizer, valid)` with location `/organizer/claim` (the `?d=` design is dropped). `photo_add(organizer_claim, success, 1)`. `claim_complete(organizer, claimed, ok)`. |
| Entry points | the landing page's search link, the sidebar's Wall row (opening the menu or sidebar first only if the row isn't a visible control) | `cta_select(search, home)` stamped `/` before the `/search` page view. The sidebar's Wall is `nav_select(wall, has_stubs)` stamped `/search`, followed by `wall_view(loaded)`. |
| Whole run, per size | — | No seeded value anywhere in the dataLayer or in outbound requests. No `?`/`#` in any `page_location`/`page_referrer`. Nothing leaves loopback except the tag request. No `purchase`, `refund`, `login` or `sign_up`. Every commerce event is labelled `sandbox` and every wallet event `simulated`. Every event carries the route template of the latest `page_view` before it. No page errors. |

## Results (2026-10-11)

- **Final run, Node 22.23.3, on a fresh production build that includes the runtime's `/wall?pinned` normalization:
  281 passed, 0 failed, in 163 s.** Every press was a real pointer press on a visible, uncovered control (73 phone,
  72 desktop, 0 fallbacks). It was a single run, so repeatability of this exact revision rests on the earlier drafts below.
- Earlier drafts, for history only: 218 checks passed on Node 22 (three runs) and Node 24.15.0 (one run); 224 on
  Node 22; 269 on Node 22 (three runs) before the last helper hardening. One Node 24 run of the 269 draft failed once:
  a desktop Flip press produced no `studio_flip`. The helper now lets a control settle and re-hit-tests it before
  pressing. Node 24 has not been re-run on the final revision.
- Fixed in the script during development, none of them app defects:
  - an assertion that expected `quantity` at event level (the tag moves it into GA's `items[0]`);
  - a click on the "Print all" publish tab instead of the button with the same words;
  - picking the Holo finish in the studio, which the product correctly never prints, so checkout's Pay and Add to cart
    were disabled further on (Matte is used instead);
  - taps on the remix and agent sheet buttons while the sheet was still fading in;
  - direct DOM clicks (contact sheet, sidebar Wall) and programmatic `requestSubmit()` calls (agent question, sign-in
    sheet, attendee claim), which Astra found. They now go through the visible pointer helper, pressing the real
    controls and submit buttons.

## Findings outside this script

- `scripts/check-analytics-order.mjs` sets `TICKETSTUB_DB` but not `TICKETSTUB_FILES`, so each run creates an empty,
  git-ignored `./data/files` in the checkout. It is harmless, but it writes outside its temp dir. This script sets both.
- The server's sandbox sign-in mail is logged to the server's stdout with the seeded address (`[mail] sandbox
  sign-in link for …`). That is the server's own developer log, not analytics, and is discarded with the run. It is
  noted so no one mistakes it for a leak.

## Not covered (stated limits)

- **Real Google.** No request reaches Google. DebugView/Realtime ingestion, GA admin settings, enhanced measurement
  and the deployed hosts are verified by hand (see `analytics-live-validation.md`).
- **Script races with the real tag.** The stub `gtag.js` is empty, so timing between the real tag's network sends
  and navigation is not exercised.
- **A real signed-in account.** Magic-link confirmation (`sign_in_return(signed_in)`), account sync, organizer guest
  links published to an account (`organizer_publish(server)`), guest claims (`/claim/g/` with a valid token), the
  account page (change email, delete) and sign-out are not driven. Only the signed-out and sandbox paths are.
- **Studio depth.** This script drives the Flip, a style (dots or rail, plus the keyboard on desktop), the stock and
  finish, a remix, the agent and the tear. It does **not** drive swipe and long-press gestures, the inspector's
  font/colour/foil/visibility, version picks, fact corrections, the phone pinch or the desktop zoom/preview.
  `studio_edit` for those comes from the same `update()` path, and its classification is unit-tested
  (`tests/analytics-flows.test.mjs`, `editChanges`), but no browser run here exercises those controls.
  `check-analytics-order.mjs` shows only the studio's mount (`studio_open`) and its ordering; it is **not** evidence
  of studio edits or of the tear. `research_complete(success)`, live art and a live agent reply cannot occur in the
  demo runtime.
- **Storage failure in the browser** (quota) is not simulated here; it is covered by `tests/analytics-flows.test.mjs`.
- **Native share.** Its success and cancel are played by replacing `navigator.share` in the page (headless Chrome has
  no share sheet). The clipboard is granted to the loopback origin, so copy failures are not exercised in the browser.
- **The server process isn't network-sandboxed.** Chrome is loopback-only, but the Next server is not. In the demo
  runtime the routes used here do not fetch (fixtures; `demo_only` for other links). A live runtime must not be used
  with this script.
- **CI.** The working tree's `.github/workflows/runtime.yml` (edited by root, not by this script's author) runs it right
  after `check-analytics-order.mjs`, with the job timeout raised to 25 minutes. It has not yet run on GitHub Actions
  (Ubuntu Chrome); the evidence above is from local runs on macOS.
