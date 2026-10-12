// Route sanitization: the only way a URL leaves the page. Share links carry whole serialized stubs
// (/s/<token>, /u/<token>, ?from=), organizer links carry designs (?d=), gift links carry names (?to=),
// and /new?url= and ?q= carry what someone typed. So a URL is reduced to a known route template;
// every dynamic segment becomes a placeholder and every query and hash value is dropped.

interface Route {
  /** Path segments; ":name" matches any one segment, "*" matches the rest. */
  match: readonly string[];
  template: string;
  title: string;
}

const route = (template: string, title: string): Route => ({
  match: template.split("/").filter(Boolean),
  template,
  title,
});

/** Every page in src/app, most specific first. A route missing here reports as /unknown. */
export const ROUTES: readonly Route[] = [
  route("/", "Home"),
  route("/make", "Make"),
  route("/search", "Search"),
  route("/new", "Printing"),
  route("/wall", "Wall"),
  route("/cart", "Cart"),
  route("/cart/unclaimed/:id", "Unclaimed seat"),
  route("/checkout/:id", "Checkout"),
  route("/payment/return", "Payment return"),
  route("/claim/g/:token", "Gift claim"),
  route("/claim/:set", "Claim"),
  route("/friends/:id", "Friends"),
  route("/gift/:id", "Gift"),
  route("/wallet/:id", "Wallet"),
  route("/studio/:id", "Studio"),
  route("/s/:token", "Share page"),
  route("/u/:token", "Public wall"),
  route("/organizer", "Organizer"),
  route("/organizer/claim", "Guest claims"),
  route("/account", "Account"),
  route("/signin/confirm", "Sign-in confirmation"),
  route("/admin", "Admin"),
  route("/admin/*", "Admin"),
  route("/help", "Help"),
  route("/map", "Map"),
  route("/privacy", "Privacy"),
  route("/terms", "Terms"),
  route("/parts", "Parts"),
  route("/stub-lab", "Stub lab"),
];

export const UNKNOWN_TEMPLATE = "/unknown";
export const API_TEMPLATE = "/api";

export interface SafePage {
  template: string;
  title: string;
}

/** The route template and a fixed title for a pathname. Never echoes a segment. */
export function sanitizePath(pathname: string): SafePage {
  const raw = typeof pathname === "string" ? pathname.split(/[?#]/, 1)[0] : "";
  const segs = raw.split("/").filter(Boolean);
  if (segs[0] === "api") return { template: API_TEMPLATE, title: "API" };
  for (const r of ROUTES) {
    if (r.match.at(-1) === "*") {
      const head = r.match.slice(0, -1);
      if (segs.length > head.length && head.every((m, i) => m === segs[i])) return { template: r.template, title: r.title };
      continue;
    }
    if (r.match.length !== segs.length) continue;
    if (r.match.every((m, i) => m.startsWith(":") ? segs[i].length > 0 : m === segs[i])) return { template: r.template, title: r.title };
  }
  return { template: UNKNOWN_TEMPLATE, title: "Page" };
}

/**
 * Campaign tags kept on a landing page view: only these exact values, reviewed in code. A value's
 * shape proves nothing (a name or a code looks like any other word), so anything else is dropped.
 * Add a campaign here, with review, before links carrying it go out. utm_campaign starts empty.
 */
export const CAMPAIGN_ALLOWLIST = {
  utm_source: ["newsletter", "instagram", "tiktok", "facebook", "x", "linkedin", "qr", "neathack", "partner"],
  utm_medium: ["email", "social", "referral", "qr", "print", "event"],
  utm_campaign: [],
} as const satisfies Record<string, readonly string[]>;

function campaignQuery(search: string): string {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return "";
  }
  const kept = new URLSearchParams();
  for (const [key, allowed] of Object.entries(CAMPAIGN_ALLOWLIST) as [string, readonly string[]][]) {
    const v = params.get(key);
    if (v !== null && allowed.includes(v)) kept.set(key, v);
  }
  const s = kept.toString();
  return s ? `?${s}` : "";
}

function safeOrigin(origin: string): string | null {
  try {
    const u = new URL(origin);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * The page_location a provider sees: origin + template, plus approved campaign tags on the landing
 * view only. Brackets would be percent-encoded, so templates use ":name" placeholders.
 */
export function sanitizeLocation(origin: string, pathname: string, search = "", opts: { landing?: boolean } = {}): string {
  const o = safeOrigin(origin);
  const { template } = sanitizePath(pathname);
  if (!o) return "";
  return `${o}${template}${opts.landing ? campaignQuery(search) : ""}`;
}

/**
 * The page_referrer for a landing view: a same-site referrer becomes its template; another site keeps
 * only its origin (acquisition source), never its path or query; anything else is empty.
 */
export function sanitizeReferrer(referrer: string, origin: string): string {
  if (!referrer) return "";
  let u: URL;
  try {
    u = new URL(referrer);
  } catch {
    return "";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "";
  const o = safeOrigin(origin);
  if (o && u.origin === o) return sanitizeLocation(o, u.pathname);
  return `${u.origin}/`;
}
