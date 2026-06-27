// Client-side app: the routing engine runs entirely in the browser, calling
// TfL and Nominatim directly (both allow CORS). No backend required.
import { plan as runPlan } from "./lib/engine.js";
import { geocode, suggest } from "./lib/geocode.js";
import { railcardPence, bikePricing } from "./lib/fares.js";

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

// "Reset map" control (bottom-right) — re-fit to the route preview, then hide
// itself until the next route is drawn.
let lastRoutePts = null;
let resetBtn = null;
function resetMapView() {
  if (lastRoutePts && lastRoutePts.length) map.fitBounds(L.latLngBounds(lastRoutePts).pad(0.25));
}
const ResetControl = L.Control.extend({
  options: { position: "bottomright" },
  onAdd() {
    const b = L.DomUtil.create("button", "map-reset");
    b.type = "button";
    b.innerHTML = "⤢ Reset map";
    L.DomEvent.on(b, "click", (e) => {
      L.DomEvent.stop(e);
      resetMapView();
      b.style.display = "none";
    });
    resetBtn = b;
    return b;
  },
});
map.addControl(new ResetControl());

let layers = L.layerGroup().addTo(map);
let lastResult = null;
let sortBy = "fastest"; // "fastest" | "cheapest"

// "Train" = anything you'd buy a National Rail ticket for on Trainline and that a
// railcard discounts: National Rail, Overground, Elizabeth line, Thameslink.
// (Tube/DLR/tram are Oyster-only, so they stay separate.)
const TRAIN_MODES = ["national-rail", "train", "overground", "elizabeth-line", "thameslink"];
const hasTrain = (legs) => legs.some((l) => TRAIN_MODES.includes(l.mode));
// Where you'd board (and so stop for a pint just before).
const BOARD_MODES = ["tube", "dlr", "overground", "elizabeth-line", "national-rail", "train", "tram", "bus"];
const RAIL_MODES = ["tube", "dlr", "overground", "elizabeth-line", "national-rail", "train", "tram"];

// Small favicon-style logos via Google's favicon service.
const favicon = (domain) => `https://www.google.com/s2/favicons?sz=64&domain=${domain}`;
const BRAND_LOGOS = { uber: "uber.com", bolt: "bolt.eu" };

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
  $("#loadingMsg").textContent = LOADING_LINES[0];
  $("#loading").classList.remove("hidden");
  loadTimer = setInterval(() => {
    i = (i + 1) % LOADING_LINES.length;
    $("#loadingMsg").textContent = LOADING_LINES[i];
  }, 1600);
}
function stopLoading() {
  if (loadTimer) clearInterval(loadTimer), (loadTimer = null);
  $("#loading").classList.add("hidden");
}

