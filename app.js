// Client-side app: the routing engine runs entirely in the browser, calling
// TfL and Nominatim directly (both allow CORS). No backend required.
import { plan as runPlan } from "./lib/engine.js";
import { geocode, suggest } from "./lib/geocode.js";
import { railcardPence, bikePricing, zoneForStation, isPeakDate, setBikeOp } from "./lib/fares.js";
import { arrivals, lineStatus } from "./lib/tfl.js";

// --- Live countdown / disruption polling state -----------------------------
let detailTimers = []; // intervals to clear when leaving the route page
let lastDetailOption = null; // the option currently shown on the route page
const ACCESS_KEY = "quickest.accessibility"; // persisted B3 preference

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

// "Reset map" control (bottom-right) — re-fit to the route preview. Hidden until
// the user actually pans/zooms the map; hidden again after reset or a new route.
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
    b.style.display = "none"; // shown only once the user interacts with the map
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

// Reveal the reset button on genuine user interaction (pan/zoom/scroll/pinch).
// Programmatic fitBounds doesn't fire these DOM events, so there are no false
// positives. The zoom +/- buttons live inside the container, so their taps count.
function revealReset() {
  if (resetBtn && lastRoutePts) resetBtn.style.display = "";
}
["mousedown", "wheel", "touchstart"].forEach((ev) =>
  map.getContainer().addEventListener(ev, revealReset, { passive: true })
);

let layers = L.layerGroup().addTo(map);
let lastResult = null;
let sortBy = "fastest"; // "fastest" | "cheapest"

// "Train" = anything you'd buy a National Rail ticket for on Trainline and that a
// railcard discounts: National Rail, Overground, Elizabeth line, Thameslink.
// (Tube/DLR/tram are Oyster-only, so they stay separate.)
const TRAIN_MODES = ["national-rail", "train", "overground", "elizabeth-line", "thameslink"];
const hasTrain = (legs) => legs.some((l) => TRAIN_MODES.includes(l.mode));
// A railcard only applies to genuine National Rail (not tube/Overground/Elizabeth).
const NATIONAL_RAIL_MODES = ["national-rail", "train"];
const hasNationalRail = (legs) => legs.some((l) => NATIONAL_RAIL_MODES.includes(l.mode));
// Where you'd board (and so stop for a pint just before).
const BOARD_MODES = ["tube", "dlr", "overground", "elizabeth-line", "national-rail", "train", "tram", "bus"];
const RAIL_MODES = ["tube", "dlr", "overground", "elizabeth-line", "national-rail", "train", "tram"];

// Small favicon-style logos via Google's favicon service.
const favicon = (domain) => `https://www.google.com/s2/favicons?sz=64&domain=${domain}`;
const BRAND_LOGOS = { uber: "uber.com", bolt: "bolt.eu" };

// Beers/ciders we can show a logo for — only used to LABEL drinks a pub actually
// lists in OpenStreetMap (never a guess). OSM coverage is sparse, so this is
// best-effort and only shown when present.
const DRINK_LOGOS = [
  { key: "guinness", name: "Guinness", domain: "guinness.com" },
  { key: "camden", name: "Camden", domain: "camdentownbrewery.com" },
  { key: "neck oil", name: "Neck Oil", domain: "beavertownbrewery.co.uk" },
  { key: "beavertown", name: "Beavertown", domain: "beavertownbrewery.co.uk" },
  { key: "lager", name: "Lager", domain: "" },
  { key: "peroni", name: "Peroni", domain: "peroni.co.uk" },
  { key: "moretti", name: "Birra Moretti", domain: "birramoretti.co.uk" },
  { key: "stella", name: "Stella Artois", domain: "stellaartois.com" },
  { key: "estrella", name: "Estrella", domain: "estrelladamm.com" },
  { key: "madri", name: "Madrí", domain: "madriexcepcional.com" },
  { key: "amstel", name: "Amstel", domain: "amstel.com" },
  { key: "heineken", name: "Heineken", domain: "heineken.com" },
  { key: "asahi", name: "Asahi", domain: "asahibeer.co.uk" },
  { key: "london pride", name: "London Pride", domain: "fullers.co.uk" },
  { key: "fuller", name: "Fuller's", domain: "fullers.co.uk" },
  { key: "doom bar", name: "Doom Bar", domain: "sharpsbrewery.co.uk" },
  { key: "pravha", name: "Pravha", domain: "" },
  { key: "carling", name: "Carling", domain: "carling.com" },
  { key: "cruzcampo", name: "Cruzcampo", domain: "cruzcampo.com" },
  { key: "carlsberg", name: "Carlsberg", domain: "carlsberg.co.uk" },
  { key: "san miguel", name: "San Miguel", domain: "sanmiguel.co.uk" },
  { key: "staropramen", name: "Staropramen", domain: "staropramen.com" },
  { key: "aspall", name: "Aspall", domain: "aspall.co.uk" },
  { key: "thatcher", name: "Thatchers", domain: "thatcherscider.co.uk" },
  { key: "strongbow", name: "Strongbow", domain: "strongbow.co.uk" },
  { key: "rekorderlig", name: "Rekorderlig", domain: "rekorderlig.com" },
  { key: "inch", name: "Inch's", domain: "inchescider.com" },
];
const drinkMatch = (text) => {
  const n = (text || "").toLowerCase();
  return DRINK_LOGOS.find((d) => d.key !== "lager" && d.key !== "pravha" && n.includes(d.key)) ||
    DRINK_LOGOS.find((d) => n.includes(d.key)) || null;
};

// --- User-switchable providers (Custom filters), persisted -----------------
const PREFS_KEY = "quickest.prefs";
let PREFS = { maps: "google", bike: "lime", trains: "trainline" };
function loadPrefs() { try { Object.assign(PREFS, JSON.parse(localStorage.getItem(PREFS_KEY) || "{}")); } catch {} }
function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(PREFS)); } catch {} }
loadPrefs();
setBikeOp(PREFS.bike);

const MAPS_APPS = {
  google: { name: "Google Maps", icon: "google.com/maps" },
  citymapper: { name: "Citymapper", icon: "citymapper.com" },
};
const BIKE_APPS = {
  // Lime app universal link (opens the app if installed, else the store).
  lime: { name: "Lime", icon: "li.me", link: "https://limebike.app.link/", emoji: "🍋‍🟩" },
  forest: { name: "Forest", icon: "humanforest.co.uk", link: "https://humanforest.onelink.me/", emoji: "🌳" },
};
const TRAIN_APPS = { trainline: { name: "Trainline", icon: "thetrainline.com" } };
const bikeApp = () => BIKE_APPS[PREFS.bike] || BIKE_APPS.lime;

