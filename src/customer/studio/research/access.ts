// Shared provider labels and fallback contract. No provider URLs are fetched here.
export const PROVIDERS = [
  { id: "axs", label: "AXS", hosts: ["axs.com"], subdomains: true },
  { id: "seatgeek", label: "SeatGeek", hosts: ["seatgeek.com", "seatgeek.ca"], subdomains: true },
  { id: "stubhub", label: "StubHub", hosts: ["stubhub.com", "stubhub.ca", "stubhub.co.uk", "stubhub.ie", "viagogo.com"], subdomains: true },
  { id: "ra", label: "Resident Advisor", hosts: ["ra.co", "residentadvisor.net"], subdomains: false },
  { id: "eventim", label: "EVENTIM", hosts: ["eventim.com", "eventim.us", "eventim.de", "eventim.co.uk"], subdomains: true },
  { id: "see_tickets", label: "See Tickets", hosts: ["seetickets.com", "seetickets.us"], subdomains: true },
  { id: "shotgun", label: "Shotgun", hosts: ["shotgun.live"], subdomains: true },
  { id: "etix", label: "Etix", hosts: ["etix.com"], subdomains: true },
  { id: "tixr", label: "Tixr", hosts: ["tixr.com"], subdomains: true },
  { id: "skiddle", label: "Skiddle", hosts: ["skiddle.com"], subdomains: true },
] as const;

export type ProviderId = (typeof PROVIDERS)[number]["id"] | "unknown";
export interface ManualFallback {
  kind: "manual_event";
  provider: ProviderId;
  url: string;
  title: string;
}

export function providerForUrl(url: URL) {
  const host = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  return PROVIDERS.find((p) => p.hosts.some((root) => host === root || (p.subdomains && host.endsWith(`.${root}`))));
}

export function providerLabel(id: ProviderId): string {
  return PROVIDERS.find((p) => p.id === id)?.label ?? "This site";
}

/** Only the verified RA event URL shape is short-circuited. Listings and lookalikes are not events. */
export function isRestrictedEvent(url: URL): boolean {
  return providerForUrl(url)?.id === "ra" && /^\/events\/\d+\/?$/.test(url.pathname);
}

export function manualFallback(url: URL): ManualFallback {
  const provider = providerForUrl(url)?.id ?? "unknown";
  const clean = new URL(url);
  clean.search = "";
  clean.hash = "";
  let slug = "";
  if (provider === "axs") slug = url.pathname.match(/\/events\/\d+\/([^/]+)/)?.[1] ?? "";
  if (provider === "stubhub") slug = url.pathname.match(/^\/([^/]+)\/event\/\d+/)?.[1] ?? "";
  try { slug = decodeURIComponent(slug); } catch { slug = ""; }
  const title = slug.replace(/[-_]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200).trim();
  return { kind: "manual_event", provider, url: clean.href, title };
}

/** Validate response data before it becomes a browser link or form default. */
export function readManualFallback(value: unknown): ManualFallback | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Partial<ManualFallback>;
  if (v.kind !== "manual_event" || typeof v.url !== "string" || typeof v.title !== "string") return;
  try {
    const url = new URL(v.url);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return;
    return manualFallback(url);
  } catch { return; }
}

export class AccessRestrictedError extends Error {
  constructor() { super("Event page access is restricted."); }
}

/** Strong challenge markers only; an ordinary error or event mentioning Cloudflare is insufficient. */
export function isAccessChallenge(status: number, headers: Headers, text = ""): boolean {
  if (headers.get("cf-mitigated") === "challenge" || headers.has("x-datadome") || /challenge|captcha/i.test(headers.get("x-amzn-waf-action") ?? "")) return true;
  const page = text.slice(0, 100_000);
  return /<title[^>]*>\s*(?:Vercel Security Checkpoint|Just a moment\.\.\.|Access Denied|Verification Required)\s*<\/title>/i.test(page)
    || /(?:captcha-delivery\.com|geo\.captcha-delivery\.com|challenges\.cloudflare\.com|awswaf\.com\/)/i.test(page)
    || ((status === 403 || status === 429) && /(?:unusual traffic|sorry, you have been blocked|akamai.*(?:access denied|reference #))/i.test(page));
}
