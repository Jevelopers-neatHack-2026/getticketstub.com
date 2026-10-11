import { NextResponse } from "next/server";
import { generateText, providerFailure } from "@/server/ai/providers";
import type { EventData } from "@/customer/studio/types";
import { getRequestContext, requireCapability } from "@/server/context";
import { HttpError, errorJson, errorResponse, foreignOrigin } from "@/server/http";
import { annotate, observeRoute, providerObserver } from "@/server/observability/measure";

// Optional direct-provider replies retain the labelled simulated fallback.
// Explicit OpenRouter failures return a bounded error instead of silently falling back.

export const POST = observeRoute("agent", async (req: Request) => {
  annotate({ operation: "agent_reply" });
  if (process.env.TICKETSTUB_RUNTIME_MODE !== "live") {
    annotate({ dependency: "demo", fallback: "rules" });
    return new NextResponse(null, { status: 204 });
  }
  if (foreignOrigin(req)) {
    annotate({ code: "bad_origin" });
    return errorResponse(new HttpError(403, "bad_origin", "This request didn't come from TicketStub."));
  }
  try {
    requireCapability(await getRequestContext(req), "agent.use");
  } catch (e) {
    annotate({ code: e instanceof HttpError ? e.code : "internal" });
    return errorResponse(e);
  }

  let body: { event?: EventData; message?: string };
  try {
    body = (await req.json()) as { event?: EventData; message?: string };
  } catch {
    annotate({ code: "bad_request" });
    return errorJson(400, "bad_request", "Send a message.");
  }
  const message = typeof body.message === "string" ? body.message.slice(0, 600) : "";
  if (!message || !body.event) {
    annotate({ code: "bad_request" });
    return errorJson(400, "bad_request", "Send a message.");
  }

  const facts = (body.event.facts ?? []).map((f) => `- ${f.label} (${f.value}; source ${f.source}; ${f.provenance}; confidence ${f.confidence})`).join("\n");
  const system = `You are the TicketStub research agent helping someone design a keepsake stub for an event they attended.
Voice: clear, short (max 2 sentences), benefit first, no exclamation marks, no puns.
Only state facts listed below; if asked about something not listed, say you could not confirm it. Never invent sources.`;
  const user = `Event: ${body.event.title}${body.event.dateISO ? `, ${body.event.dateISO}` : ""}${body.event.venue ? `, ${body.event.venue}` : ""}${body.event.city ? `, ${body.event.city}` : ""}.
Facts:
${facts || "(none)"}

Message: ${message}`;

  try {
    const result = await generateText({ capability: "agent", prompt: user, system, maxTokens: 300, signal: req.signal, observe: providerObserver() });
    if (!result) {
      annotate({ dependency: "none", fallback: "rules" });
      return new NextResponse(null, { status: 204 });
    }
    annotate({ dependency: "provider" });
    return NextResponse.json({ reply: result.value, provenance: "live", providerMetadata: result.metadata });
  } catch (error) {
    const failure = providerFailure(error);
    annotate({ dependency: "provider", code: failure?.body.code ?? "internal" });
    if (failure && (process.env.TICKETSTUB_AGENT_PROVIDER === "openrouter" || failure.body.code === "invalid_provider_configuration")) return errorJson(failure.status, failure.body.code, failure.body.error);
    annotate({ fallback: "rules" });
    return new NextResponse(null, { status: 204 });
  }
});
