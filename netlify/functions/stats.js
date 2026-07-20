/* FitMatch stats — password-protected read of the aggregate counters.
 * Set STATS_KEY as an environment variable in Netlify.
 */
const { getStore } = require("@netlify/blobs");

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

const num = async (store, key) => Number((await store.get(key)) || 0);

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

  const expected = process.env.STATS_KEY;
  if (!expected) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: "STATS_KEY not configured" }) };
  }
  const given = event.headers["x-stats-key"] || "";
  if (!safeEqual(given, expected)) {
    await new Promise((r) => setTimeout(r, 600)); // slow down guessing
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ ok: false, error: "unauthorized" }) };
  }

  try {
    const store = getStore("fitmatch-stats");
    const days = [];
    for (let i = DAYS - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
      const row = { date: d };
      row.active = await num(store, `d:${d}:active`);
      row.analyze = await num(store, `d:${d}:analyze`);
      row.profile_saved = await num(store, `d:${d}:profile_saved`);
      row.affiliate_click = await num(store, `d:${d}:affiliate_click`);
      row.src = {};
      for (const s of SOURCES) row.src[s] = await num(store, `d:${d}:src:${s}`);
      row.fb = {};
      for (const v of VERDICTS) row.fb[v] = await num(store, `d:${d}:fb:${v}`);
      days.push(row);
    }

    const sum = (pick) => days.reduce((t, r) => t + pick(r), 0);
    const totals = {
      installs: await num(store, "installs_total"),
      analyze: sum((r) => r.analyze),
      profile_saved: sum((r) => r.profile_saved),
      affiliate_click: sum((r) => r.affiliate_click),
      src: Object.fromEntries(SOURCES.map((s) => [s, sum((r) => r.src[s])])),
      fb: Object.fromEntries(VERDICTS.map((v) => [v, sum((r) => r.fb[v])])),
    };

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: true, days, totals, generatedAt: new Date().toISOString() }),
    };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: String(err) }) };
  }
};
