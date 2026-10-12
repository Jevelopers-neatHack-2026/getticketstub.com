import { APPROVAL_PURPOSES, type ApprovalPurpose } from "@/server/approval-token";
import { issueApproval, listApprovals } from "@/server/approval";
import { getRequestContext, requireCapability } from "@/server/context";
import { recordEvent } from "@/server/event-log";
import { refOf } from "@/server/events";
import { HttpError, checkOrigin, clientIp, isObject, json, limit, notFound, readJson, route } from "@/server/http";
import { requireStorage } from "@/server/index";

// Artwork approval (GT-06B, ticketstub.approval/1). An approval is issued only here, only by the signed-in owner of the
// stub, and only for the stub as the server holds it: the body names the stub, the purpose and the version the owner was
// looking at, never the content. It is not a purchase authorization (see docs/architecture/approval.md).

const STUB_ID = /^[\w.:-]{1,128}$/;

/** GET /api/approvals?project=stub:<id>: the owner's approvals for one stub, newest first, each with its current status. */
export const GET = route(async (req: Request) => {
  requireStorage();
  limit(`approvals-read:ip:${clientIp(req)}`, 120, 60_000);
  const m = /^stub:([\w.:-]{1,128})$/.exec(new URL(req.url).searchParams.get("project") ?? "");
  if (!m) throw notFound();
  const ctx = await getRequestContext(req, { kind: "stub", id: m[1] });
  requireCapability(ctx, "stub.approve"); // a stub that isn't theirs is a 404, exactly as if it did not exist
  return json({ approvals: await listApprovals(ctx.tenant.id, m[1]) });
});

/** POST /api/approvals { stubId, purpose, expectedVersionId, size? }: approve the stub's selected version for one purpose. */
export const POST = route(async (req: Request) => {
  requireStorage();
  checkOrigin(req);
  limit(`approve:ip:${clientIp(req)}`, 60, 15 * 60_000);
  const body = await readJson(req, 2048);
  if (!isObject(body) || typeof body.stubId !== "string" || !STUB_ID.test(body.stubId) || typeof body.expectedVersionId !== "string" || body.expectedVersionId.length > 128) {
    throw new HttpError(400, "bad_request", "Send { stubId, purpose, expectedVersionId }.");
  }
  if (typeof body.purpose !== "string" || !(APPROVAL_PURPOSES as readonly string[]).includes(body.purpose)) {
    throw new HttpError(400, "bad_request", `purpose must be one of ${APPROVAL_PURPOSES.join(", ")}.`);
  }
  const ctx = await getRequestContext(req, { kind: "stub", id: body.stubId });
  requireCapability(ctx, "stub.approve");
  const { view, created } = await issueApproval(ctx, body.stubId, body.purpose as ApprovalPurpose, body.expectedVersionId, body.size);
  await recordEvent(req, "approval_issued", { purpose: body.purpose, approval: refOf(view.approval.id), reissued: !created }, { project: body.stubId, ctx });
  return json({ ...view, created });
});
