import { NextResponse } from "next/server";
import { generateText, providerFailure } from "@/server/ai/providers";
import type { EventData } from "@/customer/studio/types";

// Optional direct-provider replies retain the labelled simulated fallback.
// Explicit OpenRouter failures return a bounded error instead of silently falling back.

export async function POST(req: Request) {
  if (process.env.TICKETSTUB_RUNTIME_MODE !== "live") return new NextResponse(null, { status: 204 });

  let body: { event?: EventData; message?: string };
  try {
    body = (await req.json()) as { event?: EventData; message?: string };
  } catch {
    return NextResponse.json({ error: "Send a message." }, { status: 400 });
  }
  const message = typeof body.message === "string" ? body.message.slice(0, 600) : "";
  if (!message || !body.event) return NextResponse.json({ error: "Send a message." }, { status: 400 });

  const facts = (body.event.facts ?? []).map((f) => `- ${f.label} (${f.value}; source ${f.source}; ${f.provenance}; confidence ${f.confidence})`).join("\n");
  const system = `You are the TicketStub research agent helping someone design a keepsake stub for an event they attended.
Voice: clear, short (max 2 sentences), benefit first, no exclamation marks, no puns.
Only state facts listed below; if asked about something not listed, say you could not confirm it. Never invent sources.`;
  const user = `Event: ${body.event.title}${body.event.dateISO ? `, ${body.event.dateISO}` : ""}${body.event.venue ? `, ${body.event.venue}` : ""}${body.event.city ? `, ${body.event.city}` : ""}.
Facts:
${facts || "(none)"}

Message: ${message}`;

  try {
    const result = await generateText({ capability: "agent", prompt: user, system, maxTokens: 300, signal: req.signal });
    if (!result) return new NextResponse(null, { status: 204 });
    return NextResponse.json({ reply: result.value, provenance: "live", providerMetadata: result.metadata });
  } catch (error) {
    const failure = providerFailure(error);
    if (failure && (process.env.TICKETSTUB_AGENT_PROVIDER === "openrouter" || failure.body.code === "invalid_provider_configuration")) return NextResponse.json(failure.body, { status: failure.status });
    return new NextResponse(null, { status: 204 });
  }
}
