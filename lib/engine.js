// The routing engine. It races three strategies and returns the quickest:
//   1. plain TfL transit (what Google/Citymapper give you)
//   2. pure e-bike door to door (good for short hops)
//   3. e-bike to a *faster* station, then transit  <-- the trick Maps misses
//
// Bike-leg times are estimated for ranking, then the top options are refined
// with TfL's real cycle routing for accuracy.

import * as tfl from "./tfl.js";
import { bikeCostPence, transitCostPence, BIKE_RATES, DEFAULT_BIKE } from "./fares.js";
import {
  haversine,
  walkMinutes,
  bikeMinutesEstimate,
  progressTowardDest,
  nearest,
} from "./geo.js";

const TRANSIT_MODES = [
  "tube",
  "dlr",
  "overground",
  "elizabeth-line",
  "national-rail",
  "tram",
  "bus",
  "walking",
];

// Overheads (minutes) for grabbing and parking a dockless bike.
const PICKUP_OVERHEAD = 1.5;
const DROPOFF_OVERHEAD = 1.5;

function bestJourney(journeys) {
  if (!journeys || !journeys.length) return null;
  return [...journeys].sort((a, b) => a.duration - b.duration)[0];
}

function walkMetresOf(journey) {
  let m = 0;
  for (const leg of journey.legs || []) {
    if ((leg.mode?.name || "").toLowerCase() === "walking") {
      m += leg.distance || (leg.duration || 0) * 60 * 1.35; // fallback
    }
  }
  return Math.round(m);
}

function tflLegs(journey) {
  return (journey.legs || []).map((leg) => ({
    mode: (leg.mode?.name || "walking").toLowerCase(),
    summary: leg.instruction?.summary || "",
    durationMin: leg.duration,
    line: (leg.routeOptions || [])[0]?.name || "",
    from: leg.departurePoint?.commonName,
    to: leg.arrivalPoint?.commonName,
  }));
}

function nearestBay(point, bays) {
  const n = nearest(point, bays);
  if (!n) return null;
  return {
    name: n.name || "Cycle parking",
    operator: n.operator || "any",
    lat: n.lat,
    lon: n.lon,
    metresAway: Math.round(n.distance),
  };
}

// --- strategy builders -----------------------------------------------------

function buildTransitOnly(journey) {
  return {
    strategy: "transit",
    label: "Transit only",
    durationMin: journey.duration,
    costPence: transitCostPence(journey),
    walkMetres: walkMetresOf(journey),
    legs: tflLegs(journey),
    raw: journey,
  };
}

function buildPureBike(origin, dest, bikeMin, bays) {
  const pickup = nearestBay(origin, bays);
  const dropoff = nearestBay(dest, bays);
  const total = bikeMin + PICKUP_OVERHEAD + DROPOFF_OVERHEAD;
  return {
    strategy: "bike",
    label: "E-bike all the way",
    durationMin: Math.round(total),
    costPence: bikeCostPence(bikeMin),
    walkMetres: (pickup?.metresAway || 0) + (dropoff?.metresAway || 0),
    pickupBay: pickup,
    dropoffBay: dropoff,
    legs: [
      { mode: "walking", summary: `Walk to e-bike bay`, durationMin: Math.round((pickup?.metresAway || 0) / 80) },
      { mode: "cycle", summary: `Ride to destination`, durationMin: Math.round(bikeMin) },
    ],
    _bikeMin: bikeMin,
  };
}

