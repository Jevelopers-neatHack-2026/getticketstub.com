import { NextResponse } from "next/server";
import { checkOrigin, readJson, HttpError, route } from "@/server/http";
import { requireStorage } from "@/server/index";
import { creativeHostForRequest } from "@/server/creative/host.mjs";
import { CreativeHostError } from "@/server/creative/config.mjs";

const STATUS: Record<string, number> = { invalid_request: 400, unsupported_version: 400, unauthorized: 401, permission_denied: 403,
  scope_denied: 403, not_found: 404, conflict: 409, stale_version: 409, cancelled: 409, review_required: 409, unavailable: 503, budget_unavailable: 503, failed: 502 };

/** Canonical owned consumer; the existing studio image route keeps its separate
 * credential identity. Creative payloads name resources, never credentials,
 * actor grants, verified facts, Finance holds, or arbitrary provider URLs. */
export const POST = route(async (req: Request) => {
  requireStorage(); checkOrigin(req);
  const body = await readJson(req, 128 * 1024);
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof (body as { projectId?: unknown }).projectId !== "string") {
    throw new HttpError(400, "invalid_request", "Send an existing creative project reference.");
  }
  try {
    const host = await creativeHostForRequest(req, (body as { projectId: string }).projectId);
    const result = await host.invoke(body);
    if (!result.ok) return NextResponse.json(result, { status: STATUS[result.error.code] ?? 503 });
    const job = result.job;
    const failedCode = job?.error?.code;
    const status = ["queued", "running"].includes(job?.status ?? "") ? 202
      : job?.status === "failed" ? (failedCode ? STATUS[failedCode] ?? 503 : 503)
      : job?.status === "cancelled" ? 409 : 200;
    return NextResponse.json(result, { status });
  } catch (error) {
    if (error instanceof CreativeHostError) throw new HttpError(error.status, error.code, error.message);
    if (error instanceof HttpError) throw error;
    // Provider or database errors may contain secret-bearing details. Public
    // failures are content-free and never become simulated creative success.
    throw new HttpError(503, "creative_unavailable", "The creative service could not complete this request.");
  }
});
