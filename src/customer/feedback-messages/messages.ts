// One catalog for every error the server (or the browser) can raise: a brand-voice message and a way out.
// Voice (brand-kit docs/voice.md): the situation in plain words, short active sentences, then the step to take.
// Never a raw code, a status, a stack or an exclamation mark. scripts/check-messages.mjs fails when a code
// raised anywhere in src has no entry here.

/** What the button does. `href` navigates; `action` is a verb the page maps to a handler. */
export type RecoveryAction = { label: string; href: string; action?: never } | { label: string; action: "retry" | "sign-in" | "reload"; href?: never };

export interface FeedbackMessage {
  /** The catalog code this answered, or "unknown" for a code we have no entry for. */
  code: string;
  message: string;
  action?: RecoveryAction;
  /** True when trying the same thing again can work. */
  retryable: boolean;
}

type Entry = { message: string; action?: RecoveryAction; retryable?: boolean };

const RETRY: RecoveryAction = { label: "Try again", action: "retry" };
const SIGN_IN: RecoveryAction = { label: "Sign in", action: "sign-in" };
const WALL: RecoveryAction = { label: "Open your wall", href: "/wall" };
const START: RecoveryAction = { label: "Start a stub", href: "/new" };
const SEND_NEW: RecoveryAction = { label: "Send a new link", action: "sign-in" };
const RELOAD: RecoveryAction = { label: "Reload the page", action: "reload" };

const PROVIDER_DOWN = "Our research and art helpers are out of reach right now. Your stub is safe, and the procedural art still works.";
const PROVIDER_SETUP = "This preview isn't set up for that helper yet. Your stub is safe, and the procedural art still works.";

