import { verifyContextTokenLive } from "@/server/context";
import { HttpError, clientIp, isObject, json, limit, readJson, route } from "@/server/http";

// The verification port for a consumer in another process that can't hold the signing key. It answers what
// the issuer says about a token right now. It uses no cookie, so there is nothing for a cross-site page to ride.
// A consumer may add `audience`: the host it is. A /2 token minted for another audience, or sent with no `audience` at all, is `wrong_audience`.
export const POST = route(async (req: Request) => {
  limit(`ctx-verify:ip:${clientIp(req)}`, 120, 60_000);
  const body = await readJson(req, 16 * 1024);
  if (!isObject(body) || typeof body.token !== "string" || (body.audience !== undefined && typeof body.audience !== "string")) throw new HttpError(400, "bad_request", "Send { token, audience? }.");
  const result = await verifyContextTokenLive(body.token, Date.now(), body.audience === undefined ? undefined : { audience: body.audience });
  return result.ok ? json({ ok: true, context: result.ctx }) : json({ ok: false, reason: result.reason, error: { code: "unauthorized", message: "That context token is no longer good." } }, { status: 401 });
});
