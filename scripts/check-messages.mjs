// Static check for GT-09.3: every error code raised anywhere in src has a brand-voice entry in the message
// catalog (src/customer/feedback-messages/messages.ts), every entry reads like the brand and has a way out,
// and every API error answers in the one `{ error: { code, message } }` envelope. Offline; no server needed.
//   node scripts/check-messages.mjs
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
let failed = 0;
let passed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const catalogFile = join(SRC, "customer", "feedback-messages", "messages.ts");
check("the message catalog exists", existsSync(catalogFile));
if (!existsSync(catalogFile)) process.exit(1);
const { MESSAGES, MESSAGE_CODES, messageFor, messageForError } = await import(pathToFileURL(catalogFile).href);

// ---- where codes are raised ----
const RAISED = [
  /HttpError\(\s*\d+,\s*"([a-z][a-z0-9_]*)"/g, // throw new HttpError(status, "code", ...)
  /errorJson\(\s*\d+,\s*"([a-z][a-z0-9_]*)"/g, // errorJson(status, "code", ...)
  /ProviderError\(\s*"([a-z][a-z0-9_]*)"/g, // throw new ProviderError("code")
  /error:\s*\{\s*code:\s*"([a-z][a-z0-9_]*)"/g, // { error: { code: "..." } }
  /new ApiError\(\s*"([a-z][a-z0-9_]*)"/g, // the browser's own codes
  /SAVING_OFF_CODE\s*=\s*"([a-z][a-z0-9_]*)"/g,
];
const codes = new Map(); // code -> first file
const add = (code, file) => codes.has(code) || codes.set(code, relative(ROOT, file).split(sep).join("/"));
for (const file of walk(SRC)) {
  const text = readFileSync(file, "utf8");
  for (const re of RAISED) for (const m of text.matchAll(re)) add(m[1], file);
  // providers.ts picks its code with a ternary: collect every code-shaped string literal assigned there
  if (file.endsWith(`ai${sep}providers.ts`)) {
    for (const m of text.matchAll(/"((?:provider|unsupported|invalid|missing)_[a-z_]+|server_only)"/g)) add(m[1], file);
  }
}
// The Creative route forwards typed result/job errors instead of constructing
// HttpError literals. Read its actual dispatch map and app response type without
// importing the route or invoking a provider; changes to either must stay covered.
const creativeRoute = join(SRC, "app", "api", "creative", "route.ts");
const creativeContract = join(SRC, "customer", "studio", "creative", "contracts.ts");
const parse = (file) => ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
const routeSource = parse(creativeRoute);
const status = routeSource.statements.filter(ts.isVariableStatement).flatMap((s) => [...s.declarationList.declarations])
  .find((d) => ts.isIdentifier(d.name) && d.name.text === "STATUS")?.initializer;
const routeCodes = status && ts.isObjectLiteralExpression(status) ? status.properties.map((p) =>
  ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null) : [];
const errorType = parse(creativeContract).statements.find((s) => ts.isTypeAliasDeclaration(s) && s.name.text === "CreativeErrorCode")?.type;
const contractCodes = errorType && ts.isUnionTypeNode(errorType) ? errorType.types.map((t) =>
  ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? t.literal.text : null) : [];
check("the actual Creative response dispatch map is explicit and nonempty", routeCodes.length > 0 && routeCodes.every(Boolean));
check("the app Creative error type is explicit and nonempty", contractCodes.length > 0 && contractCodes.every(Boolean));
check("Creative response dispatch and the app error type agree", routeCodes.length === new Set(routeCodes).size
  && contractCodes.length === new Set(contractCodes).size && routeCodes.length === contractCodes.length
  && routeCodes.every((code) => contractCodes.includes(code)));
for (const code of new Set([...routeCodes, ...contractCodes].filter(Boolean))) add(code, creativeRoute);
check("found the raised error codes", codes.size >= 25, `only ${codes.size}`);
for (const [code, file] of [...codes].sort()) {
  check(`code "${code}" (${file}) has a catalog entry`, Object.hasOwn(MESSAGES, code));
}
check("the catalog covers the codes the brief names", ["bad_origin", "unauthorized", "not_found", "too_large", "rate_limited", "mail_unavailable", "mail_failed", "disposable_email", "storage_unavailable", "art_limit", "variant_not_orderable", "invalid_provider_configuration", "expired", "already_claimed", "confirm_mismatch", "context_unavailable", "network", "unknown"].every((c) => Object.hasOwn(MESSAGES, c)));
check("the catalog covers every provider_* code", ["provider_authentication_failed", "provider_rate_limited", "provider_unavailable", "provider_request_cancelled"].every((c) => Object.hasOwn(MESSAGES, c)));

// ---- every entry reads like the brand ----
const ACTIONS = ["retry", "sign-in", "reload"];
for (const code of MESSAGE_CODES) {
  const m = messageFor(code);
  const sentences = m.message.split(/(?<=[.!?])\s+/).filter(Boolean);
  const bad = [];
  if (m.code !== code) bad.push("code does not round-trip");
  if (!m.message || m.message.length > 220) bad.push("empty or long");
  if (sentences.length > 2) bad.push(`${sentences.length} sentences (the voice allows 2)`);
  if (/[!]/.test(m.message) || /\boops\b/i.test(m.message)) bad.push("exclamation or Oops");
  if (/\b(error|exception|stack|undefined|null|status|http|\d{3})\b/i.test(m.message)) bad.push("leaks technical words");
  if (code.includes("_") && m.message.includes(code)) bad.push("shows its own code");
  if (m.action) {
    const a = m.action;
    if (!a.label || a.label.split(/\s+/).length > 4) bad.push("action label empty or over 4 words");
    if (!(("href" in a && typeof a.href === "string" && a.href.startsWith("/")) || ACTIONS.includes(a.action))) bad.push("action has neither a local href nor a known action");
  }
  check(`entry "${code}" is brand voice, with a safe action`, bad.length === 0, bad.join("; "));
}
const gaps = MESSAGE_CODES.filter((c) => !messageFor(c).action && !["art_limit", "provider_authentication_failed", "invalid_provider_configuration", "invalid_model_configuration", "missing_provider_key", "server_only", "unsupported_image_model"].includes(c));
check("every entry that can be recovered from has a recovery action", gaps.length === 0, gaps.join(", "));

// ---- unknown codes fall back safely ----
for (const odd of ["totally_new_code", "", undefined, null, 42, {}, "__proto__", "constructor", "<script>alert(1)</script>"]) {
  const m = messageFor(odd);
  check(`messageFor(${JSON.stringify(odd) ?? "undefined"}) falls back to the generic message`, m.code === "unknown" && m.message === MESSAGES.unknown.message);
}
check("a raw code or stack never reaches the person", !messageForError(Object.assign(new Error("at Object.<anonymous> (/srv/app.js:1:1)"), { code: "ENOENT" })).message.includes("ENOENT"));
check("an abort is a timeout", messageForError(Object.assign(new Error("x"), { name: "AbortError" })).code === "timeout");
for (const code of contractCodes.filter(Boolean)) {
  const m = messageForError({ error: { code, message: "private-fixture-detail", diagnostic_ref: "private-fixture-reference", retryable: true } });
  check(`forwarded Creative error "${code}" gets only its safe catalog projection`, m.code === code
    && !JSON.stringify(m).includes("private-fixture-") && !("diagnostic_ref" in m));
}
for (const code of ["budget_unavailable", "cancelled"]) {
  const m = messageForError({ error: { code, retryable: true } });
  check(`uncertain Creative outcome "${code}" cannot grant an immediate retry`, m.code === code && !m.retryable && m.action?.action !== "retry");
}

// ---- the one error envelope, statically ----
const api = walk(join(SRC, "app", "api"));
const offenders = [];
for (const file of api) {
  const text = readFileSync(file, "utf8");
  if (/\{\s*error:(?!\s*\{)/.test(text.replace(/console\.[a-z]+\([^)]*\)/g, ""))) offenders.push(relative(ROOT, file));
}
check("no API route answers with a bare `{ error: <string> }`", offenders.length === 0, offenders.join(", "));
const http = readFileSync(join(SRC, "server", "http.ts"), "utf8");
check("HttpError and unexpected errors both answer `{ error: { code, message } }`", /error:\s*\{\s*code:\s*e\.code,\s*message:\s*e\.message\s*\}/.test(http) && /error:\s*\{\s*code:\s*"internal"/.test(http));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
