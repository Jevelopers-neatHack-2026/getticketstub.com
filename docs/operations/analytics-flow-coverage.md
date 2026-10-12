# Analytics flow coverage (issue #39)

Where every customer flow reports, what it may say, and how far that has been verified. The event names and the
only parameters each may carry are defined once, in `src/customer/analytics/catalog.ts` (schema v1); screens call
`flow(name, params)` from `src/customer/flows/events.ts`, which is typed on that catalog and passes straight to
`track()`. Configuration, consent, page views and GA administration are in `docs/operations/analytics.md`.

## Rules every row follows

- **Commit boundaries only.** An event fires in a handler after the action took effect, or in an effect guarded by a
  ref so it runs once per visit (Strict Mode re-runs and remounts don't repeat it). Nothing fires during render, per
  keystroke or per pointer frame. Typed fields (the note on the back, organizer names) are reported on blur or not at all.
- **Response boundaries for anything a server does.** Sign-in links, saves to the account, share snapshots, gifts,
  claims, publishing and order receipts are reported when the server has answered, with the outcome it gave.
- **Bounded values only.** Enums, booleans and clamped integers. Errors are reported by catalog code
  (`errorCode()` folds anything else into `unknown`). Prices are sent as `value` in major units, and items as a closed
  `material_finish_size` variant id. No titles, names, emails, notes, photos, tokens, URLs, queries, CSV
  headers or cells, file names, prompts, agent replies or error messages are sent. The runtime rejects the whole event otherwise.
- **No double counts.** A shared helper reports, and its callers don't: `shareLink`/`copyLink`/`CopyField` report
  `share`, `placeOrder` reports `sandbox_order`, `addToCartAndFly` reports `add_to_cart`, `openSignIn` reports
  `signin_choice`, `upsertStub`/`saveCart` report storage failures. The editor's single `update()` reports
  `studio_edit` from a diff of the stub (`editChanges()`), and it leaves out what other events already report: art
  (`remix_result`), photos (`photo_add`), the note (`note_edit`), friends (`friends_update`) and the tear (`tear_complete`).
- **Honest capability.** Commerce is `sandbox` (the runtime stamps it), wallets are `simulated`, and art is `live` only
  when a real image model made it. A sign-in choice or a sent link is never a login. A prepared gift or guest link is
  never a delivery. Local ownership on a device is never identity. A download is the image generated and the download
  started, never proof that a file was kept. `purchase`, `refund`, `login` and `sign_up` are never sent.
- **Storage is an outcome.** `upsertStub`, `saveWall`, `writeWall`, `removeStub`, `saveDeleted`, `saveCart`,
  `addToCart`, `updateSeat` and `restoreCartItem` now return `true` when stored. `addOrderStored()` returns
  `{ order, stored }`, and `keepStubResult()` returns `{ id, created, stored }`. Existing callers that ignore the result
  behave as before. A failed write reports `storage_failure {store, op, reason}` once per store, operation and reason
  per page load, without the record, and the flow's own event carries `storage: "failed"` instead of claiming it was kept.

Verification key: **T** = offline test in `tests/analytics-flows.test.mjs` exercises the real module through the real
runtime with a recording transport, private-data seeds, a check that nothing is rejected, and a check that nothing
private is exported. **tsc** = the call compiles against the catalog's types (an unknown name, parameter or enum
value fails `npm run typecheck`). **B** = needs the integrated browser QA (root) because it lives in a React
handler with no DOM test harness in this repo. **GA** = pending DebugView/Realtime verification in the designated
test property (not available to this work: no measurement id, no live traffic).

## Intake, search, creation

