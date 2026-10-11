"use client";
import { decodeStub, encodeStub } from "@/customer/studio/store";
import type { Stub } from "@/customer/studio/types";
import { flow, type EventParams } from "@/customer/flows/events";

/** Where a share started (the screen), and what was shared: both bounded, never the link itself. */
export type ShareContext = NonNullable<EventParams<"share">["context"]>;
export type ShareContent = NonNullable<EventParams<"share">["content_type"]>;
/** How a share ended: the share sheet finished, the person closed it, the link was copied, or nothing worked. */
export type ShareOutcome = "shared" | "cancelled" | "copied" | "failed";

export function absoluteUrl(path: string): string {
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path}`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Copy a link and report it once as a share by copy. Use this, not copyText, where a person copies a link to send. */
export async function copyLink(url: string, context: ShareContext, content: ShareContent): Promise<boolean> {
  const ok = await copyText(url);
  flow("share", { method: "copy", content_type: content, context, result: ok ? "success" : "failure" });
  return ok;
}

/**
 * The share sheet when there is one, else (or, with `copyOnCancel`, after it is closed) a copied link. Reports exactly one
 * `share` event: closing the sheet is a cancel, not a failure, and a resolved share sheet is the browser's word, not proof of delivery.
 */
export async function shareLink(data: ShareData & { url: string }, context: ShareContext, content: ShareContent, opts: { copyOnCancel?: boolean } = {}): Promise<ShareOutcome> {
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      await navigator.share(data);
      flow("share", { method: "native", content_type: content, context, result: "success" });
      return "shared";
    } catch (err) {
      const cancelled = (err as { name?: unknown } | null)?.name === "AbortError";
      if (cancelled && !opts.copyOnCancel) {
        flow("share", { method: "native", content_type: content, context, result: "cancel" });
        return "cancelled";
      }
    }
  }
  return (await copyLink(data.url, context, content)) ? "copied" : "failed";
}

export const memoryPath = (stub: Stub) => `/s/${encodeStub(stub)}`;

/** Lean copy for list tokens: only the current design version travels. */
function lean(stub: Stub): Stub {
  return { ...stub, photos: [], versions: stub.versions.filter((v) => v.id === stub.currentVersionId).slice(0, 1) };
}

export const WALL_TOKEN_MAX = 6;

/** Public wall token: up to 6 encoded stubs joined by "." (base64url never contains "."). */
export function encodeWall(stubs: Stub[]): string {
  return stubs.slice(0, WALL_TOKEN_MAX).map((s) => encodeStub(lean(s))).join(".");
}

export function decodeWall(token: string): Stub[] {
  return token
    .split(".")
    .map((t) => decodeStub(t))
    .filter((s): s is Stub => !!s && typeof s === "object" && !!s.event);
}

export function isStub(s: unknown): s is Stub {
  return !!s && typeof s === "object" && "event" in s && "id" in s && "versions" in s;
}

export function formatDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
