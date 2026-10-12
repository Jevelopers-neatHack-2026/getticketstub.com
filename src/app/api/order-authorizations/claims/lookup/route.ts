import { HttpError, clientIp, isObject, json, limit, route } from "@/server/http";
import { requireStorage } from "@/server/index";
import { lookupOrderClaim, parseIdempotencyKey, readConsumerJson } from "@/server/order-authorization";

// Unknown-claim reconciliation, for the fulfillment consumer after a lost response or a restart: POST { tenant, project, idempotencyKey,
// authorizationId? }. found:true returns the committed claim and what a revalidate would say now. found:false is definitive (a claim
// commits in one write lock, so nothing is in flight) and the same answer a key that was never used, or that is another tenant's, gets.
export const POST = route(async (req: Request) => {
  requireStorage();
  limit(`order-auth-consumer:ip:${clientIp(req)}`, 600, 60_000);
  const body = await readConsumerJson(req, 2048);
  const project = isObject(body) && typeof body.project === "string" ? /^stub:([\w.:-]{1,128})$/.exec(body.project) : null;
  if (!isObject(body) || typeof body.tenant !== "string" || body.tenant.length > 160 || !project) throw new HttpError(400, "bad_request", "Send { tenant, project: \"stub:<id>\", idempotencyKey }.");
  const idemKey = parseIdempotencyKey(body.idempotencyKey);
  const authorizationId = typeof body.authorizationId === "string" && body.authorizationId.length <= 64 ? body.authorizationId : null;
  return json({ ok: true, ...(await lookupOrderClaim(body.tenant, project[1], idemKey, authorizationId)), checkedAt: new Date().toISOString() });
});
