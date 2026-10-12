import { getRequestContext, requireCapability } from "@/server/context";
import { recordEvent } from "@/server/event-log";
import { refOf } from "@/server/events";
import { HttpError, checkOrigin, clientIp, isObject, json, limit, notFound, readJson, route } from "@/server/http";
import { requireStorage } from "@/server/index";
import { revokeOrderAuthorization } from "@/server/order-authorization";

// Ends an authorization's authority, claimed or not. A revocation is a new row; the record and any claim stay, and a dispatch-time
// revalidate reads the revocation. Revoking cannot undo a dispatch that already happened.
export const POST = route(async (req: Request) => {
  requireStorage();
  checkOrigin(req);
  limit(`order-auth-revoke:ip:${clientIp(req)}`, 60, 15 * 60_000);
  const body = await readJson(req, 1024);
  if (!isObject(body) || typeof body.stubId !== "string" || typeof body.authorizationId !== "string" || body.authorizationId.length > 64) {
    throw new HttpError(400, "bad_request", "Send { stubId, authorizationId }.");
  }
  const ctx = await getRequestContext(req, { kind: "stub", id: body.stubId });
  requireCapability(ctx, "order.authorize"); // not their stub: 404, identical to a stub that does not exist
  const result = await revokeOrderAuthorization(ctx.tenant.id, body.stubId, body.authorizationId);
  if (result === "missing") throw notFound(); // not one of theirs: the same 404
  await recordEvent(req, "authorization_revoked", { authorization: refOf(body.authorizationId), already: result === "already" }, { project: body.stubId, ctx });
  return json({ ok: true, revoked: true, already: result === "already" });
});
