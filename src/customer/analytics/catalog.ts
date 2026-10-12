// The analytics event catalog: every event the app may send and every parameter it may carry. This is
// the single source of truth; src/customer/flows/events.ts names the same events for the screens.
// Parameters are closed enums, bounded integers, money and booleans; there is no free-text parameter,
// so a title, a name, a URL, a token or anything typed has nowhere to go. Bump SCHEMA_VERSION when a
// name or a parameter's meaning changes (adding events or enum values does not).
import { MESSAGE_CODES } from "@/customer/feedback-messages/messages";

export const SCHEMA_VERSION = 1;

export type ParamSpec =
  | { kind: "enum"; values: readonly string[] }
  | { kind: "int"; min: number; max: number }
  | { kind: "money" }
  | { kind: "bool" };

export const oneOf = <const V extends readonly string[]>(...values: V) => ({ kind: "enum", values }) as const;
const int = (max: number, min = 0) => ({ kind: "int", min, max }) as const;
const bool = { kind: "bool" } as const;
/** Major currency units (dollars), the unit GA ecommerce expects: 0-100000, two decimals. */
const money = { kind: "money" } as const;
export const MONEY_MAX = 100_000;

export const ENTRY = oneOf("home", "make", "new_page", "search");
export const INPUT_SOURCE = oneOf("link", "query", "demo", "picked");
/** The bounded server/browser error catalog (feedback-messages); never an error message. */
export const ERROR_CODE = oneOf(...MESSAGE_CODES);
/** Where a result came from. `live` is a real provider; commerce is always `sandbox`. */
export const CAPABILITY = oneOf("live", "simulated", "sandbox", "demo", "local");
export const EDITION = oneOf("researched", "letterpress", "risograph", "minimal", "classic");
export const MATERIAL = oneOf("digital", "card", "print", "framed");
export const FINISH = oneOf("matte", "foil", "holo");
export const SIZE = oneOf("classic", "stamp", "framed", "file");
export const EVENT_TYPE = oneOf("all", "concert", "game", "show", "generic");
export const STORAGE = oneOf("ok", "failed");
const COUNT = int(1000);
const MS = int(600_000);
const CLAIM_FLOW = oneOf("set", "guest", "organizer");
const PAYMENT = oneOf("apple_pay", "google_pay", "card", "gift_print", "organizer_print");
const SANDBOX = oneOf("sandbox");
const SIMULATED = oneOf("simulated");
const USD = oneOf("USD");

/** Sellable variants: material_finish_size. A closed set of 48, never a stub, cart, quote or order id. */
export const VARIANT_IDS = MATERIAL.values.flatMap((m) => FINISH.values.flatMap((f) => SIZE.values.map((s) => `${m}_${f}_${s}`)));
const VARIANT = { kind: "enum", values: VARIANT_IDS } as const;

export interface EventSpec {
  flow: string;
  params: Readonly<Record<string, ParamSpec>>;
  /** A Google Analytics recommended event, sent under its documented name. */
  recommended?: true;
  /** Values the runtime attaches regardless of the caller: the truth about commerce and wallets. */
  fixed?: Readonly<Record<string, string>>;
}

const ev = <const P extends Record<string, ParamSpec>>(flow: string, params: P) => ({ flow, params });
const rec = <const P extends Record<string, ParamSpec>>(flow: string, params: P) => ({ flow, params, recommended: true as const });

/**
 * Every product event track() accepts. A name, parameter or value not listed here is rejected at
 * runtime and the whole event is dropped. Emission boundaries: docs/operations/analytics.md.
 */
