/* FitMatch telemetry — anonymous, aggregate counters only.
 *
 * Stores nothing that identifies a person and nothing about WHICH product anyone
 * looked at: only per-day tallies, plus a shop DOMAIN so we can see where the
 * page reader struggles. Called in small batches by the extension.
 *
 * One JSON document per day, so a whole day is a single read + single write
 * instead of a dozen round-trips.
 */
const { getStore } = require("@netlify/blobs");

// Netlify does not always auto-configure Blobs on newer sites. Fall back to
// explicit credentials when they are available, so this works either way.
function blobStore(name) {
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  return siteID && token ? getStore({ name, siteID, token }) : getStore(name);
}

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Strict whitelists — nothing else is ever written to storage.
const EVENTS = new Set(["analyze", "profile_saved", "affiliate_click", "result", "feedback"]);
const SOURCES = new Set(["size-table", "ai-estimate", "generic"]);
const VERDICTS = new Set(["small", "perfect", "big"]);

const today = () => new Date().toISOString().slice(0, 10);
const cleanDomain = (s) =>
  typeof s === "string" ? s.toLowerCase().replace(/^www\./, "").replace(/[^a-z0-9.-]/g, "").slice(0, 60) : "";

function blankDay() {
  return {
    active: 0,
    analyze: 0,
    profile_saved: 0,
    affiliate_click: 0,
    src: { "size-table": 0, "ai-estimate": 0, generic: 0 },
    fb: { small: 0, perfect: 0, big: 0 },
    shops: {},
  };
}

// Marks a key once; returns true the first time only.
async function firstTime(store, key) {
  if (await store.get(key)) return false;
  await store.set(key, "1");
  return true;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: "Method not allowed" };

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false }) };
  }

  const clientId = typeof payload.clientId === "string" ? payload.clientId.slice(0, 64) : null;
  const events = Array.isArray(payload.events) ? payload.events.slice(0, 20) : [];
  if (!clientId || !events.length) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false }) };
  }

  try {
    const store = blobStore("fitmatch-stats");
    const d = today();

    const [isNewInstall, isNewToday, raw] = await Promise.all([
      firstTime(store, `c:${clientId}`),
      firstTime(store, `a:${d}:${clientId}`),
      store.get(`day:${d}`),
    ]);

    const day = Object.assign(blankDay(), JSON.parse(raw || "null") || {});
    if (isNewToday) day.active += 1;

    for (const e of events) {
      const name = e && typeof e.name === "string" ? e.name : "";
      if (!EVENTS.has(name)) continue;
      if (typeof day[name] === "number") day[name] += 1;

      if (name === "result") {
        const src = SOURCES.has(e.source) ? e.source : null;
        const shop = cleanDomain(e.shop);
        if (src) day.src[src] += 1;
        if (src && shop) {
          day.shops[shop] = day.shops[shop] || { "size-table": 0, "ai-estimate": 0, generic: 0 };
          day.shops[shop][src] += 1;
        }
      }
      if (name === "feedback" && VERDICTS.has(e.verdict)) day.fb[e.verdict] += 1;
    }

    const writes = [store.set(`day:${d}`, JSON.stringify(day))];
    if (isNewInstall) {
      const n = Number((await store.get("installs_total")) || 0);
      writes.push(store.set("installs_total", String(n + 1)));
    }
    await Promise.all(writes);

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    // Telemetry must never break the product — fail quietly.
    console.error("track error:", String(err));
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false }) };
  }
};