const slug = (s) => cleanName(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
// Trainline link for one section (from → to).
function trainTicketLink(leg) {
  const from = cleanName(leg.from || ""), to = cleanName(leg.to || "");
  if (!from || !to) return "https://www.thetrainline.com/";
  return `https://www.thetrainline.com/train-times/${slug(from)}-to-${slug(to)}`;
}

// Load the parking-bay dataset once (cached by the service worker after first
// visit). Kick it off immediately so it's ready by the time you plan.
// Resilient JSON loader: a failed/garbled response surfaces as a clean rejection
// (handled by plan's error state) rather than an unhandled "json parse" crash.
function loadJSON(url) {
  const p = fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${url} ${r.status}`);
    return r.json();
  });
  p.catch(() => {}); // mark handled so it never fires an unhandledrejection at load
  return p;
}
let baysPromise = loadJSON("./data/bays.json");
let stationsPromise = loadJSON("./data/stations.json");

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
  "Checking 🍋‍🟩 Lime Bikes…",
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

// Provider pickers (Maps app / Bike operator / Train tickets), persisted.
function wireProviderSeg(id, key, onChange) {
  const seg = $(id);
  if (!seg) return;
  seg.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("on", b.dataset[key] === PREFS[key]);
    b.onclick = () => {
      PREFS[key] = b.dataset[key];
      seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      savePrefs();
      if (onChange) onChange();
    };
  });
}
wireProviderSeg("#mapsSeg", "maps");
wireProviderSeg("#bikeSeg", "bike", () => setBikeOp(PREFS.bike)); // affects pricing → re-plan on Update

const avoidedModes = () =>
  new Set([...$("#avoid").querySelectorAll("input:checked")].map((i) => i.dataset.mode));

// Accessibility (B3): map the toggles to TfL accessibilityPreference values.
// Persisted because it's usually a fixed need, not a per-trip choice.
const ACCESS_MAP = { stepfree: "StepFreeToVehicle", nostairs: "NoStairs" };
function readAccess() {
  return [...document.querySelectorAll("#access input:checked")].map((i) => i.closest("label").dataset.acc);
}
function accessPreference() {
  return readAccess().map((k) => ACCESS_MAP[k]).filter(Boolean).join(",");
}
function saveAccess() {
  try { localStorage.setItem(ACCESS_KEY, JSON.stringify(readAccess())); } catch {}
}
function restoreAccess() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(ACCESS_KEY) || "[]"); } catch {}
  document.querySelectorAll("#access label").forEach((l) => {
    const cb = l.querySelector("input");
    if (cb) cb.checked = saved.includes(l.dataset.acc);
  });
}

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
  const acc = accessPreference();
  if (acc) o.accessibilityPreference = acc;
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

// Metres between two lat/lon points (equirectangular — fine at city scale).
function metresBetween(aLat, aLon, bLat, bLon) {
  const dy = (aLat - bLat) * 111000;
  const dx = (aLon - bLon) * 111000 * Math.cos((aLat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

// Pull the drinks a pub lists in OpenStreetMap (brand/brewery/real ale tags).
function pubDrinks(t) {
  const out = [];
  for (const k of ["brand", "brewery", "drink:beer", "beer", "drink:cider", "real_ale", "microbrewery"]) {
    const v = t[k];
    if (v && v !== "yes" && v !== "no") out.push(...String(v).split(/[;,]/).map((s) => s.trim()));
  }
  if ((t["real_ale"] === "yes" || t["microbrewery"] === "yes")) out.push("real ale");
  return out;
}

// Nearest named pub to ANY of the given stations (each searched within ~700 m,
// a ~9-min walk), returning the pub closest to a station the route actually uses.
async function findPub(stops) {
  if (!stops || !stops.length) return null;
  const clauses = stops
    .map((s) => `node(around:700,${s.lat},${s.lon})[amenity=pub][name];`)
    .join("");
  const q = `[out:json][timeout:12];(${clauses});out 80;`;
  const ctrl = new AbortController();
  const t0 = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: q, signal: ctrl.signal });
    const j = await r.json();
    const pubs = (j.elements || []).filter((e) => e.tags?.name && e.lat != null);
    if (!pubs.length) return null;
    // For each pub, the nearest route station (and the walk to it).
    const scored = pubs.map((e) => {
      let best = Infinity, near = stops[0];
      for (const s of stops) {
        const d = metresBetween(e.lat, e.lon, s.lat, s.lon);
        if (d < best) { best = d; near = s; }
      }
      return { e, d: best, near };
    }).sort((a, b) => a.d - b.d);
    const { e, d, near } = scored[0];
    const t = e.tags;
    const addr = [t["addr:housenumber"], t["addr:street"], t["addr:postcode"]].filter(Boolean).join(" ");
    return { name: t.name, lat: e.lat, lon: e.lon, addr, metres: Math.round(d), stopName: near.name, drinks: pubDrinks(t) };
  } catch {
    return null;
  } finally {
    clearTimeout(t0);
  }
}

// The stations this route uses (board points of each transit leg + final alight),
// so a pub can sit near a stop you'd actually get on/off at.
function transitStops(o) {
  const stops = [];
  const add = (name, ll) => { if (ll && ll.lat != null) stops.push({ name: cleanName(name) || "the stop", lat: ll.lat, lon: ll.lon }); };
  if (o.dropoffBay) add("the bike drop-off", o.dropoffBay);
  const transit = o.legs.filter((l) => BOARD_MODES.includes(l.mode));
  for (const l of transit) add(l.from, l.fromLL);
  const last = transit[transit.length - 1];
  if (last) add(last.to, last.toLL);
  // De-dupe near-identical points.
  return stops.filter((s, i) => stops.findIndex((x) => metresBetween(s.lat, s.lon, x.lat, x.lon) < 120) === i).slice(0, 6);
}

// C3: render a recoverable state into the results area (no silent blank screens).
// kind: loading | empty | error | offline | location | invalid
function showState(kind, opts = {}) {
  const wrap = $("#results");
  document.body.classList.add("has-results"); // keep the results panel on screen
  $("#tabs").classList.add("hidden");
  $("#custom").classList.add("hidden");
  wrap.classList.remove("hidden");
  if (kind === "loading") {
    wrap.innerHTML =
      '<div class="state-skel" aria-hidden="true">' +
      Array.from({ length: 4 }).map(() =>
        '<div class="skel-card"><div class="skel-line w40"></div><div class="skel-line w70"></div><div class="skel-pills"><span></span><span></span><span></span></div></div>'
      ).join("") +
      '</div><p class="sr-only" role="status">Finding routes…</p>';
    return;
  }
  const ICON = { empty: "🧭", error: "⚠️", offline: "📡", location: "📍", invalid: "✏️" }[kind] || "ℹ️";
  const actions = (opts.actions || [])
    .map((a, i) => `<button class="state-act" data-act="${i}">${a.label}</button>`)
    .join("");
  wrap.innerHTML = `
    <div class="state-card" role="alert" aria-live="assertive">
      <div class="state-ic">${ICON}</div>
      <div class="state-title">${opts.title || ""}</div>
      ${opts.body ? `<div class="state-body">${opts.body}</div>` : ""}
      ${actions ? `<div class="state-actions">${actions}</div>` : ""}
    </div>`;
  (opts.actions || []).forEach((a, i) => {
    const b = wrap.querySelector(`[data-act="${i}"]`);
    if (b) b.onclick = a.onClick;
  });
}

let lastQuery = null; // for the Retry action

async function plan() {
  const originStr = $("#from").value.trim();
  const destStr = $("#to").value.trim();
  // C3 invalid input — flag the empty field inline.
  if (!originStr || !destStr) {
    if (!originStr) flagField("from");
    if (!destStr) flagField("to");
    return showState("invalid", {
      title: "Add a start and a destination",
      body: "Enter both a From and a To — an address, postcode or station.",
    });
  }
  // C3 offline — don't even try; surface the last route if we have one.
  if (navigator.onLine === false) {
    return showState("offline", {
      title: "You're offline",
      body: "Quickest needs a connection to plan a route." + (lastResult ? " Showing your last route below." : ""),
      actions: [{ label: "Retry", onClick: () => plan() }],
    });
  }
  lastQuery = { originStr, destStr };
  startLoading();
  showState("loading");
  closeDetail();
  $("#acFrom").classList.add("hidden");
  $("#acTo").classList.add("hidden");
  const watchdog = setTimeout(() => {
    stopLoading();
    showState("error", {
      title: "That took too long",
      body: "TfL didn't respond in time. Check your connection and try again.",
      actions: [{ label: "Retry", onClick: () => plan() }],
    });
  }, 20000);
  try {
    const opts = extrasOpts();
    const [origin, dest, bays, stations] = await Promise.all([
      resolve($("#from")),
      resolve($("#to")),
      baysPromise,
      stationsPromise,
    ]);
    if (!origin) return planInvalid(originStr);
    if (!dest) return planInvalid(destStr);
    const data = await runPlan(origin, dest, bays, { stations, ...opts });
    data._noCab = avoidedModes().has("cab");
    lastResult = data;
    render(data);
  } catch (e) {
    // Distinguish a network/TfL outage from "no route".
    const offline = navigator.onLine === false;
    console.warn("plan failed:", e);
    showState(offline ? "offline" : "error", {
      title: offline ? "Connection lost" : "Couldn't reach TfL",
      body: offline ? "You appear to be offline — check your connection and try again." : "Something went wrong planning your route. Please try again.",
      actions: [{ label: "Retry", onClick: () => plan() }],
    });
  } finally {
    clearTimeout(watchdog);
    stopLoading();
  }
}

function planInvalid(text) {
  stopLoading();
  showState("invalid", {
    title: `Couldn't find “${text}”`,
    body: "Try a more specific address, postcode or station name.",
  });
}

