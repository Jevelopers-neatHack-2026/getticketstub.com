import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const PRIVATE = "zq_private_metadata_127";
const decode = (text) => text.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Read actual HTML metadata, excluding the page's serialized props and visible content. */
export function metadataTags(html) {
  return [...html.matchAll(/<meta\s+[^>]*>/gi)].map(([tag]) => {
    const attributes = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)].map(([, key, value]) => [key.toLowerCase(), decode(value)]));
    return { name: attributes.property ?? attributes.name, content: attributes.content ?? "" };
  }).filter((tag) => tag.name);
}

export function metadataPagePath(path) {
  return path.slice(0, -5).replace(/\[\[?\.\.\.[^\]]+\]\]?|\[[^\]]+\]/g, PRIVATE) || "/";
}

/** The server deliberately conceals every admin route from anonymous visitors. */
export function metadataPageStatus(path) {
  return /^\/admin(?:\/|$)/.test(path) ? 404 : 200;
}

/** Verify production output for every page route using only the fixture server. */
export async function checkSocialMetadata(base, check, { expectedOrigin = "https://getticketstub.com", buildRoot = repoRoot, sourceRoot = buildRoot } = {}) {
  const origin = new URL(base);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)) throw new Error("metadata checks require a loopback fixture server");
  const manifest = JSON.parse(readFileSync(resolve(buildRoot, ".next/server/app-paths-manifest.json"), "utf8"));
  const routes = Object.keys(manifest).filter((path) => path.endsWith("/page") && !path.startsWith("/_"))
    .map(metadataPagePath);
  check("metadata: production manifest contains public and shared routes", routes.includes("/") && routes.includes(`/s/${PRIVATE}`));
  const assets = new Map();
  for (const path of routes) {
    const response = await fetch(`${base}${path}?to=${PRIVATE}&token=${PRIVATE}&q=${PRIVATE}`, {
      headers: { "user-agent": "Twitterbot/1.0", "x-forwarded-host": "attacker.invalid", "x-forwarded-proto": "http" },
      redirect: "manual", signal: AbortSignal.timeout(15_000),
    });
    // Authentication guards may redirect a private route; inspect its local destination,
    // never an external location, and retain a distinct redirect assertion.
    let rendered = response;
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const destination = new URL(response.headers.get("location"), base);
      check(`metadata ${path}: redirect stays on fixture origin`, destination.origin === origin.origin, destination.origin);
      if (destination.origin !== origin.origin) continue;
      rendered = await fetch(destination, { headers: { "user-agent": "Twitterbot/1.0" }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    }
    const expectedStatus = metadataPageStatus(path);
    check(`metadata ${path}: ${expectedStatus === 404 ? "anonymous admin route stays concealed" : "server renders"}`,
      rendered.status === expectedStatus && (expectedStatus !== 404 || response.status === 404),
      { status: rendered.status, expectedStatus });
    if (rendered.status !== expectedStatus) continue;
    const tags = metadataTags(await rendered.text());
    const values = (name) => tags.filter((tag) => tag.name === name).map((tag) => tag.content);
    check(`metadata ${path}: generic Open Graph and X descriptions`,
      values("og:title").includes("TicketStub: keep the night") &&
      values("og:description").some((value) => value.includes("Digital keepsake from $9; printed editions in preview")) &&
      values("twitter:card").includes("summary_large_image"),
      { title: values("og:title"), description: values("og:description"), card: values("twitter:card") });
    check(`metadata ${path}: private route and query values never enter tags`, !tags.some(({ content }) => content.includes(PRIVATE) || content.includes("attacker.invalid")));
    for (const [tagName, filename] of [["og:image", "opengraph-image.png"], ["twitter:image", "twitter-image.png"]]) {
      const imageValues = values(tagName);
      check(`metadata ${path}: one ${tagName}`, imageValues.length === 1, imageValues);
      for (const value of imageValues) {
        let image;
        try { image = new URL(value); } catch { check(`metadata ${path}: absolute ${tagName}`, false, value); continue; }
        check(`metadata ${path}: trusted ${tagName} origin and asset`, image.origin === expectedOrigin && image.pathname === `/${filename}`, value);
        if (image.pathname === `/${filename}`) assets.set(filename, image.pathname + image.search);
      }
      check(`metadata ${path}: meaningful ${tagName} alt`, values(`${tagName}:alt`).some((value) => /TicketStub: Keep the night.*personalized keepsake ticket stub/.test(value)));
    }
    check(`metadata ${path}: Open Graph dimensions`, values("og:image:width").includes("1200") && values("og:image:height").includes("630"));
    if (/^\/(s|u|claim)\//.test(path) || path === "/account" || expectedStatus === 404) {
      check(`metadata ${path}: private route remains unindexed`, values("robots").some((value) => /noindex/.test(value)));
    }
  }
  check("metadata: both social assets are referenced", assets.size === 2);
  for (const [name, path] of assets) {
    const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(15_000) });
    const bytes = Buffer.from(await response.arrayBuffer());
    check(`metadata ${name}: image returns PNG`, response.status === 200 && /image\/png/.test(response.headers.get("content-type") ?? "") && bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a");
    check(`metadata ${name}: served dimensions are 1200 by 630`, bytes.length >= 24 && bytes.readUInt32BE(16) === 1200 && bytes.readUInt32BE(20) === 630);
    check(`metadata ${name}: served bytes match reviewed asset`, bytes.equals(readFileSync(resolve(sourceRoot, `src/app/${name}`))));
  }
}