| File | Boundary | Event | Fields | Capability | Verified |
|---|---|---|---|---|---|
| `src/customer/start/StudioStart.tsx` (home `entry=home`, /make `entry=make`) | submit with an empty field | `intake_invalid` | entry, reason=`empty` | — | tsc, B, GA |
| same | submit of a link or words; demo tag | `intake_submit` | entry, input_source (`link`/`query`/`demo`), result (`accepted`; `reopened` when the demo is already on the wall) | demo for demos | tsc, B, GA |
| same | Paste button read the clipboard; text pasted into the field | `intake_paste` | entry, via (`button`/`field`), result (`success`/`empty`/`denied`) | — | tsc, B, GA |
| same, `src/app/new/NewStub.tsx` | `Printing.onDone`, after `keepStubResult` | `creation_complete` | entry, input_source, result (`created`/`reopened`), storage | — | T (keepStubResult), B, GA |
| same | `Printing.onError` (research failed) | `creation_error` | entry, input_source, error_code | — | tsc, B, GA |
| `src/app/new/NewStub.tsx` | the address was read, once per visit | `intake_submit` / `intake_invalid` (reason=`missing_input`) | entry=`new_page`, input_source (`picked` from search) | — | tsc, B, GA |
| `src/customer/studio/research/Printing.tsx` | the print starts, once per print | `creation_start` | entry, input_source | — | tsc, B, GA |
| same | research resolved or failed (not cancelled) | `research_complete` | entry, input_source, result, duration_ms, fact_count, error_code | research API timing itself is `api_call` (server agent) | tsc, B, GA |
| same | a receipt line tapped | `reveal_fact_toggle` | kept | — | tsc, B, GA |
| same | "Skip to the stub", first press | `reveal_skip` | entry | — | tsc, B, GA |
| same | the ink settles (`finish()`, once) | `reveal_complete` | entry, skipped, duration_ms (from facts in hand), fact_count, kept_count | — | tsc, B, GA |
| `src/customer/start/StudioStart.tsx` | "No link? Search for your show" | `cta_select` | cta=`search`, context (`home`/`make`) | — | T (catalog), B, GA |
| `src/customer/nav/NavFrame.tsx`, `src/customer/nav/routes.ts` `navItem` | a sidebar row chosen (every screen except the landing page, which has no sidebar and no wall link) | `nav_select` | item (closed list of place kinds: `wall`, `all_stubs`, `stub`, `studio`, `checkout`, `share_page`, `search`, …), has_stubs (a returning wall on this device) | local stubs only | T (`navItem` over the real tree), B, GA |
| `src/app/search/SearchShows.tsx` | a search settled (250 ms debounce, only the live query) | `search_results` | result (`results`/`zero`/`error`), result_count, query_kind (`empty`/`text`), error_code | results are demo fixtures | tsc, B, GA |
| same | a type filter changed | `search_filter` | filter | — | tsc, B, GA |
| same | a result opened (click or Enter on the first) | `select_item` (GA recommended) | item_list_id=`search_results`, index (rank), item_category (event type), demo | — | tsc, B, GA |
| same | "Paste the link instead" | `search_fallback` | to=`link` | — | tsc, B, GA |

## Studio