// Inline field validation flash (C3).
function flagField(id) {
  const f = $("#" + id).closest(".field");
  if (!f) return;
  f.classList.add("invalid");
  $("#" + id).addEventListener("input", () => f.classList.remove("invalid"), { once: true });
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
  const a = leg.fromLL, b = leg.toLL;
  const mode = mapsMode(leg.mode);
  if (PREFS.maps === "citymapper") {
    if (a && b && a.lat != null && b.lat != null)
      return `https://citymapper.com/directions?startcoord=${a.lat}%2C${a.lon}&endcoord=${b.lat}%2C${b.lon}`;
    return "https://citymapper.com/";
  }
  // Google Maps (default)
  const dest = pointQuery(leg.toLL, leg.to);
  if (!dest) return null;
  const origin = pointQuery(leg.fromLL, leg.from);
  let u = `https://www.google.com/maps/dir/?api=1&travelmode=${mode}&destination=${dest}`;
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
  data._syn = estimates(data);
  const cabsAvail = !data._noCab;
  // C3 no-results: engine found nothing and there's no cab fallback either.
  if (!data.options.length && !cabsAvail) {
    $("#go").textContent = "Update";
    const avoids = [...$("#avoid").querySelectorAll("input:checked")];
    return showState("empty", {
      title: "No route with these filters",
      body: "Your Avoid / Accessibility filters ruled everything out. Try relaxing them.",
      actions: [
        avoids.length ? { label: "Clear avoids", onClick: () => { avoids.forEach((i) => (i.checked = false)); updateAvoidPreviews(); plan(); } } : null,
        { label: "Allow cabs", onClick: () => { const c = $('#avoid input[data-mode="cab"]'); if (c) c.checked = false; plan(); } },
      ].filter(Boolean),
    });
  }
  const tabs = $("#tabs");
  tabs.classList.remove("hidden");
  document.body.classList.add("has-results");
  $("#go").textContent = "Update";
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
    $("#results").scrollTop = 0; // best option sits at the top
  }
}

function readDiscounts() {
  const on = new Set([...document.querySelectorAll("#discounts input:checked")].map((i) => i.closest("label").dataset.disc));
  return { railcard: on.has("railcard") };
}

// Estimate a cab leg's fare from its straight-line distance (mirrors the engine's
// cabHop model) so cab-to-station routes split correctly into cab + transit.
function cabHopPence(leg) {
  if (!leg || !leg.fromLL || !leg.toLL) return 0;
  const toRad = (x) => (x * Math.PI) / 180, R = 6371000;
  const dLat = toRad(leg.toLL.lat - leg.fromLL.lat), dLon = toRad(leg.toLL.lon - leg.fromLL.lon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(leg.fromLL.lat)) * Math.cos(toRad(leg.toLL.lat)) * Math.sin(dLon / 2) ** 2;
  const km = ((2 * R * Math.asin(Math.sqrt(a))) / 1000) * 1.3;
  const driveMin = Math.round(km * 3 + 3);
  return Math.round(250 + 150 * km + 25 * driveMin);
}

