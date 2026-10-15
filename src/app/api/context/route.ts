import { getRequestContext, issueContextToken, issueContextV2 } from "@/server/context";
import { HttpError, json, notFound, route } from "@/server/http";

// The caller's own context, plus a signed five-minute token for a downstream consumer. `?project=stub:<id>` or
// `event:<id>` asks for the context on one project. The id is only a question: a project the caller can't see
// is a 404 whether it exists or not. That is how a dashboard selects a project: it names one here, the server
// proves the caller holds it from its own records, and the answer is a token bound to that one project.
// `?v=2` returns ticketstub.context/2 (injective ids, separate environment / economic / evidence modes, finance
// grants); the default stays ticketstub.context/1 while consumers move over.
export const GET = route(async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const raw = params.get("project");
  const version = params.get("v") ?? "1";
  if (version !== "1" && version !== "2") throw new HttpError(400, "bad_request", "v is 1 or 2.");
  let project: { id: string; kind: "stub" | "event" } | undefined;
  if (raw !== null) {
    const m = /^(stub|event):([\w.:-]{1,128})$/.exec(raw);
    if (!m) throw notFound();
    project = { kind: m[1] as "stub" | "event", id: m[2] };
  }
  const context = await getRequestContext(req, project);
  if (project && context.role === "none") throw notFound();
  if (version === "2") {
    if (context.revoked) return json({ context: null, token: null });
    return json(issueContextV2(context));
  }
  return json({ context, token: context.revoked ? null : issueContextToken(context) });
});