const pounds = (p) => "£" + (p / 100).toFixed(2);
const money = (p) => (p <= 0 ? "Free" : pounds(p));
const walkMin = (m) => Math.max(1, Math.round(m / 80)); // ~80 m/min walking
// Minutes → "Xh Ym" once it's an hour or more.
function fmtMin(min) {
  min = Math.round(min);
  if (min < 60) return `${min} Min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

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

// Custom controls only change state — nothing re-runs until you tap Update.
let peopleCount = 1;
$("#peopleSeg")
  .querySelectorAll("button")
  .forEach((b) => {
    b.onclick = () => {
      peopleCount = +b.dataset.n;
      $("#peopleSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    };
  });

let whenMode = "now"; // "now" | "depart" | "arrive"
$("#whenSeg")
  .querySelectorAll("button")
  .forEach((b) => {
    b.onclick = () => {
      whenMode = b.dataset.when;
      $("#whenSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      $("#whenTime").classList.toggle("hidden", whenMode === "now");
      if (whenMode !== "now" && !$("#whenTime").value) {
        const d = new Date(Date.now() + 5 * 60000); // default ~now
        $("#whenTime").value = new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      }
    };
  });

// Pub-on-route stop: a simple on/off checkbox.
let pubStop = false;
$("#pubChk").onchange = (e) => { pubStop = e.target.checked; };

const avoidedModes = () =>
  new Set([...$("#avoid").querySelectorAll("input:checked")].map((i) => i.dataset.mode));

// Build engine options from the Custom controls.
function extrasOpts() {
  const avoid = avoidedModes();
  const TRANSIT = ["tube", "dlr", "overground", "elizabeth-line", "national-rail", "tram", "bus", "walking"];
  const trainGroup = ["national-rail", "overground", "elizabeth-line", "dlr", "tram"];
  const transitModes = TRANSIT.filter((m) => {
    if (m === "tube" && avoid.has("tube")) return false;
    if (m === "bus" && avoid.has("bus")) return false;
    if (avoid.has("train") && trainGroup.includes(m)) return false;
    return true;
  });
  const o = { transitModes, allowBike: !avoid.has("bike"), allowCab: !avoid.has("cab") };
  if (whenMode !== "now" && $("#whenTime").value) {
    const [d, t] = $("#whenTime").value.split("T");
    o.date = d.replaceAll("-", "");
    o.time = t.replace(":", "");
    o.timeIs = whenMode === "arrive" ? "Arriving" : "Departing";
  }
  return o;
}

// Use a typeahead pick's exact coords if the user chose one; else geocode text.
function resolve(input) {
  const str = input.value.trim();
  if (input.dataset.lat) return Promise.resolve({ lat: +input.dataset.lat, lon: +input.dataset.lon, name: str });
  return geocode(str);
}

// Nearest real (named) pub to a point, with its address for a precise Maps link.
// Nearest pub within a 15-min walk (~1200 m) of the boarding station.
async function findPub(lat, lon) {
  const q = `[out:json][timeout:10];node(around:1200,${lat},${lon})[amenity=pub][name];out 30;`;
  const ctrl = new AbortController();
  const t0 = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: q, signal: ctrl.signal });
    const j = await r.json();
    const pubs = (j.elements || []).filter((e) => e.tags?.name);
    if (!pubs.length) return null;
    const metres = (e) => {
      const dy = (e.lat - lat) * 111000;
      const dx = (e.lon - lon) * 111000 * Math.cos((lat * Math.PI) / 180);
      return Math.hypot(dx, dy);
    };
    const best = pubs.map((e) => ({ e, d: metres(e) })).sort((a, b) => a.d - b.d)[0];
    const e = best.e, t = e.tags;
    const addr = [t["addr:housenumber"], t["addr:street"], t["addr:postcode"]].filter(Boolean).join(" ");
    return { name: t.name, lat: e.lat, lon: e.lon, addr, metres: Math.round(best.d) };
  } catch {
    return null;
  } finally {
    clearTimeout(t0);
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
  // Safety net: never let the full-screen splash hang if a request stalls.
  const watchdog = setTimeout(() => {
    stopLoading();
    status("That took too long — check your connection and try again", false);
    setTimeout(() => status("", false), 5000);
  }, 20000);
  try {
    const [origin, dest, bays, stations] = await Promise.all([
      resolve($("#from")),
      resolve($("#to")),
      baysPromise,
      stationsPromise,
    ]);
    if (!origin) throw new Error(`Couldn't find "${originStr}"`);
    if (!dest) throw new Error(`Couldn't find "${destStr}"`);
    const data = await runPlan(origin, dest, bays, { stations, ...extrasOpts() });
    data._noCab = avoidedModes().has("cab");
    // Cab and walk options are always synthesised, so there's always a route to
    // show even if the transit engine returned nothing (e.g. everything avoided).
    lastResult = data;
    render(data);
  } catch (e) {
    status(e.message || "Planning failed", false);
    setTimeout(() => status("", false), 4000);
  } finally {
    clearTimeout(watchdog);
    stopLoading();
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

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Compass direction a rail leg travels, from the leg's start/end coords
// ("Eastbound", "Westbound", "Northbound", "Southbound") — like the platforms.
function compassBound(leg) {
  const a = leg.fromLL, b = leg.toLL;
  if (!a || !b || a.lat == null || b.lat == null) return "";
  const dLat = b.lat - a.lat;
  const dLon = (b.lon - a.lon) * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  if (Math.abs(dLat) >= Math.abs(dLon)) return dLat >= 0 ? "Northbound" : "Southbound";
  return dLon >= 0 ? "Eastbound" : "Westbound";
}
function legChip(leg) {
  const n = Math.round(leg.durationMin);
  if (leg.mode === "cycle")
    return `<span class="leg cycle"><span class="ic">🍋‍🟩</span>${fmtMin(n)} Bike</span>`;
  if (leg.mode === "walking")
    return `<span class="leg walking"><span class="ic">🚶</span>${leg.km ? `${leg.km} km Walk` : `${fmtMin(n)} Walk`}</span>`;
  if (leg.mode === "car") {
    if (leg.brand) {
      const logo = `<img class="pill-logo" src="${favicon(BRAND_LOGOS[leg.brand])}" alt="" onerror="this.replaceWith(document.createTextNode('🚗'))">`;
      return `<span class="leg car appbtn">${logo}${cap(leg.brand)} <span class="pill-arrow">↗</span></span>`;
    }
    return `<span class="leg car"><span class="ic">🚗</span>${fmtMin(n)} Ride</span>`;
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
    main = `${fmtMin(n)} Bike`;
    sub = cleanName(leg.summary || (leg.to ? `to ${leg.to}` : ""));
  } else if (leg.mode === "walking") {
    ic = "🚶";
    main = leg.toDest ? `Walk to ${cleanName(leg.to).split(",")[0]}` : `${fmtMin(n)} Walk`;
    sub = leg.toDest ? "" : leg.to ? `To ${cleanName(leg.to).split(",")[0]}` : cleanName(leg.summary || "").split(",")[0];
    sub = sub.split(" ").slice(0, 5).join(" ");
  } else if (leg.mode === "car") {
    ic = "🚗";
    main = leg.brand ? `${cap(leg.brand)} ride · ${fmtMin(n)}` : `${fmtMin(n)} Ride`;
    sub = leg.summary || "";
  } else {
    ic = leg.mode === "bus" ? "🚌" : "🚆";
    main = `${leg.line || leg.mode}${leg.durationMin ? ` · ${fmtMin(n)}` : ""}`;
    sub = leg.from && leg.to ? `${cleanName(leg.from)} → ${cleanName(leg.to)}` : cleanName(leg.summary || "");
    // Rail legs: show the compass bound (Eastbound…) plus where it's heading.
    const towards = leg.terminus ? `Towards ${cleanName(leg.terminus)}` : cleanPlatform(leg.platform || leg.direction);
    const bound = RAIL_MODES.includes(leg.mode) ? compassBound(leg) : "";
    extra = [bound, towards].filter(Boolean).join(" · ");
  }
  const color = ["cycle", "walking", "car"].includes(leg.mode) ? "" : lineColor(leg);
  const style = color ? ` style="background:${color};color:${textOn(color)}"` : "";
  // Trains → Trainline (buy a ticket); bike legs → open the Lime app; everything
  // else → Google Maps directions for that leg.
  const isTrain = TRAIN_MODES.includes(leg.mode);
  const isBike = leg.mode === "cycle";
  const link = isTrain ? trainlineLink(leg) : isBike ? LIME_LINK : mapsLink(leg);
  const linkIc = isTrain
    ? `<img class="step-ic-img" src="${favicon("thetrainline.com")}" alt="" onerror="this.replaceWith(document.createTextNode('🎫'))">`
    : isBike
    ? `<img class="step-ic-img" src="${favicon("li.me")}" alt="" onerror="this.replaceWith(document.createTextNode('🍋‍🟩'))">`
    : `<img class="step-ic-img" src="${favicon("google.com/maps")}" alt="" onerror="this.replaceWith(document.createTextNode('🗺️'))">`;
  return `<li class="step">
    <span class="step-ic"${style}>${ic}</span>
    <div class="step-body">
      <div class="step-main">${main}</div>
      ${sub ? `<div class="step-sub">${sub}</div>` : ""}
      ${extra ? `<div class="step-plat">${extra}</div>` : ""}
    </div>
    ${link ? `<a class="step-map" href="${link}" target="_blank" rel="noopener" aria-label="Open">${linkIc}</a>` : ""}
  </li>`;
}

// Rough taxi + walking estimates, synthesised from the straight-line distance.
// Uber/Bolt are real-ish options; the free walk is the gag pinned to the bottom.
function estimates(data) {
  const km = (data.crowMetres / 1000) * 1.3; // crow → road distance
  const driveMin = Math.round(km * 3 + 3); // ~20 km/h London traffic + pickup
  const uberP = Math.round(250 + 150 * km + 25 * driveMin);
  const boltP = Math.round(uberP * 0.88);
  const walkTotal = Math.round((km / 5) * 60); // a brisk 5 km/h

  const car = (label, brand, costPence) => ({
    label, brand, costPence, durationMin: driveMin, synthetic: true,
    legs: [{ mode: "car", durationMin: driveMin, brand, fromLL: data.origin, toLL: data.dest }],
  });

  const walk = {
    label: "Walk 🚶", costPence: 0, durationMin: walkTotal, synthetic: true,
    legs: [{ mode: "walking", durationMin: walkTotal, km: Math.round(km), fromLL: data.origin, toLL: data.dest }],
    note: "Free — bring comfy shoes 🦵",
  };

  return { uber: car("Uber", "uber", uberP), bolt: car("Bolt", "bolt", boltP), walk };
}

function render(data) {
  const tabs = $("#tabs");
  tabs.classList.toggle("hidden", !data.options.length);
  document.body.classList.toggle("has-results", data.options.length > 0);
  $("#go").textContent = data.options.length ? "Update" : "Find Best and Cheapest Routes";
  data._syn = estimates(data);
  const cabs = data._noCab ? [] : [data._syn.uber, data._syn.bolt];
  const movers = [...data.options, ...cabs];
  const byTime = [...movers].sort((a, b) => a.durationMin - b.durationMin);
  const byCost = [...movers].sort((a, b) => a.costPence - b.costPence);
  $("#tabFastest").textContent = byTime[0] ? `${byTime[0].durationMin} min` : "";
  $("#tabCheapest").textContent = byCost[0] ? money(byCost[0].costPence) : "";
  // After an Update, drop the Custom view and show the freshly ranked results.
  if (sortBy === "custom") sortBy = "fastest";
  setTab(sortBy);
}

// Switch between the Fastest/Cheapest result lists and the Custom controls.
function setTab(sort) {
  sortBy = sort;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.sort === sort));
  const custom = sort === "custom";
  $("#custom").classList.toggle("hidden", !custom);
  $("#results").classList.toggle("hidden", custom);
  if (!custom) {
    renderResults();
    $("#results").scrollTop = 0;
  }
}

