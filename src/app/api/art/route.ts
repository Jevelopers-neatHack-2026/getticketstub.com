import { NextResponse } from "next/server";
import { buildArtPrompt } from "@/customer/studio/research/artPrompt";
import type { ArtLayer, Edition, EventData } from "@/customer/studio/types";

// Live mode can return generated pixels marked "live". Otherwise return simulated art:
// the bundled image for an initial researched edition without a vibe, or procedural art.

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

async function openAiImage(prompt: string): Promise<string | undefined> {
  if (process.env.TICKETSTUB_RUNTIME_MODE !== "live") return undefined;
  const key = process.env.OPENAI_API_KEY;
  if (!key) return undefined;
  try {
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-image-1", prompt, size: "1024x1536", n: 1, quality: "medium", output_format: "jpeg", output_compression: 82 }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { data?: { b64_json?: string }[] };
    const b64 = data.data?.[0]?.b64_json;
    return b64 ? `data:image/jpeg;base64,${b64}` : undefined;
  } catch {
    return undefined;
  }
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

  const src = await openAiImage(buildArtPrompt(body.event, vibe));
  if (src) {
    const art: ArtLayer = { kind: "image", src, seed, vibe, provenance: "live" };
    return NextResponse.json(art);
  }

  if (body.first && body.edition === "researched" && !vibe) {
    const art: ArtLayer = { kind: "image", src: "/brand/mockup-art-glasgow.webp", seed, provenance: "simulated" };
    return NextResponse.json(art);
  }

  const art: ArtLayer = { kind: "procedural", seed, vibe, provenance: "simulated" };
  return NextResponse.json(art);
}
