import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkSocialMetadata } from "../scripts/lib/landing-metadata-checks.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const png = readFileSync(new URL("../src/app/opengraph-image.png", import.meta.url));
const names = ["opengraph-image.png", "twitter-image.png"];
// Add a valid PNG text chunk so each fixture has genuinely distinct, still-decodable image bytes.
function fixtureImage(label) {
  const data = Buffer.from(`FixtureRoot\0${label}`), type = Buffer.from("tEXt");
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([type, data])) {
    crc ^= byte;
    for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([png.subarray(0, -12), length, type, data, checksum, png.subarray(-12)]);
}
function checkout(root, route, label) {
  mkdirSync(join(root, ".next/server"), { recursive: true });
  mkdirSync(join(root, ".next/static/chunks"), { recursive: true });
  mkdirSync(join(root, "src/app"), { recursive: true });
  writeFileSync(join(root, ".next/BUILD_ID"), `fixture-${label}`);
  writeFileSync(join(root, ".next/static/chunks/fixture.js"), "/* WebGLRenderer THREE: build inventory fixture */");
  writeFileSync(join(root, ".next/server/app-paths-manifest.json"), JSON.stringify({ "/page":"index", "/s/[token]/page":"shared", [`/${route}/page`]:"selected" }));
  for (const name of names) writeFileSync(join(root, "src/app", name), fixtureImage(`${label}:${name}`));
}
function html(path) {
  const tags = [
    ["og:title", "TicketStub: keep the night"],
    ["og:description", "Digital keepsake from $9; printed editions in preview"],
    ["twitter:card", "summary_large_image"],
    ["og:image:width", "1200"], ["og:image:height", "630"],
    ...(path.startsWith("/s/") ? [["robots", "noindex, nofollow"]] : []),
    ...names.flatMap((name, i) => {
      const key = i ? "twitter:image" : "og:image";
      return [[key, `https://getticketstub.com/${name}`], [`${key}:alt`, "TicketStub: Keep the night, personalized keepsake ticket stub"]];
    }),
  ];
  return tags.map(([key,value]) => `<meta property="${key}" content="${value}">`).join("");
}
async function setup(t) {
  const temp = mkdtempSync(join(tmpdir(), "landing-metadata-roots-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const selected = join(temp, "selected-checkout"), different = join(temp, "different-checkout"), source = join(temp, "separate-source");
  checkout(selected, "selected-only", "selected"); checkout(different, "different-only", "different"); checkout(source, "source-only", "source");
  const requests = []; let servedSource = selected;
  const server = createServer((req,res) => {
    const path = new URL(req.url, "http://localhost").pathname; requests.push(path);
    const asset = names.find(name => path === `/${name}`);
    if (asset) { res.writeHead(200, {"content-type":"image/png"}); res.end(readFileSync(join(servedSource,"src/app",asset))); return; }
    if (path === "/" || path === "/selected-only" || path.startsWith("/s/")) { res.writeHead(200,{"content-type":"text/html"}); res.end(html(path)); return; }
    res.writeHead(404); res.end("fixture route missing");
  });
  await new Promise(r => server.listen(0,"127.0.0.1",r));
  t.after(() => new Promise(r => server.close(r)));
  return {temp,selected,different,source,requests,base:`http://127.0.0.1:${server.address().port}`, serve(root) {servedSource=root;}};
}
const collect = () => { const assertions=[]; return {assertions,check(name,passed,detail) {assertions.push({name,passed,detail});}}; };

test("metadata sweep uses selected checkout route manifest and reviewed image bytes", async t => {
  const f=await setup(t), c=collect();
  await checkSocialMetadata(f.base,c.check,{buildRoot:f.selected});
  assert.equal(c.assertions.filter(a=>!a.passed).length,0,JSON.stringify(c.assertions.filter(a=>!a.passed)));
  assert.ok(f.requests.includes('/selected-only'));
  assert.ok(!f.requests.includes('/different-only') && !f.requests.includes('/account'));
  assert.equal(c.assertions.filter(a=>a.name.endsWith('served bytes match reviewed asset') && a.passed).length,2);
});

test("metadata sweep supports separately selected build and source roots without relaxing byte comparison", async t => {
  const f=await setup(t); f.serve(f.source);
  const good=collect(); await checkSocialMetadata(f.base,good.check,{buildRoot:f.selected,sourceRoot:f.source});
  assert.equal(good.assertions.filter(a=>!a.passed).length,0);
  assert.ok(f.requests.includes('/selected-only') && !f.requests.includes('/source-only'));
  const bad=collect(); await checkSocialMetadata(f.base,bad.check,{buildRoot:f.selected,sourceRoot:f.different});
  assert.deepEqual(bad.assertions.filter(a=>!a.passed).map(a=>a.name).sort(),names.map(name=>`metadata ${name}: served bytes match reviewed asset`).sort());
});

test("selecting an incorrect build manifest still fails its missing route", async t => {
  const f=await setup(t), c=collect();
  await checkSocialMetadata(f.base,c.check,{buildRoot:f.different,sourceRoot:f.selected});
  assert.ok(f.requests.includes('/different-only') && !f.requests.includes('/selected-only'));
  assert.deepEqual(c.assertions.filter(a=>!a.passed).map(a=>a.name),['metadata /different-only: server renders']);
});

test("check-landing CLI propagates --build-root and --source-root to real metadata checks", async t => {
  const f=await setup(t); f.serve(f.source);
  const hook=join(f.temp,'stop-after-metadata.mjs'), evidence=join(f.temp,'evidence');
  writeFileSync(hook, `import {registerHooks} from 'node:module'; registerHooks({resolve(s,c,next){if(s==='./lib/cdp.mjs')return {url:'data:text/javascript,export const launchBrowser=async()=>{throw new Error("fixture stop after metadata")}',shortCircuit:true};return next(s,c)}});`);
  const child=spawn(process.execPath,['--import',hook,join(repo,'scripts/check-landing.mjs'),'--base',f.base,'--build-root',f.selected,'--source-root',f.source,'--evidence-dir',evidence],{cwd:repo,stdio:['ignore','pipe','pipe']});
  let output=''; child.stdout.on('data',d=>output+=d); child.stderr.on('data',d=>output+=d);
  const status=await new Promise((yes,no)=>{child.on('error',no);child.on('exit',yes)});
  assert.equal(status,1,output); // Only the deliberately stopped browser stage fails.
  const result=JSON.parse(readFileSync(join(evidence,'results.json'),'utf8'));
  assert.equal(result.buildId,'fixture-selected'); assert.equal(result.buildRoot,f.selected); assert.equal(result.sourceRoot,f.source);
  assert.ok(result.assertions.some(a=>a.name==='metadata /selected-only: server renders' && a.passed));
  assert.ok(result.assertions.filter(a=>a.name.startsWith('metadata')).every(a=>a.passed),output);
  assert.equal(result.failed,1);
  assert.match(result.assertions.find(a=>!a.passed).detail,/fixture stop after metadata/);
});
