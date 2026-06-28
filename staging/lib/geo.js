// Geometry + bike/walk time helpers.

const R = 6371000; // earth radius, metres
const toRad = (d) => (d * Math.PI) / 180;

export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h)); // metres
}

// Straight-line distance underestimates real street distance. This factor
// converts crow-flies to a realistic on-street distance for central London.
export const STREET_FACTOR = 1.35;

// Effective speeds (m/s). E-bikes in London traffic ~ 15 km/h door-to-door.
export const WALK_MPS = 1.35; // ~4.9 km/h
export const EBIKE_MPS = 4.2; // ~15 km/h effective incl. junctions

export function walkMinutes(a, b) {
  return (haversine(a, b) * STREET_FACTOR) / WALK_MPS / 60;
}

// Quick e-bike time estimate used for ranking candidates before we refine
// the top few with TfL's real cycle routing.
export function bikeMinutesEstimate(a, b) {
  return (haversine(a, b) * STREET_FACTOR) / EBIKE_MPS / 60;
}

// How much closer to the destination does boarding at `point` get you,
// compared with starting from `origin`? Positive = progress toward dest.
export function progressTowardDest(origin, point, dest) {
  return haversine(origin, dest) - haversine(point, dest);
}

export function nearest(point, candidates) {
  let best = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = haversine(point, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best ? { ...best, distance: bestD } : null;
}
