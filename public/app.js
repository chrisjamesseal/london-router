const $ = (s) => document.querySelector(s);
const map = L.map("map", { zoomControl: false }).setView([51.5074, -0.1278], 12);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "© OpenStreetMap",
}).addTo(map);
L.control.zoom({ position: "bottomright" }).addTo(map);

let layers = L.layerGroup().addTo(map);
let lastResult = null;

const MODE_ICON = {
  walking: "🚶",
  cycle: "🚲",
  bus: "🚌",
  tube: "🚇",
  dlr: "🚈",
  overground: "🚆",
  "elizabeth-line": "🚆",
  "national-rail": "🚆",
  tram: "🚊",
};

function status(msg, spinner) {
  const el = $("#status");
  if (!msg) return el.classList.add("hidden");
  el.innerHTML = (spinner ? '<span class="spin"></span>' : "") + msg;
  el.classList.remove("hidden");
}

function pounds(p) {
  return "£" + (p / 100).toFixed(2);
}

$("#locBtn").onclick = () => {
  if (!navigator.geolocation) return status("No geolocation", false);
  status("Locating…", true);
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      $("#from").value = `${latitude.toFixed(5)},${longitude.toFixed(5)}`;
      $("#from").dataset.label = "My location";
      map.setView([latitude, longitude], 14);
      status("", false);
    },
    () => status("Location blocked — type an address", false),
    { enableHighAccuracy: true, timeout: 8000 }
  );
};

$("#go").onclick = plan;
$("#to").addEventListener("keydown", (e) => e.key === "Enter" && plan());

async function plan() {
  const origin = $("#from").value.trim();
  const dest = $("#to").value.trim();
  if (!origin || !dest) return status("Enter both From and To", false);
  status("Finding the quickest way…", true);
  $("#results").innerHTML = "";
  try {
    const res = await fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ origin, dest }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Planning failed");
    lastResult = data;
    render(data);
    status("", false);
  } catch (e) {
    status(e.message, false);
    setTimeout(() => status("", false), 3500);
  }
}

function legChip(leg) {
  const ic = MODE_ICON[leg.mode] || "•";
  let txt = leg.line || leg.mode;
  if (leg.mode === "cycle") txt = `${Math.round(leg.durationMin)}m bike`;
  else if (leg.mode === "walking") txt = `${Math.round(leg.durationMin)}m walk`;
  else if (leg.line) txt = leg.line;
  return `<span class="leg ${leg.mode}"><span class="ic">${ic}</span>${txt}</span>`;
}

function render(data) {
  const wrap = $("#results");
  wrap.innerHTML = "";
  data.options.forEach((o, i) => {
    const card = document.createElement("div");
    card.className = "card" + (o.fastest ? " fastest" : "");
    const legs = o.legs
      .map(legChip)
      .join('<span class="arrow">›</span>');
    let park = "";
    if (o.pickupBay || o.dropoffBay) {
      const pu = o.pickupBay
        ? `Grab a bike at <b>${o.pickupBay.name}</b> (${o.pickupBay.metresAway}m)`
        : "";
      const dp = o.dropoffBay
        ? `Park at <b>${o.dropoffBay.name}</b>${o.station ? " by " + o.station : ""} (${o.dropoffBay.metresAway}m)`
        : "";
      park = `<div class="park">🅿️ ${[pu, dp].filter(Boolean).join(" → ")}</div>`;
    }
    card.innerHTML = `
      ${o.fastest ? '<span class="badge">Quickest</span>' : ""}
      <div class="top">
        <div class="time">${o.durationMin}<small> min</small></div>
        <div class="meta">${pounds(o.costPence)}<br>${o.walkMetres}m walk</div>
      </div>
      <div class="label">${o.label}</div>
      <div class="legs">${legs}</div>
      ${park}`;
    card.onclick = () => select(i, card);
    wrap.appendChild(card);
  });
  if (data.options[0]) select(0, wrap.firstElementChild);
}

function select(i, card) {
  document.querySelectorAll(".card").forEach((c) => c.classList.remove("sel"));
  card.classList.add("sel");
  drawRoute(lastResult, lastResult.options[i]);
}

function marker(lat, lon, color, label) {
  return L.circleMarker([lat, lon], {
    radius: 8,
    color: "#fff",
    weight: 2,
    fillColor: color,
    fillOpacity: 1,
  }).bindTooltip(label, { permanent: false });
}

function drawRoute(data, o) {
  layers.clearLayers();
  const O = data.origin, D = data.dest;
  const pts = [[O.lat, O.lon]];
  marker(O.lat, O.lon, "#0b8a4a", "Start").addTo(layers);
  if (o.pickupBay) {
    marker(o.pickupBay.lat, o.pickupBay.lon, "#2bb673", "🚲 Grab bike").addTo(layers);
    pts.push([o.pickupBay.lat, o.pickupBay.lon]);
  }
  if (o.dropoffBay) {
    marker(o.dropoffBay.lat, o.dropoffBay.lon, "#2bb673", "🅿️ Park bike").addTo(layers);
    pts.push([o.dropoffBay.lat, o.dropoffBay.lon]);
  }
  pts.push([D.lat, D.lon]);
  marker(D.lat, D.lon, "#e0533d", "Destination").addTo(layers);
  L.polyline(pts, { color: "#0b8a4a", weight: 3, dashArray: "6 6", opacity: 0.7 }).addTo(layers);
  map.fitBounds(L.latLngBounds(pts).pad(0.25));
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
