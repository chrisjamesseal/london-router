// Resolve free text (address, postcode, place, station) to {lat,lon,name}.
// Browser-safe with a resilient fallback chain: Photon → Nominatim → TfL.
// All three allow CORS; Photon is primary because it needs no User-Agent
// (which browsers can't set) and is friendly to client-side use.
import { searchPlace } from "./tfl.js";

const COORD_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;
const LONDON_BBOX = "-0.51,51.28,0.33,51.69"; // minLon,minLat,maxLon,maxLat
const LONDON_VIEWBOX = "-0.51,51.69,0.33,51.28";

// fetch + JSON with a hard timeout, so a blocked/slow request can't hang the
// whole search (e.g. when a browser's privacy protections stall third parties).
async function fetchJSON(url, opts = {}, ms = 7000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// Build a tidy one-line label from a Photon feature.
function photonLabel(f, fallback) {
  const p = f.properties || {};
  return [p.name, p.street, p.postcode, p.city].filter(Boolean).join(", ") || fallback;
}

// London-biased but UK-wide (no hard bbox) so out-of-London trains resolve too.
async function photon(q) {
  const url =
    "https://photon.komoot.io/api/?lang=en&limit=1&lat=51.51&lon=-0.12&q=" +
    encodeURIComponent(q);
  const d = await fetchJSON(url);
  const f = d.features && d.features[0];
  if (!f) return null;
  const [lon, lat] = f.geometry.coordinates;
  return { lat, lon, name: photonLabel(f, q) };
}

async function nominatim(q) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=gb&q=" +
    encodeURIComponent(q);
  const d = await fetchJSON(url, { headers: { Accept: "application/json" } });
  if (d && d[0]) return { lat: +d[0].lat, lon: +d[0].lon, name: d[0].display_name };
  return null;
}

// Typeahead suggestions (up to 5), London-biased but UK-wide. Best-effort.
export async function suggest(q) {
  q = (q || "").trim();
  if (q.length < 3) return [];
  const url =
    "https://photon.komoot.io/api/?lang=en&limit=5&lat=51.51&lon=-0.12&q=" +
    encodeURIComponent(q);
  try {
    const d = await fetchJSON(url, {}, 5000);
    const feats = d.features || [];
    // Icon only for stations & bus stops (nothing else needs one).
    const iconFor = (p = {}) => {
      const v = (p.osm_value || "").toLowerCase();
      if (v.includes("bus")) return "🚌";
      if (
        p.osm_key === "railway" ||
        p.osm_key === "public_transport" ||
        /station|halt|subway|tram_stop/.test(v) ||
        /\bstation\b/i.test(p.name || "")
      )
        return "🚉";
      return "";
    };
    return feats
      .map((f) => {
        const [lon, lat] = f.geometry.coordinates;
        return { lat, lon, name: photonLabel(f, q), icon: iconFor(f.properties) };
      })
      // Surface stations/stops first — usually what people are routing to.
      .sort((a, b) => (b.icon ? 1 : 0) - (a.icon ? 1 : 0));
  } catch {
    return [];
  }
}

export async function geocode(q) {
  q = (q || "").trim();
  if (!q) return null;
  const m = q.match(COORD_RE);
  if (m) return { lat: +m[1], lon: +m[2], name: "Pinned location" };

  for (const fn of [photon, nominatim]) {
    try {
      const hit = await fn(q);
      if (hit) return hit;
    } catch {}
  }
  return await searchPlace(q).catch(() => null);
}
