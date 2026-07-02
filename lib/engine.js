// The routing engine. It races three strategies and returns the quickest:
//   1. plain TfL transit (what Google/Citymapper give you)
//   2. pure e-bike door to door (good for short hops)
//   3. e-bike to a *faster* station, then transit  <-- the trick Maps misses
//
// Bike-leg times are estimated for ranking, then the top options are refined
// with TfL's real cycle routing for accuracy.

import * as tfl from "./tfl.js";
import { bikeCostPence, transitCostPence, bikePricing } from "./fares.js";
import {
  haversine,
  bikeMinutesEstimate,
  progressTowardDest,
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

// Overheads (minutes) for grabbing and parking a dockless bike — realistically
// you walk to it, unlock, and at the end find a parking bay. Kept honest so a
// bike hop doesn't spuriously out-rank a straight tube/train ride.
const PICKUP_OVERHEAD = 3;
const DROPOFF_OVERHEAD = 2;

// TfL cycle routing assumes a normal pedal bike. Lime/Forest e-bikes are a bit
// faster, so scale TfL's cycle time down (conservatively) to reflect that.
const EBIKE_FACTOR = 0.8;

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

// TfL returns leg geometry as a JSON-stringified array of [lat,lon] pairs.
function parsePath(leg) {
  try {
    const arr = JSON.parse(leg.path?.lineString || "");
    if (Array.isArray(arr) && arr.length && Array.isArray(arr[0]) && arr[0].length === 2) return arr;
  } catch {}
  return null;
}

function tflLegs(journey) {
  return (journey.legs || []).map((leg) => {
    const ro = (leg.routeOptions || [])[0] || {};
    const dep = leg.departurePoint || {};
    const arr = leg.arrivalPoint || {};
    // Intermediate stops along the leg (for the expandable stop list, A2).
    const stops = (leg.path?.stopPoints || [])
      .map((s) => (s.name || "").replace(/ (Underground|Rail|DLR) Station$/i, ""))
      .filter(Boolean);
    return {
      mode: (leg.mode?.name || "walking").toLowerCase(),
      summary: leg.instruction?.summary || "",
      durationMin: leg.duration,
      line: ro.name || "",
      lineId: ro.lineIdentifier?.id || "",
      from: dep.commonName,
      to: arr.commonName,
      fromId: dep.naptanId || dep.icsCode || dep.id || "",
      toId: arr.naptanId || arr.icsCode || arr.id || "",
      fromLL: dep.lat != null ? { lat: dep.lat, lon: dep.lon } : null,
      toLL: arr.lat != null ? { lat: arr.lat, lon: arr.lon } : null,
      geometry: parsePath(leg),
      stops,
      // Per-leg fare in pence, when TfL breaks it down (rare); else null.
      farePence: typeof leg.fare === "number" ? leg.fare : null,
      platform: dep.platformName || "",
      direction: ro.directions?.[0] || "",
      terminus: ((ro.directions?.[0] || "").match(/(?:towards|to)\s+(.+)$/i) || [])[1] || "",
    };
  });
}

// bays is a compact array of [lat, lon] pairs (Lime/Forest park points).
function nearestBay(point, bays) {
  let bd = Infinity,
    bi = -1;
  for (let i = 0; i < bays.length; i++) {
    const d = haversine(point, { lat: bays[i][0], lon: bays[i][1] });
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }
  if (bi < 0) return null;
  return {
    name: "a cycle-parking bay",
    lat: bays[bi][0],
    lon: bays[bi][1],
    metresAway: Math.round(bd),
  };
}

// --- strategy builders -----------------------------------------------------

function buildTransitOnly(journey) {
  return {
    strategy: "transit",
    label: "Transit Only",
    durationMin: journey.duration,
    costPence: transitCostPence(journey),
    walkMetres: walkMetresOf(journey),
    legs: tflLegs(journey),
    _bikeMin: 0,
    _transitPence: transitCostPence(journey),
    raw: journey,
  };
}

function buildPureBike(origin, dest, bikeMin, bays) {
  const pickup = nearestBay(origin, bays);
  const dropoff = nearestBay(dest, bays);
  const total = bikeMin + PICKUP_OVERHEAD + DROPOFF_OVERHEAD;
  return {
    strategy: "bike",
    label: "E-Bike All The Way",
    durationMin: Math.round(total),
    costPence: bikeCostPence(bikeMin),
    walkMetres: (pickup?.metresAway || 0) + (dropoff?.metresAway || 0),
    pickupBay: pickup,
    dropoffBay: dropoff,
    legs: [
      { mode: "walking", summary: `Walk to E-Bike Bay`, durationMin: Math.round((pickup?.metresAway || 0) / 80),
        fromLL: { lat: origin.lat, lon: origin.lon }, toLL: pickup && { lat: pickup.lat, lon: pickup.lon } },
      { mode: "cycle", summary: `Ride to Destination`, durationMin: Math.round(bikeMin),
        fromLL: pickup && { lat: pickup.lat, lon: pickup.lon }, toLL: { lat: dest.lat, lon: dest.lon } },
    ],
    _bikeMin: bikeMin,
    _transitPence: 0,
  };
}

function buildBikeThenTransit(origin, station, bikeMin, transit, bays) {
  const pickup = nearestBay(origin, bays);
  const dropoff = nearestBay(station, bays);
  // Walk from the Lime parking bay to the station entrance.
  const walkToStn = Math.max(1, Math.round((dropoff?.metresAway || 0) / 80));
  const total = bikeMin + PICKUP_OVERHEAD + DROPOFF_OVERHEAD + walkToStn + transit.duration;
  return {
    strategy: "bike+transit",
    label: `E-Bike to ${station.name}, Then Transit`,
    durationMin: Math.round(total),
    costPence: bikeCostPence(bikeMin) + transitCostPence(transit),
    walkMetres:
      (pickup?.metresAway || 0) + (dropoff?.metresAway || 0) + walkMetresOf(transit),
    pickupBay: pickup,
    dropoffBay: dropoff,
    station: station.name,
    legs: [
      { mode: "cycle", summary: `E-Bike to ${station.name}`, durationMin: Math.round(bikeMin),
        to: station.name, fromLL: { lat: origin.lat, lon: origin.lon }, toLL: { lat: station.lat, lon: station.lon } },
      { mode: "walking", summary: `Walk to ${station.name}`, durationMin: walkToStn,
        to: station.name, fromLL: dropoff && { lat: dropoff.lat, lon: dropoff.lon }, toLL: { lat: station.lat, lon: station.lon } },
      ...tflLegs(transit),
    ],
    _bikeMin: bikeMin,
    _transitPence: transitCostPence(transit),
    _bikeFrom: origin,
    _bikeTo: station,
  };
}

// Transit most of the way, then e-bike the last mile from a station near the
// destination — the mirror of bike+transit, and the trick for places that sit
// awkwardly between stations (e.g. tube to Earl's Court, then Lime to the
// hospital). `station` is near the dest; `transit` is origin → that station.
function buildTransitThenBike(origin, station, transit, dest, bikeMin, bays) {
  const pickup = nearestBay(station, bays); // grab a bike by the station
  const dropoff = nearestBay(dest, bays); // park near the destination
  const walkToBike = Math.max(1, Math.round((pickup?.metresAway || 0) / 80));
  const total = transit.duration + walkToBike + PICKUP_OVERHEAD + DROPOFF_OVERHEAD + bikeMin;
  return {
    strategy: "transit+bike",
    label: `Transit to ${station.name}, Then E-Bike`,
    durationMin: Math.round(total),
    costPence: transitCostPence(transit) + bikeCostPence(bikeMin),
    walkMetres:
      walkMetresOf(transit) + (pickup?.metresAway || 0) + (dropoff?.metresAway || 0),
    pickupBay: pickup,
    dropoffBay: dropoff,
    station: station.name,
    legs: [
      ...tflLegs(transit),
      { mode: "walking", summary: `Walk to E-Bike`, durationMin: walkToBike,
        fromLL: { lat: station.lat, lon: station.lon }, toLL: pickup && { lat: pickup.lat, lon: pickup.lon } },
      { mode: "cycle", summary: `E-Bike to Destination`, durationMin: Math.round(bikeMin),
        from: station.name, fromLL: pickup ? { lat: pickup.lat, lon: pickup.lon } : { lat: station.lat, lon: station.lon },
        toLL: { lat: dest.lat, lon: dest.lon } },
    ],
    _bikeMin: bikeMin,
    _transitPence: transitCostPence(transit),
    _bikeFrom: station,
    _bikeTo: dest,
  };
}

// Interchange quality: more lines/modes (especially the Elizabeth line, then
// tube) make a station a better place to switch to or from a bike.
function hubScore(s) {
  const modes = s.modes || [];
  return (
    (s.lines?.length || modes.length) * 120 +
    (modes.includes("elizabeth-line") ? 500 : 0) +
    (modes.includes("tube") ? 150 : 0)
  );
}

// Rough cab cost/time for a short hop to a station.
function cabHop(a, b) {
  const km = (haversine(a, b) / 1000) * 1.3;
  const driveMin = Math.round(km * 3 + 3);
  const pence = Math.round(250 + 150 * km + 25 * driveMin);
  return { driveMin, pence };
}

// Cab (Uber/Bolt) to a faster station, then transit — handy when you'd rather
// not ride, or with bikes turned off.
function buildCabThenTransit(origin, station, transit) {
  const { driveMin, pence } = cabHop(origin, station);
  const total = driveMin + 1 + transit.duration; // +1 min to get going
  return {
    strategy: "cab+transit",
    label: `Cab to ${station.name}, Then Transit`,
    durationMin: Math.round(total),
    costPence: pence + transitCostPence(transit),
    walkMetres: walkMetresOf(transit),
    station: station.name,
    legs: [
      { mode: "car", brand: "uber", summary: `Cab to ${station.name}`, durationMin: driveMin,
        to: station.name, fromLL: { lat: origin.lat, lon: origin.lon }, toLL: { lat: station.lat, lon: station.lon } },
      ...tflLegs(transit),
    ],
    _transitPence: transitCostPence(transit),
  };
}

// Apply single-trip pass note, or convert to a round trip (there & back). The
// return leg is mirrored from the outbound, and a single Lime pass can cover
// both ways when total riding stays within its time allowance.
function applyReturn(o, returnTrip) {
  const oneBike = o._bikeMin || 0;
  const transitP = o._transitPence || 0;
  if (returnTrip) {
    o.durationMin = Math.round(o.durationMin * 2);
    o.walkMetres = Math.round(o.walkMetres * 2);
    const totalBike = oneBike * 2;
    o.costPence = transitP * 2 + bikeCostPence(totalBike);
    o.roundTrip = true;
    if (oneBike > 0) {
      const pr = bikePricing(totalBike);
      o.note = pr.pass
        ? `One ${pr.op} ${pr.passMins}-min pass (£${(pr.pence / 100).toFixed(2)}) covers both ways — ${Math.round(totalBike)} min riding total`
        : `${pr.op} e-bike, ${Math.round(totalBike)} min riding both ways`;
    }
  } else if (oneBike > 0) {
    const pr = bikePricing(oneBike);
    o.note = pr.pass
      ? `Cheapest with a ${pr.op} ${pr.passMins}-min pass (£${(pr.pence / 100).toFixed(2)})`
      : `${pr.op} e-bike`;
  }
}

// --- main ------------------------------------------------------------------

export async function plan(origin, dest, bays, opts = {}) {
  const options = [];
  const crow = haversine(origin, dest);
  // Caller can restrict transit modes and turn the bike/cab off (Extras "avoid").
  const modes = (opts.transitModes && opts.transitModes.length ? opts.transitModes : TRANSIT_MODES);
  const allowBike = opts.allowBike !== false;
  const allowCab = opts.allowCab !== false;
  // Transfer stations are useful for both bike-and-ride and cab-and-ride.
  const wantTransfers = allowBike || allowCab;
  // Transit-then-bike (last-mile e-bike from a station near the dest) only pays
  // off over a real distance — short hops are better as pure bike or walking.
  const wantTransitBike = allowBike && crow > 3000;

  // Baseline transit route. Nearby stations come from a bundled static list
  // (opts.stations) so we can scan a wide area instantly — TfL's StopPoint
  // radius search is far too slow (10s+). Falls back to the live API if no
  // station list was supplied. `destStations` are near the destination, for the
  // last-mile e-bike.
  let baselineJ, stations, destStations;
  if (opts.stations) {
    baselineJ = await tfl.journey(origin, dest, modes, opts).catch(() => []);
    stations = wantTransfers ? opts.stations.filter((s) => haversine(origin, s) <= 4500) : [];
    destStations = wantTransitBike ? opts.stations.filter((s) => haversine(dest, s) <= 3500) : [];
  } else {
    [baselineJ, stations, destStations] = await Promise.all([
      tfl.journey(origin, dest, modes, opts).catch(() => []),
      wantTransfers ? tfl.nearbyStations(origin, 3000).catch(() => []) : Promise.resolve([]),
      wantTransitBike ? tfl.nearbyStations(dest, 3000).catch(() => []) : Promise.resolve([]),
    ]);
  }

  const baseline = bestJourney(baselineJ);
  if (baseline) options.push(buildTransitOnly(baseline));

  // Shortlist transfer stations: meaningfully closer to dest, within a sane
  // ride, and biased toward big interchanges (more modes, especially the fast
  // Elizabeth line) — that's where biking-to-a-better-station really pays off.
  const score = (x) => x.progress - x.bikeMin * 40 + x.hub;
  const scored = stations
    .map((s) => ({
      s,
      progress: progressTowardDest(origin, s, dest),
      bikeMin: bikeMinutesEstimate(origin, s),
      hub: hubScore(s),
    }))
    .filter((x) => x.progress > 400 && x.bikeMin <= 20)
    .sort((a, b) => score(b) - score(a))
    .slice(0, 5);

  // Last-mile candidates: good interchanges near the dest, a sane bike from it.
  const destScored = destStations
    .map((s) => ({ s, bikeMin: bikeMinutesEstimate(s, dest), hub: hubScore(s) }))
    .filter((x) => x.bikeMin >= 3 && x.bikeMin <= 20 && haversine(x.s, dest) > 350)
    .sort((a, b) => (b.hub - b.bikeMin * 40) - (a.hub - a.bikeMin * 40))
    .slice(0, 3);

  // One parallel wave: the pure-bike door-to-door time, plus for each candidate
  // station its transit-to-destination AND the real cycle time to reach it.
  // Routing the bike legs here (rather than in a later refinement pass) keeps
  // the headline times accurate while cutting a whole round-trip.
  const pureBikePromise =
    allowBike && crow < 5500
      ? tfl.journey(origin, dest, ["cycle"], opts).then(bestJourney).catch(() => null)
      : Promise.resolve(null);

  const candPromises = scored.map(({ s, bikeMin }) =>
    Promise.all([
      // Board at the station itself (Naptan id) so TfL doesn't add a redundant
      // walk-to-platform leg — we already biked/cabbed there.
      tfl.journey(s.id || s, dest, modes, opts).then(bestJourney).catch(() => null),
      // Real cycle time only matters if the bike is allowed.
      allowBike ? tfl.journey(origin, s, ["cycle"], opts).then(bestJourney).catch(() => null) : Promise.resolve(null),
    ]).then(([transit, cyc]) => ({
      s,
      bikeMin: cyc ? cyc.duration * EBIKE_FACTOR : bikeMin,
      transit,
    }))
  );

  // Mirror wave for the last mile: transit origin → station near dest, plus the
  // real cycle time from that station to the destination.
  const destCandPromises = destScored.map(({ s, bikeMin }) =>
    Promise.all([
      tfl.journey(origin, s.id || s, modes, opts).then(bestJourney).catch(() => null),
      tfl.journey(s, dest, ["cycle"], opts).then(bestJourney).catch(() => null),
    ]).then(([transit, cyc]) => ({
      s,
      bikeMin: cyc ? cyc.duration * EBIKE_FACTOR : bikeMin,
      transit,
    }))
  );

  const [pureBikeJ, cands, destCands] = await Promise.all([
    pureBikePromise,
    Promise.all(candPromises),
    Promise.all(destCandPromises),
  ]);

  if (allowBike && crow < 5500) {
    const bm = pureBikeJ
      ? pureBikeJ.duration * EBIKE_FACTOR
      : bikeMinutesEstimate(origin, dest);
    options.push(buildPureBike(origin, dest, bm, bays));
  }
  for (const { s, bikeMin, transit } of cands) {
    if (!transit) continue;
    if (allowBike) options.push(buildBikeThenTransit(origin, s, bikeMin, transit, bays));
    if (allowCab) options.push(buildCabThenTransit(origin, s, transit));
  }
  for (const { s, bikeMin, transit } of destCands) {
    if (transit) options.push(buildTransitThenBike(origin, s, transit, dest, bikeMin, bays));
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
  let top = ranked.slice(0, 4);
  // Always surface the plain transit option (tube/train only — no bike) so a
  // straight ride like Piccadilly → Jubilee is offered even if a bike hop edges
  // it out on the estimate.
  const transit = ranked.find((o) => o.strategy === "transit");
  if (transit && !top.includes(transit)) {
    top = top.slice(0, 3).concat(transit).sort((a, b) => a.durationMin - b.durationMin);
  }

  // Single-trip pass notes, or convert every option to a there-and-back trip.
  for (const o of top) applyReturn(o, opts.returnTrip);

  const fastest = top[0];
  return {
    origin,
    dest,
    crowMetres: Math.round(crow),
    roundTrip: !!opts.returnTrip,
    fastest: fastest?.label,
    options: top.map((o) => decorate(o, fastest)),
  };
}

function decorate(o, fastest) {
  const { raw, _bikeMin, _transitPence, _bikeFrom, _bikeTo, ...clean } = o;
  return { ...clean, fastest: o === fastest };
}
