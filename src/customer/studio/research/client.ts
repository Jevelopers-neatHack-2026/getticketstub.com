// Browser-side calls to the research, art and agent routes. Errors carry user-facing copy.
import type { ArtLayer, EventData, Stub } from "../types";
import { currentVersion } from "../types";

const READ_ERROR = "We couldn't read that link.";

async function postJson<T>(path: string, body: unknown, fallbackError: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error("You look offline. Check your connection and try again.");
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error(fallbackError);
  }
  if (!res.ok || (data && typeof data === "object" && "error" in data)) {
    const msg = (data as { error?: unknown })?.error;
    throw new Error(typeof msg === "string" && msg ? msg : fallbackError);
  }
  return data as T;
}

/** Research one event from a link (or a demo keyword). Throws Error(message) on failure. */
export async function researchEvent(input: { url?: string; query?: string }): Promise<EventData> {
  if (input.url && input.url.trim()) {
    return postJson<EventData>("/api/research", { url: input.url.trim() }, READ_ERROR);
  }
  if (input.query && input.query.trim()) {
    const results = await searchEvents(input.query);
    if (!results[0]) throw new Error("We couldn't find that show. Try the artist, team or venue name.");
    return results[0];
  }
  throw new Error("Paste a link or search for your show.");
}

/** Search fallback. Results are demo events, labelled simulated. */
export async function searchEvents(query: string): Promise<EventData[]> {
  const data = await postJson<{ results?: EventData[] }>("/api/research", { query }, "Search is unavailable right now. Try again in a moment.");
  return Array.isArray(data.results) ? data.results : [];
}

/** Remix the art layer for a stub. The caller pushes it as a new DesignVersion. */
export async function remixArt(stub: Stub, vibe?: string): Promise<ArtLayer> {
  const v = currentVersion(stub);
  return postJson<ArtLayer>(
    "/api/art",
    { event: stub.event, vibe, seed: Math.floor(Math.random() * 2_147_483_647), edition: v?.edition, first: false },
    "We couldn't remix the art. Try again in a moment.",
  );
}

/** Optional server reply. Preview mode, missing configuration or request failure falls back to rules. */
export async function askAgent(stub: Stub, message: string): Promise<{ reply: string; provenance: "live" } | undefined> {
  try {
    const res = await fetch("/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: stub.event, message }),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { reply?: string; provenance?: string };
    return data.reply && data.provenance === "live" ? { reply: data.reply, provenance: "live" } : undefined;
  } catch {
    return undefined;
  }
}
