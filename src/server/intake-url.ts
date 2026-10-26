import "server-only";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { pipeline, Readable, Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

// URL-first intake boundary. Numbers here are defensive app-side ceilings, not an agreed product
// contract: the research service (event-intelligence #9) still owns safe retrieval, and the support
// matrix / limits are pending GT-03.2 agreement. Everything is rejected before any dispatch.

export const INTAKE_LIMITS = {
  /** Characters in one pasted link. */
  urlChars: 2048,
  /** Characters in a search query. */
  queryChars: 200,
  /** Bytes in the whole request body. */
  bodyBytes: 8 * 1024,
  /** Redirect hops followed for one fetch, each re-validated. */
  redirects: 3,
  /** Bytes read from one fetched page. */
  pageBytes: 2_000_000,
  /** Bytes a response may inflate to after Content-Encoding is decoded; a compression bomb is aborted here. */
  decodedBytes: 4_000_000,
} as const;

/** Request fields that mean an upload, extra sources or other input we do not support in v1. */
export const UNSUPPORTED_FIELDS = ["file", "files", "image", "images", "screenshot", "upload", "attachment", "email", "csv", "urls", "sources"] as const;

export type IntakeRejection = "url_too_long" | "url_malformed" | "unsupported_scheme" | "url_credentials" | "unsupported_port" | "blocked_destination";

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: IntakeRejection };

const SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i; // "example.com:8080/x" is a host and port, not a scheme
const CONTROL = /[\x00-\x20\x7f-\x9f\s\\]/; // controls, any whitespace (incl. U+2028/9) and backslashes
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa", ".corp", ".intranet", ".localdomain"];

function ipv4Blocked(a: number, b: number, c: number): boolean {
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol, TEST-NET-1
    (a === 192 && b === 168) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

/** True for private, loopback, link-local, multicast, documentation and otherwise reserved addresses. */
export function isBlockedIp(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    return ipv4Blocked(a, b, c);
  }
  if (kind !== 6) return true; // not an address we can classify: fail closed
  const groups = expandIpv6(ip);
  if (!groups) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  if (groups.every((g) => g === 0) || (groups.slice(0, 7).every((g) => g === 0) && g7 === 1)) return true; // :: and ::1
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96): judge the embedded IPv4.
  const embedded = [g6 >> 8, g6 & 255, g7 >> 8, g7 & 255] as const;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) return ipv4Blocked(embedded[0], embedded[1], embedded[2]);
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return ipv4Blocked(embedded[0], embedded[1], embedded[2]); // well-known NAT64
  if (g0 === 0x2002) return ipv4Blocked(g1 >> 8, g1 & 255, g2 >> 8); // 6to4 embeds an IPv4 too
  // Everything else must sit inside a prefix IANA lists as ALLOCATED and not inside a special-purpose denial. Space IANA
  // lists as RESERVED (3ffe::/16 old 6bone, 3fff::/20, 2d00::/8 ...) or does not list at all (2000::/16, 4000::/3 ...)
  // is refused: it can be handed out later, and a name must not reach it just because that has not happened yet.
  const value = groups.reduce((acc, g) => (acc << BigInt(16)) | BigInt(g), BigInt(0));
  if (IPV6_DENIED.some((p) => inPrefix(value, p))) return true;
  return !IPV6_ALLOCATED.some((p) => inPrefix(value, p));
}

type Prefix = readonly [base: bigint, length: number];
function prefix(text: string): Prefix {
  const [addr, len] = text.split("/");
  const groups = expandIpv6(addr);
  if (!groups) throw new Error(`bad prefix ${text}`);
  return [groups.reduce((acc, g) => (acc << BigInt(16)) | BigInt(g), BigInt(0)), Number(len)];
}
function inPrefix(value: bigint, [base, length]: Prefix): boolean {
  const shift = BigInt(128 - length);
  return value >> shift === base >> shift;
}

/**
 * IPv6 unicast space that IANA lists as ALLOCATED, from
 * https://www.iana.org/assignments/ipv6-unicast-address-assignments (checked 2026-10-12). Excluded on purpose: the
 * 2001::/23 IANA row (special-purpose), 2002::/16 (6to4, judged by its embedded IPv4 above), and every RESERVED row.
 */
const IPV6_ALLOCATED: Prefix[] = [
  "2001:200::/23", "2001:400::/23", "2001:600::/23", "2001:800::/22", "2001:c00::/23", "2001:e00::/23", "2001:1200::/23",
  "2001:1400::/22", "2001:1800::/23", "2001:1a00::/23", "2001:1c00::/22", "2001:2000::/19", "2001:4000::/23", "2001:4200::/23",
  "2001:4400::/23", "2001:4600::/23", "2001:4800::/23", "2001:4a00::/23", "2001:4c00::/23", "2001:5000::/20", "2001:8000::/19",
  "2001:a000::/20", "2001:b000::/20", "2003::/18", "2400::/12", "2410::/12", "2600::/12", "2610::/23", "2620::/23", "2630::/12",
  "2800::/12", "2a00::/12", "2a10::/12", "2c00::/12",
].map(prefix);