| File | Boundary | Event | Fields | Capability | Verified |
|---|---|---|---|---|---|
| `src/customer/studio/editor/Editor.tsx` | the editor mounted, once per stub | `studio_open` | status (`ready`/`missing`), device | — | tsc, B, GA |
| same, `update()` (every child control: FloatingToolbar, Inspector, ChipPopover, MaterialPicker, StyleGrid, FactsReview, VersionsPanel, AgentChat, AgentNotes, hidden-field tags) | each committed change, from `editChanges(prev, next)` | `studio_edit` | change (`edition`, `version_select`, `material`, `finish`, `font`, `title_color`, `foil`, `visibility`, `fact_kept`, `fact_correct`, `fact_confirm`, `fact_undo`); method for a style (`swipe`/`keyboard`/`grid`/`rail`/`dots`); edition/material/finish for those changes; storage | — | T (`editChanges` and the payload), B, GA |
| same | Flip tool or `F` | `studio_flip` | method | — | tsc, B, GA |
| same | zoom −/+/Fit, zoom to selection, print preview | `studio_view` | action | — | tsc, B, GA |
| same | rail/inspector fold, focus, a sheet opened (styles incl. long press, remix, facts, versions) | `studio_panel` | panel, open | — | tsc, B, GA |
| same | Ask tool / a line typed into a margin note | `agent_open` | via (`button`/`note`) | — | tsc, B, GA |
| same | tear strip pressed on an untorn stub; "Back to styling" or Escape | `tear_start`, `tear_cancel` | — | — | tsc, B, GA |
| `src/customer/studio/editor/TearFlow.tsx` + `stub/TearGesture.tsx` | the stub ripped; the gesture only says how, the stage saves and reports once | `tear_complete` | method (`drag`/`keyboard`/`auto`), storage | — | tsc, B, GA |
| `src/customer/studio/editor/RemixSheet.tsx` | "Remix the art" | `remix_request` | via=`sheet`, vibe (chip or `none`) | — | tsc, B, GA |
| same | remix answered, capped or failed; photo used as art | `remix_result` | via, result (`success`/`limited`/`error`), art (`generated`/`procedural`/`uploaded`), capability (`live` only for a real model; `local` for a photo), duration_ms, error_code | as reported by the art | T (`artOutcome`), B, GA |
| `src/customer/studio/agent/AgentNotes.tsx` | the note's "moodier" remix | `remix_request` / `remix_result` | via=`note` | as above | tsc, B, GA |
| `src/customer/studio/agent/AgentChat.tsx` | a message handled | `agent_message` | intent (`weather`/`photo`/`question`/`remix`), result (`live` model reply / `rules` / `pending` weather / `error`), error_code | `live` only when `/api/agent` returned a model reply; 204 is `rules` | tsc, B, GA |
| same | a suggestion chip | `agent_suggestion` | suggestion | — | tsc, B, GA |
| same | a typed remix | `remix_request` / `remix_result` | via=`agent`, vibe=`custom` (the words are never sent) | as above | tsc, B, GA |
| same, `src/customer/studio/editor/Memories.tsx` | photo read and added, or unreadable | `photo_add` | via (`agent`/`memories`), result, photo_count | local only | tsc, B, GA |
| `src/customer/studio/editor/Memories.tsx` | leaving the note field after changing it | `note_edit` | has_note | — | tsc, B, GA |
| `Editor.tsx`, `Tray.tsx` | Print it / Share page / Friends / missing-stub "Paste a new link" | `cta_select` | cta, context=`editor` | — | tsc, B, GA |

## Wall, sharing, memory page, public wall

