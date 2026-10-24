import { NextResponse } from "next/server";
import type { EventData } from "@/customer/studio/types";

// Optional free-text replies require live runtime mode and ANTHROPIC_API_KEY.
// Preview mode, a missing key, or model failure returns 204 so the client uses simulated replies.

export async function POST(req: Request) {
  if (process.env.TICKETSTUB_RUNTIME_MODE !== "live") return new NextResponse(null, { status: 204 });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return new NextResponse(null, { status: 204 });

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
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 300, system, messages: [{ role: "user", content: user }] }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return new NextResponse(null, { status: 204 });
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const reply = data.content?.find((c) => c.type === "text")?.text?.trim();
    if (!reply) return new NextResponse(null, { status: 204 });
    return NextResponse.json({ reply, provenance: "live" });
  } catch {
    return new NextResponse(null, { status: 204 });
  }
}
