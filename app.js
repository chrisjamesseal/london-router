// Client-side app: the routing engine runs entirely in the browser, calling
// TfL and Nominatim directly (both allow CORS). No backend required.
import { plan as runPlan } from "./lib/engine.js";
import { geocode, suggest } from "./lib/geocode.js";
import { railcardPence } from "./lib/fares.js";

const $ = (s) => document.querySelector(s);
const map = L.map("map", { zoomControl: false }).setView([51.5074, -0.1278], 12);
// Google Maps tiles, rendered through Leaflet so all the marker/route drawing
// below keeps working unchanged.
L.tileLayer("https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}", {
  maxZoom: 20,
  subdomains: ["0", "1", "2", "3"],
  attribution: "© Google",
}).addTo(map);
L.control.zoom({ position: "topright" }).addTo(map);

let layers = L.layerGroup().addTo(map);
let lastResult = null;
let sortBy = "best"; // "best" | "fastest" | "cheapest"

// Modes that a railcard (1/3 off) applies to — excludes bus/bike/taxi/walk.
const RAIL_MODES = ["tube", "dlr", "overground", "elizabeth-line", "national-rail", "tram", "train"];
const hasRail = (legs) => legs.some((l) => RAIL_MODES.includes(l.mode));

// Load the parking-bay dataset once (cached by the service worker after first
// visit). Kick it off immediately so it's ready by the time you plan.
let baysPromise = fetch("./data/bays.json").then((r) => r.json());
let stationsPromise = fetch("./data/stations.json").then((r) => r.json());

// Official TfL line colours, keyed by lower-cased line name ("… line" trimmed).
const LINE_COLORS = {
  bakerloo: "#B36305",
  central: "#E32017",
  circle: "#FFD300",
  district: "#00782A",
  "hammersmith & city": "#F3A9BB",
  jubilee: "#A0A5A9",
  metropolitan: "#9B0056",
  northern: "#000000",
  piccadilly: "#003688",
  victoria: "#0098D4",
  "waterloo & city": "#95CDBA",
  elizabeth: "#6950A1",
  dlr: "#00A4A7",
  overground: "#EE7C0E",
  "london overground": "#EE7C0E",
  liberty: "#5D6061",
  lioness: "#FAA61A",
  mildmay: "#0079C2",
  suffragette: "#76B82A",
  weaver: "#823A62",
  windrush: "#DC241F",
  tram: "#5FB526",
  thameslink: "#E10A8E",
};
const MODE_COLORS = {
  bus: "#E1251B",
  "national-rail": "#7A7A7A",
  dlr: "#00A4A7",
  overground: "#EE7C0E",
  "elizabeth-line": "#6950A1",
  tram: "#5FB526",
  tube: "#10069F",
};

function lineColor(leg) {
  if (leg.mode === "bus") return MODE_COLORS.bus;
  const ln = (leg.line || "").toLowerCase().replace(/\s+line$/, "").trim();
  return LINE_COLORS[ln] || MODE_COLORS[leg.mode] || "#6b7b73";
}
function textOn(hex) {
  const r = parseInt(hex.slice(1, 3), 16),
    g = parseInt(hex.slice(3, 5), 16),
    b = parseInt(hex.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? "#14211b" : "#fff";
}

function status(msg, spinner) {
  const el = $("#status");
  if (!msg) return el.classList.add("hidden");
  el.innerHTML = (spinner ? '<span class="spin"></span>' : "") + msg;
  el.classList.remove("hidden");
}

// Rotating, engaging loading lines so the wait never feels static.
const LOADING_LINES = [
  "Finding the quickest way…",
  "Hunting down the cheapest route…",
  "Racing tubes, buses & e-bikes…",
  "Checking 🍋‍🟩 Lime & 🌳 Forest bikes…",
  "Sniffing out clever shortcuts…",
  "Skipping the slow changes…",
  "Beating plain old Maps…",
];
let loadTimer = null;
function startLoading() {
  let i = 0;
  status(LOADING_LINES[0], true);
  loadTimer = setInterval(() => {
    i = (i + 1) % LOADING_LINES.length;
    status(LOADING_LINES[i], true);
  }, 1600);
}
function stopLoading() {
  if (loadTimer) clearInterval(loadTimer), (loadTimer = null);
  status("", false);
}

const pounds = (p) => "£" + (p / 100).toFixed(2);
const money = (p) => (p <= 0 ? "Free" : pounds(p));
const walkMin = (m) => Math.max(1, Math.round(m / 80)); // ~80 m/min walking

$("#locBtn").onclick = () => {
  if (!navigator.geolocation) return status("No geolocation", false);
  status("Locating…", true);
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      $("#from").value = `${latitude.toFixed(5)},${longitude.toFixed(5)}`;
      delete $("#from").dataset.lat;
      delete $("#from").dataset.lon;
      map.setView([latitude, longitude], 14);
      status("", false);
    },
    () => status("Location blocked — type an address", false),
    { enableHighAccuracy: true, timeout: 8000 }
  );
};

