import { NextResponse } from "next/server";
import { generateImage, providerFailure } from "@/server/ai/providers";
import { buildArtPrompt } from "@/customer/studio/research/artPrompt";
import type { ArtLayer, Edition, EventData } from "@/customer/studio/types";

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

export async function POST(req: Request) {
  let body: ArtRequest;
  try {
    body = (await req.json()) as ArtRequest;
  } catch {
    return NextResponse.json({ error: "Send the event to remix." }, { status: 400 });
  }
  if (!body.event || typeof body.event.title !== "string") {
    return NextResponse.json({ error: "Send the event to remix." }, { status: 400 });
  }

  const vibe = typeof body.vibe === "string" && body.vibe.trim() ? body.vibe.trim().slice(0, 120) : undefined;
  const seed = typeof body.seed === "number" && Number.isFinite(body.seed) ? Math.floor(body.seed) : freshSeed();

  try {
    const result = await generateImage(buildArtPrompt(body.event, vibe), req.signal);
    if (result) {
      const art: ArtLayer = { kind: "image", src: result.value, seed, vibe, provenance: "live", providerMetadata: result.metadata };
      return NextResponse.json(art);
    }
  } catch (error) {
    const failure = providerFailure(error);
    if (failure && (process.env.TICKETSTUB_ART_PROVIDER === "openrouter" || failure.body.code === "invalid_provider_configuration")) return NextResponse.json(failure.body, { status: failure.status });
  }

  if (body.first && body.edition === "researched" && !vibe) {
    const art: ArtLayer = { kind: "image", src: "/brand/mockup-art-glasgow.webp", seed, provenance: "simulated" };
    return NextResponse.json(art);
  }

  const art: ArtLayer = { kind: "procedural", seed, vibe, provenance: "simulated" };
  return NextResponse.json(art);
}