export const EVENTS = {
  // Intake, search, creation
  intake_submit: ev("intake", { entry: ENTRY, input_source: INPUT_SOURCE, result: oneOf("accepted", "reopened") }),
  intake_invalid: ev("intake", { entry: ENTRY, reason: oneOf("empty", "clipboard_empty", "clipboard_denied", "missing_input") }),
  intake_paste: ev("intake", { entry: ENTRY, result: oneOf("success", "empty", "denied"), via: oneOf("button", "field") }),
  search_results: ev("search", { result: oneOf("results", "zero", "error"), result_count: COUNT, query_kind: oneOf("empty", "text"), error_code: ERROR_CODE }),
  search_filter: ev("search", { filter: EVENT_TYPE }),
  /** Search result chosen: GA's recommended list-selection event, with the list, rank and event type only. */
  select_item: rec("search", { item_list_id: oneOf("search_results"), index: int(100), item_category: EVENT_TYPE, demo: bool }),
  search_fallback: ev("search", { to: oneOf("link") }),
  creation_start: ev("create", { entry: ENTRY, input_source: INPUT_SOURCE }),
  research_complete: ev("create", { entry: ENTRY, input_source: INPUT_SOURCE, result: oneOf("success", "error"), duration_ms: MS, fact_count: COUNT, error_code: ERROR_CODE }),
  reveal_fact_toggle: ev("create", { kept: bool }),
  reveal_skip: ev("create", { entry: ENTRY }),
  reveal_complete: ev("create", { entry: ENTRY, skipped: bool, duration_ms: MS, fact_count: COUNT, kept_count: COUNT }),
  creation_complete: ev("create", { entry: ENTRY, input_source: INPUT_SOURCE, result: oneOf("created", "reopened"), storage: STORAGE }),
  creation_error: ev("create", { entry: ENTRY, input_source: INPUT_SOURCE, error_code: ERROR_CODE }),

  // Studio (committed actions only, never renders or pointer frames)
  studio_open: ev("editor", { status: oneOf("ready", "missing"), device: oneOf("desktop", "phone") }),
  studio_edit: ev("editor", {
    change: oneOf("edition", "art_version", "version_select", "material", "finish", "font", "title_color", "foil", "visibility", "fact_kept", "fact_correct", "fact_confirm", "fact_undo", "photos", "friends"),
    method: oneOf("swipe", "keyboard", "grid", "rail", "dots", "other"),
    edition: EDITION,
    material: MATERIAL,
    finish: FINISH,
    storage: STORAGE,
  }),
  studio_flip: ev("editor", { method: oneOf("button", "keyboard") }),
  studio_view: ev("editor", { action: oneOf("zoom_in", "zoom_out", "fit", "zoom_selection", "preview_on", "preview_off") }),
  studio_panel: ev("editor", { panel: oneOf("rail", "inspector", "focus", "styles", "remix", "agent", "facts", "versions"), open: bool }),
  remix_request: ev("remix", { via: oneOf("sheet", "agent", "note"), vibe: oneOf("neon", "risograph", "70s", "minimal", "custom", "none") }),
  remix_result: ev("remix", { via: oneOf("sheet", "agent", "note"), result: oneOf("success", "limited", "error"), art: oneOf("generated", "procedural", "uploaded"), capability: CAPABILITY, duration_ms: MS, error_code: ERROR_CODE }),
  photo_add: ev("memories", { via: oneOf("memories", "agent", "memory_page", "organizer_claim"), result: oneOf("success", "error"), photo_count: COUNT }),
  note_edit: ev("memories", { has_note: bool }),
  agent_open: ev("agent", { via: oneOf("button", "note", "seed") }),
  agent_message: ev("agent", { intent: oneOf("weather", "photo", "question", "remix", "action"), result: oneOf("live", "rules", "pending", "error"), error_code: ERROR_CODE }),
  agent_suggestion: ev("agent", { suggestion: oneOf("moodier", "weather", "photo") }),
  /** One proposed action the owner applied: its kind, how it ended and how long it took. Never the value or the message. */
  agent_action: ev("agent", {
    action: oneOf("set_fact", "set_style", "set_material", "set_finish", "set_text", "remix_art", "show_back"),
    result: oneOf("applied", "failed", "rejected"),
    error_code: ERROR_CODE,
    duration_ms: MS,
  }),
  tear_start: ev("tear", {}),
  tear_cancel: ev("tear", {}),
  tear_complete: ev("tear", { method: oneOf("drag", "keyboard", "auto"), storage: STORAGE }),

  // Wall, sharing, memory page, public wall
  wall_view: ev("wall", { state: oneOf("empty", "loaded"), stub_count: COUNT }),
  wall_filter: ev("wall", { filter: EVENT_TYPE }),
  wall_stub_open: ev("wall", { via: oneOf("pointer", "keyboard") }),
  wall_reorder: ev("wall", { method: oneOf("drag", "keyboard"), storage: STORAGE }),
  wall_remove: ev("wall", { storage: STORAGE }),
  wall_public_toggle: ev("wall", { public: bool, result: oneOf("saved", "local", "error"), error_code: ERROR_CODE }),
  wall_stop_sharing: ev("wall", { result: oneOf("saved", "error"), error_code: ERROR_CODE }),
  wall_banner_dismiss: ev("wall", {}),
  cta_select: ev("share", {
    cta: oneOf("make", "print", "wallet", "friends", "save", "claim", "make_own", "gift", "share_page", "search", "edit", "open_page", "save_dismiss"),
    context: oneOf("wall", "memory", "public_wall", "gift", "claim", "editor", "lamp", "home", "make"),
  }),
  /** A sidebar place chosen: its kind (never a stub id or title), and whether this device already has stubs (a returning wall). */
  nav_select: ev("nav", {
    item: oneOf("make", "search", "printing", "wall", "all_stubs", "stub", "studio", "checkout", "wallet", "friends", "gift", "share_page", "claim", "public_wall", "cart", "unclaimed", "organizer", "guest_claims", "account", "orders", "help", "privacy", "terms", "admin", "other"),
    has_stubs: bool,
  }),
  /**
   * GA's recommended share event: the share sheet or copy step on this device, with its outcome. It is
   * never proof of delivery; reports count `result = success` only.
   */
  share: rec("share", {
    method: oneOf("native", "copy"),
    content_type: oneOf("stub", "wall", "gift", "invite", "claim_link", "story"),
    result: oneOf("success", "cancel", "failure"),
    context: oneOf("wall", "lamp", "memory", "public_wall", "gift", "friends", "organizer"),
  }),
  share_landing: ev("share", { surface: oneOf("memory", "public_wall", "gift"), result: oneOf("valid", "invalid", "not_found", "error"), viewer: oneOf("owner", "visitor"), link_kind: oneOf("server", "encoded") }),
  public_wall_select: ev("share", { rank: int(100) }),
  gift_unwrap: ev("share", {}),
  /** A download click starts an export; it is not proof a file was saved. */
  story_export: ev("share", { action: oneOf("download"), result: oneOf("generated", "failed") }),
  /** The stub itself as a PNG (front or back). `result` is the image being made; `method` is how it was handed over, never proof it was kept. */
  stub_download: ev("share", {
    side: oneOf("front", "back"),
    context: oneOf("editor", "lamp", "memory"),
    method: oneOf("download", "share", "tab", "cancelled", "none"),
    result: oneOf("generated", "failed"),
    error_code: ERROR_CODE,
  }),
  memory_photo_remove: ev("share", { photo_count: COUNT, storage: STORAGE }),
  stop_sharing_stub: ev("share", { result: oneOf("saved", "error"), error_code: ERROR_CODE }),

  // Friends, claims, account. A sign-in choice or a sent magic link is not a login.
  friends_update: ev("friends", { action: oneOf("add", "remove", "mode"), friend_count: COUNT, mode: oneOf("make", "claim"), storage: STORAGE }),
  claim_view: ev("claim", { flow: CLAIM_FLOW, result: oneOf("valid", "invalid", "expired", "claimed", "error"), error_code: ERROR_CODE }),
  claim_invalid: ev("claim", { flow: CLAIM_FLOW, reason: oneOf("name_missing") }),
  claim_complete: ev("claim", { flow: CLAIM_FLOW, result: oneOf("claimed", "error"), storage: STORAGE, error_code: ERROR_CODE }),
  signin_choice: ev("account", { choice: oneOf("sign_in", "skip"), reason: oneOf("save", "checkout", "claim") }),
  sign_in_return: ev("account", { result: oneOf("signed_in", "not_signed_in", "expired") }),
  sign_in_link: ev("account", { reason: oneOf("save", "checkout", "claim"), result: oneOf("sent", "sandbox", "invalid", "error"), error_code: ERROR_CODE }),
  sign_out: ev("account", { result: oneOf("done", "offline") }),
  account_action: ev("account", { action: oneOf("change_email", "delete"), result: oneOf("sent", "sandbox", "done", "invalid", "error"), error_code: ERROR_CODE }),
  server_save: ev("account", { kind: oneOf("sync", "share", "order", "gift", "publish", "claim"), result: oneOf("saved", "failed", "off"), error_code: ERROR_CODE }),

  // Commerce: sandbox only. There is no purchase event; the runtime stamps capability=sandbox.
  product_option: ev("checkout", { option: oneOf("material", "finish", "size"), material: MATERIAL, finish: FINISH, size: SIZE, context: oneOf("checkout") }),
  add_to_cart: { ...rec("cart", { currency: USD, value: money, item_id: VARIANT, quantity: COUNT, context: oneOf("checkout", "friends", "wall", "memory"), capability: SANDBOX }), fixed: { capability: "sandbox" } },
  remove_from_cart: { ...rec("cart", { currency: USD, value: money, item_id: VARIANT, quantity: COUNT, context: oneOf("cart", "mini_cart") }), fixed: { capability: "sandbox" } },
  view_cart: { ...rec("cart", { currency: USD, value: money, item_count: COUNT, context: oneOf("cart", "mini_cart") }), fixed: { capability: "sandbox" } },
  cart_update: ev("cart", { action: oneOf("restore", "remove_undo", "quantity") }),
  begin_checkout: { ...rec("checkout", { currency: USD, value: money, item_id: VARIANT, item_count: COUNT, context: oneOf("checkout", "cart"), capability: SANDBOX }), fixed: { capability: "sandbox" } },
  /** The payment method chosen on the sandbox checkout. No payment details exist or are sent. */
  add_payment_info: { ...rec("checkout", { payment_type: PAYMENT, capability: SANDBOX }), fixed: { capability: "sandbox" } },
  checkout_invalid: ev("checkout", { reason: oneOf("email", "variant_blocked", "choose_again", "empty", "quote_expired") }),
  quote_expired: ev("checkout", { context: oneOf("checkout", "cart") }),
  quote_refresh: ev("checkout", { context: oneOf("checkout", "cart") }),
  /** A sandbox order record was persisted (server or local receipt). Never a purchase, never revenue. */
  sandbox_order: { ...ev("checkout", { method: PAYMENT, result: oneOf("placed", "blocked", "not_persisted"), receipt: oneOf("server", "local"), line_count: COUNT, value: money, currency: USD, capability: SANDBOX, storage: STORAGE, error_code: ERROR_CODE }), fixed: { capability: "sandbox" } },
  sandbox_order_retry: { ...ev("checkout", { result: oneOf("server", "local"), error_code: ERROR_CODE }), fixed: { capability: "sandbox" } },
  seat_decision: ev("cart", { decision: oneOf("seat_only", "gift", "drop") }),
  /** A gift link or print was prepared. Preparation is not delivery. */
  gift_prepare: ev("gift", { delivery: oneOf("link", "print"), wrap: bool, has_message: bool, result: oneOf("prepared", "invalid", "blocked", "error"), storage: oneOf("server", "local"), error_code: ERROR_CODE }),
  /** A delivery or wrap choice changed before sending: the choice only, never the name or note. */
  gift_option: ev("gift", { option: oneOf("delivery", "wrap"), delivery: oneOf("link", "print"), wrap: bool }),
  gift_revoke: ev("gift", { result: oneOf("saved", "error"), error_code: ERROR_CODE }),
  /** A wallet choice. Passes are simulated: nothing is issued. */
  wallet_select: { ...ev("wallet", { provider: oneOf("apple", "google"), capability: SIMULATED }), fixed: { capability: "simulated" } },
  /** The wallet tab switched before adding: a preference, not a pass. */
  wallet_option: ev("wallet", { provider: oneOf("apple", "google") }),

  // Organizer (never CSV values, headers, file names or attendee details)
  /** The step on screen: `open` when the wizard first settles (Design, or Publish for a draft restored after sign-in), `nav` for a move between steps. */
  organizer_step: ev("organizer", { step: oneOf("design", "guests", "check", "publish", "done"), via: oneOf("open", "restore", "nav") }),
  organizer_design: ev("organizer", { change: oneOf("edition", "allowed", "lock_logo", "lock_title", "organizer_name", "title"), edition: EDITION, value: bool }),
  organizer_csv: ev("organizer", { source: oneOf("file", "paste", "sample"), result: oneOf("parsed", "empty", "no_rows", "error"), row_count: COUNT, column_count: int(100) }),
  organizer_mapping: ev("organizer", { result: oneOf("auto", "manual"), has_seat: bool, has_extra: bool }),
  organizer_check: ev("organizer", { row_count: COUNT, missing_name_count: COUNT }),
  /** A stub chosen on the Check step's contact sheet (rank 1-based), or more of the sheet shown: never the guest. */
  organizer_contact_select: ev("organizer", { action: oneOf("inspect", "show_more"), rank: int(1000), shown_count: COUNT, row_count: COUNT }),
  organizer_publish: ev("organizer", { mode: oneOf("links", "print"), result: oneOf("server", "local", "blocked", "error"), guest_count: COUNT, error_code: ERROR_CODE }),

  // Reliability seen from the browser
  storage_failure: ev("reliability", { store: oneOf("wall", "deleted", "cart", "orders", "session", "prefs"), op: oneOf("read", "write"), reason: oneOf("quota", "unavailable", "parse", "unknown") }),
  /** A client-observed API call: one per product operation, `attempt` counts retries. */
  api_call: ev("reliability", {
    api: oneOf("research", "art", "agent", "context", "share", "account", "auth", "orders", "gift", "claim", "wall_sync", "events", "other"),
    result: oneOf("success", "empty", "fallback", "failure", "aborted"),
    status_class: oneOf("2xx", "204", "3xx", "4xx", "5xx", "network"),
    duration_ms: int(3_600_000),
    /** Where the answer came from (the response's own provenance), as CAPABILITY plus `fallback`. */
    mode: oneOf("live", "simulated", "fallback", "demo", "sandbox", "local"),
    attempt: int(20, 1),
    /** A coarse class of the server's error code; the code and message themselves are never sent. */
    error_code: oneOf(
      "network", "timeout", "aborted", "http_4xx", "http_5xx", "rate_limited", "unauthorized", "not_found",
      "invalid_input", "unsupported_url", "provider", "provider_config", "parse", "unknown",
    ),
  }),
} as const satisfies Record<string, EventSpec>;