// Split a route's cost into its parts so a railcard only discounts the *train*
// fare (not the bike hire, cab, tube or bus). Returns pence amounts.
function fareParts(o) {
  const isCab = !!o.brand || o.legs.some((l) => l.mode === "car");
  const bike = o.legs.find((l) => l.mode === "cycle");
  const bikePart = bike ? bikePricing(Math.round(bike.durationMin)).pence : 0;
  const carLeg = o.legs.find((l) => l.mode === "car");
  // Whole-journey cab (synthetic Uber/Bolt) = the lot; cab-to-station = just the hop.
  const carPart = carLeg ? (o.synthetic ? o.costPence : Math.min(cabHopPence(carLeg), o.costPence)) : 0;
  const transit = Math.max(0, o.costPence - bikePart - carPart);
  const busPart = o.legs.some((l) => l.mode === "bus") ? Math.min(175, transit) : 0;
  const railPart = Math.max(0, transit - busPart); // tube/train portion
  return { isCab, bikePart, carPart, transit, busPart, railPart };
}

// What a route actually costs to show, after discounts. Returns {pence, prefix, railHint}.
function priceOf(o) {
  const d = readDiscounts();
  const parts = fareParts(o);
  const trainy = hasNationalRail(o.legs); // railcard only for normal trains
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

  // Best option at the top; the free-walk gag and small print at the bottom.
  opts.forEach((o, i) => {
    const card = document.createElement("div");
    card.className = "card";
    const badge = i === 0 ? `<span class="${badgeClass}">${badgeLabel}</span>` : "";
    card.innerHTML = `<div class="card-head">${badge}${summaryHTML(o)}</div>`;
    const head = card.querySelector(".card-head");
    head.onclick = o.brand
      ? () => window.open(rideLink(o.brand), "_blank", "noopener")
      : () => openDetail(o);
    wrap.appendChild(card);
  });

  const sp = document.createElement("p");
  sp.className = "smallprint";
  sp.textContent = "Estimated prices and times. Check each operator for exact fares before you travel.";
  wrap.appendChild(sp);
  wrap.scrollTop = 0; // best option (top) in view
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

// --- A2: rich itinerary ----------------------------------------------------
const TRANSIT_LEG = (l) => RAIL_MODES.includes(l.mode) || l.mode === "bus";
function legIcon(leg) {
  if (leg.mode === "walking") return "🚶";
  if (leg.mode === "cycle") return "🍋‍🟩";
  if (leg.mode === "car") return "🚗";
  if (leg.mode === "bus") return "🚌";
  if (leg.mode === "dlr") return "🚈";
  if (leg.mode === "tram") return "🚊";
  if (leg.mode === "tube") return "🚇";
  return "🚆"; // national-rail / overground / elizabeth / thameslink
}
const fmtClock = (d) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
// Departure/arrival clock times for the summary header.
function clockTimes(o) {
  const dur = (o.durationMin || 0) * 60000;
  let dep, arr;
  if (whenMode !== "now" && $("#whenTime").value) {
    const t = new Date($("#whenTime").value);
    if (whenMode === "arrive") { arr = t; dep = new Date(+t - dur); }
    else { dep = t; arr = new Date(+t + dur); }
  } else { dep = new Date(); arr = new Date(Date.now() + dur); }
  return { dep, arr };
}
const countChanges = (legs) => Math.max(0, legs.filter(TRANSIT_LEG).length - 1);

// Friendly summary of the vehicles used, e.g. "Tube · Bus" or "Lime Bike · Train".
const MODE_NAME = {
  tube: "Tube", bus: "Bus", dlr: "DLR", overground: "Overground",
  "elizabeth-line": "Elizabeth line", tram: "Tram", "national-rail": "Train",
  train: "Train", thameslink: "Train", car: "Cab",
};
function modeSummary(legs) {
  const seq = legs.filter((l) => l.mode !== "walking")
    .map((l) => l.mode === "cycle" ? `${bikeApp().name} Bike` : (MODE_NAME[l.mode] || cap(l.mode)));
  const out = [];
  for (const m of seq) if (out[out.length - 1] !== m) out.push(m);
  return out.length ? out.join(" · ") : "On foot";
}

// One leg of the itinerary, with line-colour accent, board/alight, walk time,
// the leg's fare, a live-countdown / bus-frequency slot, and expandable stops.
function legCard(leg, idx, firstTransitIdx, fare, note) {
  const n = Math.round(leg.durationMin);
  const isTransit = TRANSIT_LEG(leg);
  const color = isTransit ? lineColor(leg) : "#9aa7b2";
  let title, sub = "";
  if (leg.mode === "walking") {
    title = leg.toDest ? `Walk to ${cleanName(leg.to).split(",")[0]}` : `Walk · ${fmtMin(n)}`;
    sub = leg.toDest ? "" : leg.to ? `to ${cleanName(leg.to).split(",")[0]}` : "";
  } else if (leg.mode === "cycle") {
    title = `${bikeApp().name} Bike · ${fmtMin(n)}`;
    sub = leg.to ? `to ${cleanName(leg.to)}` : "";
  } else if (leg.mode === "car") {
    title = `${cap(leg.brand || "Cab")} · ${fmtMin(n)}`;
    sub = leg.to ? `to ${cleanName(leg.to)}` : "";
  } else {
    title = `${leg.line || cap(leg.mode)} · ${fmtMin(n)}`;
    sub = leg.from && leg.to ? `${cleanName(leg.from)} → ${cleanName(leg.to)}` : cleanName(leg.summary || "");
  }
  // Direction: trains show where they terminate; tube/DLR/tram show the bound.
  let dir = "";
  if (TRAIN_MODES.includes(leg.mode)) dir = leg.terminus ? `Towards ${cleanName(leg.terminus)}` : "";
  else if (RAIL_MODES.includes(leg.mode)) dir = compassBound(leg);
  const extra = [dir, note].filter(Boolean).join(" · ");
  const cd = idx === firstTransitIdx
    ? `<div class="leg-countdown" data-leg="${idx}"><span class="spin sm"></span> live times…</div>` : "";
  const freq = leg.mode === "bus"
    ? `<div class="leg-freq" data-leg="${idx}"><span class="spin sm"></span> checking frequency…</div>` : "";
  const disr = isTransit && leg.lineId
    ? `<div class="leg-disr" data-line="${leg.lineId}" hidden></div>` : "";
  const stops = leg.stops && leg.stops.length > 2
    ? `<details class="leg-stops"><summary>${leg.stops.length} stops</summary><ol>${leg.stops.map((s) => `<li>${s}</li>`).join("")}</ol></details>` : "";
  // Operator/app icon: real logos for Lime/Forest & cabs; mode emoji otherwise.
  const appLogo = leg.mode === "cycle" ? bikeApp().icon
    : leg.mode === "car" ? (BRAND_LOGOS[leg.brand] || "uber.com") : null;
  const iconHtml = appLogo
    ? `<img class="legc-logo" src="${favicon(appLogo)}" alt="" onerror="this.replaceWith(document.createTextNode('${leg.mode === "cycle" ? bikeApp().emoji : "🚗"}'))">`
    : legIcon(leg);
  const iconBg = appLogo ? "#fff" : color;
  // Right-side action: open the relevant app (maps / bike / cab / train tickets).
  const act = legAction(leg);
  const linkHtml = act
    ? `<a class="legc-link" href="${act.url}" target="_blank" rel="noopener" aria-label="Open ${act.label}"><img class="legc-link-img" src="${favicon(act.icon)}" alt="" onerror="this.replaceWith(document.createTextNode('${act.fallback}'))"></a>`
    : "";
  return `<li class="legc" style="--acc:${color}">
    <span class="legc-ic" style="background:${iconBg};color:${textOn(color)}">${iconHtml}</span>
    <div class="legc-body">
      <div class="legc-title">${title}</div>
      ${sub ? `<div class="legc-sub">${sub}</div>` : ""}
      ${extra ? `<div class="legc-extra">${extra}</div>` : ""}
      ${cd}${freq}${disr}${stops}
    </div>
    ${linkHtml}
  </li>`;
}

// Where a leg's right-side icon should link: the chosen maps app, the bike app,
// the ride app, or the chosen train-ticket site — opening that exact section.
function legAction(leg) {
  if (leg.mode === "cycle") return { url: bikeApp().link, icon: bikeApp().icon, fallback: bikeApp().emoji, label: bikeApp().name };
  if (leg.mode === "car") {
    const brand = leg.brand || "uber";
    return { url: rideLink(brand), icon: BRAND_LOGOS[brand] || "uber.com", fallback: "🚗", label: cap(brand) };
  }
  if (TRAIN_MODES.includes(leg.mode)) {
    return { url: trainTicketLink(leg), icon: TRAIN_APPS[PREFS.trains].icon, fallback: "🎫", label: TRAIN_APPS[PREFS.trains].name };
  }
  const u = mapsLink(leg);
  if (!u) return null;
  return { url: u, icon: MAPS_APPS[PREFS.maps].icon, fallback: "🗺️", label: MAPS_APPS[PREFS.maps].name };
}

// Per-leg fare strings + the zone note for the (first) rail leg. Mirrors the
// cost-panel split so the itinerary shows each leg's price inline.
function legFares(o, legs) {
  const parts = fareParts(o);
  const { prefix } = priceOf(o);
  const railLegs = legs.filter((l) => RAIL_MODES.includes(l.mode));
  let zoneStr = "";
  if (railLegs.length) {
    const a = railLegs[0], b = railLegs[railLegs.length - 1];
    const fz = zoneForStation(a.from, a.fromLL?.lat, a.fromLL?.lon);
    const tz = zoneForStation(b.to, b.toLL?.lat, b.toLL?.lon);
    const lo = Math.min(fz, tz), hi = Math.max(fz, tz);
    zoneStr = `${lo === hi ? `Zone ${lo}` : `Zones ${lo}–${hi}`}, ${isPeakDate(clockTimes(o).dep) ? "peak" : "off-peak"}`;
  }
  let railShown = false, busShown = false;
  return legs.map((leg) => {
    if (leg.mode === "walking") return { fare: "", note: "" };
    if (leg.mode === "cycle") return { fare: money(parts.bikePart), note: "" };
    if (leg.mode === "car") return { fare: `${prefix}${money(parts.carPart)}`, note: "" };
    if (leg.mode === "bus") {
      const f = busShown ? "incl." : money(parts.busPart || 175);
      busShown = true;
      return { fare: f, note: "" };
    }
    if (!railShown) { railShown = true; return { fare: money(parts.railPart), note: zoneStr }; }
    return { fare: "incl.", note: "" };
  });
}

// A4: cost breakdown per leg and per traveller, with capping caveat.
function costPanel(o, legs) {
  const parts = fareParts(o);
  const { pence, prefix } = priceOf(o);
  // Zone label for the tube/rail portion (one PAYG fare covers all the rail legs).
  const railLegs = legs.filter((l) => RAIL_MODES.includes(l.mode));
  let zoneStr = "";
  if (railLegs.length) {
    const a = railLegs[0], b = railLegs[railLegs.length - 1];
    const fz = zoneForStation(a.from, a.fromLL?.lat, a.fromLL?.lon);
    const tz = zoneForStation(b.to, b.toLL?.lat, b.toLL?.lon);
    const lo = Math.min(fz, tz), hi = Math.max(fz, tz);
    zoneStr = `${lo === hi ? `Zone ${lo}` : `Zones ${lo}–${hi}`}, ${isPeakDate(clockTimes(o).dep) ? "peak" : "off-peak"}`;
  }
  // Merged calculator: one line per mode group (all tube/rail combined), no per-leg.
  const rows = [];
  if (legs.some((l) => l.mode === "cycle"))
    rows.push([bikeApp().emoji, `${bikeApp().name} Bike`, money(parts.bikePart)]);
  if (parts.railPart > 0)
    rows.push(["🚆", `Tube / Rail${zoneStr ? ` <span class="muted">· ${zoneStr}</span>` : ""}`, money(parts.railPart)]);
  if (parts.busPart > 0) rows.push(["🚌", "Bus", money(parts.busPart)]);
  if (parts.carPart > 0)
    rows.push(["🚗", cap(o.brand || "Cab"), `${money(Math.round(parts.carPart * 0.85))}–${money(parts.carPart)} est.`]);
  const rowsHtml = rows.map(([e, l, v]) => `<div class="cost-row"><span>${e} ${l}</span><span>${v}</span></div>`).join("");

  const perTraveller = parts.isCab ? Math.round(pence / peopleCount) : pence;
  const total = parts.isCab ? pence : pence * peopleCount; // whole party
  const perRow = peopleCount > 1
    ? `<div class="cost-tot"><span>Per traveller</span><span>${prefix}${money(perTraveller)}</span></div>` : "";
  const railNote = hasNationalRail(o.legs) && readDiscounts().railcard
    ? `<div class="cost-note">Railcard applied per eligible traveller.</div>` : "";
  const capNote = `<div class="cost-note">Single-fare estimate. TfL daily capping may make your real spend lower; cab fares are estimates and excluded from capping.</div>`;
  return `<details class="cost-panel" open>
    <summary>Cost breakdown</summary>
    <div class="cost-rows">${rowsHtml}</div>
    ${perRow}
    <div class="cost-tot big"><span>Total</span><span>${prefix}${money(total)}</span></div>
    ${bikeWorkings(legs)}${bikeReturnAlert(legs)}${railNote}${capNote}
  </details>`;
}

// Bike fare workings: pay-as-you-go vs a time pass.
function bikeWorkings(legs) {
  const bike = legs.find((l) => l.mode === "cycle");
  if (!bike) return "";
  const b = bikePricing(Math.round(bike.durationMin));
  const li = [];
  const unlock = b.unlockPence > 0 ? `${money(b.unlockPence)} unlock + ` : "no unlock, ";
  li.push(`Pay-as-you-go: ${unlock}${b.perMinPence}p/min × ${b.min} min = <b>${money(b.paygPence)}</b>`);
  if (b.hasPass) {
    li.push(`${b.passMins}-min pass${b.passesNeeded > 1 ? ` × ${b.passesNeeded}` : ""}: <b>${money(b.passPence)}</b>`);
    li.push(b.pass
      ? `✓ The pass wins — you save ${money(b.paygPence - b.passPence)} on this ride.`
      : `✓ Pay-as-you-go is cheaper for a ride this short.`);
  }
  return `<details class="cost-sub"><summary>${bikeApp().emoji} How the ${b.op} fare works</summary><ul>${li.map((x) => `<li>${x}</li>`).join("")}</ul></details>`;
}

// Lime return-trip tip — its own lime-green alert, below the bike calculation.
function bikeReturnAlert(legs) {
  const bike = legs.find((l) => l.mode === "cycle");
  if (!bike) return "";
  const b = bikePricing(Math.round(bike.durationMin));
  if (!b.returnPassCovers) return "";
  const rtPayg = 2 * b.paygPence;
  return `<div class="lime-alert">${bikeApp().emoji} Heading back the same way? One ${b.passMins}-min pass (${money(b.passUnitPence)}) covers there <b>and</b> back (${b.min * 2} min total) — vs ${money(rtPayg)} for two pay-as-you-go trips.</div>`;
}

// Open the single-route page: own screen, map at top (scrolls), itinerary below.
function openDetail(o) {
  const data = lastResult;
  clearDetailTimers();
  lastDetailOption = o;
  const pubOn = pubStop && !o.synthetic;

  // Anchor to the entered start/end; collapse the train journey into one section.
  const legs = mergeTrainLegs(o.legs.map((l) => ({ ...l })));
  if (legs.length) {
    legs[0] = { ...legs[0], from: data.origin.name, fromLL: data.origin };
    const last = { ...legs[legs.length - 1], to: data.dest.name, toLL: data.dest };
    if (last.mode === "walking") last.toDest = true;
    legs[legs.length - 1] = last;
  }

  const firstTransitIdx = legs.findIndex(TRANSIT_LEG);
  const fares = legFares(o, legs);
  const cards = legs.map((leg, i) => legCard(leg, i, firstTransitIdx, fares[i].fare, fares[i].note));
  if (pubOn) {
    let idx = legs.findIndex((l) => BOARD_MODES.includes(l.mode));
    if (idx < 0) idx = cards.length;
    cards.splice(idx, 0, '<li class="legc pub-step" style="--acc:#d9a521"><span class="legc-ic" style="background:#d9a521">🍺</span><div class="legc-body"><div class="legc-title pub-name">Finding a good pub…</div></div></li>');
  }

  const { dep, arr } = clockTimes(o);
  const { pence, prefix } = priceOf(o);
  const accActive = !o.synthetic && !!accessPreference();
  $("#detailContent").innerHTML = `
    <div class="disr-banner" id="disrBanner" hidden></div>
    <div class="itin-head">
      <div class="itin-row">
        <div class="itin-time">${fmtMin(o.durationMin)}</div>
        <div class="itin-cost">${prefix}${money(pence)}${peopleCount > 1 && pence > 0 ? " <small>pp</small>" : ""}</div>
      </div>
      <div class="itin-meta">${fmtClock(dep)} → ${fmtClock(arr)} · ${modeSummary(legs)}</div>
      ${accActive ? '<div class="itin-acc">♿ Step-free routing requested</div>' : ""}
    </div>
    <ol class="legs-list">${cards.join("")}</ol>
    ${costPanel(o, legs)}`;
  $("#detail").classList.remove("hidden");
  document.body.classList.add("detail-open");
  $("#detail").scrollTop = 0;
  setTimeout(() => {
    map.invalidateSize();
    drawRoute(data, o);
  }, 60);
  if (pubOn) loadPub(o);
  if (!o.synthetic) {
    // Detail-side live data must never break the page if TfL misbehaves.
    try { startCountdown(legs, firstTransitIdx); } catch (e) { console.warn("countdown:", e); }
    try { loadDisruptions(legs); } catch (e) { console.warn("disruptions:", e); }
    try { loadBusFrequencies(legs, clockTimes(o).dep); } catch (e) { console.warn("bus freq:", e); }
  }
}

// --- A2 live countdown -----------------------------------------------------
function clearDetailTimers() {
  detailTimers.forEach(clearInterval);
  detailTimers = [];
}
async function refreshCountdown(leg, idx) {
  const el = $(`#detailContent .leg-countdown[data-leg="${idx}"]`);
  if (!el) return;
  const list = await arrivals(leg.fromId, leg.line).catch(() => []);
  if (!list.length) { el.innerHTML = ""; return; } // no live prediction → show nothing
  const mins = Math.round(list[0].seconds / 60);
  el.innerHTML = `🟢 Departs <b>${mins <= 0 ? "now" : `in ${mins} min`}</b>`;
}
function startCountdown(legs, idx) {
  if (idx < 0) return;
  const leg = legs[idx];
  if (!leg || !leg.fromId) return;
  refreshCountdown(leg, idx);
  const t = setInterval(() => {
    if (document.hidden) return; // pause when backgrounded (save battery/quota)
    refreshCountdown(leg, idx);
  }, 30000);
  detailTimers.push(t);
}

// --- Bus frequency (how often the bus runs, on average) --------------------
// Typical headway by time band, for the searched date/time when live data
// isn't applicable (future searches) or unavailable.
function typicalBusFreq(dep) {
  if (!(dep instanceof Date) || isNaN(dep)) return 10;
  const h = dep.getHours() + dep.getMinutes() / 60;
  if (h < 5 || h >= 23.5) return 30;            // night
  if (isPeakDate(dep)) return 7;                 // weekday peak
  if (h >= 19) return 12;                        // evening
  return 10;                                     // daytime off-peak
}
// Average gap between upcoming live arrivals of a bus line at a stop (minutes).
async function liveBusFreq(stopId, lineName) {
  const list = await arrivals(stopId, lineName).catch(() => []);
  const secs = [...new Set(list.map((a) => a.seconds))].sort((a, b) => a - b).slice(0, 6);
  if (secs.length < 2) return null;
  let total = 0;
  for (let i = 1; i < secs.length; i++) total += secs[i] - secs[i - 1];
  return Math.max(1, Math.round(total / (secs.length - 1) / 60));
}
async function loadBusFrequencies(legs, dep) {
  const live = whenMode === "now"; // live arrivals only reflect "now"
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg.mode !== "bus") continue;
    const el = $(`#detailContent .leg-freq[data-leg="${i}"]`);
    if (!el) continue;
    let mins = null;
    if (live && leg.fromId) mins = await liveBusFreq(leg.fromId, leg.line);
    if (mins == null) mins = typicalBusFreq(dep);
    el.innerHTML = `🚌 Every ~<b>${mins} min</b>`;
  }
}

