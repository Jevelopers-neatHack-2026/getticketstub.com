// Diagnostic evidence only. The caller owns the original screenshot and comparison result.
// No helper here decodes an image, draws a canvas, changes the DOM, or retries an assertion.
import { createHash } from "node:crypto";

const OFFSETS_MS = [100, 500];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clock = () => performance.now();
const elapsed = (start, now) => Math.round((now - start) * 100) / 100;

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("capture diagnostic unavailable")), 2000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

export async function browserProvenance(conn) {
  try {
    const version = await bounded(conn.send("Browser.getVersion"));
    const formats = { protocolVersion: /^\d+\.\d+$/, product: /^(HeadlessChrome|Chrome|Chromium|Edg)\/\d+(\.\d+){1,4}$/,
      revision: /^@?[a-f\d]{7,64}$/i, jsVersion: /^\d+(\.\d+){1,5}$/ };
    const fields = Object.fromEntries(Object.entries(formats).map(([key, format]) => [key,
      typeof version[key] === "string" && version[key].length <= 128 && format.test(version[key]) ? version[key] : "omitted_unrecognized_format"]));
    // A custom user agent may contain private text. Keep only its bounded digest, never the raw value.
    const userAgent = typeof version.userAgent === "string" && version.userAgent.length <= 4096
      ? { status: "hashed", sha256: createHash("sha256").update(version.userAgent).digest("hex") } : { status: "omitted" };
    return { status: "recorded", method: "Browser.getVersion", ...fields, userAgent };
  } catch {
    return { status: "unavailable", method: "Browser.getVersion" };
  }
}