function readDiscounts() {
  const on = new Set([...document.querySelectorAll("#discounts input:checked")].map((i) => i.closest("label").dataset.disc));
  return { railcard: on.has("railcard") };
}

// Split a route's cost into its parts so a railcard only discounts the *train*
// fare (not the bike hire, tube or bus). Returns pence amounts.
function fareParts(o) {
  const isCab = !!o.brand || o.legs.some((l) => l.mode === "car");
  const bike = o.legs.find((l) => l.mode === "cycle");
  const bikePart = bike ? bikePricing(Math.round(bike.durationMin)).pence : 0;
  const transit = isCab ? 0 : Math.max(0, o.costPence - bikePart);
  const busPart = o.legs.some((l) => l.mode === "bus") ? Math.min(175, transit) : 0;
  const railPart = Math.max(0, transit - busPart); // tube/train portion
  return { isCab, bikePart, transit, busPart, railPart };
}

// What a route actually costs to show, after discounts. Returns {pence, prefix, railHint}.
function priceOf(o) {
  const d = readDiscounts();
  const parts = fareParts(o);
  const trainy = hasTrain(o.legs);
  let pence = o.costPence;
  let railHint = "";
  if (trainy && !o.synthetic) {
    // Railcard takes ~1/3 off the train fare only — leave bike/tube/bus alone.
    const saving = parts.railPart - railcardPence(parts.railPart);
    if (d.railcard) { pence -= saving; railHint = `<small class="rail">railcard ✓</small>`; }
    else railHint = `<small class="rail">${money(o.costPence - saving)} w/ railcard</small>`;
  }
  return { pence, prefix: parts.isCab ? "&lt;" : "", railHint }; // "<" = estimated, up-to fare
}

