/* FitMatch service worker.
 * For the MVP all scraping + matching happens in the popup (offline, no key).
 * This worker is where the real Claude call will live for the hard pages —
 * when only a model hint ("model is 180 cm, wears M") is available and we need
 * the AI to estimate garment measurements. Stubbed for now.
 */

const CONFIG = {
  // The production backend, baked in so the AI works out of the box for users.
  // The URL is not secret — the Anthropic key lives only in the backend's env.
  // Change it here (not via storage) if the backend ever moves.
  defaultEndpoint: "https://findfitmatch.netlify.app/.netlify/functions/estimate",
};

// A stable anonymous per-install id, so the backend can apply a fair daily quota
// without identifying the user. Generated once, stored locally.
async function getClientId() {
  const { clientId } = await chrome.storage.local.get("clientId");
  if (clientId) return clientId;
  const id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random();
  await chrome.storage.local.set({ clientId: id });
  return id;
}

// One-time cleanup: earlier builds let the endpoint be overridden from the UI and
// stored it. That stored value now shadows the built-in endpoint and can point at
// a site that no longer exists, so drop it.
chrome.storage.local.remove("apiEndpoint");

async function aiEstimateGarment(payload) {
  const endpoint = CONFIG.defaultEndpoint;
  if (!endpoint) {
    return { ok: false, reason: "no-endpoint" };
  }
  try {
    const clientId = await getClientId();
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, clientId }),
    });
    if (res.status === 429) return { ok: false, reason: "rate-limited" };
    if (!res.ok) return { ok: false, reason: "http-" + res.status };
    return await res.json();
  } catch (e) {
    return { ok: false, reason: "fetch-failed", error: String(e) };
  }
}

/* ---- anonymous, aggregate telemetry --------------------------------------
 * Only counts: which events happened and, for results, the shop DOMAIN.
 * Never a product, a URL, a measurement or anything identifying. Batched so a
 * burst of activity costs one request, and silently dropped if it fails —
 * telemetry must never affect the product.
 */
const TRACK_ENDPOINT = CONFIG.defaultEndpoint.replace(/\/estimate$/, "/track");
const FLUSH_DELAY_MS = 4000;
let queue = [];
let flushTimer = null;

async function flush() {
  flushTimer = null;
  const events = queue.splice(0, 20);
  if (!events.length) return;
  try {
    const clientId = await getClientId();
    await fetch(TRACK_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, events }),
    });
  } catch {
    /* ignore — never surface telemetry problems to the user */
  }
}

function track(evt) {
  queue.push(evt);
  if (queue.length >= 20) return flush();
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "AI_ESTIMATE") {
    aiEstimateGarment(msg.payload).then(sendResponse);
    return true; // async
  }
  if (msg?.type === "TRACK") {
    track(msg.event || {});
  }
});
