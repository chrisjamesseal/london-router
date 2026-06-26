// Resolve free text (address, postcode, place, station) to {lat,lon,name}.
// Browser-safe with a resilient fallback chain: Photon → Nominatim → TfL.
// All three allow CORS; Photon is primary because it needs no User-Agent
// (which browsers can't set) and is friendly to client-side use.
import { searchPlace } from "./tfl.js";

const COORD_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;
const LONDON_BBOX = "-0.51,51.28,0.33,51.69"; // minLon,minLat,maxLon,maxLat
const LONDON_VIEWBOX = "-0.51,51.69,0.33,51.28";

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
  const r = await fetch(url);
  const d = await r.json();
  const f = d.features && d.features[0];
  if (!f) return null;
  const [lon, lat] = f.geometry.coordinates;
  return { lat, lon, name: photonLabel(f, q) };
}

async function nominatim(q) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=gb&q=" +
    encodeURIComponent(q);
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  const d = await r.json();
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
    const r = await fetch(url);
    const d = await r.json();
    return (d.features || []).map((f) => {
      const [lon, lat] = f.geometry.coordinates;
      return { lat, lon, name: photonLabel(f, q) };
    });
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