function buildBikeThenTransit(origin, station, bikeMin, transit, bays) {
  const pickup = nearestBay(origin, bays);
  const dropoff = nearestBay(station, bays);
  const total = bikeMin + PICKUP_OVERHEAD + DROPOFF_OVERHEAD + transit.duration;
  return {
    strategy: "bike+transit",
    label: `E-bike to ${station.name}, then transit`,
    durationMin: Math.round(total),
    costPence: bikeCostPence(bikeMin) + transitCostPence(transit),
    walkMetres:
      (pickup?.metresAway || 0) + (dropoff?.metresAway || 0) + walkMetresOf(transit),
    pickupBay: pickup,
    dropoffBay: dropoff,
    station: station.name,
    legs: [
      { mode: "cycle", summary: `E-bike to ${station.name}`, durationMin: Math.round(bikeMin) },
      ...tflLegs(transit),
    ],
    _bikeMin: bikeMin,
    _bikeFrom: origin,
    _bikeTo: station,
  };
}

// --- main ------------------------------------------------------------------

export async function plan(origin, dest, bays, opts = {}) {
  const options = [];
  const crow = haversine(origin, dest);

  // Run the independent TfL lookups in parallel.
  const [baselineJ, stations] = await Promise.all([
    tfl.journey(origin, dest, TRANSIT_MODES, opts).catch(() => []),
    tfl.nearbyStations(origin, 2800).catch(() => []),
  ]);

  const baseline = bestJourney(baselineJ);
  if (baseline) options.push(buildTransitOnly(baseline));

  // Pick promising transfer stations: meaningfully closer to dest, not a
  // crazy-long ride, and a short shortlist (each one costs API calls).
  const scored = stations
    .map((s) => ({
      s,
      progress: progressTowardDest(origin, s, dest),
      bikeMin: bikeMinutesEstimate(origin, s),
    }))
    .filter((x) => x.progress > 500 && x.bikeMin <= 18)
    .sort((a, b) => b.progress - b.bikeMin * 40 - (a.progress - a.bikeMin * 40))
    .slice(0, 3);

  // One parallel wave: the pure-bike door-to-door time, plus for each candidate
  // station its transit-to-destination AND the real cycle time to reach it.
  // Routing the bike legs here (rather than in a later refinement pass) keeps
  // the headline times accurate while cutting a whole round-trip.
  const pureBikePromise =
    crow < 5500
      ? tfl.journey(origin, dest, ["cycle"], opts).then(bestJourney).catch(() => null)
      : Promise.resolve(null);

  const candPromises = scored.map(({ s, bikeMin }) =>
    Promise.all([
      // Board at the station itself (Naptan id) so TfL doesn't add a redundant
      // walk-to-platform leg — we already biked there.
      tfl.journey(s.id || s, dest, TRANSIT_MODES, opts).then(bestJourney).catch(() => null),
      tfl.journey(origin, s, ["cycle"], opts).then(bestJourney).catch(() => null),
    ]).then(([transit, cyc]) => ({ s, bikeMin: cyc ? cyc.duration : bikeMin, transit }))
  );

  const [pureBikeJ, cands] = await Promise.all([
    pureBikePromise,
    Promise.all(candPromises),
  ]);

  if (crow < 5500) {
    const bm = pureBikeJ ? pureBikeJ.duration : bikeMinutesEstimate(origin, dest);
    options.push(buildPureBike(origin, dest, bm, bays));
  }
  for (const { s, bikeMin, transit } of cands) {
    if (transit) options.push(buildBikeThenTransit(origin, s, bikeMin, transit, bays));
  }

  // Rank, dedupe, keep the top few.
  options.sort((a, b) => a.durationMin - b.durationMin);
  const seen = new Set();
  const ranked = options.filter((o) => {
    const sig = `${o.strategy}:${o.station || ""}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
  const top = ranked.slice(0, 4);

  const fastest = top[0];
  return {
    origin,
    dest,
    crowMetres: Math.round(crow),
    fastest: fastest?.label,
    options: top.map((o) => decorate(o, fastest)),
  };
}

function decorate(o, fastest) {
  const { raw, _bikeMin, _bikeFrom, _bikeTo, ...clean } = o;
  return {
    ...clean,
    fastest: o === fastest,
    savingVsTransit: undefined, // filled in caller if desired
  };
}