| File | Boundary | Event | Fields | Capability | Verified |
|---|---|---|---|---|---|
| `src/app/wall/WallClient.tsx` | the stored wall was read, once per visit | `wall_view` | state (`empty`/`loaded`), stub_count | local | tsc, B, GA |
| same | filter changed | `wall_filter` | filter | — | tsc, B, GA |
| same | a stub lifted (click, or Enter/Space: `detail === 0`) | `wall_stub_open` | via | — | tsc, B, GA |
| same | a drag dropped; arrow-key moves settled (800 ms after the last key) | `wall_reorder` | method, storage | — | tsc, B, GA |
| same | "Take it down" confirmed | `wall_remove` | storage | — | T (removeStub result), B, GA |
| same | public switch: server answered, or signed out (local encoded link) | `wall_public_toggle` | public, result (`saved`/`local`/`error`), error_code | — | tsc, B, GA |
| same | "Stop sharing" answered | `wall_stop_sharing` | result, error_code | — | tsc, B, GA |
| same | receipt banner dismissed | `wall_banner_dismiss` | — | — | tsc, B, GA |
| same | Make / Print / Wallet / Friends; lamp Page / Edit / Print | `cta_select` | cta, context (`wall`/`lamp`) | — | tsc, B, GA |
| `src/customer/pages/share.ts` `shareLink` (wall, lamp, memory page) | the share sheet resolved, was closed (AbortError), or the copy fallback finished | `share` (GA recommended) | method (`native`/`copy`), content_type, context, result (`success`/`cancel`/`failure`) | a share is the step on this device, never delivery | T, B, GA |
| `src/customer/pages/share.ts` `copyLink`; `src/customer/pages/ui.tsx` `CopyField` | a copy attempt finished (public wall link, friends invite, gift link, organizer links) | `share` | method=`copy`, content_type (`wall`/`invite`/`gift`/`claim_link`), context, result | — | T, B, GA |
| `src/app/s/[token]/MemoryPage.tsx` | the link was read, once per token | `share_landing` | surface (`memory`/`gift`), result (`valid`/`invalid`), viewer (`owner` only for a server link to a stub on this device; local ownership, not identity), link_kind (`server`/`encoded`) | — | tsc, B, GA |
| same | "Story image": image built and download started, or build failed | `story_export` | action=`download`, result (`generated`/`failed`) | not proof the file was kept | tsc, B, GA |
| `src/customer/studio/download/DownloadStub.tsx` (editor tray, lamp, memory page) | "Download stub": the stub drawn to a PNG and handed over (download, share sheet, tab) or failed | `stub_download` | side, context, method, result, error_code | not proof the file was kept | tsc, B, GA |
| same | photos added; a photo removed | `photo_add` (via=`memory_page`), `memory_photo_remove` | result, photo_count, storage | local only | tsc, B, GA |
| same | "Stop sharing" answered | `stop_sharing_stub` | result, error_code | — | tsc, B, GA |
| same | the gift wrap is torn open (animation done) | `gift_unwrap` | — | — | tsc, B, GA |
| same | owner Print / Wallet / Friends; visitor make-your-own / claim | `cta_select` | cta, context=`memory` | — | tsc, B, GA |
| `src/app/u/[token]/PublicWall.tsx` | the wall link was read, once per token | `share_landing` | surface=`public_wall`, result (`valid`/`not_found`/`invalid`/`error`), viewer=`visitor`, link_kind | — | tsc, B, GA |
| same | a stub opened | `public_wall_select` | rank | — | tsc, B, GA |
| same | "Make your own wall" | `cta_select` | cta=`make_own`, context=`public_wall` | — | tsc, B, GA |

## Friends, claims, account

