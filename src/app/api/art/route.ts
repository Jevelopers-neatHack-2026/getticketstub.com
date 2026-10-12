import { NextResponse } from "next/server";
import { generateImage, imageProviderConfigured, providerFailure } from "@/server/ai/providers";
import { buildArtPrompt } from "@/customer/studio/research/artPrompt";
import type { ArtLayer, Edition, EventData, EventType, Fact } from "@/customer/studio/types";
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
  /** Demo and fixture runtimes only: answer as a failed art provider, so the agent's recovery path can be shown and tested. */
  simulate?: "failure";
}

const EVENT_TYPES = new Set<EventType>(["concert", "game", "show", "generic"]);
const str = (v: unknown, max = 300): string | undefined => (typeof v === "string" && v.trim() ? v.slice(0, max) : undefined);

/** The validated subset of a request event that buildArtPrompt reads; anything malformed is dropped, not thrown on. */
function promptEvent(raw: EventData): EventData {
  const facts = Array.isArray(raw.facts)
    ? raw.facts.filter((f): f is Fact => !!f && typeof f === "object" && typeof f.id === "string" && typeof f.label === "string" && typeof f.value === "string").slice(0, 200)
    : [];
  return {
    type: EVENT_TYPES.has(raw.type) ? raw.type : "generic",
    title: raw.title.slice(0, 300),
    venue: str(raw.venue),
    city: str(raw.city),
    dateISO: str(raw.dateISO, 32),
    facts,
  };
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
  if (!body || typeof body !== "object" || !body.event || typeof body.event !== "object" || typeof body.event.title !== "string") {
    annotate({ code: "bad_request" });
    return errorJson(400, "bad_request", "Send the event to remix.");
  }

  // Only the fields the art prompt reads, each checked, so a malformed request field can't break the prompt build
  // (and spend the art allowance) before the image call.
  const event = promptEvent(body.event);
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
  // A configured live path needs durable quota counters. Missing storage is an
  // explicit failure; the default demo can still draw procedural art.
  const saving = storageAvailable();
  if (!saving && process.env.TICKETSTUB_RUNTIME_MODE === "live") {
    annotate({ code: "storage_unavailable", dependency: "storage" });
    return reply({ error: { code: "storage_unavailable", message: "Image generation needs available storage." } }, 503);
  }
  let imageProvider: boolean;
  try { imageProvider = imageProviderConfigured(); }
  catch (error) {
    const failure = providerFailure(error);
    const code = failure?.body.code ?? "provider_unavailable";
    annotate({ code, dependency: "provider" });
    await recordEvent(req, "art_failed", { code }, { ctx: rc });
    return reply({ error: { code, message: failure?.body.error ?? "Image generation is not configured." } }, failure?.status ?? 503);
  }
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

  // After the quota check, so a forced failure is metered like a real request and can't be looped unmetered.
  if (body.simulate === "failure" && process.env.TICKETSTUB_RUNTIME_MODE !== "live") {
    annotate({ code: "provider_unavailable", dependency: "provider" });
    await recordEvent(req, "art_failed", { code: "provider_unavailable" }, { ctx: rc });
    return reply({ error: { code: "provider_unavailable", message: "The selected AI service could not complete this request." } }, 502);
  }

  if (saving) {
    try {
      const result = await generateImage(buildArtPrompt(event, vibe), req.signal, providerObserver());
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
      if (failure) {
        annotate({ dependency: "provider" });
        return reply({ error: { code: failure.body.code, message: failure.body.error } }, failure.status);
      }
      if (process.env.TICKETSTUB_RUNTIME_MODE === "live") {
        annotate({ dependency: "provider" });
        await recordEvent(req, "art_failed", { code: "provider_unavailable" }, { ctx: rc });
        return reply({ error: { code: "provider_unavailable", message: "The selected AI service could not complete this request." } }, 502);
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