// This function is serialized into an ALREADY EXISTING page eval. The final pre-capture sample now
// explicitly reads bounded presentation state. Those reads can flush layout and affect the first frame;
// they are observations, never readiness gates. Earlier identity/decode samples still do not read styles.
function installCaptureProvenance() {
  const MAX_IMAGES = 8, MAX_SNAPSHOTS = 6, MAX_SOURCE_CHARS = 65536, MAX_ANCESTORS = 16, MAX_CAPTURE_NODES = 48;
  const nodes = new WeakMap();
  const snapshots = [];
  const capturedNodes = new Map(), capturedParents = new Map(), omittedNodes = new WeakSet();
  let captureId = null, captureNodeIds = [], nodeRetentionOmissions = 0, nodesReleased = false;
  let capturedFigure = null, capturedImages = [], capturedImageCount = 0, captureBindingStatus = "not_requested";
  let nextId = 1;
  let snapshotsOmitted = 0;
  const id = (node) => {
    if (!node) return null;
    if (!nodes.has(node)) nodes.set(node, nextId++);
    return nodes.get(node);
  };
  const finite = (n) => Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  const rect = (node) => {
    const r = node.getBoundingClientRect();
    return Object.fromEntries(["x", "y", "width", "height"].map((key) => [key, finite(r[key])]));
  };
  // No arbitrary CSS text, URLs, class names, element IDs, animation names or text content.
  const styles = (node) => {
    const s = getComputedStyle(node);
    const animations = node.getAnimations();
    const choice = (value, allowed) => allowed.includes(value) ? value : "other";
    const matrix = /^(none|matrix(3d)?\([-+\d., eE]+\))$/;
    const tiltVariable = (name, unit) => {
      const value = s.getPropertyValue?.(name)?.trim();
      if (!value) return { status: "unset_or_unavailable" };
      const numeric = unit === "deg" ? /^[-+]?(\d+(\.\d*)?|\.\d+)deg$/ : /^[-+]?(\d+(\.\d*)?|\.\d+)$/;
      const parsed = Number.parseFloat(value);
      return value.length <= 32 && numeric.test(value) && Number.isFinite(parsed) && Math.abs(parsed) <= 10000
        ? { status: "recorded", value: finite(parsed), unit } : { status: "omitted_unrecognized_value" };
    };
    return {
      display: choice(s.display, ["none", "block", "inline", "inline-block", "flex", "grid", "contents"]),
      visibility: choice(s.visibility, ["visible", "hidden", "collapse"]),
      opacity: finite(Number(s.opacity)),
      transform: matrix.test(s.transform) && s.transform.length <= 512 ? s.transform : "other",
      transformStyle: choice(s.transformStyle, ["flat", "preserve-3d"]),
      perspective: s.perspective === "none" ? "none" : finite(Number.parseFloat(s.perspective)),
      backfaceVisibility: choice(s.backfaceVisibility, ["visible", "hidden"]),
      hasFilter: s.filter !== "none", hasMask: s.maskImage !== "none", hasClipPath: s.clipPath !== "none",
      isolation: choice(s.isolation, ["auto", "isolate"]),
      overflowX: choice(s.overflowX, ["visible", "hidden", "clip", "scroll", "auto"]),
      overflowY: choice(s.overflowY, ["visible", "hidden", "clip", "scroll", "auto"]),
      contentVisibility: choice(s.contentVisibility, ["visible", "hidden", "auto"]),
      objectFit: choice(s.objectFit, ["fill", "contain", "cover", "none", "scale-down"]),
      // useTilt writes these numeric variables from JS requestAnimationFrame; getAnimations alone
      // cannot establish that the element is stationary. Never export arbitrary custom properties.
      tilt: { rx: tiltVariable("--rx", "deg"), ry: tiltVariable("--ry", "deg"), px: tiltVariable("--px", "number"), py: tiltVariable("--py", "number") },
      animationCount: animations.length, animationsTruncated: animations.length > 4,
      animations: animations.slice(0, 4).map((a) => ({
        kind: "transitionProperty" in a ? "css_transition" : "animationName" in a ? "css_animation" : "other",
        playState: choice(a.playState, ["idle", "running", "paused", "finished"]),
        pending: a.pending === true, currentTime: finite(a.currentTime), startTime: finite(a.startTime), playbackRate: finite(a.playbackRate),
        durationMs: finite(a.effect?.getComputedTiming?.().duration),
      })),
    };
  };
  const source = async (value) => {
    const chars = value.length;
    if (chars > MAX_SOURCE_CHARS) return { status: "omitted_too_long", chars };
    try {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
      return { status: "hashed", chars, sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("") };
    } catch {
      return { status: "digest_unavailable", chars };
    }
  };
  const retainSource = (value) => {
    const raw = String(value ?? "");
    return raw.length > MAX_SOURCE_CHARS ? { status: "omitted_too_long", chars: raw.length } : { status: "pending_digest", raw };
  };
  const collector = {
    sample(phase, figure, images, includePresentation = false, requestedCaptureId = null) {
      if (snapshots.length >= MAX_SNAPSHOTS) { snapshotsOmitted++; return; }
      const snapshot = { phase, at: finite(performance.now()), figureId: id(figure), imageCount: images.length, imagesTruncated: images.length > MAX_IMAGES };
      snapshots.push(snapshot);
      const beforeFirst = phase === "before_original_capture" && includePresentation;
      if (includePresentation) snapshot.presentationRead = beforeFirst ? "before_first_screenshot" : "after_screenshot";
      if (beforeFirst) {
        if (captureId) captureBindingStatus = "duplicate_capture_binding";
        else if (typeof requestedCaptureId === "string" && /^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(requestedCaptureId)) {
          captureId = requestedCaptureId;
          capturedFigure = figure;
          capturedImageCount = images.length;
          capturedImages = images.slice(0, MAX_IMAGES);
          captureBindingStatus = "recorded";
        } else captureBindingStatus = "invalid_capture_id";
      }
      const retain = (node) => {
        if (!beforeFirst || captureBindingStatus !== "recorded" || !node || capturedNodes.has(id(node)) || omittedNodes.has(node)) return;
        if (capturedNodes.size === MAX_CAPTURE_NODES) { omittedNodes.add(node); nodeRetentionOmissions++; return; }
        capturedNodes.set(id(node), node);
        capturedParents.set(id(node), node.parentElement);
        captureNodeIds.push(id(node));
      };
      const presentations = new Map();
      const presentation = (node) => {
        retain(node);
        if (!presentations.has(node)) {
          try { presentations.set(node, { presentationStatus: "recorded", rect: rect(node), styles: styles(node) }); }
          catch { presentations.set(node, { presentationStatus: "unavailable" }); }
        }
        return presentations.get(node);
      };
      try {
        snapshot.status = figure ? "recorded" : "figure_unavailable";
        snapshot.fonts = document.fonts.status === "loaded" ? "loaded" : "loading";
        snapshot.visibility = ["visible", "hidden"].includes(document.visibilityState) ? document.visibilityState : "other";
        if (includePresentation && figure) snapshot.figure = { nodeId: id(figure), ...presentation(figure) };
        snapshot.images = images.slice(0, MAX_IMAGES).map((img) => {
          const image = { nodeId: id(img), connected: img.isConnected === true, complete: img.complete === true,
            naturalWidth: finite(img.naturalWidth), naturalHeight: finite(img.naturalHeight),
            src: retainSource(img.src), currentSrc: retainSource(img.currentSrc) };
          if (includePresentation) {
            Object.assign(image, presentation(img));
            image.ancestors = [];
            let p = img.parentElement, last = null;
            for (let n = 0; p && n < MAX_ANCESTORS; p = p.parentElement, n += 1) {
              image.ancestors.push({ nodeId: id(p), ...presentation(p) });
              last = p;
            }
            // Continue above the figure: page/checkout ancestors can animate or hide the whole preview.
            image.ancestorsTruncated = !!p;
            image.ancestorBoundary = p ? "limit" : last === document.documentElement ? "document_root" : "detached_or_shadow_root";
          }
          return image;
        });
        if (includePresentation && figure) {
          snapshot.figureRect = snapshot.figure.rect;
          snapshot.presentationReadCompletedAt = finite(performance.now());
        }
      } catch {
        snapshot.status = "unavailable";
      }
    },
    // Only retained pre-first references are exposed as remote objects, after that screenshot returns.
    // A fresh query could silently map a replacement element to an earlier layer record.
    nodeStatusForCapture(requestedId, currentFigure) {
      const unavailable = (reason) => ({ status: "unavailable", reason });
      if (requestedId !== captureId || captureBindingStatus !== "recorded") return unavailable("capture_binding_unavailable");
      if (nodesReleased) return unavailable("references_released");
      if (!capturedFigure || capturedFigure !== currentFigure || !capturedFigure.isConnected) return unavailable("figure_replaced_or_disconnected");
      const currentImages = [...currentFigure.querySelectorAll("img")];
      if (currentImages.length !== capturedImageCount || capturedImages.some((node, index) => node !== currentImages[index])) return unavailable("images_replaced");
      for (const [nodeId, node] of capturedNodes) {
        if (!node.isConnected) return unavailable("node_disconnected");
        if (node.parentElement !== capturedParents.get(nodeId)) return unavailable("ancestry_changed");
      }
      return { status: nodeRetentionOmissions || capturedImageCount > MAX_IMAGES ? "partial" : "recorded", nodeIds: [...captureNodeIds], omitted: nodeRetentionOmissions };
    },
    nodesForCapture(requestedId, currentFigure) {
      const state = this.nodeStatusForCapture(requestedId, currentFigure);
      return ["recorded", "partial"].includes(state.status) ? captureNodeIds.map((nodeId) => capturedNodes.get(nodeId)) : null;
    },
    releaseCapture(requestedId) {
      if (requestedId !== captureId) return false;
      capturedNodes.clear(); capturedParents.clear(); capturedImages = []; capturedFigure = null; nodesReleased = true;
      return true;
    },
    async read() {
      // Hash after the original screenshot. Raw sources never cross the CDP return boundary.
      for (const snapshot of snapshots) for (const image of snapshot.images ?? []) {
        for (const key of ["src", "currentSrc"]) if (image[key].status === "pending_digest") {
          const held = image[key];
          image[key] = await source(held.raw);
          delete held.raw;
        }
      }
      const firstPresentationRead = snapshots.some((s) => s.presentationRead === "before_first_screenshot");
      return { status: "recorded", schema: "ticketstub.capture-provenance.v2", timeOrigin: finite(performance.timeOrigin),
        limits: { images: MAX_IMAGES, snapshots: MAX_SNAPSHOTS, sourceCharacters: MAX_SOURCE_CHARS, ancestors: MAX_ANCESTORS, captureNodes: MAX_CAPTURE_NODES },
        captureId, captureBindingStatus, preCaptureNodeIds: [...captureNodeIds], nodeRetentionOmissions, nodesReleased,
        sampledStylesOnlyAfterCapture: !firstPresentationRead, instrumentationMayAffectFirstCapture: firstPresentationRead,
        presentationReadsMayFlushLayout: firstPresentationRead, instrumentationMayAffectLaterScheduling: true,
        animationObservationDoesNotIncludeJavaScriptFrameLoops: true,
        snapshotsTruncated: snapshotsOmitted > 0, snapshotsOmitted, snapshots };
    },
  };
  window.__ticketstubCaptureProvenance = collector;
  return collector;
}

