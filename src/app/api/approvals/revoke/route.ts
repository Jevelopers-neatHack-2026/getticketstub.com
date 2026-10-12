import { revokeApproval } from "@/server/approval";
import { getRequestContext, requireCapability } from "@/server/context";
import { recordEvent } from "@/server/event-log";
import { refOf } from "@/server/events";
import { HttpError, checkOrigin, clientIp, isObject, json, limit, notFound, readJson, route } from "@/server/http";
import { requireStorage } from "@/server/index";

// Ends an approval's authority. A revocation is a new row; the approval record stays, and so does every stored art file.
export const POST = route(async (req: Request) => {
  requireStorage();
  checkOrigin(req);
  limit(`approve-revoke:ip:${clientIp(req)}`, 60, 15 * 60_000);
  const body = await readJson(req, 1024);
  if (!isObject(body) || typeof body.stubId !== "string" || typeof body.approvalId !== "string" || body.approvalId.length > 64) {
    throw new HttpError(400, "bad_request", "Send { stubId, approvalId }.");
  }
  const ctx = await getRequestContext(req, { kind: "stub", id: body.stubId });
  requireCapability(ctx, "stub.approve"); // not their stub: 404, identical to a stub that does not exist
  const result = await revokeApproval(ctx.tenant.id, body.stubId, body.approvalId);
  if (result === "missing") throw notFound(); // not one of theirs: the same 404
  await recordEvent(req, "approval_revoked", { approval: refOf(body.approvalId), already: result === "already" }, { project: body.stubId, ctx });
  return json({ ok: true, revoked: true, already: result === "already" });
});
