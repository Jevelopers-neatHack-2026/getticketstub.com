// Which art sources the PNG export may fetch. A gifted or imported stub carries its own art.src, so the export never
// fetches an arbitrary same-origin GET on its behalf: only inline data, our own /api/art, or a public https picture.
export type ArtFetchPlan = { fetch: false } | { fetch: true; credentials: "same-origin" | "omit" };

/** Decides how (or whether) to fetch `src`. `base` is the page's own URL (location.href). Anything else is skipped. */
export function planArtFetch(src: string, base: string): ArtFetchPlan {
  if (!src || /^data:/i.test(src)) return { fetch: false };
  let url: URL;
  let self: URL;
  try {
    self = new URL(base);
    url = new URL(src, self);
  } catch {
    return { fetch: false };
  }
  if (url.origin === self.origin && (url.pathname === "/api/art" || url.pathname.startsWith("/api/art/"))) {
    // Resolved by URL, so "/api/art/../x" and "//host/api/art" can't pass for ours.
    return { fetch: true, credentials: "same-origin" };
  }
  if (url.protocol === "https:" && url.origin !== self.origin) return { fetch: true, credentials: "omit" };
  return { fetch: false };
}