// Time/price block reused by the list cards and the single-route page.
function summaryHTML(o) {
  const timeBlock = `<div class="time">${fmtMin(o.durationMin)}</div>`;
  const { pence, prefix, railHint } = priceOf(o);
  // Show "pp" (per person) whenever there's more than one traveller. Cabs split
  // the fare — per-person big, total underneath; transit fares are already pp.
  const pp = peopleCount > 1 && pence > 0;
  const ppTag = pp ? ` <small class="pp">pp</small>` : "";
  let priceMain, priceSub = "";
  if (o.brand && pp) {
    priceMain = prefix + money(Math.round(pence / peopleCount)) + ppTag;
    priceSub = `${prefix}${money(pence)} total`;
  } else {
    priceMain = prefix + money(pence) + ppTag;
  }
  // Pub icon (no name) appears in the summary; the name shows on the route page.
  const legChips = o.legs.map(legChip);
  if (pubStop && !o.synthetic) {
    let idx = o.legs.findIndex((l) => BOARD_MODES.includes(l.mode));
    legChips.splice(idx < 0 ? legChips.length : idx, 0, '<span class="leg pub"><span class="ic">🍺</span></span>');
  }
  const legs = legChips.join('<span class="arrow">›</span>');
  return `
    <div class="top">
      <div class="timewrap">${timeBlock}</div>
      <div class="price">${priceMain}${priceSub ? `<small>${priceSub}</small>` : ""}${railHint}</div>
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
  const cabs = data._noCab ? [] : [syn.uber, syn.bolt];
  const movers = [...data.options, ...cabs].sort(sorter);
  const opts = [...movers, syn.walk]; // free walk always sits at the bottom

  const badgeLabel = sortBy === "cheapest" ? "Cheapest" : "Fastest";
  const badgeClass = sortBy === "cheapest" ? "badge cheap" : "badge";

  opts.forEach((o, i) => {
    const card = document.createElement("div");
    card.className = "card";
    const badge = i === 0 ? `<span class="${badgeClass}">${badgeLabel}</span>` : "";
    card.innerHTML = `<div class="card-head">${badge}${summaryHTML(o)}</div>`;
    const head = card.querySelector(".card-head");
    // Cab cards open the ride app straight away (the pill is the button); every
    // other route opens its single-route page.
    head.onclick = o.brand
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
  // Bolt universal link (no public coordinate deep-link) — opens the app/site.
  return "https://bolt.eu/en-gb/";
}
const LIME_LINK = "https://www.li.me/";
// Trainline: buy a ticket for a National Rail leg (no map needed on a train).
const slug = (s) => cleanName(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
function trainlineLink(leg) {
  if (!leg.from || !leg.to) return "https://www.thetrainline.com/";
  return `https://www.thetrainline.com/train-times/${slug(leg.from)}-to-${slug(leg.to)}`;
}

