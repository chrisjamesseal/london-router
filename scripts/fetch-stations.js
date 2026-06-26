// Builds data/stations.json — every tube/DLR/Overground/Elizabeth-line/tram
// station, so "nearby stations" is an instant local lookup instead of TfL's
// very slow StopPoint radius search. Re-run to refresh.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODES = "tube,dlr,overground,elizabeth-line,tram";

function clean(name) {
  return (name || "")
    .replace(/\s+(Underground|Rail|DLR|Overground)\s+Station$/i, "")
    .replace(/\s+Station$/i, "")
    .trim();
}

async function main() {
  console.log("Fetching all stations from TfL…");
  const res = await fetch(`https://api.tfl.gov.uk/StopPoint/Mode/${MODES}`);
  const data = await res.json();
  const raw = data.stopPoints || [];
  console.log(`  ${raw.length} stop records`);

  // Collapse to one entry per station, merging modes.
  const byName = new Map();
  for (const s of raw) {
    if (s.lat == null || s.lon == null) continue;
    const name = clean(s.commonName);
    if (!name) continue;
    const cur = byName.get(name);
    if (cur) {
      cur.modes = [...new Set([...cur.modes, ...(s.modes || [])])];
    } else {
      byName.set(name, {
        id: s.id || s.naptanId,
        name,
        lat: s.lat,
        lon: s.lon,
        modes: [...(s.modes || [])],
      });
    }
  }
  const stations = [...byName.values()];
  const out = join(__dirname, "..", "data", "stations.json");
  await writeFile(out, JSON.stringify(stations));
  console.log(`Wrote ${stations.length} stations -> ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
