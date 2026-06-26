// Cost model. Transit fares come from TfL's journey response when available;
// otherwise we estimate. Dockless e-bike pricing covers Lime + Forest, picking
// the cheapest applicable option (pay-as-you-go vs a time pass).

// £ values. Tweak as operator pricing changes.
//   Lime: ~£1 unlock + ~£0.29/min, OR a 30-min pass for £3.99 (much cheaper
//         for anything over ~14 min, and it covers a there-and-back trip whose
//         total riding is ≤ 30 min).
//   Forest: ~£0.19/min, no unlock — usually cheapest for short hops.
export const BIKE_RATES = {
  lime: { unlock: 1.0, perMin: 0.29, passMins: 30, passPrice: 3.99, label: "Lime" },
  forest: { unlock: 0.0, perMin: 0.19, label: "Forest" },
};

// Cheapest way to ride `minutes` across Lime/Forest, PAYG or pass.
// Returns { pence, op, pass, passMins }.
export function bikePricing(minutes) {
  let best = null;
  const consider = (c) => {
    if (!best || c.pence < best.pence) best = c;
  };
  for (const key of Object.keys(BIKE_RATES)) {
    const r = BIKE_RATES[key];
    consider({
      pence: Math.round((r.unlock + r.perMin * minutes) * 100),
      op: r.label,
      pass: false,
      passMins: 0,
    });
    if (r.passPrice) {
      const n = Math.max(1, Math.ceil(minutes / r.passMins));
      consider({
        pence: Math.round(n * r.passPrice * 100),
        op: r.label,
        pass: true,
        passMins: r.passMins,
      });
    }
  }
  return best || { pence: 0, op: "Lime", pass: false, passMins: 0 };
}

export function bikeCostPence(minutes) {
  return bikePricing(minutes).pence;
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
  if (usesRail) p += 290; // ~£2.90 central PAYG single
  if (usesBus) p += 175; // Hopper
  return p;
}

// A typical railcard takes 1/3 off rail fares.
export const railcardPence = (pence) => Math.round((pence * 2) / 3);

export const pounds = (pence) => `£${(pence / 100).toFixed(2)}`;
