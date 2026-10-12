import { HttpError, clientIp, isObject, json, limit, route } from "@/server/http";
import { requireStorage } from "@/server/index";
import { ORDER_AUTH_REASON_STATUS, parseExpect, readConsumerJson, verifyOrderAuthorizationLive } from "@/server/order-authorization";
import { ORDER_AUTH_FAILURES } from "@/server/order-auth-token";

// The read-only verification port for the fulfillment consumer. It answers what the issuer says about a token right now for the
// exact scope and terms the consumer holds. It never claims: a verify that says ok leaves the authorization claimable. The request
// is signed with ORDER_AUTH_CONSUMER_KEY (a stopgap, see docs/architecture/order-authorization.md); there is no cookie and no Origin.
export const POST = route(async (req: Request) => {
  requireStorage();
  limit(`order-auth-consumer:ip:${clientIp(req)}`, 600, 60_000);
  const body = await readConsumerJson(req, 8 * 1024);
  if (!isObject(body) || typeof body.token !== "string") throw new HttpError(400, "bad_request", "Send { token, expect: { tenant, project, action, provider, terms } }.");
  const result = await verifyOrderAuthorizationLive(body.token, parseExpect(body.expect));
  if (result.ok) return json({ ok: true, authorization: result.authorization, checkedAt: new Date().toISOString() });
  const reason = ORDER_AUTH_FAILURES.includes(result.reason) ? result.reason : "unknown";
  return json({ ok: false, reason, ...(result.fields ? { fields: result.fields } : {}), error: { code: "authorization_invalid", message: "That authorization doesn't cover this purchase." } }, { status: ORDER_AUTH_REASON_STATUS[reason] ?? 403 });
});