$("#go").onclick = plan;
$("#to").addEventListener("keydown", (e) => e.key === "Enter" && plan());
// Re-plan when the return toggle or pub stop changes, if we already planned.
const replanIfReady = () => {
  if ($("#from").value.trim() && $("#to").value.trim() && lastResult) plan();
};
$("#return").addEventListener("change", replanIfReady);
$("#pubStop").addEventListener("change", replanIfReady);
// Party size only affects the fare split — re-render, no need to re-plan.
$("#people").addEventListener("input", () => lastResult && render(lastResult));

// Use a typeahead pick's exact coords if the user chose one; else geocode text.
function resolve(input) {
  const str = input.value.trim();
  if (input.dataset.lat) return Promise.resolve({ lat: +input.dataset.lat, lon: +input.dataset.lon, name: str });
  return geocode(str);
}

// Best-effort: find a named pub near a point (for the Extras pub stop).
async function findPub(lat, lon) {
  const q = `[out:json][timeout:8];node(around:900,${lat},${lon})[amenity=pub][name];out 1;`;
  try {
    const r = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: q });
    const j = await r.json();
    return j.elements?.[0]?.tags?.name || null;
  } catch {
    return null;
  }
}

async function plan() {
  const originStr = $("#from").value.trim();
  const destStr = $("#to").value.trim();
  if (!originStr || !destStr) return status("Enter both From and To", false);
  startLoading();
  $("#results").innerHTML = "";
  $("#tabs").classList.add("hidden");
  $("#smallprint").classList.add("hidden");
  document.body.classList.remove("map-open");
  try {
    const [origin, dest, bays, stations] = await Promise.all([
      resolve($("#from")),
      resolve($("#to")),
      baysPromise,
      stationsPromise,
    ]);
    if (!origin) throw new Error(`Couldn't find "${originStr}"`);
    if (!dest) throw new Error(`Couldn't find "${destStr}"`);
    const data = await runPlan(origin, dest, bays, {
      returnTrip: $("#return").checked,
      stations,
    });
    if (!data.options.length) throw new Error("No routes found");
    if ($("#pubStop").checked) {
      const name = await findPub((origin.lat + dest.lat) / 2, (origin.lon + dest.lon) / 2);
      data.pub = name || "a local pub";
    }
    lastResult = data;
    render(data);
    stopLoading();
  } catch (e) {
    stopLoading();
    status(e.message || "Planning failed", false);
    setTimeout(() => status("", false), 4000);
  }
}

function legChip(leg) {
  if (leg.mode === "cycle")
    return `<span class="leg cycle"><span class="ic">🍋‍🟩</span>${Math.round(leg.durationMin)} min bike</span>`;
  if (leg.mode === "walking")
    return `<span class="leg walking"><span class="ic">🚶</span>${Math.round(leg.durationMin)} min walk</span>`;
  if (leg.mode === "car")
    return `<span class="leg car"><span class="ic">🚗</span>${Math.round(leg.durationMin)} min ride</span>`;
  const color = lineColor(leg);
  const emoji =
    leg.mode === "bus" ? "🚌 " : leg.mode === "national-rail" || leg.mode === "train" ? "🚆 " : "";
  const label = `${emoji}${leg.line || (leg.mode === "bus" ? "Bus" : leg.mode)}`;
  return `<span class="leg" style="background:${color};color:${textOn(color)}">${label}</span>`;
}

