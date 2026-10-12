import { recordEvent } from "@/server/event-log";
import { HttpError, clientIp, isObject, json, limit, route } from "@/server/http";
import { requireStorage } from "@/server/index";
import { LOGGED_REFUSALS, ORDER_AUTH_REASON_STATUS, parseExpect, readConsumerJson, revalidateOrderAuthorization } from "@/server/order-authorization";
import { ORDER_AUTH_FAILURES } from "@/server/order-auth-token";

// Dispatch-time revalidation, for the fulfillment consumer: POST { token, expect: { ..., claimReference } }, called after the claim and
// immediately before the provider call. It re-checks everything now (scope and terms, revoked, expired, the referenced approval still
// current, membership, capability version, the order gate) and that the claim reference is the committed one. It never changes anything.
export const POST = route(async (req: Request) => {
  requireStorage();
  limit(`order-auth-consumer:ip:${clientIp(req)}`, 600, 60_000);
  const body = await readConsumerJson(req, 8 * 1024);
  if (!isObject(body) || typeof body.token !== "string") throw new HttpError(400, "bad_request", "Send { token, expect: { tenant, project, action, provider, terms, claimReference } }.");
  const expect = parseExpect(body.expect, true);
  const result = await revalidateOrderAuthorization(body.token, expect);
  if (result.ok) return json({ ok: true, status: "dispatchable", authorization: result.authorization, checkedAt: new Date().toISOString() });
  const reason = ORDER_AUTH_FAILURES.includes(result.reason) ? result.reason : "unknown";
  if (LOGGED_REFUSALS.has(reason)) await recordEvent(req, "authorization_refused", { op: "revalidate", reason }, { account: expect.tenant, project: expect.project?.id });
  return json({ ok: false, status: "rejected", reason, ...(result.fields ? { fields: result.fields } : {}), error: { code: "authorization_invalid", message: "That authorization doesn't cover this purchase." } }, { status: ORDER_AUTH_REASON_STATUS[reason] ?? 403 });
});
