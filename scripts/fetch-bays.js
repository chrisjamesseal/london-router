// Builds data/bays.json — places to grab/park a Lime/Forest e-bike.
// Source: OSM cycle parking across Greater London (Lime/Forest publish no open
// London bay feed, so cycle parking is the proxy). Stored compactly as
// [lat, lon] pairs to keep the file small despite wide coverage.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Greater London (covers outer boroughs where Lime/Forest also operate).
const BBOX = "51.32,-0.53,51.69,0.30"; // S,W,N,E

const OVERPASS = "https://overpass-api.de/api/interpreter";
const QUERY = `[out:json][timeout:180];
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
    bays.push([+lat.toFixed(5), +lon.toFixed(5)]);
  }
  return bays;
}

async function main() {
  console.log("Fetching cycle parking from OSM (Overpass)…");
  const bays = await osmParking().catch((e) => {
    console.warn("  Overpass failed:", e.message);
    return [];
  });
  const out = join(__dirname, "..", "data", "bays.json");
  await writeFile(out, JSON.stringify(bays));
  console.log(`Wrote ${bays.length} bays -> ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