// --- D3 disruptions --------------------------------------------------------
const SEV = (s) => (s <= 6 ? "severe" : s < 10 ? "minor" : "ok"); // <10 = worse than Good Service
async function loadDisruptions(legs) {
  const ids = [...new Set(legs.filter(TRANSIT_LEG).map((l) => l.lineId).filter(Boolean))];
  if (!ids.length) return;
  const run = async () => {
    const statuses = await lineStatus(ids).catch(() => []);
    const bad = statuses.filter((s) => s.severity < 10);
    const banner = $("#disrBanner");
    if (!bad.length) {
      if (banner) { banner.hidden = true; banner.innerHTML = ""; }
      // clear per-leg badges
      $$(".leg-disr").forEach((e) => { e.hidden = true; e.innerHTML = ""; });
      return;
    }
    if (banner) {
      const worst = bad.reduce((w, s) => (s.severity < w.severity ? s : w), bad[0]);
      banner.hidden = false;
      banner.className = `disr-banner ${SEV(worst.severity)}`;
      banner.innerHTML =
        `<b>⚠️ ${bad.map((b) => b.name).join(", ")}: ${worst.description}</b>` +
        (worst.reason ? `<div class="disr-reason">${worst.reason}</div>` : "");
    }
    // per-leg badges (match by attribute value safely, no selector injection)
    const byId = new Map(bad.map((s) => [s.id, s]));
    $$(".leg-disr").forEach((e) => {
      const s = byId.get(e.getAttribute("data-line"));
      if (!s) return;
      e.hidden = false;
      e.className = `leg-disr ${SEV(s.severity)}`;
      e.textContent = `⚠️ ${s.description}${s.reason ? " — " + s.reason : ""}`;
    });
  };
  const safeRun = () => run().catch((err) => console.warn("disruptions:", err));
  safeRun();
  const t = setInterval(() => { if (!document.hidden) safeRun(); }, 45000);
  detailTimers.push(t);
}
// "Find alternative": re-plan avoiding the disrupted leg's mode, then reopen.
function findAlternative(leg) {
  if (!leg) return;
  const modeToAvoid = TRAIN_MODES.includes(leg.mode) ? "train" : leg.mode;
  const cb = $(`#avoid input[data-mode="${modeToAvoid === "tube" ? "tube" : modeToAvoid}"]`);
  if (cb) cb.checked = true;
  updateAvoidPreviews();
  closeDetail();
  plan();
}
const $$ = (s) => [...document.querySelectorAll(s)];