/** IANA special-purpose blocks that sit inside the allocated space above (documentation, AS112 direct delegation) and are never an event host. */
const IPV6_DENIED: Prefix[] = ["2001:db8::/32", "2620:4f:8000::/48"].map(prefix);

function expandIpv6(ip: string): number[] | undefined {
  let text = ip;
  const v4 = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const p = v4[1].split(".").map(Number);
    if (p.some((n) => n > 255)) return undefined;
    text = text.slice(0, -v4[1].length) + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return undefined;
  const all = [...head, ...Array(fill).fill("0"), ...tail].map((g) => parseInt(g, 16));
  return all.length === 8 && all.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? all : undefined;
}

/** Hostname rules that need no DNS: IP literals, localhost-style names and single-label hosts. */
function hostBlocked(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (isIP(host.replace(/^\[|\]$/g, ""))) return isBlockedIp(host);
  if (host === "localhost" || !host.includes(".")) return true;
  return BLOCKED_SUFFIXES.some((s) => host.endsWith(s));
}

/** Does this text carry an explicit scheme, or credentials before an "@" in its authority? Those are never silently repaired. */
function hasScheme(raw: string): boolean {
  return SCHEME.test(raw) || raw.startsWith("//");
}

/**
 * Validates one pasted link without any network access. A bare "example.com/x" is read as https;
 * anything with another scheme, credentials, a non-standard port or a private/reserved host is rejected.
 */
export function parseIntakeUrl(input: string): UrlCheck {
  const raw = input.trim();
  if (raw.length > INTAKE_LIMITS.urlChars) return { ok: false, reason: "url_too_long" };
  if (!raw || CONTROL.test(raw)) return { ok: false, reason: "url_malformed" };
  if (hasScheme(raw) && !/^https?:\/\//i.test(raw)) return { ok: false, reason: "unsupported_scheme" };
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, reason: "url_malformed" };
  }
  return checkUrl(url);
}

/** The checks that apply to the first URL and to every redirect target alike. */
export function checkUrl(url: URL): UrlCheck {
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "unsupported_scheme" };
  if (url.href.length > INTAKE_LIMITS.urlChars) return { ok: false, reason: "url_too_long" };
  if (url.username || url.password) return { ok: false, reason: "url_credentials" };
  if (url.port && url.port !== "80" && url.port !== "443") return { ok: false, reason: "unsupported_port" };
  if (!url.hostname || url.hostname.length > 253) return { ok: false, reason: "url_malformed" };
  if (hostBlocked(url.hostname)) return { ok: false, reason: "blocked_destination" };
  return { ok: true, url };
}

export type HostResolver = (hostname: string) => Promise<string[]>;

const systemResolver: HostResolver = async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);
let resolver: HostResolver = systemResolver;

/** Offline tests install a resolver so no real DNS runs; pass nothing to restore the system one. */
export function setHostResolver(next?: HostResolver): void {
  resolver = next ?? systemResolver;
}

export class BlockedDestinationError extends Error {
  constructor(readonly reason: IntakeRejection | "too_many_redirects" | "dns_failed") {
    super(reason);
  }
}

type LookupCallback = (err: Error | null, address: string | { address: string; family: number }[], family?: number) => void;

/**
 * The socket's own DNS lookup. It resolves once, refuses the whole name if any answer is private or
 * reserved, and hands the socket only validated addresses, so the address that is checked is the
 * address that is connected to. There is no separate preflight lookup to race against.
 */
export function createPinnedLookup(resolve: () => HostResolver, allowed: (address: string) => boolean = (a) => !isBlockedIp(a)) {
  return (hostname: string, options: { all?: boolean; family?: number | string } | number | undefined, callback: LookupCallback): void => {
    const opts = typeof options === "object" && options ? options : {};
    const want = Number(typeof options === "number" ? options : opts.family) || 0;
    resolve()(hostname).then(
      (addresses) => {
        if (addresses.length === 0 || addresses.some((a) => !isIP(a) || !allowed(a))) return callback(new BlockedDestinationError("blocked_destination"), "", 0);
        const usable = addresses.filter((a) => !want || isIP(a) === want);
        if (usable.length === 0) return callback(new BlockedDestinationError("dns_failed"), "", 0);
        if (opts.all) return callback(null, usable.map((address) => ({ address, family: isIP(address) })));
        callback(null, usable[0], isIP(usable[0]));
      },
      () => callback(new BlockedDestinationError("dns_failed"), "", 0),
    );
  };
}

