import { chromium } from "playwright";
import fs from "node:fs/promises";
import crypto from "node:crypto";

const sources = {
  tensio: {
    name: "Tensio",
    page: "https://www.tensio.no/no/kunde/strombruddskart",
    map: "https://www.tensio.no/no/kunde/strombruddskart"
  },
  nettselskapet: {
    name: "Nettselskapet AS",
    page: "https://nettselskapet.as/driftsmeldinger",
    map: "https://nettselskapetpg.digpro.se/outagemap2/?app=fpp&cust=nsl"
  }
};

const outputDir = "public";
const stateFile = "state.json";
const now = new Date().toISOString();

await fs.mkdir(`${outputDir}/debug`, { recursive: true });

let state = { current: {}, events: [] };
try {
  state = JSON.parse(await fs.readFile(stateFile, "utf8"));
} catch {
  // Første kjøring starter med tom historikk.
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function flattenObject(value, prefix = "", depth = 0, result = []) {
  if (depth > 5 || result.length > 1000) return result;
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenObject(item, `${prefix}[${index}]`, depth + 1, result));
  } else if (value && typeof value === "object") {
    const entries = Object.entries(value);
    const text = clean(entries
      .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
      .map(([k, v]) => `${k}: ${v}`)
      .join(" | "));
    const signal = /(outage|fault|incident|avbrudd|strøm|strom|stans|driftsmelding|customer|kunde|status|planned|planlagt)/i;
    if (text.length >= 12 && signal.test(text)) result.push({ path: prefix || "root", text });
    entries.forEach(([key, item]) => flattenObject(item, prefix ? `${prefix}.${key}` : key, depth + 1, result));
  }
  return result;
}

async function scrapeSource(browser, id, source) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "nb-NO" });
  const jsonCandidates = [];
  const responseUrls = [];

  page.on("response", async response => {
    const type = response.request().resourceType();
    if (type !== "xhr" && type !== "fetch") return;
    responseUrls.push({ status: response.status(), url: response.url() });
    const contentType = response.headers()["content-type"] || "";
    if (!contentType.includes("json")) return;
    try {
      const data = await response.json();
      jsonCandidates.push({ url: response.url(), matches: flattenObject(data) });
    } catch {
      // Enkelte svar merkes som JSON uten å være gyldig JSON.
    }
  });

  await page.goto(source.map, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(15000);

  for (const label of ["Godta alle", "Bruk nødvendige", "Accept all", "OK"]) {
    const button = page.getByRole("button", { name: label, exact: true });
    if (await button.count()) {
      await button.first().click({ timeout: 2000 }).catch(() => {});
      break;
    }
  }

  if (id === "tensio") {
    const tab = page.getByText("Pågående", { exact: true });
    if (await tab.count()) await tab.first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(5000);
  }

  const bodyText = clean(await page.locator("body").innerText().catch(() => ""));
  const domCandidates = await page.locator("main ul > li, ul > li, [class*='outage'], [class*='incident'], [class*='message'], [class*='list'] > div")
    .evaluateAll(elements => elements.map((element, index) => ({
      index,
      tag: element.tagName,
      className: element.className,
      text: (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim()
    })).filter(item => item.text.length >= 3 && item.text.length <= 1000))
    .catch(() => []);

  await page.screenshot({ path: `${outputDir}/debug/${id}.png`, fullPage: true }).catch(() => {});
  await fs.writeFile(`${outputDir}/debug/${id}.json`, JSON.stringify({
    checkedAt: now,
    url: source.map,
    title: await page.title(),
    bodyText: bodyText.slice(0, 20000),
    domCandidates,
    responseUrls,
    jsonCandidates: jsonCandidates.filter(item => item.matches.length)
  }, null, 2));

  await page.close();

  let items = [];
  if (id === "tensio") {
    items = domCandidates
      .filter(item => /\d/.test(item.text) && !/meny|cookie|personvern|sjekkliste/i.test(item.text))
      .map(item => item.text);
  } else {
    const jsonTexts = jsonCandidates.flatMap(candidate => candidate.matches.map(match => match.text));
    const domTexts = domCandidates.map(item => item.text);
    items = [...jsonTexts, ...domTexts]
      .filter(text => /(avbrudd|strøm|strom|stans|feil|planlagt|outage|fault|incident)/i.test(text));
  }

  items = [...new Set(items.map(clean))].slice(0, 200);
  return items.map(text => ({
    key: hash(`${id}:${text.replace(/\d+/g, "#")}`),
    contentHash: hash(text),
    text
  }));
}

function recordChanges(sourceId, items) {
  const source = sources[sourceId];
  const previous = state.current[sourceId] || {};
  const current = Object.fromEntries(items.map(item => [item.key, item]));

  for (const item of items) {
    const old = previous[item.key];
    if (!old) {
      state.events.unshift({
        id: hash(`${sourceId}:new:${item.contentHash}:${now}`), sourceId,
        title: `Nytt strømbrudd hos ${source.name}`,
        description: item.text, date: now, link: source.page
      });
    } else if (old.contentHash !== item.contentHash) {
      state.events.unshift({
        id: hash(`${sourceId}:update:${item.contentHash}:${now}`), sourceId,
        title: `Oppdatert strømbrudd hos ${source.name}`,
        description: item.text, date: now, link: source.page
      });
    }
  }

  for (const [key, old] of Object.entries(previous)) {
    if (!current[key]) {
      state.events.unshift({
        id: hash(`${sourceId}:ended:${old.contentHash}:${now}`), sourceId,
        title: `Strømbrudd avsluttet hos ${source.name}`,
        description: old.text, date: now, link: source.page
      });
    }
  }

  state.current[sourceId] = current;
}

function makeFeed(title, description, events, filename) {
  const base = "https://tormodytrehus.github.io/strombrudd-rss";
  const items = events.slice(0, 100).map(event => `    <item>
      <title>${escapeXml(event.title)}</title>
      <link>${escapeXml(event.link)}</link>
      <guid isPermaLink="false">${escapeXml(event.id)}</guid>
      <pubDate>${new Date(event.date).toUTCString()}</pubDate>
      <description>${escapeXml(event.description)}</description>
    </item>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${base}/${filename}</link>
    <description>${escapeXml(description)}</description>
    <lastBuildDate>${new Date(now).toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>\n`;
}

const browser = await chromium.launch({ headless: true });
try {
  for (const [id, source] of Object.entries(sources)) {
    try {
      const items = await scrapeSource(browser, id, source);
      console.log(`${source.name}: fant ${items.length} mulige strømbrudd.`);
      recordChanges(id, items);
    } catch (error) {
      console.error(`${source.name} feilet:`, error);
    }
  }
} finally {
  await browser.close();
}

state.events = state.events.slice(0, 500);
await fs.writeFile(stateFile, JSON.stringify(state, null, 2));

for (const [id, source] of Object.entries(sources)) {
  const events = state.events.filter(event => event.sourceId === id);
  await fs.writeFile(`${outputDir}/${id}.xml`, makeFeed(
    `${source.name} – strømbrudd`,
    `Nye og oppdaterte strømbrudd fra ${source.name}.`,
    events,
    `${id}.xml`
  ));
}

await fs.writeFile(`${outputDir}/strombrudd.xml`, makeFeed(
  "Strømbrudd – samlet",
  "Nye og oppdaterte strømbrudd fra Tensio og Nettselskapet AS.",
  state.events,
  "strombrudd.xml"
));