// A detailed, concise step for the expanded card view.
function stepDetail(leg) {
  let ic, main, sub;
  if (leg.mode === "cycle") {
    ic = "🍋‍🟩";
    main = `E-bike ${Math.round(leg.durationMin)} min`;
    sub = leg.summary || (leg.to ? `to ${leg.to}` : "");
  } else if (leg.mode === "walking") {
    ic = "🚶";
    main = `Walk ${Math.round(leg.durationMin)} min`;
    sub = leg.summary || (leg.to ? `to ${leg.to}` : "");
  } else if (leg.mode === "car") {
    ic = "🚗";
    main = `Car ${Math.round(leg.durationMin)} min`;
    sub = leg.summary || "";
  } else {
    ic = leg.mode === "bus" ? "🚌" : "🚆";
    main = `${leg.line || leg.mode}${leg.durationMin ? ` · ${Math.round(leg.durationMin)} min` : ""}`;
    sub = leg.from && leg.to ? `${leg.from} → ${leg.to}` : leg.summary || "";
  }
  const color = ["cycle", "walking", "car"].includes(leg.mode) ? "" : lineColor(leg);
  const style = color ? ` style="background:${color};color:${textOn(color)}"` : "";
  return `<li class="step">
    <span class="step-ic"${style}>${ic}</span>
    <div class="step-body">
      <div class="step-main">${main}</div>
      ${sub ? `<div class="step-sub">${sub}</div>` : ""}
    </div>
  </li>`;
}

// Rough taxi + walking estimates, synthesised from the straight-line distance.
// Uber/Bolt are real-ish options; the free walk is the gag pinned to the bottom.
function estimates(data) {
  const people = Math.max(1, parseInt($("#people").value, 10) || 1);
  const km = (data.crowMetres / 1000) * 1.3; // crow → road distance
  const driveMin = Math.round(km * 3 + 3); // ~20 km/h London traffic + pickup
  const uberP = Math.round(250 + 150 * km + 25 * driveMin);
  const boltP = Math.round(uberP * 0.88);
  const walkTotal = Math.round((km / 5) * 60); // a brisk 5 km/h

  const car = (label, costPence) => {
    const o = { label, costPence, durationMin: driveMin, synthetic: true,
      legs: [{ mode: "car", durationMin: driveMin }] };
    if (data.roundTrip) {
      o.thereMin = driveMin; o.backMin = driveMin;
      o.durationMin = driveMin * 2; o.costPence = costPence * 2;
    }
    o.priceSub = people > 1 ? `${money(Math.round(o.costPence / people))} each` : "tap Extras to split";
    return o;
  };

  const walk = { label: "Walk 🚶", costPence: 0, durationMin: walkTotal, synthetic: true,
    legs: [{ mode: "walking", durationMin: walkTotal }], note: "Free — bring comfy shoes 🦵",
    priceSub: `${km.toFixed(1)} km` };
  if (data.roundTrip) { walk.thereMin = walkTotal; walk.backMin = walkTotal; walk.durationMin = walkTotal * 2; }

  return { uber: car("Uber", uberP), bolt: car("Bolt", boltP), walk };
}

// "Best" balances time against money — £1 ≈ 3 min, so it won't pick an Uber
// that costs a fortune to shave a few minutes off the train.
const bestScore = (o) => o.durationMin + (o.costPence / 100) * 3;

