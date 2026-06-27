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

// "Reset map" control — re-fit to the route preview after zooming/panning.
let lastRoutePts = null;
function resetMapView() {
  if (lastRoutePts && lastRoutePts.length) map.fitBounds(L.latLngBounds(lastRoutePts).pad(0.25));
}
const ResetControl = L.Control.extend({
  options: { position: "bottomleft" },
  onAdd() {
    const b = L.DomUtil.create("button", "map-reset");
    b.type = "button";
    b.innerHTML = "⤢ Reset map";
    L.DomEvent.on(b, "click", (e) => {
      L.DomEvent.stop(e);
      resetMapView();
    });
    return b;
  },
});
map.addControl(new ResetControl());

let layers = L.layerGroup().addTo(map);
let lastResult = null;
let sortBy = "fastest"; // "fastest" | "cheapest"

// Railcards (1/3 off) apply to National Rail trains only — not the tube/bus.
const TRAIN_MODES = ["national-rail", "train"];
const hasTrain = (legs) => legs.some((l) => TRAIN_MODES.includes(l.mode));
// Where you'd board (and so stop for a pint just before).
const BOARD_MODES = ["tube", "dlr", "overground", "elizabeth-line", "national-rail", "train", "tram", "bus"];

// Small favicon-style logos via Google's favicon service.
const favicon = (domain) => `https://www.google.com/s2/favicons?sz=64&domain=${domain}`;
const BRAND_LOGOS = { uber: "uber.com", bolt: "bolt.eu" };
const BEER_LOGOS = {
  guinness: "guinness.com", camden: "camdentownbrewery.com",
  "neck oil": "beavertownbrewery.co.uk", beavertown: "beavertownbrewery.co.uk",
  estrella: "estrelladamm.com", "london pride": "fullers.co.uk", "fuller": "fullers.co.uk",
  peroni: "peroni.co.uk", stella: "stellaartois.com", heineken: "heineken.com",
  madri: "madriexcepcional.com", asahi: "asahibeer.co.uk", "birra moretti": "birramoretti.com",
};
function beerLogo(name) {
  const n = name.toLowerCase();
  for (const k in BEER_LOGOS) if (n.includes(k)) return favicon(BEER_LOGOS[k]);
  return null;
}

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
  "Checking 🍋‍🟩 Lime e-bikes…",
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
      $("#from").value = "Current Location";
      $("#from").dataset.lat = latitude;
      $("#from").dataset.lon = longitude;
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
// Party size (+/- stepper) only affects the fare split — re-render, no re-plan.
let peopleCount = 1;
function setPeople(n) {
  peopleCount = Math.max(1, n);
  $("#peopleVal").textContent = peopleCount;
  if (lastResult) render(lastResult);
}
$("#peopleMinus").onclick = () => setPeople(peopleCount - 1);
$("#peoplePlus").onclick = () => setPeople(peopleCount + 1);

// Use a typeahead pick's exact coords if the user chose one; else geocode text.
function resolve(input) {
  const str = input.value.trim();
  if (input.dataset.lat) return Promise.resolve({ lat: +input.dataset.lat, lon: +input.dataset.lon, name: str });
  return geocode(str);
}

// Exact tap lists aren't available in open data, so this is an indicative fallback.
const DEFAULT_BEERS = ["Guinness", "Camden Hells", "Beavertown Neck Oil", "Estrella Damm", "Guest cask ale"];

// Beers we can actually infer from the pub's OpenStreetMap tags.
function beersFromTags(t = {}) {
  const out = [];
  if (t.brewery && t.brewery !== "yes") out.push(...t.brewery.split(";").map((s) => s.trim()));
  if (t.real_ale === "yes" || t.real_ale === "only" || t.cask === "yes") out.push("Cask ales");
  if (t["drink:beer"] && t["drink:beer"] !== "yes") out.push(t["drink:beer"]);
  if (t.microbrewery === "yes") out.push("House microbrew");
  if (t.craft_beer === "yes") out.push("Craft beer");
  return [...new Set(out.filter(Boolean))];
}