/** Builds a web Response from node's IncomingMessage: validates the status, decodes Content-Encoding under a decoded-byte cap. */
function toResponse(res: IncomingMessage, maxDecoded: number): Response {
  const status = res.statusCode ?? 0;
  if (!Number.isInteger(status) || status < 200 || status > 599) throw new Error(`unsupported upstream status ${status}`);
  const out = new Headers();
  for (const [k, v] of Object.entries(res.headers)) for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) out.append(k, x);
  if (status === 204 || status === 205 || status === 304) {
    res.resume();
    return new Response(null, { status, headers: out });
  }
  const codings = (out.get("content-encoding") ?? "").toLowerCase().split(",").map((c) => c.trim()).filter((c) => c && c !== "identity");
  const decoders = codings.reverse().map((c) => {
    if (c === "gzip" || c === "x-gzip") return createGunzip();
    if (c === "deflate") return createInflate();
    if (c === "br") return createBrotliDecompress();
    throw new Error(`unsupported content-encoding ${c}`);
  });
  let source: Readable = res;
  if (decoders.length) {
    out.delete("content-encoding");
    out.delete("content-length");
    let total = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        total += chunk.length;
        if (total > maxDecoded) cb(new Error("decoded body exceeds the size cap"));
        else cb(null, chunk);
      },
    });
    // pipeline destroys every stage, including the socket, when any stage fails or the reader cancels.
    source = pipeline([res, ...decoders, counter] as never, () => undefined) as unknown as Readable;
  }
  return new Response(Readable.toWeb(source) as ReadableStream<Uint8Array>, { status, headers: out });
}

/** One request, no redirects. */
export type Transport = (url: URL, init: RequestInit) => Promise<Response>;

/**
 * Default transport: node's http/https with the pinned lookup. The URL's hostname stays the TLS
 * servername and Host header, so certificate validation is against the name the person gave, while
 * the TCP connection can only go to an address that passed the check. Redirects are not followed.
 */
export function createPinnedTransport(opts: { resolver?: () => HostResolver; allowed?: (address: string) => boolean; ca?: string; maxDecodedBytes?: number } = {}): Transport {
  const maxDecodedBytes = opts.maxDecodedBytes ?? INTAKE_LIMITS.decodedBytes;
  const lookupFn = createPinnedLookup(opts.resolver ?? (() => resolver), opts.allowed);
  return (url, init) =>
    new Promise<Response>((resolveResponse, reject) => {
      const secure = url.protocol === "https:";
      const headers: Record<string, string> = {};
      headers["accept-encoding"] = "gzip, deflate, br";
      new Headers(init.headers).forEach((v, k) => (headers[k] = v));
      const req = (secure ? httpsRequest : httpRequest)(
        {
          protocol: url.protocol,
          hostname: url.hostname.replace(/^\[|\]$/g, ""),
          port: url.port || (secure ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers,
          lookup: lookupFn as never,
          agent: false, // a fresh, validated connection per request; no pooled socket carried across a DNS change
          signal: init.signal ?? undefined,
          ...(secure ? { rejectUnauthorized: true, ...(opts.ca ? { ca: opts.ca } : {}), servername: isIP(url.hostname.replace(/^\[|\]$/g, "")) ? undefined : url.hostname } : {}),
        },
        (res) => {
          // Nothing thrown here may escape: this runs in an event callback, where a throw would crash the process.
          try {
            resolveResponse(toResponse(res, maxDecodedBytes));
          } catch (error) {
            res.destroy();
            req.destroy();
            reject(error instanceof Error ? error : new Error("bad upstream response"));
          }
        },
      );
      req.on("error", reject);
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new DOMException("aborted", "AbortError")), { once: true });
      req.end();
    });
}

let transport: Transport = createPinnedTransport();

/** Offline tests replace the transport (for example with a stub of globalThis.fetch); pass nothing to restore the pinned one. */
export function setTransport(next?: Transport): void {
  transport = next ?? createPinnedTransport();
}

/**
 * The one outbound fetch for user-supplied links. Redirects are followed by hand so each hop is
 * re-validated (scheme, credentials, port, length, literal host) and then connected through the
 * pinned transport, which validates the resolved address at connect time.
 */
export async function fetchPublic(start: string | URL, init: RequestInit = {}, destinationAllowed?: (url: URL) => boolean): Promise<Response> {
  let url = typeof start === "string" ? new URL(start) : start;
  for (let hop = 0; ; hop++) {
    const check = checkUrl(url);
    if (!check.ok) throw new BlockedDestinationError(check.reason);
    if (destinationAllowed && !destinationAllowed(check.url)) throw new BlockedDestinationError("blocked_destination");
    const res = await transport(check.url, init);
    if (res.status < 300 || res.status >= 400 || res.status === 304) return res;
    const location = res.headers.get("location");
    await res.body?.cancel().catch(() => undefined);
    if (!location) return res;
    if (hop >= INTAKE_LIMITS.redirects) throw new BlockedDestinationError("too_many_redirects");
    if (location.length > INTAKE_LIMITS.urlChars) throw new BlockedDestinationError("url_too_long");
    try {
      url = new URL(location, check.url);
    } catch {
      throw new BlockedDestinationError("url_malformed");
    }
  }
}

/** Reads at most `max` bytes of text, so a huge body cannot be pulled into memory first. */
export async function readCapped(res: Response, max: number = INTAKE_LIMITS.pageBytes): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  const bytes = new Uint8Array(Math.min(total, max));
  let at = 0;
  for (const c of chunks) {
    const part = c.subarray(0, bytes.length - at);
    bytes.set(part, at);
    at += part.length;
  }
  return new TextDecoder().decode(bytes);
}
