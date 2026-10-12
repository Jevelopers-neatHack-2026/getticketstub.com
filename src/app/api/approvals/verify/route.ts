import { verifyApprovalLive } from "@/server/approval";
import { APPROVAL_FAILURES, HEX64, type ApprovalExpectation, type ApprovalHashes } from "@/server/approval-token";
import { HttpError, clientIp, isObject, json, limit, readJson, route } from "@/server/http";
import { requireStorage } from "@/server/index";

// The verification port for a consumer (print-production, the harness) that can't hold the signing key. It answers
// what the issuer says about an approval token right now: ok with the record, or the one reason it fails closed.
// A consumer MUST name the tenant, project and purpose it is acting for and the hashes of the content it holds: every one
// that applies (print.compose: design, art, facts, composition; artifact.download: art). A missing one is content_missing.
// It uses no cookie and no Origin (a consumer is not a browser), so there is nothing for a cross-site page to ride.
// It is read-only and never changes an approval.
const HASH_KEYS = ["designHash", "artHash", "factsHash", "compositionHash"] as const;

export const POST = route(async (req: Request) => {
  requireStorage();
  limit(`approval-verify:ip:${clientIp(req)}`, 120, 60_000);
  const body = await readJson(req, 16 * 1024);
  const bad = () => new HttpError(400, "bad_request", "Send { token, expect: { tenant, project, purpose, content } }.");
  if (!isObject(body) || typeof body.token !== "string" || !isObject(body.expect)) throw bad();
  const e = body.expect;
  const project = typeof e.project === "string" ? /^(stub):([\w.:-]{1,128})$/.exec(e.project) : null;
  if (typeof e.tenant !== "string" || e.tenant.length > 160 || !project || typeof e.purpose !== "string" || e.purpose.length > 64 || !isObject(e.content)) throw bad();
  const content: Partial<ApprovalHashes> = {};
  for (const k of HASH_KEYS) {
    const v = e.content[k];
    if (v === undefined) continue;
    if (typeof v !== "string" || !HEX64.test(v)) throw bad();
    content[k] = v;
  }
  if (Object.keys(content).length === 0) throw bad(); // a consumer that holds no content can't say the approval fits it
  const expect: ApprovalExpectation = { tenant: e.tenant, project: { kind: project[1], id: project[2] }, purpose: e.purpose, content };
  const result = await verifyApprovalLive(body.token, expect);
  if (result.ok) return json({ ok: true, approval: result.approval, checkedAt: new Date().toISOString() });
  const reason = APPROVAL_FAILURES.includes(result.reason) ? result.reason : "unknown";
  return json({ ok: false, reason, error: { code: "approval_invalid", message: "That approval doesn't cover this use." } }, { status: 403 });
});