// Nearest real (named) pub to a point, with beers inferred from OSM where possible.
async function findPub(lat, lon) {
  const q = `[out:json][timeout:10];node(around:650,${lat},${lon})[amenity=pub][name];out 15;`;
  try {
    const r = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: q });
    const j = await r.json();
    const pubs = (j.elements || []).filter((e) => e.tags?.name);
    if (!pubs.length) return null;
    const d2 = (e) => (e.lat - lat) ** 2 + (e.lon - lon) ** 2;
    const best = pubs.sort((a, b) => d2(a) - d2(b))[0];
    return { name: best.tags.name, lat: best.lat, lon: best.lon, beers: beersFromTags(best.tags) };
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
  closeDetail();
  document.body.classList.remove("has-results");
  $("#acFrom").classList.add("hidden");
  $("#acTo").classList.add("hidden");
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
    lastResult = data;
    render(data);
    stopLoading();
  } catch (e) {
    stopLoading();
    status(e.message || "Planning failed", false);
    setTimeout(() => status("", false), 4000);
  }
}

// Drop the redundant "Station" wording and tidy ALL-CAPS (LONDON → London).
function cleanName(s) {
  if (!s) return s || "";
  s = s
    .replace(/\b(Rail|Underground|DLR|Overground|Tram)\s+Station\b/gi, "")
    .replace(/\bStation\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,)])/g, "$1")
    .trim()
    .replace(/[,\s]+$/, "");
  return s.replace(/\b[A-Z]{2,}\b/g, (w) => w[0] + w.slice(1).toLowerCase());
}
// Google Maps directions deep link for a single leg, in the matching mode.
const mapsMode = (m) => (m === "cycle" ? "bicycling" : m === "car" ? "driving" : m === "walking" ? "walking" : "transit");
// Prefer a real place name over coordinates; never pass the literal "Current Location".
function pointQuery(pt, name) {
  const nm = (pt && pt.name) || name;
  if (nm && !/current location/i.test(nm)) return encodeURIComponent(cleanName(nm));
  if (pt && pt.lat != null) return `${pt.lat},${pt.lon}`;
  return null;
}
function mapsLink(leg) {
  const dest = pointQuery(leg.toLL, leg.to);
  if (!dest) return null;
  const origin = pointQuery(leg.fromLL, leg.from);
  let u = `https://www.google.com/maps/dir/?api=1&travelmode=${mapsMode(leg.mode)}&destination=${dest}`;
  if (origin) u += `&origin=${origin}`;
  return u;
}

