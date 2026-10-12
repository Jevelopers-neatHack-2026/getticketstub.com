import { getRequestContext, requireCapability } from "@/server/context";
import { recordEvent } from "@/server/event-log";
import { refOf } from "@/server/events";
import { HttpError, checkOrigin, clientIp, isObject, json, limit, notFound, readJson, route } from "@/server/http";
import { requireStorage } from "@/server/index";
import { isProvider, issueOrderAuthorization, listOrderAuthorizations, parseIdempotencyKey } from "@/server/order-authorization";
import { HEX64 } from "@/server/order-auth-token";

// Order authorization (GT-07, ticketstub.order-authorization/1). Issued only here, only by the signed-in owner of the stub, only on
// an explicit confirmation, and only for the stub as the server holds it: the body names the stub, the print.compose approval to
// reference, the quote and destination reference the owner confirmed and the version they were looking at, never the content.
// It is not an approval and not a payment (see docs/architecture/order-authorization.md).

const STUB_ID = /^[\w.:-]{1,128}$/;
const REF = /^[\w.:-]{8,128}$/;
const bad = (m = "Send { stubId, approvalId, expectedVersionId, orderRef, quote, destination, idempotencyKey, confirm: true }.") => new HttpError(400, "bad_request", m);

/** GET /api/order-authorizations?project=stub:<id>: the owner's authorizations for one stub, newest first, each with its current status. */
export const GET = route(async (req: Request) => {
  requireStorage();
  limit(`order-auth-read:ip:${clientIp(req)}`, 120, 60_000);
  const m = /^stub:([\w.:-]{1,128})$/.exec(new URL(req.url).searchParams.get("project") ?? "");
  if (!m) throw notFound();
  const ctx = await getRequestContext(req, { kind: "stub", id: m[1] });
  requireCapability(ctx, "order.authorize"); // a stub that isn't theirs is a 404, exactly as if it did not exist
  return json({ authorizations: await listOrderAuthorizations(ctx.tenant.id, m[1]) });
});

/** POST /api/order-authorizations: confirm one order for one provider, once. `confirm` must be the literal true. */
export const POST = route(async (req: Request) => {
  requireStorage();
  checkOrigin(req);
  limit(`order-auth:ip:${clientIp(req)}`, 30, 15 * 60_000);
  const body = await readJson(req, 4096);
  if (!isObject(body) || typeof body.stubId !== "string" || !STUB_ID.test(body.stubId) || typeof body.approvalId !== "string" || body.approvalId.length === 0 || body.approvalId.length > 64) throw bad();
  if (typeof body.expectedVersionId !== "string" || body.expectedVersionId.length === 0 || body.expectedVersionId.length > 128) throw bad();
  if (typeof body.orderRef !== "string" || !REF.test(body.orderRef) || body.orderRef.length > 64) throw bad("orderRef must be an opaque reference of 8 to 64 characters.");
  if (body.confirm !== true) throw bad("An order is only authorized by an explicit confirmation: send confirm: true.");
  const quote = body.quote;
  if (!isObject(quote) || typeof quote.id !== "string" || quote.id.length === 0 || quote.id.length > 200 || typeof quote.amountMinor !== "number" || !Number.isInteger(quote.amountMinor) || quote.amountMinor < 1 || quote.amountMinor > 100_000_000 || typeof quote.currency !== "string") throw bad("Send the quote you confirmed: { id, amountMinor, currency }.");
  const dest = body.destination;
  if (!isObject(dest) || typeof dest.ref !== "string" || !REF.test(dest.ref) || typeof dest.digest !== "string" || !HEX64.test(dest.digest)) throw bad("destination must be an opaque { ref, digest }, never an address.");
  const quantity = body.quantity === undefined ? 1 : body.quantity;
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw bad("quantity must be a whole number from 1 to 100.");
  const provider = body.provider === undefined ? "sandbox" : body.provider;
  if (!isProvider(provider)) throw bad("provider must be sandbox or prodigi.");
  const idempotencyKey = parseIdempotencyKey(body.idempotencyKey);
  const ctx = await getRequestContext(req, { kind: "stub", id: body.stubId });
  requireCapability(ctx, "order.authorize");
  const { view, created } = await issueOrderAuthorization(ctx, {
    stubId: body.stubId,
    approvalId: body.approvalId,
    expectedVersionId: body.expectedVersionId,
    orderRef: body.orderRef,
    quantity,
    provider,
    quote: { id: quote.id, amountMinor: quote.amountMinor, currency: quote.currency },
    destination: { ref: dest.ref, digest: dest.digest },
    idempotencyKey,
  });
  await recordEvent(req, "order_authorized", { provider, authorization: refOf(view.authorization.id), reissued: !created }, { project: body.stubId, ctx });
  return json({ ...view, created });
});
