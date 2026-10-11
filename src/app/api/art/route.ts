import { NextResponse } from "next/server";
import { generateImage, providerFailure } from "@/server/ai/providers";
import { buildArtPrompt } from "@/customer/studio/research/artPrompt";
import type { ArtLayer, Edition, EventData } from "@/customer/studio/types";
import { ensureDevice, getRequestContext, requireCapability } from "@/server/context";
import { requestIdOf } from "@/server/events";
import { hashToken } from "@/server/crypto";
import { recordEvent } from "@/server/event-log";
import { HttpError, clientIp, errorJson, errorResponse, foreignOrigin } from "@/server/http";
import { getStorage, storageAvailable } from "@/server/index";
import { annotate, observeRoute, providerObserver } from "@/server/observability/measure";
import type { ArtQuota } from "@/server/storage";

// Daily caps on OpenAI art: per account, per device (an httpOnly cookie) and per IP as a backstop.
// The caps are read on every call but only counted when OpenAI is actually called, so a server
// without a key never uses anyone's allowance.
const PER_ACCOUNT = 10;
const PER_DEVICE = 10;
const PER_IP = 30;

// Art layer generation. "live" only when a real image model returned pixels in this request;
// otherwise a deterministic procedural layer (seed + vibe) marked "simulated".

interface ArtRequest {
  event?: EventData;
  vibe?: string;
  seed?: number;
  /** Optional: edition of the version being made. */
  edition?: Edition;
  /** Optional: true for the very first version of a stub (no remix yet). */
  first?: boolean;
}

function freshSeed(): number {
  return Math.floor(Math.random() * 2_147_483_647);
}

export const POST = observeRoute("art", async (req: Request) => {
  annotate({ operation: "art_generate" });
  // Guests make art too, so a missing Origin passes (no cookie is needed to call it); a foreign one doesn't.
  if (foreignOrigin(req)) {
    annotate({ code: "bad_origin" });
    return errorResponse(new HttpError(403, "bad_origin", "This request didn't come from TicketStub."));
  }
  const rc = await getRequestContext(req);
  try {
    requireCapability(rc, "art.generate");
  } catch (e) {
    annotate({ code: e instanceof HttpError ? e.code : "internal" });
    return errorResponse(e);
  }
  let body: ArtRequest;
  try {
    body = (await req.json()) as ArtRequest;
  } catch {
    annotate({ code: "bad_request" });
    return errorJson(400, "bad_request", "Send the event to remix.");
  }
  if (!body.event || typeof body.event.title !== "string") {
    annotate({ code: "bad_request" });
    return errorJson(400, "bad_request", "Send the event to remix.");
  }

  const vibe = typeof body.vibe === "string" && body.vibe.trim() ? body.vibe.trim().slice(0, 120) : undefined;
  const seed = typeof body.seed === "number" && Number.isFinite(body.seed) ? Math.floor(body.seed) : freshSeed();

  const device = ensureDevice(req);
  const headers: Record<string, string> = device.cookie ? { "set-cookie": device.cookie } : {};
  const reply = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { ...headers, "x-request-id": requestIdOf(req.headers) } });
  await recordEvent(req, "art_requested", { first: !!body.first }, { ctx: rc });

  const quotas: ArtQuota[] = [
    { key: `dev:${hashToken(device.id)}`, max: PER_DEVICE },
    { key: `ip:${hashToken(clientIp(req))}`, max: PER_IP },
    ...(rc.actor.kind === "account" ? [{ key: `acc:${rc.actor.id}`, max: PER_ACCOUNT }] : []),
  ];
  // Only a live server with an image provider key spends anyone's allowance.
  const imageProvider =
    process.env.TICKETSTUB_RUNTIME_MODE === "live" &&
    !!(process.env.TICKETSTUB_ART_PROVIDER === "openrouter" ? process.env.TICKETSTUB_ART_OPENROUTER_API_KEY : process.env.OPENAI_API_KEY)?.trim();
  // Storage off: no counters to spend, so fail open to procedural art and never call a provider.
  const saving = storageAvailable();
  const quota = saving ? await getStorage().useArtQuota(quotas, Date.now(), imageProvider) : { ok: true as const };
  annotate({ quota: !saving ? "storage_off" : quota.ok ? "ok" : "limited" });
  if (!quota.ok) {
    annotate({ code: "art_limit", dependency: "procedural", fallback: "procedural" });
    // Over the cap: say so, and hand back procedural art so the caller never has to show a broken stub.
    const art: ArtLayer = { kind: "procedural", seed, vibe, provenance: "simulated" };
    await recordEvent(req, "art_limit", { retryAt: quota.retryAt }, { ctx: rc });
    return reply(
      { error: { code: "art_limit", message: "You've made a lot of art today. Procedural art still works, and new art comes back tomorrow." }, retryAt: quota.retryAt, art },
      429,
    );
  }

  if (saving) {
    try {
      const result = await generateImage(buildArtPrompt(body.event, vibe), req.signal, providerObserver());
      if (result) {
        annotate({ dependency: "provider" });
        const art: ArtLayer = { kind: "image", src: result.value, seed, vibe, provenance: "live", providerMetadata: result.metadata };
        await recordEvent(req, "art_ready", { provider: "live" }, { ctx: rc });
        return reply(art);
      }
    } catch (error) {
      const failure = providerFailure(error);
      if (failure) await recordEvent(req, "art_failed", { code: failure.body.code }, { ctx: rc });
      annotate({ code: failure?.body.code ?? "internal" });
      if (failure && (process.env.TICKETSTUB_ART_PROVIDER === "openrouter" || failure.body.code === "invalid_provider_configuration")) {
        annotate({ dependency: "provider" });
        return reply({ error: { code: failure.body.code, message: failure.body.error } }, failure.status);
      }
    }
  }

  if (body.first && body.edition === "researched" && !vibe) {
    const art: ArtLayer = { kind: "image", src: "/brand/mockup-art-glasgow.webp", seed, provenance: "simulated" };
    annotate({ dependency: "fixture", fallback: "simulated" });
    await recordEvent(req, "art_ready", { provider: "simulated" }, { ctx: rc });
    return reply(art);
  }

  const art: ArtLayer = { kind: "procedural", seed, vibe, provenance: "simulated" };
  annotate({ dependency: "procedural", fallback: "procedural" });
  await recordEvent(req, "art_ready", { provider: "procedural" }, { ctx: rc });
  return reply(art);
});
