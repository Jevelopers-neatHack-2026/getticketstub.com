import { recordEvent } from "@/server/event-log";
import { refOf } from "@/server/events";
import { HttpError, clientIp, isObject, json, limit, route } from "@/server/http";
import { requireStorage } from "@/server/index";
import { LOGGED_REFUSALS, ORDER_AUTH_REASON_STATUS, claimOrderAuthorization, parseExpect, parseIdempotencyKey, readConsumerJson } from "@/server/order-authorization";
import { ORDER_AUTH_FAILURES } from "@/server/order-auth-token";

// The atomic single-use claim, for the fulfillment consumer: POST { token, idempotencyKey, expect }. First claim wins. The same key
// again returns the same claim while the authority still stands (the answer to a lost response). A different key after a claim is
// 409 already_claimed. The consumer must still call revalidate immediately before it sends, because a claim is not a promise that the
// authority will still hold at dispatch. The response shape follows fulfillment-connectors' AuthorizationClaimResult.
export const POST = route(async (req: Request) => {
  requireStorage();
  limit(`order-auth-consumer:ip:${clientIp(req)}`, 600, 60_000);
  const body = await readConsumerJson(req, 8 * 1024);
  if (!isObject(body) || typeof body.token !== "string") throw new HttpError(400, "bad_request", "Send { token, idempotencyKey, expect: { tenant, project, action, provider, terms } }.");
  const idemKey = parseIdempotencyKey(body.idempotencyKey);
  const expect = parseExpect(body.expect);
  const result = await claimOrderAuthorization(body.token, expect, idemKey);
  const account = expect.tenant;
  const project = expect.project?.id;
  if (result.ok) {
    await recordEvent(req, "authorization_claimed", { authorization: refOf(result.claim.authorizationId), replayed: result.replayed }, { account, project });
    return json({ ok: true, status: "claimed", replayed: result.replayed, ...result.claim });
  }
  const reason = ORDER_AUTH_FAILURES.includes(result.reason) ? result.reason : "unknown";
  if (LOGGED_REFUSALS.has(reason)) await recordEvent(req, "authorization_refused", { op: "claim", reason }, { account, project });
  return json({ ok: false, status: "rejected", reason, ...(result.fields ? { fields: result.fields } : {}), error: { code: "authorization_invalid", message: "That authorization doesn't cover this purchase." } }, { status: ORDER_AUTH_REASON_STATUS[reason] ?? 403 });
});
