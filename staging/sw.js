// Staging service worker — scoped to /staging/ only, so it never touches the
// live root app. Network-first for our own files (testers always get the latest
// build) with a cache fallback so the offline state (C3) still works.
const CACHE = "quickest-staging-v1";
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
  "../data/bays.json",
  "../data/stations.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("quickest-staging") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // let TfL / tiles / fonts pass

  // Network-first: fresh when online, cached copy when offline.
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      try {
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
      } catch {
        const cached = await cache.match(request);
        return cached || Response.error();
      }
    })
  );
});