| File | Boundary | Event | Fields | Capability | Verified |
|---|---|---|---|---|---|
| `src/app/friends/[id]/FriendsClient.tsx` | a friend added or removed; the mode changed (saved each time) | `friends_update` | action, friend_count (counts only), mode, storage | — | tsc, B, GA |
| same | "Add the set to your cart" | `add_to_cart` | via `addToCartAndFly`, context=`friends` | sandbox | T, B, GA |
| `src/app/claim/[set]/ClaimClient.tsx` | the set link read | `claim_view` | flow=`set`, result | — | tsc, B, GA |
| same | Claim with no name; claim stored | `claim_invalid` (reason=`name_missing`), `claim_complete` | flow, result=`claimed`, storage | a local claim on this device | tsc, B, GA |
| `src/app/claim/g/[token]/GuestClaimClient.tsx` | claim info answered (valid/expired/claimed/missing/error) | `claim_view` | flow=`guest`, result, error_code | — | tsc, B, GA |
| same | `/api/claim` answered | `claim_complete` | flow=`guest`, result (`claimed`/`error`), storage, error_code | the account has it | tsc, B, GA |
| `src/app/organizer/claim/OrganizerClaimClient.tsx` | link read; claim with no name; claim stored | `claim_view`, `claim_invalid`, `claim_complete` | flow=`organizer` | a local claim | tsc, B, GA |
| same | the attendee picked a photo: it could be read or not | `photo_add` | via=`organizer_claim`, result, photo_count (0/1) | never the photo or file name | T (catalog), B, GA |
| `src/customer/account/signin.ts` | the sign-in sheet opened (once per opening); first-pin "Not now" | `signin_choice` | choice (`sign_in`/`skip`), reason | a choice, not a login | T, B, GA |
| `src/customer/account/SignInSheet.tsx` | bad email; `/api/auth/link` answered; "Not now" | `sign_in_link`, `signin_choice` | reason, result (`sent`/`sandbox` dev link/`invalid`/`error`), error_code | a link sent is not a sign-in | tsc, B, GA |
| `src/customer/account/AccountRoot.tsx` | back from the emailed link: after `/api/auth/me` answered; or `?signin=expired` | `sign_in_return` | result (`signed_in` only when the server says so / `not_signed_in` / `expired`) | the only signed-in signal; GA `login` stays unused | tsc, B, GA |
| `src/customer/account/useAccount.ts` | `/api/auth/signout` answered or failed | `sign_out` | result (`done`/`offline`) | — | tsc, B, GA |
| `src/app/account/AccountClient.tsx` | change-email link answered; delete answered | `account_action` | action, result (`sent`/`sandbox`/`invalid`/`done`/`error`), error_code | an email change happens only when the link is opened | tsc, B, GA |
| `src/customer/account/sync.ts` | a sync answered: the first success, every failure, the success after a failure | `server_save` | kind=`sync`, result, error_code | — | T, B, GA |
| `src/customer/account/share.ts` | share snapshot saved, failed (encoded link used), or saving off | `server_save` | kind=`share`, result (`saved`/`failed`/`off`), error_code | — | T, B, GA |

## Commerce (sandbox), gift, wallet

