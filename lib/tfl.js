// Thin TfL Unified API client. No key required at low volume; if you have
// one, set TFL_APP_KEY in the environment for higher rate limits.

const BASE = "https://api.tfl.gov.uk";
// Optional app key for higher rate limits. Works without one. Guarded so the
// same module runs unchanged in the browser, where `process` doesn't exist.
const KEY =
  (typeof process !== "undefined" && process.env && process.env.TFL_APP_KEY) || "";

function withKey(url) {
  if (!KEY) return url;
  return url + (url.includes("?") ? "&" : "?") + "app_key=" + KEY;
}

async function get(path, timeoutMs = 8000) {
  const url = withKey(BASE + path);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`TfL ${res.status} on ${path}: ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

const coord = (p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
// An endpoint can be a {lat,lon} point or a raw string (a Naptan stop id, or
// an already-formatted "lat,lon"). Strings are passed through untouched so we
// can start a journey *on the platform* of a station rather than at its kerb.
const endpoint = (p) => (typeof p === "string" ? p : coord(p));

// Full multimodal journey planner. `modes` is an array like
// ["tube","bus","walking"]. Returns the raw TfL journeys array.
export async function journey(from, to, modes, opts = {}) {
  const params = new URLSearchParams();
  if (modes && modes.length) params.set("mode", modes.join(","));
  params.set("timeIs", opts.timeIs === "Arriving" ? "Arriving" : "Departing");
  if (opts.time) params.set("time", opts.time);
  if (opts.date) params.set("date", opts.date);
  // Ask for fares + a few alternatives.
  params.set("alternativeWalking", "false");
  const path = `/Journey/JourneyResults/${encodeURIComponent(
    endpoint(from)
  )}/to/${encodeURIComponent(endpoint(to))}?${params.toString()}`;
  const data = await get(path);
  return data.journeys || [];
}

// Stations within `radius` metres of a point. stopTypes default to the
// rail-like modes useful as bike-and-ride transfer points.
export async function nearbyStations(point, radius = 2500, stopTypes) {
  const types =
    stopTypes ||
    [
      "NaptanMetroStation",
      "NaptanRailStation",
    ].join(",");
  const params = new URLSearchParams({
    lat: String(point.lat),
    lon: String(point.lon),
    radius: String(radius),
    stopTypes: types,
    // TfL rejects multiple stopTypes unless a modes filter is also supplied.
    modes: "tube,dlr,overground,elizabeth-line,national-rail,tram",
  });
  const data = await get(`/StopPoint?${params.toString()}`);
  const points = data.stopPoints || [];
  return points.map((s) => ({
    id: s.id || s.naptanId,
    name: (s.commonName || "").replace(/ (Underground|Rail|DLR) Station$/i, ""),
    lat: s.lat,
    lon: s.lon,
    modes: s.modes || [],
    lines: (s.lines || []).map((l) => l.name),
  }));
}

// All Santander Cycle docking stations (official park/pickup points).
export async function bikePoints() {
  const data = await get(`/BikePoint`);
  return (data || []).map((b) => {
    const prop = (n) =>
      (b.additionalProperties || []).find((p) => p.key === n)?.value;
    return {
      id: b.id,
      name: b.commonName,
      lat: b.lat,
      lon: b.lon,
      operator: "santander",
      bikes: Number(prop("NbBikes")) || 0,
      docks: Number(prop("NbEmptyDocks")) || 0,
    };
  });
}

// Geocode free text to a point using TfL's own search (good for stations &
// London places). Returns {lat,lon,name} or null.
export async function searchPlace(query) {
  const data = await get(
    `/Place/Search?name=${encodeURIComponent(query)}&types=`
  );
  const hit = (data || []).find((p) => p.lat && p.lon);
  if (!hit) return null;
  return { lat: hit.lat, lon: hit.lon, name: hit.commonName };
}
