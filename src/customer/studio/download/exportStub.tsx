"use client";
// The exact stub as a PNG: the studio's own StubView, rendered once more off screen in its `still` mode (one face, flat,
// no tilt, flip, window light, desk shadow or animation) and rasterised by modern-screenshot (SVG foreignObject over the
// live DOM, so next/font faces, CSS masks, blend modes, cqw units and the procedural art come out as the browser draws them).
//
// What is on the PNG: paper and grain, the edition's edge (perforation, tear-off, corners), the selected version's art,
// every printed word (title, subtitle, venue/date, kept facts, the unsure-fact chips, guest name, the Open-Meteo credit),
// the foil or holo stock at rest, and on the back the setlist/score/cast/programme, note, friends, Memory page code and
// the Ts stamp. What is not: the desk, the drop shadow, tilt and glare, selection outlines, buttons, source marks and
// legends (those live outside StubView), and the stub's accessible description.
// Size: 3x the studio's large stub. Portrait editions 1080 x 1620 (2 x 3 in at 540 dpi), landscape 1680 wide (5.5 in at
// ~305 dpi); the height follows the edition's aspect. The corners outside the perforation stay transparent.
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { domToBlob } from "modern-screenshot";
import { currentVersion, type Stub } from "../types";
import { StubView } from "../stub/StubView";
import { EDITION_META } from "../stub/editions";
import { planArtFetch } from "./artSource";
import { checkFactFit } from "../facts/fitProof";

export type StubSide = "front" | "back";

/** The `lg` stub's CSS width (StubView WIDTHS) times EXPORT_SCALE is the PNG's width. The stub is laid out at the on-screen size (its hairlines and stripe pitch are screen pixels) and drawn 3x. */
const CSS_WIDTH = { portrait: 360, landscape: 560 } as const;
export const EXPORT_SCALE = 3;

/** A failure with a catalog code (feedback-messages), so the screen can say it in words and a flow event can name it. */
function coded(code: string, cause?: unknown): Error {
  return Object.assign(new Error(code, { cause }), { code });
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** The art as a data URL, so nothing is fetched or tainted while drawing. Cross-origin art that doesn't allow CORS can't be exported. */
async function inlineArt(stub: Stub): Promise<Stub> {
  const version = currentVersion(stub);
  const art = version?.art;
  if (!art || art.kind !== "image" || !art.src) return stub;
  // Only data:, our own /api/art and https pictures are fetched; anything else keeps the procedural art (no request at all).
  const plan = planArtFetch(art.src, location.href);
  if (!plan.fetch) return stub;
  let res: Response;
  try {
    res = await fetch(art.src, { mode: "cors", credentials: plan.credentials });
  } catch (e) {
    // a cross-origin picture without CORS headers throws here exactly like being offline; tell them apart
    throw coded(new URL(art.src, location.href).origin === location.origin ? "network" : "bad_image", e);
  }
  if (!res.ok) throw coded(res.status === 404 ? "not_found" : "unavailable");
  const blob = await res.blob();
  if (!blob.type.startsWith("image/")) throw coded("bad_image");
  const src = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(coded("bad_image"));
    r.onload = () => resolve(String(r.result));
    r.readAsDataURL(blob);
  });
  return { ...stub, versions: stub.versions.map((v) => (v.id === version.id ? { ...v, art: { ...v.art, src } } : v)) };
}

const isWebKitOnly = () => /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg|Android/.test(navigator.userAgent);

/** Renders one face of the stub to a PNG blob. Throws an Error with a catalog `code` when it can't. */
export async function renderStubPng(stub: Stub, side: StubSide = "front"): Promise<Blob> {
  if ((await checkFactFit(stub)).some((f) => f.state === "blocked")) throw coded("fact_layout_overflow");
  if (typeof document === "undefined") throw coded("unknown");
  const drawn = await inlineArt(stub);
  const meta = EDITION_META[currentVersion(drawn)?.edition ?? "researched"];

  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("inert", "");
  host.setAttribute("data-stub-export", side);
  // Off screen but laid out (not display:none), with the cap that keeps the stub under the viewport lifted.
  host.style.cssText = "position:fixed;left:0;top:0;z-index:-1;clip-path:inset(100%);pointer-events:none;contain:layout;--stub-max:2000px;";
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(<StubView stub={drawn} size="lg" still={side} />));
    const node = host.firstElementChild as HTMLElement | null;
    if (!node) throw coded("unknown");
    // Fonts first (the faces are fetched when the text is laid out), then every picture decoded.
    await nextFrame();
    await document.fonts.ready;
    await Promise.all(Array.from(host.querySelectorAll("img")).map((img) => img.decode().catch(() => undefined)));
    await nextFrame();
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) throw coded("unknown");
    const options = { scale: EXPORT_SCALE, backgroundColor: null, type: "image/png", timeout: 15_000, style: { margin: "0" } } as const;
    // The first pass after load can rasterise before the cloned art inside the SVG has been decoded (a cold Linux Chrome
    // produced a PNG with an empty art well), and WebKit paints foreignObject images and fonts on the second pass only.
    // So every browser takes a warm-up pass first: full size on WebKit, a cheap 1x one elsewhere. Its output is discarded.
    await domToBlob(node, isWebKitOnly() ? options : { ...options, scale: 1 }).catch(() => null);
    await nextFrame();
    const blob = await domToBlob(node, options).catch((e) => {
      throw coded("unknown", e);
    });
    if (!blob || blob.size < 1000 || Math.abs(rect.width - CSS_WIDTH[meta.orientation]) > 1) throw coded("unknown");
    return blob;
  } finally {
    root.unmount();
    host.remove();
  }
}

export function stubFileName(stub: Stub, side: StubSide = "front", now = new Date()): string {
  const slug = stub.event.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48).replace(/-$/, "") || "stub";
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return `ticketstub-${slug}-${date}${side === "back" ? "-back" : ""}.png`;
}

export type Delivery = "share" | "tab" | "download" | "cancelled";

const isIos = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function anchorDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Hands the file to the person. iPhone and iPad (Safari ignores `<a download>` for blobs): the share sheet with the file
 * ("Save Image", AirDrop, Files), else the picture opened in a tab to press and hold. Android and desktop: a normal download.
 */
export async function deliverPng(blob: Blob, filename: string): Promise<Delivery> {
  if (isIos()) {
    const file = new File([blob], filename, { type: "image/png" });
    if (typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename });
        return "share";
      } catch (e) {
        if ((e as { name?: string })?.name === "AbortError") return "cancelled";
        // not allowed (the gesture ran out while drawing) or unsupported: fall through to the tab
      }
    }
    const url = URL.createObjectURL(blob);
    const tab = window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
    if (tab) return "tab";
  }
  anchorDownload(blob, filename);
  return "download";
}