function render(data) {
  const tabs = $("#tabs");
  tabs.classList.toggle("hidden", !data.options.length);
  data._syn = estimates(data);
  const movers = [...data.options, data._syn.uber, data._syn.bolt];
  const byBest = [...movers].sort((a, b) => bestScore(a) - bestScore(b));
  const byTime = [...movers].sort((a, b) => a.durationMin - b.durationMin);
  const byCost = [...movers].sort((a, b) => a.costPence - b.costPence);
  $("#tabBest").textContent = byBest[0] ? `${byBest[0].durationMin} min` : "";
  $("#tabFastest").textContent = byTime[0] ? `${byTime[0].durationMin} min` : "";
  $("#tabCheapest").textContent = byCost[0] ? money(byCost[0].costPence) : "";
  renderResults();
}

function renderResults() {
  const data = lastResult;
  if (!data) return;
  document.body.classList.remove("map-open"); // map only appears once a card is tapped
  const wrap = $("#results");
  wrap.innerHTML = "";
  const syn = data._syn;
  const sorter =
    sortBy === "cheapest"
      ? (a, b) => a.costPence - b.costPence || a.durationMin - b.durationMin
      : sortBy === "fastest"
      ? (a, b) => a.durationMin - b.durationMin || a.costPence - b.costPence
      : (a, b) => bestScore(a) - bestScore(b);
  const movers = [...data.options, syn.uber, syn.bolt].sort(sorter);
  const opts = [...movers, syn.walk]; // free walk always sits at the bottom

  const badgeLabel = sortBy === "cheapest" ? "Cheapest" : sortBy === "fastest" ? "Fastest" : "Best";
  const badgeClass = sortBy === "cheapest" ? "badge cheap" : "badge";

  opts.forEach((o, i) => {
    const card = document.createElement("div");
    card.className = "card";
    const legs = o.legs.map(legChip).join('<span class="arrow">›</span>');

    // Step-by-step, optionally with a pub stop slipped in before the first ride.
    const legSteps = o.legs.map(stepDetail);
    if (data.pub && !o.synthetic) {
      const idx = o.legs.findIndex((l) => RAIL_MODES.includes(l.mode) || l.mode === "bus");
      const pubStep = `<li class="step"><span class="step-ic">🍺</span><div class="step-body"><div class="step-main">Pint at ${data.pub}</div><div class="step-sub">a cheeky one en route</div></div></li>`;
      legSteps.splice(idx < 0 ? legSteps.length : idx, 0, pubStep);
    }
    const steps = `<ol class="steps">${legSteps.join("")}</ol>`;

    let park = "";
    if (o.pickupBay || o.dropoffBay) {
      const pu = o.pickupBay
        ? `Grab a <b>🍋‍🟩 Lime</b> / <b>🌳 Forest</b> e-bike near ${o.pickupBay.name} (${walkMin(o.pickupBay.metresAway)} min walk)`
        : "";
      const dp = o.dropoffBay
        ? `park near ${o.dropoffBay.name}${o.station ? " by " + o.station : ""} (${walkMin(o.dropoffBay.metresAway)} min walk)`
        : "";
      park = `<div class="park">🅿️ ${[pu, dp].filter(Boolean).join(" → ")}</div>`;
    }
    const note = o.note ? `<div class="note">💷 ${o.note}</div>` : "";
    const timeBlock = data.roundTrip
      ? `<div class="time">${o.thereMin}<small> min there</small></div>
         <div class="backtime">↩ ${o.backMin} min back</div>`
      : `<div class="time">${o.durationMin}<small> min</small></div>`;
    const rail = !o.synthetic && hasRail(o.legs) ? railcardPence(o.costPence) : null;
    const priceSub = o.priceSub || `${o.walkMetres} m walk`;
    const badge = i === 0 ? `<span class="${badgeClass}">${badgeLabel}</span>` : "";

    card.innerHTML = `
      <div class="card-head">
        ${badge}
        <div class="top">
          <div class="timewrap">${timeBlock}</div>
          <div class="price">${money(o.costPence)}<small>${priceSub}</small>${rail ? `<small class="rail">${money(rail)} w/ railcard</small>` : ""}</div>
        </div>
        <div class="label">${o.label}</div>
        <div class="legs">${legs}</div>
      </div>
      <div class="detail">${steps}${park}${note}</div>`;
    card.querySelector(".card-head").onclick = () => select(o, card);
    wrap.appendChild(card);
  });

  $("#smallprint").classList.toggle("hidden", !opts.length);
}