function closeDetail() {
  clearDetailTimers();
  lastDetailOption = null;
  $("#detail").classList.add("hidden");
  document.body.classList.remove("detail-open");
}

// --- C1: live "Avoid" preview deltas ---------------------------------------
// Shows "+12 min / +£0.80" next to each Avoid toggle before you commit.
const previewCache = new Map();
let previewToken = 0;
let previewTimer = null;
function baselineHeadline() {
  if (!lastResult || !lastResult.options) return null;
  const movers = [...lastResult.options];
  if (!movers.length) return null;
  const best = movers.reduce((a, b) => (a.durationMin <= b.durationMin ? a : b));
  return { min: best.durationMin, pence: best.costPence };
}
function avoidComboKey(extraAvoid) {
  const base = [...avoidedModes()];
  if (extraAvoid) base.push(extraAvoid);
  const o = lastResult || {};
  return `${o.origin?.lat},${o.dest?.lat}|${[...new Set(base)].sort().join(",")}`;
}
async function previewFor(input) {
  const base = baselineHeadline();
  const badge = input.closest("label").querySelector(".avoid-delta");
  if (!badge) return;
  if (input.checked || !base) { badge.textContent = ""; return; } // only preview turning ON
  const mode = input.dataset.mode;
  const key = avoidComboKey(mode);
  badge.innerHTML = '<span class="spin sm"></span>';
  const apply = (h) => {
    if (!h) return (badge.textContent = "");
    if (h === "none") { badge.textContent = "No route"; badge.classList.add("bad"); return; }
    const dMin = Math.round(h.min - base.min);
    const dP = h.pence - base.pence;
    const parts = [];
    if (dMin) parts.push(`${dMin > 0 ? "+" : ""}${dMin} min`);
    if (Math.abs(dP) >= 5) parts.push(`${dP > 0 ? "+" : "−"}${pounds(Math.abs(dP)).slice(1) ? "£" + (Math.abs(dP) / 100).toFixed(2) : ""}`);
    badge.classList.remove("bad");
    badge.textContent = parts.length ? parts.join(" · ") : "≈ same";
  };
  if (previewCache.has(key)) return apply(previewCache.get(key));
  const myToken = ++previewToken;
  try {
    const [bays, stations] = await Promise.all([baysPromise, stationsPromise]);
    // Candidate avoid set = current avoids + this toggle.
    const avoid = new Set([...avoidedModes(), mode]);
    const TRANSIT = ["tube", "dlr", "overground", "elizabeth-line", "national-rail", "tram", "bus", "walking"];
    const trainGroup = ["national-rail", "overground", "elizabeth-line", "dlr", "tram"];
    const transitModes = TRANSIT.filter((m) => {
      if (m === "tube" && avoid.has("tube")) return false;
      if (m === "bus" && avoid.has("bus")) return false;
      if (avoid.has("train") && trainGroup.includes(m)) return false;
      return true;
    });
    const data = await runPlan(lastResult.origin, lastResult.dest, bays, {
      stations, transitModes, allowBike: !avoid.has("bike"), allowCab: !avoid.has("cab"),
    });
    if (myToken !== previewToken) return; // a newer toggle superseded this one
    let h = "none";
    if (data.options && data.options.length) {
      const best = data.options.reduce((a, b) => (a.durationMin <= b.durationMin ? a : b));
      h = { min: best.durationMin, pence: best.costPence };
    }
    previewCache.set(key, h);
    apply(h);
  } catch {
    if (myToken === previewToken) badge.textContent = ""; // fail silently (don't block Update)
  }
}
function updateAvoidPreviews() {
  previewCache.clear();
  $$("#avoid input").forEach((i) => {
    const badge = i.closest("label").querySelector(".avoid-delta");
    if (badge) badge.textContent = "";
  });
}

