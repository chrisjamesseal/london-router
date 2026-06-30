# Real National Rail train fares

TfL's journey planner returns fares for the tube, DLR, Overground, the Elizabeth
line and buses — but **not** for National Rail services (Southeastern,
Southern, Thameslink, GWR, etc.). Those fares aren't zonal and TfL simply
doesn't carry them, which is why journeys with a train leg used to show a zone
*estimate* with a `*` and a link to Trainline.

This document explains how Quickest can show a **real** "from £X" walk-up single
for National Rail legs, and how to switch it on. It's optional: with nothing
configured the app behaves exactly as before (estimate + `*` + Trainline link).

---

## The research: where do real UK rail fares come from?

UK rail fares are published by the Rail Delivery Group (RDG). There is no free,
keyless, CORS-enabled public endpoint a static web app can call directly. The
realistic options:

| Source | Real fares? | Cost / access | Usable from a static PWA directly? |
| --- | --- | --- | --- |
| **TfL Unified API** | Tube/DLR/Overground/Elizabeth/bus only | Free | Yes — already used. **No National Rail fares.** |
| **BR Fares legacy API** (`gw.brfares.com`) | ✅ Full National Rail fares | Free for non-commercial use, ~100 calls/day, **registration + key required** | No — key must stay secret, and it sends no CORS headers |
| **RDG / OJP fares feed** | ✅ Official, complete | Licensed/commercial, contractual | No |
| **Trainline / 3rd-party affiliate** | ✅ | Affiliate agreement, deep links only (no fare API) | No (deep links only — what we already do) |
| **Scraping retailer pages** | ✅ | Fragile, against ToS, IP-blocked | No |
| **NRE Darwin / OpenLDBWS** | ❌ live times only, not fares | Free key | N/A |

**Conclusion.** The only source that gives complete National Rail fares for free
is the **BR Fares legacy API**. It can't be called from the browser directly
because (a) the key would be exposed in client JS, and (b) it sends no CORS
headers. The fix is a tiny **proxy** you host: it keeps the key server-side, adds
CORS, and caches results so you stay under the free daily allowance. The proxy
in `workers/` is ~120 lines and runs free on Cloudflare Workers.

### The BR Fares legacy API

- **Autocomplete** a station name → location/CRS code:
  `GET https://gw.brfares.com/legacy_ac_loc?term=london%20bridge`
- **Query fares** between two CRS codes:
  `GET https://gw.brfares.com/legacy_querysimple?orig=LBG&dest=RAM&rlc=`
- **Auth:** HTTP Basic, your API key as the username and an empty password
  (`Authorization: Basic base64(KEY + ":")`).
- **Response shape** (trimmed):
  ```json
  {
    "fares": [
      {
        "ticket": {
          "name": "Anytime Day Single",
          "type":   { "desc": "SINGLE" },
          "tclass": { "desc": "STD" }
        },
        "adult": { "fare": 790 },
        "child": { "fare": 395 }
      }
    ]
  }
  ```
  `adult.fare` is an **integer number of pence**. The headline "from" price is
  the cheapest standard-class (`tclass.desc === "STD"`) single
  (`type.desc === "SINGLE"`).

---

## How it fits together

```
  Browser (Quickest PWA)                Your Cloudflare Worker            BR Fares
  ─────────────────────                 ──────────────────────           ────────
  detail page has a train leg
        │  GET <proxy>/fare?from=London%20Bridge&to=Ramsgate
        ▼
                                        resolve CRS via legacy_ac_loc ───▶
                                        query legacy_querysimple ────────▶
                                        pick cheapest STD SINGLE
        ◀──── { fromPence: 2840, ticketName, fromCrs, toCrs, url } ──────
  swap the estimate → "from £28.40"
```

- `lib/trainfares.js` (client) reads the proxy URL from
  `localStorage["quickest.faresEndpoint"]` and calls `<proxy>/fare?from=&to=`.
- `workers/brfares-proxy.js` (server) holds the key, talks to BR Fares, parses
  the cheapest standard single, and caches each pair for a day.
- If the proxy URL is unset or any call fails, the app silently falls back to the
  existing estimate + Trainline link. Zero risk when off.

---

## Setup (about 5 minutes, free)

### 1. Get a BR Fares API key

Register for free non-commercial access at <https://www.brfares.com/> (look for
the API / developer signup, or email them). You'll get an API key and a daily
call allowance (around 100/day — the proxy caches to stay well under it).

### 2. Deploy the proxy to Cloudflare Workers

You need a free Cloudflare account and Node installed.

```bash
cd workers
npx wrangler login                 # opens the browser once
npx wrangler secret put BRFARES_KEY  # paste your BR Fares key when prompted
npx wrangler deploy
```

`wrangler deploy` prints a URL like:

```
https://brfares-proxy.<your-subdomain>.workers.dev
```

Quick check (should return JSON with a `fromPence`):

```bash
curl "https://brfares-proxy.<your-subdomain>.workers.dev/fare?from=London%20Bridge&to=Ramsgate"
```

### 3. Tell Quickest to use it

Two ways:

- **In the app:** open the **Custom** tab → **Real train fares (beta)** → paste
  the Worker URL into the box. It's saved on your device.
- **Or from the console:**
  ```js
  localStorage.setItem("quickest.faresEndpoint", "https://brfares-proxy.<you>.workers.dev")
  ```

Now plan a journey that includes a National Rail leg and open it: the cost
breakdown shows the real fare (no `*`), e.g. *"🚆 Train · Anytime Day Single —
£28.40"*. Clear the box to go back to estimates.

---

## Notes & limitations

- The headline is the **cheapest standard-class single** for the route. Off-peak
  singles aren't sold everywhere, so the figure shown is genuinely the cheapest
  walk-up single BR Fares returns — not necessarily what an Advance ticket would
  cost. The Trainline link is kept so you can hunt for cheaper Advances.
- Fares are **per person**; the app multiplies by the traveller count like every
  other fare.
- The proxy day-caches by station pair, so repeated lookups don't burn quota.
- For **commercial** use you must license fares from RDG instead of using the BR
  Fares non-commercial tier.
- Station-name → CRS matching is best-effort. You can also pass CRS codes
  directly (e.g. `?from=LBG&to=RAM`).
