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

  // Pure e-bike for short hops.
  if (crow < 5500) {
    options.push(buildPureBike(origin, dest, bikeMinutesEstimate(origin, dest), bays));
  }

  // Pick promising transfer stations: meaningfully closer to dest, not a
  // crazy-long ride, and a manageable shortlist.
  const scored = stations
    .map((s) => ({
      s,
      progress: progressTowardDest(origin, s, dest),
      bikeMin: bikeMinutesEstimate(origin, s),
    }))
    .filter((x) => x.progress > 500 && x.bikeMin <= 18)
    .sort((a, b) => b.progress - b.bikeMin * 40 - (a.progress - a.bikeMin * 40))
    .slice(0, 5);

  const legResults = await Promise.all(
    scored.map(async ({ s, bikeMin }) => {
      // Board at the station itself (Naptan id) so TfL doesn't tack on a
      // redundant walk-to-the-platform leg — we already biked there.
      const tj = await tfl.journey(s.id || s, dest, TRANSIT_MODES, opts).catch(() => []);
      const best = bestJourney(tj);
      if (!best) return null;
      return buildBikeThenTransit(origin, s, bikeMin, best, bays);
    })
  );
  options.push(...legResults.filter(Boolean));

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

  // Refine the bike legs of the surviving options with TfL's real cycle
  // routing so the headline time is trustworthy.
  await Promise.all(
    top.map(async (o) => {
      if (o.strategy === "bike+transit" && o._bikeFrom && o._bikeTo) {
        const cj = bestJourney(await tfl.journey(o._bikeFrom, o._bikeTo, ["cycle"], opts).catch(() => []));
        if (cj) reviseBike(o, cj.duration);
      } else if (o.strategy === "bike") {
        const cj = bestJourney(await tfl.journey(origin, dest, ["cycle"], opts).catch(() => []));
        if (cj) reviseBike(o, cj.duration);
      }
    })
  );

  top.sort((a, b) => a.durationMin - b.durationMin);

  const fastest = top[0];
  return {
    origin,
    dest,
    crowMetres: Math.round(crow),
    fastest: fastest?.label,
    options: top.map((o) => decorate(o, fastest)),
  };
}

function reviseBike(option, realBikeMin) {
  const old = option._bikeMin || 0;
  const delta = realBikeMin - old;
  option.durationMin = Math.round(option.durationMin + delta);
  option.costPence =
    option.strategy === "bike"
      ? bikeCostPence(realBikeMin)
      : option.costPence - bikeCostPence(old) + bikeCostPence(realBikeMin);
  // update the cycle leg display
  const cleg = option.legs.find((l) => l.mode === "cycle");
  if (cleg) cleg.durationMin = Math.round(realBikeMin);
  option._bikeMin = realBikeMin;
}

function decorate(o, fastest) {
  const { raw, _bikeMin, _bikeFrom, _bikeTo, ...clean } = o;
  return {
    ...clean,
    fastest: o === fastest,
    savingVsTransit: undefined, // filled in caller if desired
  };
}