// Platform / direction you'd board at, tidied (no "Station" wording).
function cleanPlatform(s) {
  if (!s) return "";
  s = s.replace(/\bStation\b/gi, "").replace(/\s{2,}/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function legChip(leg) {
  const n = Math.round(leg.durationMin);
  if (leg.mode === "cycle")
    return `<span class="leg cycle"><span class="ic">🍋‍🟩</span>${n} Minute Bike</span>`;
  if (leg.mode === "walking")
    return `<span class="leg walking"><span class="ic">🚶</span>${n} Minute Walk</span>`;
  if (leg.mode === "car") {
    const badge = leg.brand
      ? `<img class="pill-logo" src="${favicon(BRAND_LOGOS[leg.brand])}" alt="${leg.brand}">`
      : '<span class="ic">🚗</span>';
    return `<span class="leg car">${badge}${n} Minute Ride</span>`;
  }
  const color = lineColor(leg);
  const emoji =
    leg.mode === "bus" ? "🚌 " : leg.mode === "national-rail" || leg.mode === "train" ? "🚆 " : "";
  const label = `${emoji}${leg.line || (leg.mode === "bus" ? "Bus" : leg.mode)}`;
  return `<span class="leg" style="background:${color};color:${textOn(color)}">${label}</span>`;
}

// A detailed, concise step for the single-route page.
function stepDetail(leg) {
  const n = Math.round(leg.durationMin);
  let ic, main, sub, extra = "";
  if (leg.mode === "cycle") {
    ic = "🍋‍🟩";
    main = `${n} Minute Bike`;
    sub = cleanName(leg.summary || (leg.to ? `to ${leg.to}` : ""));
  } else if (leg.mode === "walking") {
    ic = "🚶";
    main = `${n} Minute Walk`;
    sub = cleanName(leg.summary || (leg.to ? `to ${leg.to}` : ""));
  } else if (leg.mode === "car") {
    ic = "🚗";
    main = `${n} Minute Ride`;
    sub = leg.summary || "";
  } else {
    ic = leg.mode === "bus" ? "🚌" : "🚆";
    main = `${leg.line || leg.mode}${leg.durationMin ? ` · ${n} min` : ""}`;
    sub = leg.from && leg.to ? `${cleanName(leg.from)} → ${cleanName(leg.to)}` : cleanName(leg.summary || "");
    extra = cleanPlatform(leg.platform || leg.direction);
  }
  const color = ["cycle", "walking", "car"].includes(leg.mode) ? "" : lineColor(leg);
  const style = color ? ` style="background:${color};color:${textOn(color)}"` : "";
  const link = mapsLink(leg);
  return `<li class="step">
    <span class="step-ic"${style}>${ic}</span>
    <div class="step-body">
      <div class="step-main">${main}</div>
      ${sub ? `<div class="step-sub">${sub}</div>` : ""}
      ${extra ? `<div class="step-plat">${extra}</div>` : ""}
    </div>
    ${link ? `<a class="step-map" href="${link}" target="_blank" rel="noopener" aria-label="Open in Google Maps">↗</a>` : ""}
  </li>`;
}

// Rough taxi + walking estimates, synthesised from the straight-line distance.
// Uber/Bolt are real-ish options; the free walk is the gag pinned to the bottom.
function estimates(data) {
  const people = peopleCount;
  const km = (data.crowMetres / 1000) * 1.3; // crow → road distance
  const driveMin = Math.round(km * 3 + 3); // ~20 km/h London traffic + pickup
  const uberP = Math.round(250 + 150 * km + 25 * driveMin);
  const boltP = Math.round(uberP * 0.88);
  const walkTotal = Math.round((km / 5) * 60); // a brisk 5 km/h

  const car = (label, brand, costPence) => {
    const o = { label, brand, costPence, durationMin: driveMin, synthetic: true,
      legs: [{ mode: "car", durationMin: driveMin, brand, fromLL: data.origin, toLL: data.dest }] };
    if (data.roundTrip) {
      o.thereMin = driveMin; o.backMin = driveMin;
      o.durationMin = driveMin * 2; o.costPence = costPence * 2;
    }
    o.priceSub = people > 1 ? `${money(Math.round(o.costPence / people))} each` : "Tap Extras to Split";
    return o;
  };

  const walk = { label: "Walk 🚶", costPence: 0, durationMin: walkTotal, synthetic: true,
    legs: [{ mode: "walking", durationMin: walkTotal, fromLL: data.origin, toLL: data.dest }],
    note: "Free — bring comfy shoes 🦵", priceSub: `${km.toFixed(1)} km` };
  if (data.roundTrip) { walk.thereMin = walkTotal; walk.backMin = walkTotal; walk.durationMin = walkTotal * 2; }

  return { uber: car("Uber", "uber", uberP), bolt: car("Bolt", "bolt", boltP), walk };
}

function render(data) {
  const tabs = $("#tabs");
  tabs.classList.toggle("hidden", !data.options.length);
  document.body.classList.toggle("has-results", data.options.length > 0);
  data._syn = estimates(data);
  const movers = [...data.options, data._syn.uber, data._syn.bolt];
  const byTime = [...movers].sort((a, b) => a.durationMin - b.durationMin);
  const byCost = [...movers].sort((a, b) => a.costPence - b.costPence);
  $("#tabFastest").textContent = byTime[0] ? `${byTime[0].durationMin} min` : "";
  $("#tabCheapest").textContent = byCost[0] ? money(byCost[0].costPence) : "";
  renderResults();
}

// Time/price block reused by the list cards and the single-route page.
function summaryHTML(o, data) {
  const timeBlock = data.roundTrip
    ? `<div class="time">${o.thereMin}<small> min there</small></div>
       <div class="backtime">↩ ${o.backMin} min back</div>`
    : `<div class="time">${o.durationMin}<small> min</small></div>`;
  const rail = !o.synthetic && hasTrain(o.legs) ? railcardPence(o.costPence) : null;
  const priceSub = o.priceSub || `${o.walkMetres} m walk`;
  // Pub icon (no name) appears in the summary; the name shows on the route page.
  const legChips = o.legs.map(legChip);
  if ($("#pubStop").checked && !o.synthetic) {
    let idx = o.legs.findIndex((l) => BOARD_MODES.includes(l.mode));
    legChips.splice(idx < 0 ? legChips.length : idx, 0, '<span class="leg pub"><span class="ic">🍺</span></span>');
  }
  const legs = legChips.join('<span class="arrow">›</span>');
  return `
    <div class="top">
      <div class="timewrap">${timeBlock}</div>
      <div class="price">${money(o.costPence)}<small>${priceSub}</small>${rail ? `<small class="rail">${money(rail)} w/ railcard</small>` : ""}</div>
    </div>
    <div class="legs">${legs}</div>`;
}

function renderResults() {
  const data = lastResult;
  if (!data) return;
  const wrap = $("#results");
  wrap.innerHTML = "";
  const syn = data._syn;
  const sorter =
    sortBy === "cheapest"
      ? (a, b) => a.costPence - b.costPence || a.durationMin - b.durationMin
      : (a, b) => a.durationMin - b.durationMin || a.costPence - b.costPence;
  const movers = [...data.options, syn.uber, syn.bolt].sort(sorter);
  const opts = [...movers, syn.walk]; // free walk always sits at the bottom

  const badgeLabel = sortBy === "cheapest" ? "Cheapest" : "Fastest";
  const badgeClass = sortBy === "cheapest" ? "badge cheap" : "badge";

  opts.forEach((o, i) => {
    const card = document.createElement("div");
    card.className = "card";
    const badge = i === 0 ? `<span class="${badgeClass}">${badgeLabel}</span>` : "";
    card.innerHTML = `<div class="card-head">${badge}${summaryHTML(o, data)}</div>`;
    card.querySelector(".card-head").onclick = o.brand
      ? () => window.open(rideLink(o.brand), "_blank", "noopener")
      : () => openDetail(o);
    wrap.appendChild(card);
  });

  // Small print scrolls at the very bottom of the list (not pinned on screen).
  const sp = document.createElement("p");
  sp.className = "smallprint";
  sp.textContent = "Estimated prices and times. Check each operator for exact fares before you travel.";
  wrap.appendChild(sp);
}

// Deep links that open the ride app with the journey pre-filled.
function rideLink(brand) {
  const O = lastResult.origin, D = lastResult.dest;
  if (brand === "uber") {
    return `https://m.uber.com/ul/?action=setPickup&pickup[latitude]=${O.lat}&pickup[longitude]=${O.lon}` +
      `&pickup[nickname]=${encodeURIComponent(O.name || "Start")}` +
      `&dropoff[latitude]=${D.lat}&dropoff[longitude]=${D.lon}` +
      `&dropoff[nickname]=${encodeURIComponent(D.name || "Destination")}`;
  }
  // Bolt has no public coordinate deep-link; pass coords best-effort, open app.
  return `https://bolt.eu/?pickup_lat=${O.lat}&pickup_lng=${O.lon}&destination_lat=${D.lat}&destination_lng=${D.lon}`;
}

// A start/end point row, linking to that place on Google Maps.
function endpointStep(kind, pt) {
  const ic = kind === "start" ? "🟢" : "🏁";
  const label = kind === "start" ? "Start" : "End";
  const q = pointQuery(pt);
  const link = q ? `https://www.google.com/maps/search/?api=1&query=${q}` : null;
  return `<li class="step">
    <span class="step-ic">${ic}</span>
    <div class="step-body"><div class="step-main">${label}</div><div class="step-sub">${cleanName(pt.name || "")}</div></div>
    ${link ? `<a class="step-map" href="${link}" target="_blank" rel="noopener" aria-label="Open in Google Maps">↗</a>` : ""}
  </li>`;
}

// Open the single-route page: own screen, map at top (scrolls), steps below.
function openDetail(o) {
  const data = lastResult;
  const pubOn = $("#pubStop").checked && !o.synthetic;

  // Anchor the journey to the entered start/end (so links use those, by name).
  const legs = o.legs.map((l) => ({ ...l }));
  if (legs.length) {
    legs[0] = { ...legs[0], from: data.origin.name, fromLL: data.origin };
    legs[legs.length - 1] = { ...legs[legs.length - 1], to: data.dest.name, toLL: data.dest };
  }

  const legSteps = legs.map(stepDetail);
  if (pubOn) {
    let idx = legs.findIndex((l) => BOARD_MODES.includes(l.mode));
    if (idx < 0) idx = legSteps.length;
    legSteps.splice(idx, 0, '<li class="step pub-step"><span class="step-ic">🍺</span><div class="step-body"><div class="pub-name">Finding a good pub…</div></div></li>');
  }

  $("#detailContent").innerHTML = `
    <div class="d-head">${summaryHTML(o, data)}</div>
    <ol class="steps">${endpointStep("start", data.origin)}${legSteps.join("")}${endpointStep("end", data.dest)}</ol>`;
  $("#detail").classList.remove("hidden");
  document.body.classList.add("detail-open");
  $("#detail").scrollTop = 0;
  setTimeout(() => {
    map.invalidateSize(); // map lives in the hidden page until now
    drawRoute(data, o);
  }, 60);
  if (pubOn) loadPub(o);
}

function closeDetail() {
  $("#detail").classList.add("hidden");
  document.body.classList.remove("detail-open");
}

// Look up a real pub near where this route boards, then drop it into its step.
async function loadPub(o) {
  const step = $("#detailContent .pub-step");
  if (!step) return;
  const O = lastResult.origin, D = lastResult.dest;
  const pt = o.dropoffBay || { lat: (O.lat + D.lat) / 2, lon: (O.lon + D.lon) / 2 };
  if (!o._pub) o._pub = (await findPub(pt.lat, pt.lon)) || { name: null };
  const body = step.querySelector(".step-body");
  const pub = o._pub;
  if (!pub.name) return (body.innerHTML = '<div class="pub-name">No Pub on Route</div>');
  // Only show beers we have a real logo for, so it looks official.
  const beers = (pub.beers && pub.beers.length ? pub.beers : DEFAULT_BEERS)
    .map((b) => ({ b, logo: beerLogo(b) }))
    .filter((x) => x.logo)
    .slice(0, 5)
    .map((x) => `<li><img class="beer-logo" src="${x.logo}" alt=""> ${x.b}</li>`)
    .join("");
  const gmaps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(pub.name)}%20${pub.lat}%2C${pub.lon}`;
  body.innerHTML = `
    <a class="pub-name" href="${gmaps}" target="_blank" rel="noopener">${pub.name} ↗</a>
    ${beers ? `<ul class="pub-beers">${beers}</ul>` : ""}`;
}

// Sort tabs (Skyscanner-style): re-rank the same routes by time or cost.
document.querySelectorAll(".tab").forEach((tab) => {
  tab.onclick = () => {
    sortBy = tab.dataset.sort;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    renderResults();
  };
});

$("#backBtn").onclick = closeDetail;

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

// Clear (✕) button inside each field.
document.querySelectorAll(".clear").forEach((btn) => {
  btn.onclick = () => {
    const input = $("#" + btn.dataset.for);
    input.value = "";
    delete input.dataset.lat;
    delete input.dataset.lon;
    input.focus();
  };
});

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
  if ((O.name || "").toLowerCase().includes("current location"))
    emojiMarker(O.lat, O.lon, "📍", "You are here").addTo(layers);
  else dotMarker(O.lat, O.lon, "#00b894", "Start").addTo(layers);
  if (o.pickupBay) {
    emojiMarker(o.pickupBay.lat, o.pickupBay.lon, "🍋‍🟩", "Grab e-bike").addTo(layers);
    pts.push([o.pickupBay.lat, o.pickupBay.lon]);
  }
  if (o.dropoffBay) {
    emojiMarker(o.dropoffBay.lat, o.dropoffBay.lon, "🅿️", "Drop off the bike").addTo(layers);
    pts.push([o.dropoffBay.lat, o.dropoffBay.lon]);
  }
  pts.push([D.lat, D.lon]);
  dotMarker(D.lat, D.lon, "#e0533d", "Destination").addTo(layers);
  L.polyline(pts, { color: "#0062e3", weight: 4, dashArray: "6 8", opacity: 0.75 }).addTo(layers);
  lastRoutePts = pts;
  map.fitBounds(L.latLngBounds(pts).pad(0.25));
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