// Tapping a card reveals the map with a route overview; tapping it again hides it.
function select(o, card) {
  const already = card.classList.contains("sel");
  document.querySelectorAll(".card").forEach((c) => c.classList.remove("sel"));
  if (already) {
    document.body.classList.remove("map-open");
    return;
  }
  card.classList.add("sel");
  document.body.classList.add("map-open");
  setTimeout(() => {
    map.invalidateSize(); // map was hidden, so recompute its size first
    drawRoute(lastResult, o);
  }, 60);
}

// Sort tabs (Skyscanner-style): re-rank the same routes by time or cost.
document.querySelectorAll(".tab").forEach((tab) => {
  tab.onclick = () => {
    sortBy = tab.dataset.sort;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    renderResults();
  };
});

// Close the route overview and return to the list.
$("#mapClose").onclick = () => {
  document.body.classList.remove("map-open");
  document.querySelectorAll(".card").forEach((c) => c.classList.remove("sel"));
};

// Location typeahead: debounced suggestions, tap to fill (with exact coords).
function attachAutocomplete(input, box) {
  let timer;
  input.addEventListener("input", () => {
    delete input.dataset.lat; // typing invalidates any previously picked coords
    delete input.dataset.lon;
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) return box.classList.add("hidden");
    timer = setTimeout(async () => {
      const items = await suggest(q);
      if (!items.length || input.value.trim() !== q) return box.classList.add("hidden");
      box._items = items;
      box.innerHTML = items
        .map((s, i) => `<div class="ac-item" data-i="${i}">${s.name}</div>`)
        .join("");
      box.classList.remove("hidden");
    }, 250);
  });
  // mousedown fires before blur, so the pick lands before the box hides.
  box.addEventListener("mousedown", (e) => {
    const el = e.target.closest(".ac-item");
    if (!el) return;
    const s = box._items[+el.dataset.i];
    input.value = s.name;
    input.dataset.lat = s.lat;
    input.dataset.lon = s.lon;
    box.classList.add("hidden");
  });
  input.addEventListener("blur", () => setTimeout(() => box.classList.add("hidden"), 150));
}
attachAutocomplete($("#from"), $("#acFrom"));
attachAutocomplete($("#to"), $("#acTo"));

function dotMarker(lat, lon, color, label) {
  return L.circleMarker([lat, lon], {
    radius: 8,
    color: "#fff",
    weight: 2,
    fillColor: color,
    fillOpacity: 1,
  }).bindTooltip(label);
}
function emojiMarker(lat, lon, emoji, label) {
  return L.marker([lat, lon], {
    icon: L.divIcon({
      className: "emoji-pin",
      html: `<span>${emoji}</span>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    }),
  }).bindTooltip(label);
}

function drawRoute(data, o) {
  layers.clearLayers();
  const O = data.origin,
    D = data.dest;
  const pts = [[O.lat, O.lon]];
  dotMarker(O.lat, O.lon, "#00b894", "Start").addTo(layers);
  if (o.pickupBay) {
    emojiMarker(o.pickupBay.lat, o.pickupBay.lon, "🍋‍🟩", "Grab e-bike").addTo(layers);
    pts.push([o.pickupBay.lat, o.pickupBay.lon]);
  }
  if (o.dropoffBay) {
    emojiMarker(o.dropoffBay.lat, o.dropoffBay.lon, "🌳", "Park e-bike").addTo(layers);
    pts.push([o.dropoffBay.lat, o.dropoffBay.lon]);
  }
  pts.push([D.lat, D.lon]);
  dotMarker(D.lat, D.lon, "#e0533d", "Destination").addTo(layers);
  L.polyline(pts, { color: "#0062e3", weight: 4, dashArray: "6 8", opacity: 0.75 }).addTo(layers);
  map.fitBounds(L.latLngBounds(pts).pad(0.25));
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
