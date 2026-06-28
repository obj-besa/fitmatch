/* EXAMPLE Netlify Function — multimodal AI fallback for FitMatch.
 *
 * Deploy on YOUR backend with ANTHROPIC_API_KEY set. NEVER put the key in the
 * extension. Receives the product page's images + text + model hint, asks Claude
 * to estimate the garment's body-fit measurements in cm, and returns them in the
 * shape engine.js expects (so the same local matching + UI is reused).
 *
 *   npm i @anthropic-ai/sdk
 *   netlify env:set ANTHROPIC_API_KEY sk-ant-...
 */
const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: "Method not allowed" };

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: "bad json" }) };
  }

  const { pageText = "", images = [], type = "unknown", modelHint = null, fit = null, gender = "unisex" } = payload;

  const prompt = `Du er ekspert i tøjstørrelser. Ud fra produktbillederne og sidens tekst
skal du estimere en størrelsestabel i CENTIMETER for de KROPSMÅL tøjet "passer til".
Tag højde for snittet du ser på billederne (oversized, slim, regular osv.) og
model-info hvis den findes.

Kontekst:
- Tøjtype: ${type}
- Køn: ${gender}
- Snit/fit fra siden: ${fit || "ukendt"}
- Model-info: ${JSON.stringify(modelHint)}

Returnér KUN gyldig JSON i præcis dette format (udelad felter du ikke kan begrunde):
{"type":"top|bottom|full","rows":[{"size":"S","chest":92,"waist":78,"hip":94,"shoulder":44}],"note":"kort begrundelse på dansk"}

Brug realistiske EU-konventioner. Hvis du er usikker, lav et fornuftigt skøn og
skriv det i "note".

SIDENS TEKST:
${pageText.slice(0, 6000)}`;

  const content = [];
  for (const url of (images || []).slice(0, 4)) {
    if (typeof url === "string" && url.startsWith("http")) {
      content.push({ type: "image", source: { type: "url", url } });
    }
  }
  content.push({ type: "text", text: prompt });

  try {
    const msg = await client.messages.create({
      // Sonnet = god billed-/snit-forståelse til ~5× lavere pris end Opus.
      // Skift til "claude-opus-4-8" hvis du vil have maks. præcision.
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content }],
    });

    const text = msg.content.map((c) => c.text || "").join("");
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        type: json.type || type,
        unit: "cm",
        source: "ai-estimate",
        rows: Array.isArray(json.rows) ? json.rows : [],
        note: json.note || "AI-estimat ud fra produktets billeder og tekst.",
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: String(e) }) };
  }
};
