// Cloudflare Worker: a tiny proxy that turns two station names (or CRS codes)
// into the cheapest walk-up National Rail single fare, using the BR Fares
// legacy API. Deploy this yourself (see docs/TRAIN_FARES.md); the PWA then
// calls it and shows a real "from £X" instead of the zone estimate.
//
// Why a proxy at all?
//   1. The BR Fares key must stay secret — it can't live in client-side JS.
//   2. BR Fares doesn't send CORS headers, so a browser can't call it directly.
//   3. Caching here keeps you under the free 100-calls/day allowance.
//
// Required secret (set with `wrangler secret put BRFARES_KEY`):
//   BRFARES_KEY  — your BR Fares API key (used as HTTP Basic username).
//
// Endpoint:  GET /fare?from=<name|CRS>&to=<name|CRS>
// Response:  { from, to, fromCrs, toCrs, fromPence, anytimePence, ticketName, url }
//            (fromPence === 0 / null-ish fields when nothing usable was found)

const BR = "https://gw.brfares.com";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (url.pathname !== "/fare") {
      return json({ error: "GET /fare?from=&to=" }, 404);
    }
    const from = (url.searchParams.get("from") || "").trim();
    const to = (url.searchParams.get("to") || "").trim();
    if (!from || !to) return json({ error: "from and to are required" }, 400);

    // Day-cache by the normalised pair so repeat lookups don't burn the quota.
    const cacheKey = new Request(`${url.origin}/fare?k=${norm(from)}|${norm(to)}`);
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return withCors(hit);

    try {
      const auth = "Basic " + btoa((env.BRFARES_KEY || "") + ":");
      const [fromCrs, toCrs] = await Promise.all([
        resolveCrs(from, auth),
        resolveCrs(to, auth),
      ]);
      if (!fromCrs || !toCrs) {
        return json({ from, to, fromCrs, toCrs, fromPence: 0, error: "station not found" }, 200);
      }
      const data = await queryFares(fromCrs, toCrs, auth);
      const best = cheapestSingle(data);
      const body = {
        from, to, fromCrs, toCrs,
        fromPence: best.singlePence || 0,
        anytimePence: best.anytimePence || 0,
        ticketName: best.name || "",
        url: `https://www.brfares.com/querysimple?orig=${fromCrs}&dest=${toCrs}`,
      };
      const res = json(body, 200, { "Cache-Control": "public, max-age=86400" });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    } catch (e) {
      return json({ from, to, fromPence: 0, error: String(e && e.message || e) }, 200);
    }
  },
};

// --- BR Fares calls --------------------------------------------------------

// Turn a station name into a CRS code. A 3-letter token is taken as a CRS as-is;
// otherwise we ask BR Fares' location autocomplete and take the first hit.
async function resolveCrs(q, auth) {
  const cleaned = stripStation(q);
  if (/^[A-Za-z]{3}$/.test(cleaned)) return cleaned.toUpperCase();
  const r = await fetch(`${BR}/legacy_ac_loc?term=${encodeURIComponent(cleaned)}`, {
    headers: { Authorization: auth, Accept: "application/json" },
  });
  if (!r.ok) throw new Error("autocomplete " + r.status);
  const data = await r.json();
  return firstCrs(data);
}

async function queryFares(orig, dest, auth) {
  const r = await fetch(`${BR}/legacy_querysimple?orig=${orig}&dest=${dest}&rlc=`, {
    headers: { Authorization: auth, Accept: "application/json" },
  });
  if (!r.ok) throw new Error("querysimple " + r.status);
  return r.json();
}

// --- Parsing ---------------------------------------------------------------

// Pull a CRS code out of an autocomplete payload, whatever its exact shape.
// Entries look roughly like { code: "KGX", name: "London Kings Cross [KGX]" }.
function firstCrs(data) {
  const list = Array.isArray(data) ? data : (data && (data.result || data.results || data.locations)) || [];
  for (const item of list) {
    if (!item) continue;
    const code = item.crs || item.code || item.value || item.id;
    if (typeof code === "string" && /^[A-Za-z]{3}$/.test(code.trim())) return code.trim().toUpperCase();
    // Some payloads only carry the code inside a "Name [CRS]" label.
    const label = item.label || item.name || item.text || "";
    const m = /\[([A-Za-z]{3})\]/.exec(String(label));
    if (m) return m[1].toUpperCase();
  }
  return "";
}

// Cheapest standard-class adult fare: an Anytime/peak single is the honest
// "from" headline (off-peak singles aren't always sold), but we also surface the
// overall cheapest single and the Anytime price separately.
function cheapestSingle(data) {
  const fares = (data && data.fares) || [];
  let singlePence = 0, anytimePence = 0, name = "";
  for (const f of fares) {
    const t = f && f.ticket;
    if (!t) continue;
    const type = (t.type && t.type.desc || "").toUpperCase();
    const tclass = (t.tclass && t.tclass.desc || "").toUpperCase();
    if (type !== "SINGLE") continue;
    if (tclass && tclass !== "STD") continue; // standard class only
    const pence = adultPence(f);
    if (!pence) continue;
    if (!singlePence || pence < singlePence) { singlePence = pence; name = t.name || ""; }
    const isAnytime = /anytime/i.test(t.name || "");
    if (isAnytime && (!anytimePence || pence < anytimePence)) anytimePence = pence;
  }
  return { singlePence, anytimePence, name };
}

// adult.fare is an integer number of pence in the legacy payload.
function adultPence(f) {
  const a = f && f.adult;
  if (!a) return 0;
  const v = typeof a.fare === "number" ? a.fare : Number(a.fare);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

// --- helpers ---------------------------------------------------------------

function stripStation(s) {
  return String(s)
    .replace(/\s*\[.*?\]\s*/g, " ")
    .replace(/\b(rail|underground|dlr|station|stn)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function norm(s) { return stripStation(s).toLowerCase(); }

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}
function withCors(res) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
}
