# Quickest · London

A personal multimodal journey planner for London that finds the **genuinely
quickest** way across town by combining **e-bikes + tube + bus + walking** —
including the trick Google Maps never suggests: *bike to a faster or further
station, then take transit.*

Mobile-first PWA. Add it to your home screen and it behaves like a native app.

## What it does

For any origin → destination it races three strategies and ranks them by time,
showing **cost** and **walking distance** for each:

1. **Transit only** — what Google / Citymapper give you.
2. **E-bike all the way** — usually wins on short hops.
3. **E-bike to a faster station → transit** — the gap most apps miss.

Each bike option tells you **where to grab and where to park** the bike
(nearest cycle bay + how far away), drawn on the map.

## Run it

No dependencies — just Node 18+.

```bash
node server.js                 # http://localhost:3000
```

Refresh the parking-bay dataset (Santander docks + OSM cycle parking):

```bash
npm run fetch-bays
```

### Put it on your phone (temporary public URL)

```bash
# one-off: grab the standalone binary, then:
cloudflared tunnel --url http://localhost:3000
```

Open the printed `https://….trycloudflare.com` link on your phone and
"Add to Home Screen". The URL lasts only while your Mac is awake and the
tunnel is running.

## How it's built

| File | Role |
|------|------|
| `server.js` | Zero-dep Node `http` server: serves the PWA + `/api/plan`, `/api/geocode`, `/api/bays`. |
| `lib/engine.js` | The routing engine — generates and races the three strategies. |
| `lib/tfl.js` | TfL Unified API client (journeys, nearby stations, Santander docks). No key needed. |
| `lib/fares.js` | Cost model (editable bike rates; TfL fares when available). |
| `lib/geo.js` | Distance + bike/walk time helpers. |
| `scripts/fetch-bays.js` | Builds `data/bays.json` from TfL + OpenStreetMap. |
| `public/` | The mobile PWA (Leaflet map, service worker, manifest). |

## Data sources

- **TfL Unified API** — transit routing, accurate bike-leg times (`mode=cycle`),
  nearby stations, Santander Cycle docks. No API key required at low volume;
  set `TFL_APP_KEY` for higher rate limits.
- **OpenStreetMap (Overpass)** — ~19k cycle-parking locations as the dockless
  park-bay layer (Lime/Forest don't publish open feeds for London).
- **Nominatim** — geocoding, bounded to London.

## Tuning

Bike pricing and speeds live in `lib/fares.js` and `lib/geo.js`. Fare estimates
are approximate — adjust to taste.