export const MESSAGES = {
  // Request and access
  bad_origin: { message: "That request didn't come from TicketStub, so we stopped it. Open TicketStub directly and try again.", action: RELOAD },
  origin_unavailable: { message: "We can't finish that action right now. Open your wall and try again later.", action: WALL },
  unauthorized: { message: "Sign in with an emailed link to do that. It takes a minute and needs no password.", action: SIGN_IN },
  forbidden: { message: "This stub isn't yours to change. Open one from your own wall.", action: WALL },
  not_found: { message: "We couldn't find that. The link may have been stopped, or it may have a typo.", action: START },
  too_large: { message: "That's more than we can take in one go. Send fewer stubs or smaller photos and try again.", action: RETRY, retryable: true },
  rate_limited: { message: "You've tried that a few times in a row. Wait a few minutes, then try again.", action: RETRY, retryable: true },
  bad_request: { message: "Something in that wasn't quite right. Check what you entered and try again.", action: RETRY, retryable: true },
  bad_json: { message: "That didn't send properly. Reload the page and try again.", action: RELOAD },
  bad_image: { message: "We couldn't read that picture. Try a PNG or JPG.", action: RETRY, retryable: true },
  message_too_long: { message: "That message is a little long for a gift. Trim it and send again.", action: RETRY, retryable: true },
  same_email: { message: "That's the email you already use. Enter a different one to change it.", action: RETRY, retryable: true },
  disposable_email: { message: "That email looks like a throwaway inbox, so we can't send a link there. Use an address you keep.", action: RETRY, retryable: true },
  confirm_mismatch: { message: "That didn't match, so nothing was deleted. Type your email exactly as shown, then try again.", action: RETRY, retryable: true },
  internal: { message: "Something broke on our side, but your stub is safe. Try again in a moment.", action: RETRY, retryable: true },

  // Links, claims and orders
  expired: { message: "This link has expired. Ask whoever sent it for a new one.", action: START },
  signin_expired: { message: "That sign-in link has run out. Each one works once and lasts 15 minutes.", action: SEND_NEW },
  already_claimed: { message: "Someone already claimed this stub. Ask the organizer for your own link.", action: START },
  variant_not_orderable: { message: "That size and finish isn't orderable yet. Choose another, or keep it as a preview.", action: WALL },
  amount_mismatch: { message: "The price changed since you last looked. Reload to see the current price, then pay again.", action: RELOAD },
  checkout_closed: { message: "That checkout has closed, and nothing more was charged. Start again.", action: RELOAD },
  payment_unavailable: { message: "We couldn't start the payment. Nothing was charged, so try again in a moment.", action: RETRY, retryable: true },
  payments_off: { message: "Payments aren't switched on here yet. Nothing was charged.", action: WALL },
  bad_signature: { message: "We couldn't verify that request, so it was ignored. Nothing was changed.", action: RETRY, retryable: true },
  unreadable_link: { message: "We couldn't read that link. Paste the event page address, or search for the event by name.", action: RETRY, retryable: true },
  unsupported_url: { message: "That link can't be read. Paste the full address of a public event webpage, with no username or password.", action: RETRY, retryable: true },
  unsupported_input: { message: "Uploads and extra sources aren't supported yet. Paste one event page link instead.", action: RETRY, retryable: true },
  demo_only: { message: "This preview only knows its demo events. Try neatHack, The Pale Hours or Harbour FC.", action: RETRY, retryable: true },
  context_unavailable: { message: "Signed context isn't set up on this server yet, so nothing can use it. Your stubs are unaffected.", action: RETRY, retryable: true },
  approval_conflict: { message: "This stub changed while you were approving it. Look it over once more, then approve it again.", action: RELOAD },
  approval_unavailable: { message: "We can't read this stub's art right now, so it can't be approved yet. Try again in a moment.", action: RETRY, retryable: true },
  approval_invalid: { message: "That approval doesn't cover this use. Approve the stub again from your wall.", action: WALL },
  authorization_conflict: { message: "That order changed while you were confirming it. Look it over once more, then confirm it again.", action: RELOAD },
  authorization_invalid: { message: "That order confirmation doesn't cover this purchase any more. Confirm the order again from your wall.", action: WALL },
  consumer_unavailable: { message: "Order handoff isn't set up on this server yet, so nothing was sent. Your stubs are unaffected.", action: RETRY, retryable: true },
  consumer_unauthorized: { message: "That request didn't come from a service we know, so we ignored it. Nothing was changed.", action: START },

  // Mail
  mail_unavailable: { message: "Email isn't switched on for this preview, so we can't send a link. Come back soon.", action: RETRY, retryable: true },
  mail_failed: { message: "We couldn't send that email. Check the address, then try again in a moment.", action: RETRY, retryable: true },

  // Storage and limits
  storage_unavailable: { message: "Saving is off on this preview. Your stub stays on this device, and you can keep working.", action: RETRY, retryable: true },
  art_limit: { message: "You've made a lot of art today. Procedural art still works, and new art comes back tomorrow." },
  backup_running: { message: "A backup is already being made. Wait for it to finish, then try again.", action: RETRY, retryable: true },

  // Providers (research, art and the agent). Their detail never reaches a person.
  provider_unavailable: { message: PROVIDER_DOWN, action: RETRY, retryable: true },
  provider_rate_limited: { message: "Our art and research helpers are busy right now. Try again in a minute.", action: RETRY, retryable: true },
  provider_request_cancelled: { message: "That took too long, so we stopped it. Try again.", action: RETRY, retryable: true },
  provider_authentication_failed: { message: PROVIDER_SETUP },
  invalid_provider_configuration: { message: PROVIDER_SETUP },
  invalid_model_configuration: { message: PROVIDER_SETUP },
  missing_provider_key: { message: PROVIDER_SETUP },
  server_only: { message: PROVIDER_SETUP },
  unsupported_provider_request: { message: "That helper couldn't take this request. Try a different event or a simpler vibe.", action: RETRY, retryable: true },
  unsupported_image_model: { message: PROVIDER_SETUP },
  invalid_provider_response: { message: "A helper sent back something we couldn't use, so we ignored it. Try again.", action: RETRY, retryable: true },
  unsupported_provider_response: { message: "A helper sent back something we couldn't use, so we ignored it. Try again.", action: RETRY, retryable: true },
  invalid_image_response: { message: "The art that came back wasn't usable, so we threw it out. Try again.", action: RETRY, retryable: true },

  // Supplier callbacks (POST /api/fulfillment/prodigi/callbacks/{token}). The reader is Prodigi's sender, not a person.
  callback_invalid: { message: "That callback wasn't in the shape we accept, so nothing changed. Send it again as documented.", action: RETRY, retryable: true },
  callback_oversized: { message: "That callback was more than we take in one go, so nothing changed. Send a smaller one.", action: RETRY, retryable: true },
  callback_source_mismatch: { message: "That callback came from a source we don't expect, so nothing changed. Try again shortly.", action: RETRY, retryable: true },
  callbacks_unavailable: { message: "We can't take callbacks right now, and nothing changed. Try again shortly.", action: RETRY, retryable: true },

  // Browser side
  network: { message: "You look offline. Check your connection, then try again.", action: RETRY, retryable: true },
  timeout: { message: "That's taking longer than it should, and we can't tell yet whether it went through. Check before you try again.", action: RETRY, retryable: true },
  unavailable: { message: "We couldn't reach the server, but your stub is safe on this device. Try again in a moment.", action: RETRY, retryable: true },
  unknown: { message: "Something went wrong, and we're not sure what. Your stub is safe, so try again in a moment.", action: RETRY, retryable: true },
} as const satisfies Record<string, Entry>;

export type MessageCode = keyof typeof MESSAGES;

/** Every code the catalog answers, for the static coverage check. */
export const MESSAGE_CODES = Object.keys(MESSAGES) as MessageCode[];

/** The catalog entry for `code`. Anything we don't know (or isn't a string) gets the safe generic message. */
export function messageFor(code: unknown): FeedbackMessage {
  const known = typeof code === "string" && Object.hasOwn(MESSAGES, code) ? (code as MessageCode) : "unknown";
  const entry: Entry = MESSAGES[known];
  return { code: known, message: entry.message, ...(entry.action ? { action: entry.action } : {}), retryable: entry.retryable ?? false };
}

/** The code inside whatever a catch block got: an ApiError, an `{ error: { code } }` body, or nothing useful. */
export function codeOf(e: unknown): string {
  if (typeof e === "object" && e !== null) {
    const o = e as { code?: unknown; name?: unknown; error?: { code?: unknown } };
    if (typeof o.code === "string") return o.code;
    if (typeof o.error?.code === "string") return o.error.code;
    if (o.name === "AbortError" || o.name === "TimeoutError") return "timeout";
  }
  return "unknown";
}

/** `messageFor(codeOf(e))`: the message and way out for a caught error. */
export const messageForError = (e: unknown): FeedbackMessage => messageFor(codeOf(e));
