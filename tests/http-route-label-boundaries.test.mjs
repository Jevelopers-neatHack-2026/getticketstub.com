import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true };
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      const url = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".ts")) return {
      format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    };
    return nextLoad(url, context);
  },
});
const { HttpError, json, route } = await import("../src/server/http.ts");
const { ringEvents } = await import("../src/server/events.ts");
afterEach(() => { delete globalThis.__ticketstubEventRing; delete globalThis.__ticketstubEventSeq; });
const unavailable = route(async () => { throw new HttpError(503, "storage_unavailable", "Storage isn't available.", { "retry-after": "30" }); });
async function label(path) {
  const response = await unavailable(new Request(`https://ticketstub.example${path}`, { headers: { "x-request-id": "req_fixture_routes" } }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: { code: "storage_unavailable", message: "Storage isn't available." } });
  assert.equal(response.headers.get("x-request-id"), "req_fixture_routes");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("retry-after"), "30");
  const event = ringEvents().at(-1);
  assert.equal(event.type, "storage_unavailable");
  assert.equal(event.requestId, "req_fixture_routes");
  assert.equal(event.fields.code, "storage_unavailable");
  return event.fields.route;
}

test("dynamic route values never enter storage-failure telemetry", async () => {
  for (const canary of ["canary_ab12", "fixture-secret-value-with-a-long-suffix", "%63anary_ab12", "fixture%40example.test"]) {
    for (const [prefix, expected] of [["share", "share_token"], ["claim", "claim_token"], ["gift", "gift_token"], ["files", "files_name"], ["stub-image", "stub_image_token"], ["u", "u_token"]]) {
      assert.equal(await label(`/api/${prefix}/${canary}?canary=fixture_query`), expected);
      assert.ok(!JSON.stringify(ringEvents()).includes("canary_ab12"));
      assert.ok(!JSON.stringify(ringEvents()).includes("fixture_query"));
    }
  }
});

test("unknown and extended paths have one constant label", async () => {
  for (const path of ["/api/canary_ab12", "/api/auth/canary_ab12", "/api/creative/canary_ab12", "/api/%63reative", "/api/share/canary_ab12/extra", "/api/files/canary_ab12/extra", "/api//share/canary_ab12", "/api/SHARE/canary_ab12", "/elsewhere/canary_ab12", "/api"]) {
    assert.equal(await label(path), "unknown", path);
  }
});

test("known static routes retain useful categorical labels after the real event sanitizer", async () => {
  for (const [path, expected] of [
    ["account", "account"], ["account/email", "account_email"], ["account/email/confirm", "account_email_confirm"],
    ["admin/backup", "admin_backup"], ["admin/harness", "admin_harness"], ["agent", "agent"],
    ["approvals", "approvals"], ["approvals/revoke", "approvals_revoke"], ["approvals/verify", "approvals_verify"], ["art", "art"],
    ["auth/callback", "auth_callback"], ["auth/confirm", "auth_confirm"], ["auth/link", "auth_link"], ["auth/me", "auth_me"], ["auth/signout", "auth_signout"],
    ["context", "context"], ["context/verify", "context_verify"], ["creative", "creative"], ["dev/email-preview", "dev_email_preview"], ["events", "events"], ["gift", "gift"], ["health", "health"],
    ["order-authorizations", "order_authorizations"], ["order-authorizations/claim", "order_auth_claim"], ["order-authorizations/claims/lookup", "order_auth_claim_lookup"],
    ["order-authorizations/revalidate", "order_auth_revalidate"], ["order-authorizations/revoke", "order_auth_revoke"], ["order-authorizations/verify", "order_auth_verify"],
    ["orders", "orders"], ["organizer/events", "organizer_events"], ["payments/dodo/webhook", "payments_dodo_webhook"], ["payments/stripe/webhook", "payments_stripe_webhook"],
    ["research", "research"], ["share", "share"], ["share/revoke", "share_revoke"], ["wall/public", "wall_public"], ["wall/sync", "wall_sync"],
  ]) assert.equal(await label(`/api/${path}`), expected, path);
  assert.equal(await label("/api/auth/link/?canary=fixture_query"), "auth_link");
  assert.equal(await label("/api/creative/?canary=fixture_query"), "creative");
  assert.ok(!JSON.stringify(ringEvents()).includes("fixture_query"));
});

test("responses without storage failure produce no storage event", async () => {
  const ok = route(async () => json({ ok: true }, { status: 201 }));
  const response = await ok(new Request("https://ticketstub.example/api/share/canary_ab12"));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true });
  assert.match(response.headers.get("x-request-id"), /^req_/);
  const denied = route(async () => { throw new HttpError(404, "not_found", "Missing."); });
  assert.equal((await denied()).status, 404);
  assert.deepEqual(ringEvents(), []);
});

test("storage failure without a Request keeps unknown label and response compatibility", async () => {
  const response = await unavailable();
  assert.equal(response.status, 503);
  assert.equal(ringEvents().at(-1).fields.route, "unknown");
  assert.equal(ringEvents().at(-1).requestId, response.headers.get("x-request-id"));
});