// Collapse a whole train journey into ONE section — you buy a single
// through-ticket for it (one Trainline link). A run of train hops is merged even
// across the short platform-change walks between them.
function mergeTrainLegs(legs) {
  const isTrain = (l) => l && TRAIN_MODES.includes(l.mode);
  const out = [];
  let i = 0;
  while (i < legs.length) {
    if (!isTrain(legs[i])) { out.push({ ...legs[i] }); i++; continue; }
    // Extend the run: keep absorbing further train hops and the interchange
    // walks that sit between them.
    let last = i, k = i + 1;
    while (k < legs.length) {
      if (isTrain(legs[k])) { last = k; k++; continue; }
      if (legs[k].mode === "walking") {
        let p = k;
        while (p < legs.length && legs[p].mode === "walking") p++;
        if (p < legs.length && isTrain(legs[p])) { k = p; continue; } // walk → train: absorb
      }
      break;
    }
    const run = legs.slice(i, last + 1);
    const first = legs[i], lastLeg = legs[last];
    const lines = [...new Set(run.filter(isTrain).map((l) => l.line).filter(Boolean))];
    out.push({
      ...first,
      mode: "national-rail", // one train section → Trainline link + 🚆
      to: lastLeg.to,
      toLL: lastLeg.toLL,
      durationMin: run.reduce((s, l) => s + (l.durationMin || 0), 0),
      line: lines.join(" + ") || first.line || "Train",
      terminus: lastLeg.terminus || first.terminus,
      summary: `${cleanName(first.from)} → ${cleanName(lastLeg.to)}`,
    });
    i = last + 1;
  }
  return out;
}

