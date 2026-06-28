/* FitMatch service worker.
 * For the MVP all scraping + matching happens in the popup (offline, no key).
 * This worker is where the real Claude call will live for the hard pages —
 * when only a model hint ("model is 180 cm, wears M") is available and we need
 * the AI to estimate garment measurements. Stubbed for now.
 */

const CONFIG = {
  // Set in chrome.storage.local under "apiEndpoint" to enable AI fallback.
  // Point it at YOUR backend (never ship an Anthropic key inside the extension).
  defaultEndpoint: "",
};

async function aiEstimateGarment(payload) {
  const { apiEndpoint } = await chrome.storage.local.get("apiEndpoint");
  const endpoint = apiEndpoint || CONFIG.defaultEndpoint;
  if (!endpoint) {
    return { ok: false, reason: "no-endpoint" };
  }
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { ok: false, reason: "http-" + res.status };
    return await res.json();
  } catch (e) {
    return { ok: false, reason: "fetch-failed", error: String(e) };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "AI_ESTIMATE") {
    aiEstimateGarment(msg.payload).then(sendResponse);
    return true; // async
  }
});
