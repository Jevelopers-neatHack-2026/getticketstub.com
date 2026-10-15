import { NextResponse } from "next/server";
import { generateText, providerFailure } from "@/server/ai/providers";
import { liveTurn, rulesTurn, toResponse } from "@/server/ai/agent-turn";
import type { Turn } from "@/server/ai/agent-turn";
import { parseRequest } from "@/customer/studio/agent/protocol";
import type { AgentRequest } from "@/customer/studio/agent/protocol";
import type { EventData } from "@/customer/studio/types";
import { getRequestContext, requireCapability } from "@/server/context";
import { recordEvent } from "@/server/event-log";
import { HttpError, clientIp, errorJson, errorResponse, foreignOrigin, isObject, limit, readJson } from "@/server/http";
import { agentStep, annotate, observeRoute, providerObserver } from "@/server/observability/measure";

// Two request shapes share this route.
//  - { schema: "ticketstub.agent-action/1", state, message?, results? }: the action protocol. The answer is
//    { schema, reply, actions[], provenance }. Live mode asks the model for strict JSON and validates it (one repair
//    attempt, then a safe reply with no actions); demo mode, and live with no model, uses the deterministic planner.
//  - { event, message }: the older short factual reply. Optional direct-provider replies retain the labelled
//    simulated fallback; explicit OpenRouter failures return a bounded error instead of silently falling back.
// Neither shape edits anything: the owner applies proposed actions in the studio.

const MAX_BODY = 24_000;
const WINDOW = 15 * 60_000;
const PER_IP = 120;

export const POST = observeRoute("agent", async (req: Request) => {
  annotate({ operation: "agent_reply" });
  if (foreignOrigin(req)) {
    annotate({ code: "bad_origin" });
    return errorResponse(new HttpError(403, "bad_origin", "This request didn't come from TicketStub."));
  }
  let body: unknown;
  try {
    body = await readJson(req, MAX_BODY);
  } catch (e) {
    // an unreadable body keeps this route's long-standing answer; a body that is too large keeps its own
    const unreadable = e instanceof HttpError && e.code === "bad_json";
    annotate({ code: unreadable ? "bad_request" : e instanceof HttpError ? e.code : "internal" });
    return unreadable ? errorJson(400, "bad_request", "Send a message.") : errorResponse(e);
  }
  if (isObject(body) && "schema" in body) return actionTurn(req, body);
  return legacyReply(req, body);
});

async function actionTurn(req: Request, body: Record<string, unknown>): Promise<Response> {
  try {
    requireCapability(await getRequestContext(req), "agent.use");
    limit(`agent:ip:${clientIp(req)}`, PER_IP, WINDOW);
  } catch (e) {
    annotate({ code: e instanceof HttpError ? e.code : "internal" });
    return errorResponse(e);
  }
  const parsed = parseRequest(body);
  if (!parsed.ok) {
    annotate({ code: "bad_request" });
    return errorJson(400, "bad_request", "That request wasn't valid. Try again.");
  }
  const input: AgentRequest = parsed.value;
  annotate({ operation: input.message !== undefined ? "agent_plan" : "agent_followup" });

  // What the browser observed when the owner applied the last actions: each result is a traced step.
  // (on a new message the same results are only context for the planner, and were traced with their own follow-up)
  for (const r of input.message === undefined ? (input.results ?? []) : []) {
    agentStep({ step: "result", action: r.action.type, outcome: r.status, code: r.code, durationMs: r.ms });
    if (r.status !== "applied") agentStep({ step: "failure", action: r.action.type, outcome: r.status, code: r.code });
    else if (r.action.type === "remix_art" && r.action.procedural) agentStep({ step: "recovery", action: r.action.type, outcome: "applied" });
    await recordEvent(req, "agent_action", { action: r.action.type === "none" ? undefined : r.action.type, result: r.status, code: r.code });
  }

  const started = performance.now();
  let turn: Turn;
  if (process.env.TICKETSTUB_RUNTIME_MODE !== "live") {
    annotate({ dependency: "demo", fallback: "rules" });
    turn = rulesTurn(input);
  } else {
    try {
      const live = await liveTurn({ req: input, signal: req.signal, observe: providerObserver() });
      if (live) {
        annotate({ dependency: "provider" });
        turn = live;
      } else {
        annotate({ dependency: "none", fallback: "rules" });
        turn = rulesTurn(input);
      }
    } catch (error) {
      const failure = providerFailure(error);
      annotate({ dependency: "provider", code: failure?.body.code ?? "internal" });
      if (failure && (process.env.TICKETSTUB_AGENT_PROVIDER === "openrouter" || failure.body.code === "invalid_provider_configuration")) {
        return errorJson(failure.status, failure.body.code, failure.body.error);
      }
      annotate({ fallback: "rules" });
      turn = rulesTurn(input);
    }
  }
  agentStep({
    step: input.message !== undefined ? "plan" : "followup",
    outcome: turn.outcome,
    source: turn.source,
    durationMs: performance.now() - started,
    count: turn.plan.actions.length,
    code: turn.outcome === "invalid_plan" ? "invalid_plan" : undefined,
  });
  await recordEvent(req, "agent_plan", { source: turn.source, outcome: turn.outcome, actions: turn.plan.actions.length });
  return NextResponse.json({ ...toResponse(turn), ...(turn.metadata ? { providerMetadata: turn.metadata } : {}) }, { headers: { "cache-control": "no-store" } });
}

async function legacyReply(req: Request, raw: unknown): Promise<Response> {
  if (process.env.TICKETSTUB_RUNTIME_MODE !== "live") {
    annotate({ dependency: "demo", fallback: "rules" });
    return new NextResponse(null, { status: 204 });
  }
  try {
    requireCapability(await getRequestContext(req), "agent.use");
  } catch (e) {
    annotate({ code: e instanceof HttpError ? e.code : "internal" });
    return errorResponse(e);
  }

  const body = (isObject(raw) ? raw : {}) as { event?: EventData; message?: string };
  const message = typeof body.message === "string" ? body.message.slice(0, 600) : "";
  if (!message || !body.event) {
    annotate({ code: "bad_request" });
    return errorJson(400, "bad_request", "Send a message.");
  }

  const facts = (Array.isArray(body.event.facts) ? body.event.facts : []).filter((f) => !!f && typeof f === "object").map((f) => `- ${f.label} (${f.value}; source ${f.source}; ${f.provenance}; confidence ${f.confidence})`).join("\n");
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
}