| File | Boundary | Event | Fields | Capability | Verified |
|---|---|---|---|---|---|
| `src/customer/cart/cartStore.ts` `addToCartAndFly` | the line was stored (an unstored add is only a storage failure) | `add_to_cart` | currency, value, item_id (variant), quantity (billable seats), context | sandbox (stamped) | T |
| `src/app/checkout/[id]/CheckoutClient.tsx` | the stub was found, once per visit | `begin_checkout` | currency, value, item_id, item_count, context=`checkout` | sandbox | tsc, B, GA |
| same | material, finish or size changed | `product_option` | option, material, finish, size | — | tsc, B, GA |
| same | the 15-minute quote ran out (the clock's tick); "Refresh the quote" | `quote_expired`, `quote_refresh` | context=`checkout` | quotes are fixtures | tsc, B, GA |
| same, `src/app/cart/CartClient.tsx` | Pay refused: blocked variant, expired quote, choose again, bad email | `checkout_invalid` | reason | — | tsc, B, GA |
| same | Pay accepted (sandbox card chosen) | `add_payment_info` | payment_type=`card` | sandbox; no payment details exist | tsc, B, GA |
| `src/customer/account/orders.ts` `placeOrder` (checkout, cart, organizer print run) | after the server answered, or wasn't asked (saving off); not when the server started a provider checkout (that is the server's `checkout_started`, and `order_paid` follows from the webhook) | `sandbox_order` | method, result (`placed` when the server kept it or the local record was stored; `not_persisted` when neither, sent without value/currency; `blocked`), receipt (`server`/`local`), line_count, value, currency, storage (the local record), error_code (why the server didn't keep it, incl. `storage_unavailable` when saving is off) | sandbox; never `purchase`, never revenue | T (server receipt, refused, quota+server, quota+refused, saving off, saving off+quota, gift print) |
| same `resendOrder` | the retry answered (no second record) | `sandbox_order_retry` | result, error_code | sandbox | T |
| `src/app/cart/CartClient.tsx` | the stored cart read, once per visit; first Pay press | `view_cart`; `begin_checkout` (context=`cart`) | currency, value, item_count (+ item_id for one line) | sandbox | tsc, B, GA |
| same, `src/customer/cart/MiniCart.tsx` | a line removed and stored; the mini cart opened; Undo | `remove_from_cart`; `view_cart` (context=`mini_cart`); `cart_update` (action=`remove_undo`) | currency, value, item_id, quantity, context | sandbox | tsc, B, GA |
| `src/app/cart/unclaimed/[id]/UnclaimedClient.tsx`, `src/app/gift/[id]/GiftClient.tsx` | the seat decision stored | `seat_decision` | decision (`seat_only`/`gift`/`drop`) | a simulated refund for drop | tsc, B, GA |
| `src/app/gift/[id]/GiftClient.tsx` | no name; print blocked; link made (server or local); failed | `gift_prepare` | delivery, wrap, has_message, result (`invalid`/`blocked`/`prepared`/`error`), storage (`server`/`local`), error_code | preparation, never delivery | tsc, B, GA |
| same | a print gift: local sandbox record | `sandbox_order` | method=`gift_print`, receipt=`local`, result `placed` only if stored, else `not_persisted` | sandbox | T (`reportOrder`), B |
| same | `/api/gift` answered | `server_save` | kind=`gift` | — | tsc, B, GA |
| same | "Stop this gift link" answered | `gift_revoke` | result, error_code | — | tsc, B, GA |
| `src/app/gift/[id]/GiftClient.tsx` | delivery tab or wrap switch changed before sending | `gift_option` | option (`delivery`/`wrap`), delivery, wrap | the choice only | T (catalog), B, GA |
| `src/app/wallet/[id]/WalletClient.tsx` | the wallet tab switched | `wallet_option` | provider | a preference, not a pass | T (catalog), B, GA |
| `src/app/wallet/[id]/WalletClient.tsx` | "Add to Apple/Google Wallet" | `wallet_select` | provider | simulated (stamped); never a pass issued | tsc, B, GA |

## Organizer

| File | Boundary | Event | Fields | Capability | Verified |
|---|---|---|---|---|---|
| `src/app/organizer/OrganizerClient.tsx`, `src/customer/pages/organizer.ts` (`reportOpeningStep`, `reportStepMove`) | the wizard settled when it opened (once per mount, guarded by a ref so Strict Mode's second effect run, which no longer finds the draft, adds nothing); each move between steps | `organizer_step` | step, via (`open` = Design, `restore` = Publish after sign-in, `nav`) | — | T (opening once, restore, moves, no self-moves), B, GA |
| same | style, second style, logo/title lock chosen | `organizer_design` | change, edition, value | — | tsc, B, GA |
| same, `src/customer/pages/organizer.ts` `csvSummary` | a CSV read (file, drop or sample) or unreadable | `organizer_csv` | source, result (`parsed`/`empty`/`no_rows`/`error`), row_count, column_count | parsed on the device | T |
| same | columns matched automatically on load; a column picked by hand | `organizer_mapping` | result (`auto`/`manual`), has_seat, has_extra | — | tsc, B, GA |
| same, `mappedCounts` | moving to Check | `organizer_check` | row_count, missing_name_count | — | T |
| same | `/api/organizer/events` answered; "Share one link without guest names" | `organizer_publish` | mode=`links`, result (`server`/`local`/`error`), guest_count, error_code | links prepared, not delivered | tsc, B, GA |
| same | a stub on the Check step's contact sheet inspected (a different one); "Show more" | `organizer_contact_select` | action (`inspect`/`show_more`), rank (1-based position), shown_count, row_count | never the guest | T (catalog), B, GA |
| same | guest links copied (one, or all as a list) | `share` | via `copyLink`: method=`copy`, content_type=`claim_link`, context=`organizer` | the copied text never travels | T (copyLink), B, GA |
| same | print run placed | `sandbox_order` | method=`organizer_print` (via `placeOrder`) | sandbox | T (placeOrder), B |
| same | the publish draft could not be kept before sign-in | `storage_failure` | store=`prefs`, op=`write`, reason | — | tsc, B |

## Storage

| File | Boundary | Event | Fields | Verified |
|---|---|---|---|---|
| `src/customer/studio/store.ts` | wall/tombstone read or write threw | `storage_failure` | store (`wall`/`deleted`), op, reason (`quota`/`unavailable`/`parse`/`unknown`), once per page load per combination | T |
| `src/customer/pages/commerce.ts` | cart/order read or write threw | `storage_failure` | store (`cart`/`orders`), op, reason | T |

## Deliberately not reported

- Page views: the analytics provider records them centrally from `src/app/layout.tsx`, and no screen emits its own.
  Entry clicks are reported as the control that was used: the start section's search link is `cta_select`, and a
  sidebar row is `nav_select` with `has_stubs` marking a returning wall. The landing page has no wall link today, so a
  returning visitor who goes from the landing page to the wall without the sidebar shows up only as a page view.
- Every keystroke, pointer move, camera pan or pinch, hover, render, and the editor's per-key note saves (only
  `note_edit` on blur).
- **Intentional privacy exclusion:** the organizer's name and event-title fields, the gift recipient and note, the
  claim names, the attendee's note, and the friend names are free text. Their contents, lengths and edit events are
  not reported. Only the bounded outcomes that follow them are (`gift_prepare.has_message`, `claim_invalid` for a
  missing name, friend counts).
- Generic reads and writes (`loadWall`, `getStub`, `quote()`, `loadCart`) and the API client's request attempts.
  Client-observed API timing is `api_call`, owned by the server/observability work (`src/customer/studio/research/client.ts`).
- Removing the attendee's photo again, and re-selecting the contact-sheet stub that is already shown (no change).
- `share_landing` doesn't record who opened a link: the viewer is `owner` only when this device holds the stub and
  the link is a server snapshot. That is local ownership, not identity, and cross-device linkage is not attempted.

## Verification status and limits

- `tests/analytics-flows.test.mjs` (28 tests) runs storage, orders, share/copy, share snapshots, sync, sign-in
  choice, cart adds, the sidebar's place kinds, the option/position events, the editor's edit diff, the organizer CSV summary and the analytics-off path through the real
  runtime (`configureAnalytics` with a recording transport, consent granted). After every test it asserts that the
  catalog rejected nothing (no silent drops), that no seeded private value (names, email, note, photo data, share
  token, event URL, CSV header/cell, file name, error message) reached the transport, and that `purchase`/`refund`/
  `login`/`sign_up` never appeared. A mutation check (adding the URL to a `share` payload) fails the suite as expected.
- Not unit-tested: React handlers in `.tsx` screens (StudioStart, Printing, Editor and its sheets, Wall, Memory page,
  Public wall, Claims, Gift, Wallet, Checkout, Cart, Organizer, Account). This repo has no DOM test harness, and
  adding one is out of scope (no package changes). Their calls are type-checked against the catalog. Their
  boundaries need the integrated headless-Chrome QA (root, `scripts/lib/cdp.mjs`) with a recording transport, on phone
  and desktop widths: creation journey, zero results, research failure, storage quota, share cancel, quote expiry,
  sandbox order and retry.
- External verification: root created dedicated GA4 properties (production `G-RVV7ZNF463`, preview/development
  `G-M2ELMGCNKW`; enhanced measurement off) and is verifying ingestion into the preview property with synthetic traffic
  in Chrome. This flows work sent no traffic itself. DebugView/Realtime evidence for these flows (phone and desktop)
  is pending that QA. The new parameters `item`, `option`, `provider`, `action`, `rank`, `shown_count` and
  `has_stubs` are not among the 14 registered custom dimensions and 2 metrics, so they appear in DebugView and
  explorations of raw events but not in standard reports until someone registers them (an admin step, not code).
