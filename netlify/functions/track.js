/* FitMatch telemetry — anonymous, aggregate counters only.
 *
 * Stores nothing that identifies a person and nothing about WHICH product anyone
 * looked at: only per-day tallies, plus a shop DOMAIN so we can see where the
 * page reader struggles. Called in small batches by the extension.
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

async function inc(store, key, by = 1) {
  const n = Number((await store.get(key)) || 0);
  await store.set(key, String(n + by));
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

    // Install + daily-active counts, without ever listing or storing a profile.
    if (await firstTime(store, `c:${clientId}`)) await inc(store, "installs_total");
    if (await firstTime(store, `a:${d}:${clientId}`)) await inc(store, `d:${d}:active`);

    for (const e of events) {
      const name = e && typeof e.name === "string" ? e.name : "";
      if (!EVENTS.has(name)) continue;
      await inc(store, `d:${d}:${name}`);

      if (name === "result") {
        const src = SOURCES.has(e.source) ? e.source : null;
        const shop = cleanDomain(e.shop);
        if (src) await inc(store, `d:${d}:src:${src}`);
        if (src && shop) await inc(store, `shop:${shop}:${src}`);
      }
      if (name === "feedback" && VERDICTS.has(e.verdict)) {
        await inc(store, `d:${d}:fb:${e.verdict}`);
      }
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    // Telemetry must never break the product — fail quietly.
    console.error("track error:", String(err));
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false }) };
  }
};