/** Events only the analytics runtime sends: callers cannot track() these. */
export const INTERNAL_EVENTS = {
  page_view: ev("nav", {}),
  web_vital: ev("performance", {
    metric_name: oneOf("CLS", "FCP", "INP", "LCP", "TTFB"),
    /** Milliseconds, except CLS which is the layout-shift score x 1000. */
    metric_value: int(600_000),
    metric_rating: oneOf("good", "needs-improvement", "poor"),
    navigation_type: oneOf("navigate", "reload", "back-forward", "back-forward-cache", "prerender", "restore", "unknown"),
  }),
  route_timing: ev("performance", { duration_ms: MS, navigation_type: oneOf("push", "replace", "traverse", "reload", "unknown") }),
} as const satisfies Record<string, EventSpec>;

/**
 * Names that must never be emitted from this prototype: commerce is sandbox, sign-in is not a
 * production identity, wallet passes are simulated, and GA's automatic events stay off. `purchase`
 * and `refund` wait for authoritative payment confirmation deduplicated by transaction id.
 */
export const FORBIDDEN_EVENTS = [
  "purchase", "refund", "login", "sign_up", "add_shipping_info", "generate_lead", "close_convert_lead",
  "qualify_lead", "working_lead", "earn_virtual_currency", "spend_virtual_currency", "search",
  "view_search_results", "first_visit", "session_start", "user_engagement", "first_open", "scroll",
  "click", "file_download", "form_start", "form_submit", "video_start", "ad_impression",
] as const;

/** Parameters the runtime attaches itself, or that would identify a person or an order. */
export const RESERVED_PARAMS = [
  "schema_version", "deployment_env", "runtime_mode", "route_template",
  "page_location", "page_referrer", "page_title", "page_path",
  "user_id", "client_id", "session_id", "transaction_id", "debug_mode", "items",
] as const;

export type EventName = keyof typeof EVENTS;
export type InternalEventName = keyof typeof INTERNAL_EVENTS;

type SpecValue<S> = S extends { kind: "enum"; values: readonly (infer V)[] }
  ? V
  : S extends { kind: "int" | "money" }
    ? number
    : S extends { kind: "bool" }
      ? boolean
      : never;

type ParamsOf<P> = { -readonly [K in keyof P]?: SpecValue<P[K]> };

export type EventParams<E extends EventName> = ParamsOf<(typeof EVENTS)[E]["params"]>;
export type InternalEventParams<E extends InternalEventName> = ParamsOf<(typeof INTERNAL_EVENTS)[E]["params"]>;

export function isEventName(name: unknown): name is EventName {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(EVENTS, name);
}