export const BEGIN_CAPTURE_PROVENANCE = `(${installCaptureProvenance.toString()})()`;

export async function readCaptureProvenance(page, figure, phase = "after_original_capture") {
  try {
    return await bounded(page.eval(`(async () => {
      const collector = window.__ticketstubCaptureProvenance;
      if (!collector) return { status: "unavailable" };
      const f = ${figure};
      collector.sample(${JSON.stringify(phase)}, f, f ? [...f.querySelectorAll("img")] : [], true);
      return await collector.read();
    })()`));
  } catch {
    // Diagnostic errors must not expose exception text (which can contain source URLs) or replace a required result.
    return { status: "unavailable" };
  }
}

export async function captureFailureFrames({ matched, page, figure, clip, originalCapturedAt, save, now = clock, wait = sleep }) {
  if (matched) return null;
  const failedAt = now();
  const evidence = { originalComparison: "failed", authoritativeFrame: "original", offsetOrigin: "failed_comparison_completed",
    instrumentationMayAffectLaterScheduling: true, frames: [] };
  // Exactly two diagnostic attempts. Never examine later pixels, retry until they match, or return a replacement image.
  for (const offsetMs of OFFSETS_MS) {
    await wait(Math.max(0, failedAt + offsetMs - now()));
    const frame = { requestedOffsetMs: offsetMs, startedAfterFailureMs: elapsed(failedAt, now()), startedAfterOriginalMs: elapsed(originalCapturedAt, now()) };
    evidence.frames.push(frame);
    try {
      const { data } = await bounded(page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, clip }));
      const png = Buffer.from(data, "base64");
      frame.completedAfterFailureMs = elapsed(failedAt, now());
      frame.sha256 = createHash("sha256").update(png).digest("hex");
      frame.file = await bounded(Promise.resolve().then(() => save(offsetMs, png)));
      frame.provenance = await readCaptureProvenance(page, figure, `after_diagnostic_${offsetMs}ms`);
      frame.status = "recorded";
    } catch {
      frame.status = "unavailable";
    }
  }
  return evidence;
}
