/* FitMatch stats — password-protected read of the aggregate counters.
 * Set STATS_KEY as an environment variable in Netlify.
 *
 * Reads one document per day, all 30 in parallel — a whole month is 31 requests
 * rather than several hundred sequential ones.
 */
const { getStore } = require("@netlify/blobs");

function blobStore(name) {
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  return siteID && token ? getStore({ name, siteID, token }) : getStore(name);
}

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-stats-key",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const DAYS = 30;
const SOURCES = ["size-table", "ai-estimate", "generic"];
const VERDICTS = ["small", "perfect", "big"];

// Length-independent-ish comparison so the key can't be guessed byte by byte.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function blankDay(date) {
  return {
    date,
    active: 0,
    analyze: 0,
    profile_saved: 0,
    affiliate_click: 0,
    src: { "size-table": 0, "ai-estimate": 0, generic: 0 },
    fb: { small: 0, perfect: 0, big: 0 },
    shops: {},
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

  const expected = process.env.STATS_KEY;
  if (!expected) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: "STATS_KEY not configured" }) };
  }
  if (!safeEqual(event.headers["x-stats-key"] || "", expected)) {
    await new Promise((r) => setTimeout(r, 600)); // slow down guessing
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ ok: false, error: "unauthorized" }) };
  }

  try {
    const store = blobStore("fitmatch-stats");
    const dates = [];
    for (let i = DAYS - 1; i >= 0; i--) {
      dates.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10));
    }

    const [installsRaw, ...raws] = await Promise.all([
      store.get("installs_total"),
      ...dates.map((d) => store.get(`day:${d}`)),
    ]);

    const days = dates.map((d, i) => Object.assign(blankDay(d), JSON.parse(raws[i] || "null") || {}, { date: d }));

    const sum = (pick) => days.reduce((t, r) => t + (pick(r) || 0), 0);
    const shops = {};
    for (const day of days) {
      for (const [name, counts] of Object.entries(day.shops || {})) {
        shops[name] = shops[name] || { "size-table": 0, "ai-estimate": 0, generic: 0, total: 0 };
        for (const s of SOURCES) {
          shops[name][s] += counts[s] || 0;
          shops[name].total += counts[s] || 0;
        }
      }
    }

    const totals = {
      installs: Number(installsRaw || 0),
      analyze: sum((r) => r.analyze),
      profile_saved: sum((r) => r.profile_saved),
      affiliate_click: sum((r) => r.affiliate_click),
      src: Object.fromEntries(SOURCES.map((s) => [s, sum((r) => r.src[s])])),
      fb: Object.fromEntries(VERDICTS.map((v) => [v, sum((r) => r.fb[v])])),
    };

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: true, days, totals, shops, generatedAt: new Date().toISOString() }),
    };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: String(err) }) };
  }
};
