// Cost model. Transit fares come from TfL's journey response when available;
// otherwise we estimate. Dockless e-bike rates are approximate and editable.

// £ values. Tweak these as operator pricing changes.
export const BIKE_RATES = {
  forest: { unlock: 0.0, perMin: 0.18, label: "Forest" },
  lime: { unlock: 1.0, perMin: 0.27, label: "Lime" },
  santander: { unlock: 1.65, perMin: 0.0, label: "Santander", cap30: true },
};

// Default dockless operator to price against when a bay isn't operator-tagged.
export const DEFAULT_BIKE = "forest";

export function bikeCostPence(minutes, operator = DEFAULT_BIKE) {
  const r = BIKE_RATES[operator] || BIKE_RATES[DEFAULT_BIKE];
  if (r.cap30) {
    // Santander: flat fee per 30-min ride.
    const rides = Math.max(1, Math.ceil(minutes / 30));
    return Math.round(rides * r.unlock * 100);
  }
  return Math.round((r.unlock + r.perMin * minutes) * 100);
}

// Pull a fare from a TfL journey if present (totalCost is in pence), else
// estimate from the modes used. The Hopper fare = £1.75 for unlimited buses
// within an hour; tube PAYG is zone-based — we use a simple central estimate.
export function transitCostPence(journey) {
  const tfl = journey?.fare?.totalCost;
  if (typeof tfl === "number" && tfl > 0) return tfl;

  const legs = journey?.legs || [];
  let usesRail = false;
  let usesBus = false;
  for (const leg of legs) {
    const m = (leg.mode?.name || "").toLowerCase();
    if (["tube", "dlr", "overground", "elizabeth-line", "national-rail", "tram"].includes(m))
      usesRail = true;
    if (m === "bus") usesBus = true;
  }
  let p = 0;
  if (usesRail) p += 290; // ~£2.90 central PAYG single (zone 1-2 off-peak-ish)
  if (usesBus) p += 175; // Hopper
  return p;
}

export const pounds = (pence) => `£${(pence / 100).toFixed(2)}`;
