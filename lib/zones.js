// London station -> TfL fare-zone lookup (logic).
//
// The data lives in ./zones-data.js (ZONE_DATA). That file is the hand-curated
// core by default and can be regenerated with full authoritative coverage via
// scripts/generate-zones.mjs (which pulls TfL StopPoint data). Stations not in
// the table fall back to a distance-from-centre estimate (zoneFor in fares.js).
import { ZONE_DATA } from "./zones-data.js";

// Normalise a station name so "Oxford Circus Underground Station",
// "Oxford Circus" and "OXFORD CIRCUS" all collapse to "oxford circus".
export function normStation(name) {
  return (name || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/['’.]/g, "")
    .replace(/\((?:[^)]*)\)/g, " ")
    .replace(/\b(underground|overground|dlr|tram|tube)\b/g, " ")
    .replace(/\b(rail|national rail)\b/g, " ")
    .replace(/\bstation\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const STATION_ZONES = ZONE_DATA;

// Look up a station's zone by name; null if not in the table.
export function zoneForName(name) {
  const z = ZONE_DATA[normStation(name)];
  return z || null;
}
