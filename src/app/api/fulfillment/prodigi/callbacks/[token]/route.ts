import { route } from "@/server/http";
import { handleProdigiCallback } from "@/server/fulfillment/prodigi-callback-route";

// Prodigi sandbox order callbacks (integration-evals decision 0003 R5). Off unless TICKETSTUB_PRODIGI_CALLBACKS=sandbox:
// until then every request is a 404 and nothing is read. See docs/operations/prodigi-callbacks-runbook.md.
export const dynamic = "force-dynamic";

export const POST = route(async (req: Request, ctx: { params: Promise<{ token: string }> }) => {
  const { token } = await ctx.params;
  return handleProdigiCallback(req, token);
});
