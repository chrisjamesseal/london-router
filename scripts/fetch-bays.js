// Builds data/bays.json — the set of places you can grab/park a bike.
// Sources: TfL Santander docks (official) + OSM cycle parking (proxy for
// where dockless Lime/Forest bikes can be left). Re-run any time to refresh.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as tfl from "../lib/tfl.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Inner London (roughly zones 1-3) — the area where bike-and-ride pays off.
// Widen this bbox if you want more coverage (slower, bigger file).
const BBOX = "51.43,-0.30,51.58,0.05"; // S,W,N,E

const OVERPASS = "https://overpass-api.de/api/interpreter";
const QUERY = `[out:json][timeout:120];
nwr["amenity"="bicycle_parking"](${BBOX});
out center;`;

async function osmParking() {
  const res = await fetch(OVERPASS, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "london-router/0.1 (personal bike-routing project)",
      Accept: "application/json",
    },
    body: "data=" + encodeURIComponent(QUERY),
  });
  if (!res.ok) throw new Error("Overpass " + res.status);
  const data = await res.json();
  const bays = [];
  for (const el of data.elements || []) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;
    bays.push({
      id: "osm-" + el.type[0] + el.id,
      name: el.tags?.name || "Cycle parking",
      lat,
      lon,
      operator: "any",
      capacity: el.tags?.capacity ? Number(el.tags.capacity) || null : null,
    });
  }
  return bays;
}

async function main() {
  console.log("Fetching Santander docks from TfL…");
  const docks = (await tfl.bikePoints().catch((e) => {
    console.warn("  BikePoint failed:", e.message);
    return [];
  })).map((d) => ({
    id: d.id,
    name: d.name,
    lat: d.lat,
    lon: d.lon,
    operator: "santander",
  }));
  console.log(`  ${docks.length} docks`);

  console.log("Fetching cycle parking from OSM (Overpass)…");
  const osm = await osmParking().catch((e) => {
    console.warn("  Overpass failed:", e.message);
    return [];
  });
  console.log(`  ${osm.length} cycle-parking locations`);

  const bays = [...docks, ...osm];
  const out = join(__dirname, "..", "data", "bays.json");
  await writeFile(out, JSON.stringify(bays));
  console.log(`Wrote ${bays.length} bays -> ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