// Open the single-route page: own screen, map at top (scrolls), steps below.
function openDetail(o) {
  const data = lastResult;
  const pubOn = pubStop && !o.synthetic;

  // Anchor to the entered start/end (links use those names). The final leg
  // becomes "Walk to <end>" so we don't need a separate Start/End row.
  // Consecutive train hops collapse into one section (one ticket, one Trainline link).
  const legs = mergeTrainLegs(o.legs.map((l) => ({ ...l })));
  if (legs.length) {
    legs[0] = { ...legs[0], from: data.origin.name, fromLL: data.origin };
    const last = { ...legs[legs.length - 1], to: data.dest.name, toLL: data.dest };
    if (last.mode === "walking") last.toDest = true;
    legs[legs.length - 1] = last;
  }

  const legSteps = legs.map(stepDetail);
  if (pubOn) {
    let idx = legs.findIndex((l) => BOARD_MODES.includes(l.mode));
    if (idx < 0) idx = legSteps.length;
    legSteps.splice(idx, 0, '<li class="step pub-step"><span class="step-ic">🍺</span><div class="step-body"><div class="pub-name">Finding a good pub…</div></div></li>');
  }

  $("#detailContent").innerHTML = `
    <div class="d-head">${summaryHTML(o)}</div>
    <ol class="steps">${legSteps.join("")}</ol>
    ${priceBreakdown(o)}`;
  $("#detail").classList.remove("hidden");
  document.body.classList.add("detail-open");
  $("#detail").scrollTop = 0;
  setTimeout(() => {
    map.invalidateSize(); // map lives in the hidden page until now
    drawRoute(data, o);
  }, 60);
  if (pubOn) loadPub(o);
}

