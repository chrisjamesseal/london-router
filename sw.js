// Service worker: makes the app installable + fast on repeat visits.
// - App shell + engine modules are pre-cached on install.
// - Same-origin GETs (incl. the big bays.json) are cached on first use
//   (stale-while-revalidate).
// - Live API calls to TfL / Nominatim always hit the network.
const CACHE = "quickest-v19";
const SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./icon.svg",
  "./manifest.webmanifest",
  "./lib/engine.js",
  "./lib/tfl.js",
  "./lib/fares.js",
  "./lib/geo.js",
  "./lib/geocode.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Only cache our own origin; let cross-origin (TfL, Nominatim, tiles) pass.
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((res) => {
          if (res.ok) cache.put(request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
