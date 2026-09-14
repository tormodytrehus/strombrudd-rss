const TENSIO_PAGE = "https://www.tensio.no/no/kunde/strombruddskart";
const NETTSELSKAPET_PAGE = "https://nettselskapet.as/driftsmeldinger";
const DIGPRO_KML = "https://nettselskapetpg.digpro.se/bios/servlet/sys.outagemap.servlets.api.GetOutagesKML?app=fpp_nsl";
const CACHE_SECONDS = 10;
const HISTORY_HOURS = 48;

const TENSIO_URLS = [
  ["TS", "Ongoing"],
  ["TN", "Ongoing"],
  ["TS", "Terminated"],
  ["TN", "Terminated"]
].map(([region, status]) => ({
  region,
  status,
  url: `https://api-www.tensio.no/power-outage/features?status=${status}&region=${region}&includeArcgisFeatures=false&cached=true`
}));

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "strombrudd-rss" });
    }

    const cacheKey = new Request(`${url.origin}/strombrudd.xml`, { method: "GET" });
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      return request.method === "HEAD"
        ? new Response(null, { status: cached.status, headers: cached.headers })
        : cached;
    }

    try {
      const [tensio, digpro] = await Promise.all([
        fetchTensio(),
        fetch(DIGPRO_KML, { headers: { "User-Agent": "strombrudd-rss/1.0" } })
      ]);

      if (!digpro.ok) throw new Error(`Digpro svarte ${digpro.status}`);
      const nettselskapet = parseDigpro(await digpro.text());
      const items = [...tensio, ...nettselskapet]
        .sort((a, b) => b.updatedMs - a.updatedMs)
        .slice(0, 100);
      const xml = makeRss(items, url.origin);

      const response = new Response(request.method === "HEAD" ? null : xml, {
        headers: {
          "Content-Type": "application/rss+xml; charset=utf-8",
          "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
          "Access-Control-Allow-Origin": "*",
          "X-Feed-Items": String(items.length)
        }
      });
      ctx.waitUntil(cache.put(cacheKey, new Response(xml, {
        status: response.status,
        headers: response.headers
      })));
      return response;
    } catch (error) {
      return new Response(makeErrorRss(error, url.origin), {
        status: 502,
        headers: { "Content-Type": "application/rss+xml; charset=utf-8" }
      });
    }
  }
};

async function fetchTensio() {
  const responses = await Promise.all(TENSIO_URLS.map(async source => {
    const response = await fetch(source.url, { headers: { "User-Agent": "strombrudd-rss/1.0" } });
    if (!response.ok) throw new Error(`Tensio ${source.region}/${source.status} svarte ${response.status}`);
    return { ...source, data: await response.json() };
  }));

  const cutoff = Date.now() - HISTORY_HOURS * 60 * 60 * 1000;
  return responses.flatMap(({ status, data }) => {
    if (!Array.isArray(data)) return [];
    return data
      .filter(item => status === "Ongoing" || Number(item.terminatedTimestamp || 0) >= cutoff)
      .map(item => {
        const place = clean(item.municipalTxt) || `område ${item.region || "Tensio"}`;
        const customers = Number(item.numAb || 0);
        const ended = item.status === "Terminated" || status === "Terminated";
        const updatedMs = Number(item.lastUpdated || item.terminatedTimestamp || item.startTime || Date.now());
        const details = [
          clean(item.typeTxt),
          customers ? `${customers} berørte kunder` : "ingen kunder registrert",
          clean(item.reasonTxt),
          clean(item.customerWebText)
        ].filter(Boolean).join(" – ");
        return {
          title: `Tensio: ${ended ? "Avsluttet" : "Strømbrudd"} i ${place}${customers ? ` – ${customers} kunder` : ""}`,
          description: details,
          link: TENSIO_PAGE,
          guid: `tensio-${item.region}-${item.id}-${item.status}-${item.lastUpdated}-${item.numAb}`,
          updatedMs
        };
      });
  });
}

function parseDigpro(kml) {
  const cutoff = Date.now() - HISTORY_HOURS * 60 * 60 * 1000;
  const placemarks = kml.match(/<Placemark\b[\s\S]*?<\/Placemark>/gi) || [];
  return placemarks.flatMap(mark => {
    const style = first(mark, /<styleUrl>\s*#?([^<]+)<\/styleUrl>/i);
    const data = {};
    for (const match of mark.matchAll(/<Data\s+name="([^"]+)">[\s\S]*?<value>([\s\S]*?)<\/value>[\s\S]*?<\/Data>/gi)) {
      data[match[1]] = decodeXml(match[2]);
    }

    const active = /active_outage/i.test(style) && !/inactive_outage/i.test(style);
    const planned = /planned_outage/i.test(style);
    const ended = /inactive_outage/i.test(style);
    const updatedMs = parseNorwegianTime(data.restored || data.occurred || data.reported);
    if (ended && updatedMs < cutoff) return [];

    const customers = Number(data.current_affected_customers || data.previously_affected_customers || 0);
    const id = data.outage_id || data.outage_oid || "ukjent";
    const note = clean(data.note_external);
    const coordinates = first(mark, /<Point>[\s\S]*?<coordinates>\s*([^<]+)<\/coordinates>/i)
      .split(",").slice(0, 2).join(", ");
    const state = ended ? "Avsluttet" : planned ? "Planlagt strømstans" : active ? "Strømbrudd" : "Driftsmelding";
    const description = [
      note,
      customers ? `${customers} berørte kunder` : "ingen berørte kunder registrert",
      data.occurred ? `Oppsto: ${data.occurred}` : "",
      data.planned_restored_time ? `Planlagt slutt: ${data.planned_restored_time}` : "",
      coordinates ? `Posisjon: ${coordinates}` : ""
    ].filter(Boolean).join(" – ");

    return [{
      title: `Nettselskapet AS: ${state}${customers ? ` – ${customers} kunder` : ""}`,
      description,
      link: NETTSELSKAPET_PAGE,
      guid: `nettselskapet-${id}-${style}-${data.current_affected_customers}-${data.restored}-${data.note_external}`,
      updatedMs: updatedMs || Date.now()
    }];
  });
}

function makeRss(items, origin) {
  const body = items.map(item => `    <item>
      <title>${xml(item.title)}</title>
      <link>${xml(item.link)}</link>
      <guid isPermaLink="false">${xml(item.guid)}</guid>
      <pubDate>${new Date(item.updatedMs).toUTCString()}</pubDate>
      <description>${xml(item.description)}</description>
    </item>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Strømbrudd – Tensio og Nettselskapet AS</title>
    <link>${xml(origin)}/strombrudd.xml</link>
    <description>Direkteoppdatert RSS-feed for strømbrudd og driftsmeldinger.</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${body}
  </channel>
</rss>`;
}

function makeErrorRss(error, origin) {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Strømbrudd – midlertidig feil</title><link>${xml(origin)}</link><description>${xml(error?.message || error)}</description></channel></rss>`;
}

function first(text, pattern) {
  return clean(text.match(pattern)?.[1] || "");
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function decodeXml(value) {
  return clean(value)
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function xml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function parseNorwegianTime(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (!match) return 0;
  const [, year, month, day, hour, minute] = match;
  // Kartet bruker norsk lokal tid. September er normalt UTC+2.
  return Date.parse(`${year}-${month}-${day}T${hour}:${minute}:00+02:00`);
}