// AI-style price breakdown shown under the route steps. Each emoji works like a
// bullet point: the text sits inline beside it with a hanging indent.
function priceBreakdown(o) {
  const { pence, prefix } = priceOf(o);
  const d = readDiscounts();
  const parts = fareParts(o);
  const rows = []; // [emoji, html]

  const bike = o.legs.find((l) => l.mode === "cycle");
  if (bike) {
    const m = Math.round(bike.durationMin);
    const p = bikePricing(m);
    rows.push(["🍋‍🟩", p.pass
      ? `Lime: a ${p.passMins}-min pass is cheapest here — ${money(parts.bikePart)} for ${m} min riding.`
      : `Lime: pay-as-you-go (£1 unlock + 29p/min) is ${money(parts.bikePart)} for ${m} min riding.`]);
  }

  if (parts.isCab) {
    rows.push(["🚗", `${cap(o.brand || "Cab")} fare is an upper estimate (the “&lt;”); you pay the live metered price in the app.`]);
  } else {
    if (hasTrain(o.legs)) {
      rows.push(["🚆", d.railcard
        ? `Train: ${money(railcardPence(parts.railPart))} with your railcard applied (${money(parts.railPart)} without). One through-ticket covers the whole train journey.`
        : `Train: ${money(parts.railPart)} off-peak — a railcard saves ~⅓ off this (${money(railcardPence(parts.railPart))}). Buy one through-ticket for the whole train journey.`]);
    } else if (parts.railPart > 0) {
      rows.push(["🚇", `Tube/DLR: ${money(parts.railPart)} — a zone-based pay-as-you-go estimate.`]);
    }
    if (parts.busPart > 0) rows.push(["🚌", `Bus: ${money(175)} (Hopper — unlimited buses within an hour).`]);
  }

  if (!rows.length) return "";
  const body = rows
    .map(([em, txt]) => `<div class="ai-row"><span class="ai-em">${em}</span><span class="ai-txt">${txt}</span></div>`)
    .join("");
  return `<div class="ai-note"><b>✨ How we worked out ${prefix}${money(pence)}</b>${body}</div>`;
}

function closeDetail() {
  $("#detail").classList.add("hidden");
  document.body.classList.remove("detail-open");
}

// Pub within a 15-min walk of where this route boards; drop it into its step + map.
async function loadPub(o) {
  const step = $("#detailContent .pub-step");
  if (!step) return;
  const O = lastResult.origin, D = lastResult.dest;
  const board =
    o.dropoffBay ||
    (o.legs.find((l) => BOARD_MODES.includes(l.mode)) || {}).fromLL ||
    { lat: (O.lat + D.lat) / 2, lon: (O.lon + D.lon) / 2 };
  if (!o._pub) o._pub = (await findPub(board.lat, board.lon)) || { name: null };
  const body = step.querySelector(".step-body");
  const pub = o._pub;
  if (!pub.name) return (body.innerHTML = '<div class="pub-name">No pub within a 15-min walk</div>');
  emojiMarker(pub.lat, pub.lon, "🍺", pub.name).addTo(layers); // show on the map
  const query = encodeURIComponent([pub.name, pub.addr].filter(Boolean).join(", "));
  const gmaps = `https://www.google.com/maps/search/?api=1&query=${query}`;
  body.innerHTML = `
    <a class="pub-name" href="${gmaps}" target="_blank" rel="noopener">${pub.name} ↗</a>
    <div class="step-sub">${walkMin(pub.metres || 0)} min walk from the station</div>`;
}

// Tabs: Fastest / Cheapest re-rank the list; Custom shows the controls.
document.querySelectorAll(".tab").forEach((tab) => {
  tab.onclick = () => setTab(tab.dataset.sort);
});

$("#backBtn").onclick = closeDetail;

