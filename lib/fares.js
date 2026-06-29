// Cost model. Transit fares come from TfL's journey response when available;
// otherwise we estimate. Dockless e-bike pricing covers Lime + Forest, picking
// the cheapest applicable option (pay-as-you-go vs a time pass).
import { zoneForName } from "./zones.js";

// Dockless e-bike pricing. Lime: ~£1 unlock + ~£0.29/min, OR a 30-min pass for
// £3.99 (cheaper over ~14 min, and one pass covers a there-and-back ≤30 min ride).
// Forest (Human Forest): no unlock, ~£0.19/min, no time pass.
export const BIKE_RATES = {
  lime: { unlock: 1.0, perMin: 0.29, passMins: 30, passPrice: 3.99, label: "Lime" },
  forest: { unlock: 0.0, perMin: 0.19, passMins: 0, passPrice: 0, label: "Forest" },
};

// The operator the app prices/labels bikes as. Set from the user's Custom choice.
let BIKE_OP = "lime";
export function setBikeOp(op) { if (BIKE_RATES[op]) BIKE_OP = op; }
export function bikeOp() { return BIKE_OP; }

// Cheapest way to ride `minutes` on the chosen operator — pay-as-you-go vs a time
// pass (where offered) — with the full workings so the UI can explain it.
export function bikePricing(minutes) {
  const r = BIKE_RATES[BIKE_OP] || BIKE_RATES.lime;
  const m = Math.max(0, Math.round(minutes || 0));
  const unlockPence = Math.round(r.unlock * 100);
  const perMinPence = Math.round(r.perMin * 100);
  const paygPence = unlockPence + perMinPence * m;
  const hasPass = r.passPrice > 0 && r.passMins > 0;
  const passUnitPence = Math.round(r.passPrice * 100);
  const passesNeeded = hasPass ? Math.max(1, Math.ceil(m / r.passMins)) : 0;
  const passPence = hasPass ? passesNeeded * passUnitPence : Infinity;
  const usePass = hasPass && passPence <= paygPence;
  return {
    op: r.label,
    min: m,
    pence: usePass ? passPence : paygPence,
    hasPass,
    pass: usePass,
    passMins: r.passMins,
    passUnitPence,
    passesNeeded,
    passPence,
    paygPence,
    unlockPence,
    perMinPence,
    // A single pass also covers the return on the same route when both legs fit.
    returnPassCovers: hasPass && 2 * m <= r.passMins,
  };
}

export function bikeCostPence(minutes) {
  return bikePricing(minutes).pence;
}

// --- Zone-based tube/rail pricing ------------------------------------------
// London fare zones are roughly concentric rings around the centre. We don't
// have a per-station zone list, so we estimate a station's zone from its
// distance to central London — good enough for a PAYG single estimate, and
// always overridden by TfL's own fare when the journey planner returns one.
const ZONE_CENTRE = { lat: 51.5074, lon: -0.1278 };
// Outer radius (km) of each zone: index 0 = zone 1 edge, 1 = zone 2 edge, …
const ZONE_EDGES = [3.5, 6.5, 9.5, 13, 17, 21, 26, 32];
export function zoneFor(lat, lon) {
  if (lat == null || lon == null) return 1;
  const dy = (lat - ZONE_CENTRE.lat) * 111;
  const dx = (lon - ZONE_CENTRE.lon) * 111 * Math.cos((lat * Math.PI) / 180);
  const km = Math.hypot(dx, dy);
  let z = 1;
  for (const edge of ZONE_EDGES) { if (km > edge) z++; else break; }
  return Math.min(z, 9);
}

// Prefer the curated station→zone lookup; fall back to the distance estimate.
export function zoneForStation(name, lat, lon) {
  return zoneForName(name) || zoneFor(lat, lon);
}

// Adult pay-as-you-go single fares (pence). Estimates of current TfL fares;
// TfL's own returned fare is always preferred over these.
const FARE_VIA_Z1 = { // journeys touching zone 1, keyed by the furthest zone
  1: { peak: 290, off: 280 },
  2: { peak: 350, off: 290 },
  3: { peak: 380, off: 300 },
  4: { peak: 450, off: 320 },
  5: { peak: 520, off: 350 },
  6: { peak: 580, off: 360 },
};
const FARE_NO_Z1 = { // journeys outside zone 1, keyed by number of zones crossed
  1: { peak: 210, off: 190 },
  2: { peak: 210, off: 190 },
  3: { peak: 250, off: 200 },
  4: { peak: 290, off: 230 },
  5: { peak: 320, off: 230 },
  6: { peak: 320, off: 230 },
};
export function zoneFarePence(z1, z2, peak) {
  const lo = Math.min(z1, z2), hi = Math.max(z1, z2), k = peak ? "peak" : "off";
  if (lo <= 1) return (FARE_VIA_Z1[Math.min(hi, 6)] || FARE_VIA_Z1[6])[k];
  const crossed = Math.min(hi - lo + 1, 6);
  return (FARE_NO_Z1[crossed] || FARE_NO_Z1[6])[k];
}

// Peak = weekday 06:30–09:30 and 16:00–19:00 (London local time).
export function isPeakDate(d) {
  if (!(d instanceof Date) || isNaN(d)) return false;
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  const mins = d.getHours() * 60 + d.getMinutes();
  return (mins >= 390 && mins < 570) || (mins >= 960 && mins < 1140);
}

const RAIL_FARE_MODES = ["tube", "dlr", "overground", "elizabeth-line", "national-rail", "tram"];

// Pull a fare from a TfL journey if present (totalCost is in pence), else
// estimate: a zone-based tube/rail single + the £1.75 Hopper bus fare.
export function transitCostPence(journey) {
  const tfl = journey?.fare?.totalCost;
  if (typeof tfl === "number" && tfl > 0) return tfl;

  const legs = journey?.legs || [];
  const railLegs = legs.filter((l) => RAIL_FARE_MODES.includes((l.mode?.name || "").toLowerCase()));
  const usesBus = legs.some((l) => (l.mode?.name || "").toLowerCase() === "bus");

  let p = 0;
  if (railLegs.length) {
    const a = railLegs[0].departurePoint || {};
    const b = railLegs[railLegs.length - 1].arrivalPoint || {};
    const peak = isPeakDate(journey?.startDateTime ? new Date(journey.startDateTime) : null);
    p += zoneFarePence(
      zoneForStation(a.commonName, a.lat, a.lon),
      zoneForStation(b.commonName, b.lat, b.lon),
      peak
    );
  }
  if (usesBus) p += 175; // Hopper
  return p;
}

// A typical railcard takes 1/3 off rail fares.
export const railcardPence = (pence) => Math.round((pence * 2) / 3);

export const pounds = (pence) => `£${(pence / 100).toFixed(2)}`;
