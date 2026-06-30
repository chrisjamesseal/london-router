// Real National Rail fares, fetched from a small proxy you deploy (it holds the
// BR Fares API key server-side, adds CORS, and caches). See docs/TRAIN_FARES.md.
//
// When no proxy is configured the app falls back to the "*" estimate + Trainline
// link, so this is entirely optional and safe to leave unset.

// Where to read the proxy URL from (localStorage so it needs no rebuild):
//   localStorage.setItem("quickest.faresEndpoint", "https://your-worker.workers.dev")
export function faresEndpoint() {
  try { return (localStorage.getItem("quickest.faresEndpoint") || "").trim(); } catch { return ""; }
}

const cache = new Map(); // session cache, keyed by "from|to"

// Returns { fromPence, anytimePence, ticketName, fromCrs, toCrs, url } or null.
export async function trainFare(fromName, toName) {
  const ep = faresEndpoint();
  if (!ep || !fromName || !toName) return null;
  const key = `${fromName}|${toName}`;
  if (cache.has(key)) return cache.get(key);
  const url = `${ep.replace(/\/+$/, "")}/fare?from=${encodeURIComponent(fromName)}&to=${encodeURIComponent(toName)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error("fares " + r.status);
    const j = await r.json();
    const out = j && typeof j.fromPence === "number" && j.fromPence > 0 ? j : null;
    cache.set(key, out);
    return out;
  } catch {
    return null; // any failure → silent fall back to the estimate
  } finally {
    clearTimeout(t);
  }
}