// Home / reset — clear everything and start a fresh search.
function resetApp() {
  $("#from").value = "";
  $("#to").value = "";
  ["from", "to"].forEach((id) => {
    delete $("#" + id).dataset.lat;
    delete $("#" + id).dataset.lon;
  });
  $("#acFrom").classList.add("hidden");
  $("#acTo").classList.add("hidden");
  $("#results").innerHTML = "";
  $("#results").classList.remove("hidden");
  $("#custom").classList.add("hidden");
  lastResult = null;
  $("#tabs").classList.add("hidden");
  document.body.classList.remove("has-results");
  closeDetail();
  pubStop = false;
  $("#pubChk").checked = false;
  $("#avoid").querySelectorAll("input").forEach((i) => (i.checked = false));
  $("#discounts").querySelectorAll("input").forEach((i) => (i.checked = false));
  peopleCount = 1;
  $("#peopleSeg").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.n === "1"));
  whenMode = "now";
  $("#whenSeg").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.when === "now"));
  $("#whenTime").classList.add("hidden");
  $("#whenTime").value = "";
  sortBy = "fastest";
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.sort === "fastest"));
  $("#go").textContent = "Find Best and Cheapest Routes";
}
$("#homeLink").onclick = resetApp;

// Changelog (tap the version pill). Concise, plain-English summaries.
const CHANGELOG = [
  ["0.29", [
    "The whole train journey now collapses into one section with a single Trainline link — even when you change trains.",
    "Overground, Elizabeth line and Thameslink now count as trains, so their fare shows and a railcard applies.",
  ]],
  ["0.28", [
    "Prices show “pp” (per person) when you're travelling as a group.",
    "Pub stop is now a simple on/off — drops in the nearest pub within a 15-min walk.",
    "Railcard now only discounts the train portion of a fare, and train prices add up correctly.",
    "Tidied the splash screen and removed the Uber One option.",
  ]],
  ["0.27", [
    "Tap the Uber/Bolt pill on a card to open the app — it's now a proper button.",
    "Lime opens from the bike step on the route page (its icon replaces the map icon there).",
    "Tube/rail steps now show the bound — Eastbound, Westbound, Northbound or Southbound.",
    "Train hops on one journey combine into a single section with one Trainline link (buy one through-ticket).",
    "Price breakdown now lists each fare (tube, train, bus, Lime) with the numbers, laid out as neat bullets.",
  ]],
  ["0.26", [
    "Pub stops now find pubs serving Jubel or Guinness within a 15-min walk, shown on the map, with a link to the brand's pub finder.",
    "Custom tab tidied: section titles, Travellers 1–6, a Discounts section (Railcard, Uber One), and Avoid chips that turn into a red ✕.",
    "Smarter prices: railcard saving on trains, an upper “<” estimate for cabs, and an AI breakdown of how each fare was worked out.",
    "Times now show as hours and minutes over an hour.",
    "Route page: trains link to Trainline, other legs to Google Maps; clearer terminus labels; Start row removed and the final leg reads “Walk to …”.",
    "Open Uber/Bolt/Lime straight from a card with a ↗.",
    "Reset-map button moved to the bottom-right and hides after use.",
  ]],
  ["0.25", ["Fixed a bug where the loading screen could get stuck."]],
  ["0.24", ["Added departure/arrival times, mode filters, and a single-route page with the map up top."]],
  ["Earlier", ["Fastest/Cheapest tabs, e-bike + cab-to-station routing, live fares, and the bottom search bar."]],
];
function openChangelog() {
  $("#changelogBody").innerHTML = CHANGELOG.map(([v, items]) =>
    `<div class="cl-ver">v${v}</div><ul class="cl-list">${items.map((i) => `<li>${i}</li>`).join("")}</ul>`
  ).join("");
  $("#changelog").classList.remove("hidden");
}
$("#verPill").onclick = openChangelog;
$("#changelogClose").onclick = () => $("#changelog").classList.add("hidden");
$("#changelog").onclick = (e) => { if (e.target.id === "changelog") $("#changelog").classList.add("hidden"); };

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
        .map((s, i) => `<div class="ac-item" data-i="${i}">${s.icon ? `<span class="ac-ic">${s.icon}</span>` : ""}${s.name}</div>`)
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
  const O = data.origin, D = data.dest;
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
  if (resetBtn) resetBtn.style.display = ""; // show again for this route
  map.fitBounds(L.latLngBounds(pts).pad(0.25));
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
