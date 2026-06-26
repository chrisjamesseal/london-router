// Zero-dependency server (Node built-in http). Serves the PWA, proxies
// geocoding, exposes the parking-bay dataset, and runs the routing engine.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";
import { plan } from "./lib/engine.js";
import * as tfl from "./lib/tfl.js";
import { haversine } from "./lib/geo.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// The web root is the repo root now (static-first). The /api routes below are
// kept for optional local server-side use, but the deployed app is static.
const PUBLIC = __dirname;
const PORT = process.env.PORT || 3000;

// --- bays dataset ----------------------------------------------------------
let BAYS = [];
async function loadBays() {
  try {
    BAYS = JSON.parse(await readFile(join(__dirname, "data", "bays.json"), "utf8"));
    console.log(`Loaded ${BAYS.length} parking bays from data/bays.json`);
  } catch {
    console.warn("No data/bays.json — falling back to live Santander docks. Run `npm run fetch-bays`.");
    BAYS = await tfl.bikePoints().catch(() => []);
    console.log(`Loaded ${BAYS.length} Santander docks as fallback bays`);
  }
}

// --- geocoding -------------------------------------------------------------
const COORD_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;
async function geocode(q) {
  const m = q.match(COORD_RE);
  if (m) return { lat: +m[1], lon: +m[2], name: "Pinned location" };
  try {
    const url =
      "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=gb" +
      "&viewbox=-0.51,51.69,0.33,51.28&bounded=1&q=" + encodeURIComponent(q);
    const res = await fetch(url, { headers: { "User-Agent": "london-router/0.1 (personal)" } });
    const data = await res.json();
    if (data && data[0]) return { lat: +data[0].lat, lon: +data[0].lon, name: data[0].display_name };
  } catch {}
  return await tfl.searchPlace(q).catch(() => null);
}

// --- helpers ---------------------------------------------------------------
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".ico": "image/x-icon",
};

function send(res, code, body, type = "application/json") {
  const data = type === "application/json" ? JSON.stringify(body) : body;
  res.writeHead(code, { "Content-Type": type });
  res.end(data);
}

async function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
  const file = normalize(join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) return send(res, 403, "forbidden", "text/plain");
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error();
    const buf = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    send(res, 404, "not found", "text/plain");
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); }
    });
  });
}

// --- routing ---------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  try {
    if (path === "/api/health") return send(res, 200, { ok: true, bays: BAYS.length });

    if (path === "/api/geocode") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return send(res, 400, { error: "missing q" });
      const hit = await geocode(q);
      return hit ? send(res, 200, hit) : send(res, 404, { error: "not found" });
    }

    if (path === "/api/bays") {
      const lat = +url.searchParams.get("lat");
      const lon = +url.searchParams.get("lon");
      const radius = +url.searchParams.get("radius") || 600;
      if (!lat || !lon) return send(res, 200, { bays: [] });
      const here = { lat, lon };
      const near = BAYS.map((b) => ({ ...b, d: haversine(here, b) }))
        .filter((b) => b.d <= radius).sort((a, b) => a.d - b.d).slice(0, 60);
      return send(res, 200, { bays: near });
    }

    if (path === "/api/plan" && req.method === "POST") {
      let { origin, dest } = await readBody(req);
      if (typeof origin === "string") origin = await geocode(origin);
      if (typeof dest === "string") dest = await geocode(dest);
      if (!origin?.lat || !dest?.lat)
        return send(res, 400, { error: "Could not resolve origin or destination" });
      const result = await plan(
        { lat: +origin.lat, lon: +origin.lon, name: origin.name },
        { lat: +dest.lat, lon: +dest.lon, name: dest.name },
        BAYS
      );
      return send(res, 200, result);
    }

    return serveStatic(req, res);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
});

await loadBays();
server.listen(PORT, () => console.log(`London Router on http://localhost:${PORT}`));