// Pub within a 15-min walk of where this route boards; drop it into its step + map.
async function loadPub(o) {
  const step = $("#detailContent .pub-step");
  if (!step) return;
  const O = lastResult.origin, D = lastResult.dest;
  let stops = transitStops(o);
  if (!stops.length) stops = [{ name: "your route", lat: (O.lat + D.lat) / 2, lon: (O.lon + D.lon) / 2 }];
  if (!o._pub) o._pub = (await findPub(stops)) || { name: null };
  const body = step.querySelector(".legc-body");
  if (!body) return;
  const pub = o._pub;
  if (!pub.name) return (body.innerHTML = '<div class="pub-name">No pub within a short walk of a stop</div>');
  emojiMarker(pub.lat, pub.lon, "🍺", pub.name).addTo(layers); // show on the map
  const query = encodeURIComponent([pub.name, pub.addr].filter(Boolean).join(", "));
  const gmaps = `https://www.google.com/maps/search/?api=1&query=${query}`;
  // Label any drinks the pub actually lists in OSM (best-effort; usually empty).
  const seen = new Set();
  const beers = [];
  for (const d of pub.drinks || []) {
    const m = drinkMatch(d);
    if (m && m.domain && !seen.has(m.name)) { seen.add(m.name); beers.push(m); }
  }
  const beerHtml = beers.length
    ? `<ul class="pub-beers">${beers.slice(0, 8).map((m) => `<li><img class="beer-logo" src="${favicon(m.domain)}" alt="" onerror="this.remove()"> ${m.name}</li>`).join("")}</ul>`
    : "";
  body.innerHTML = `
    <a class="pub-name" href="${gmaps}" target="_blank" rel="noopener">${pub.name} ↗</a>
    <div class="step-sub">${walkMin(pub.metres || 0)} min walk from ${pub.stopName || "the stop"}</div>
    ${beerHtml}`;
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
  updateAvoidPreviews();
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
  ["0.38", [
    "Best option is back at the top of the results list.",
  ]],
  ["0.37", [
    "Cleaner cost breakdown: per-leg prices removed from the itinerary; the bottom calculator merges all tube/rail into one line and shows a single Total (with Per-traveller only when in a group).",
    "The Lime pass return-trip tip now sits in its own lime-green box under the bike calculation.",
    "Removed TrainPal and Apple Maps options, and the disruption ‘Find alternative’ button. Lime icon opens the Lime app.",
  ]],
  ["0.36", [
    "Each leg now has an “open app” icon on the right — bus/tube to your maps app, the bike leg to Lime/Forest, trains to Trainline/TrainPal (for that exact section), cabs to Uber/Bolt.",
    "Custom filters: switch your maps app (Google / Citymapper / Apple), bike (Lime / Forest) and train tickets (Trainline / TrainPal).",
    "Best result now sits at the bottom of the list, nearest the search bar.",
    "Railcard only shows when a normal National Rail train is involved (never for tube/Overground).",
    "Tidied labels: trains show where they terminate, tubes show the bound, bus shows “Every ~N min”, no “Free” clutter on walks.",
  ]],
  ["0.35", [
    "Pub stop now searches around every stop you actually get on/off at (not just the first), so it finds a pub right by a station on your route.",
    "Where a pub lists its beers in OpenStreetMap, those are now shown (sparse data, so often blank).",
    "“Cycle” is now “Lime Bike”; the route header shows the vehicles used (e.g. “Tube · Bus”) instead of “0 changes”.",
    "Cab cost now clearly splits per traveller; clearer Custom (Filters) tab.",
  ]],
  ["0.34", [
    "Each leg of the route now shows its own fare — the tube/rail price (with its zones) sits right on the leg, not just in the breakdown.",
    "Bus legs show how often the bus runs on average — live frequency when you're travelling now, or a typical figure for the time and day you searched.",
    "The “Reset map” button now only appears once you've actually moved or zoomed the map.",
  ]],
  ["0.33", [
    "Station fare zones can now be refreshed from TfL's full station list, so zone-based fares cover the whole network accurately.",
  ]],
  ["0.32", [
    "Lime fares now show their workings: pay-as-you-go (£1 + 29p/min) vs a 30-min pass, whichever is cheaper — with a tip when one pass also covers your return.",
    "Tube/rail zones now come from a station lookup (more accurate than the distance estimate), falling back to the estimate for any station not yet listed.",
  ]],
  ["0.31", [
    "Tube/rail fares are now estimated by zone (e.g. Zones 1–3, peak/off-peak) instead of a flat fare — shown in the cost breakdown and used for ranking.",
  ]],
  ["0.30", [
    "Route page rebuilt as a step-by-step itinerary: mode icons, official line colours, walk times, changes count and depart/arrive clock times.",
    "Live departure countdown on your first transit leg, refreshing every 30s (pauses when the tab is hidden).",
    "Cost breakdown per leg and per traveller, with a party total and capping caveat.",
    "Live disruption alerts: a banner when a line on your route is delayed or suspended, with a Find alternative action.",
    "Accessibility filters (step-free only / avoid stairs), saved across visits.",
    "Avoid toggles now preview their time/cost impact before you tap Update.",
    "Clear loading skeletons and recoverable empty / offline / error states.",
  ]],
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
  if (resetBtn) resetBtn.style.display = "none"; // hidden until the user moves the map
  map.fitBounds(L.latLngBounds(pts).pad(0.25));
}

// --- C1 wiring: debounced preview on each Avoid toggle ---------------------
$$("#avoid input").forEach((input) => {
  input.addEventListener("change", () => {
    clearTimeout(previewTimer);
    // Run a preview for every OFF toggle (turning one ON clears its own delta).
    previewTimer = setTimeout(() => {
      $$("#avoid input").forEach((i) => previewFor(i));
    }, 400);
  });
});

// --- B3 wiring: persist the accessibility preference -----------------------
restoreAccess();
$$("#access input").forEach((i) => i.addEventListener("change", saveAccess));

// --- C3: react to connectivity changes -------------------------------------
window.addEventListener("offline", () => {
  if (!document.body.classList.contains("detail-open")) {
    showState("offline", {
      title: "You're offline",
      body: "Quickest needs a connection to plan a route." + (lastResult ? " Your last route is still saved." : ""),
      actions: lastResult ? [{ label: "Show last route", onClick: () => render(lastResult) }] : [],
    });
  }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
