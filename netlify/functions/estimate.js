/* Netlify Function — FitMatch AI size advisor (multimodal, model-anchored).
 *
 * Deploy on YOUR backend with ANTHROPIC_API_KEY set. NEVER put the key in the
 * extension. Receives the product images + text + model reference + the USER's
 * own measurements, then reasons like a fit expert:
 *   1. Read the intended fit from the images (how it drapes on the model).
 *   2. Anchor to the model ("181 cm wearing M" = the intended look).
 *   3. Estimate an anchored body-fit chart in cm.
 *   4. Recommend the size that gives THIS user the same intended look.
 * Returns the chart + a concrete recommendation; engine.js renders the bars.
 *
 *   npm i @anthropic-ai/sdk
 *   netlify env:set ANTHROPIC_API_KEY sk-ant-...
 */
const Anthropic = require("@anthropic-ai/sdk");
const { getStore } = require("@netlify/blobs");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Budget protection: per-install daily quota + per-IP hourly abuse backstop.
// Tunable via env vars. Each AI call costs money, so this caps the blast radius
// of a bug or a malicious caller hitting the public endpoint.
const DAILY_PER_CLIENT = Number(process.env.FM_DAILY_PER_CLIENT || 40);
const HOURLY_PER_IP = Number(process.env.FM_HOURLY_PER_IP || 80);

async function bump(store, key, limit) {
  const n = Number((await store.get(key)) || 0);
  if (n >= limit) return false;
  await store.set(key, String(n + 1)); // fixed-window counter; minor races are fine for a cap
  return true;
}

// Returns null if allowed, or a scope string if the limit is hit. Fails OPEN on
// store errors so a storage hiccup never breaks the product for legit users.
async function rateLimited(clientId, ip) {
  try {
    const store = getStore("fitmatch-ratelimit");
    const iso = new Date().toISOString();
    const day = iso.slice(0, 10); // yyyy-mm-dd
    const hour = iso.slice(0, 13); // yyyy-mm-ddTHH
    if (clientId && !(await bump(store, `c_${clientId}_${day}`, DAILY_PER_CLIENT))) return "client";
    if (ip && !(await bump(store, `i_${ip}_${hour}`, HOURLY_PER_IP))) return "ip";
    return null;
  } catch (e) {
    console.error("rate-limit store error (failing open):", String(e));
    return null;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

  // Safe diagnostic: reports WHETHER the key is visible to this function.
  // Never returns the value — only presence, length and matching variable NAMES.
  if (event.queryStringParameters && event.queryStringParameters.diag === "1") {
    const k = process.env.ANTHROPIC_API_KEY;
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        hasKey: !!k,
        keyLength: k ? String(k).length : 0,
        startsWithSkAnt: k ? String(k).startsWith("sk-ant-") : false,
        matchingEnvNames: Object.keys(process.env).filter((n) => /ANTHROPIC|CLAUDE/i.test(n)),
        node: process.version,
      }),
    };
  }

  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: "Method not allowed" };

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: "bad json" }) };
  }

  const {
    pageText = "",
    images = [],
    type = "unknown",
    modelHint = null,
    fit = null,
    gender = "unisex",
    measurements = {},
    fitPref = "regular",
    lang = "en",
    clientId = null,
  } = payload;

  // Enforce the quota BEFORE the paid Claude call.
  const ip =
    event.headers["x-nf-client-connection-ip"] ||
    (event.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    null;
  const limited = await rateLimited(clientId, ip);
  if (limited) {
    return {
      statusCode: 429,
      headers: CORS,
      body: JSON.stringify({ ok: false, reason: "rate-limited", scope: limited }),
    };
  }

  const LANG_NAME =
    { en: "English", da: "Danish", de: "German", fr: "French", es: "Spanish" }[lang] || "English";

  const prompt = `Du er en af verdens dygtigste eksperter i tøjpasform og størrelser.
Din opgave: anbefal PRÆCIST hvilken størrelse denne specifikke bruger skal vælge,
så tøjet sidder som DESIGNET (samme look som på modellen). Vær konservativ og
ærlig — det er bedre at sige "middel sikkerhed" end at gætte forkert.

VIGTIGT: Skriv ALLE fritekst-felter ("reasoning" og hver "when") på ${LANG_NAME}.

SÅDAN RÆSONNERER DU (følg rækkefølgen):
1. SE PÅ BILLEDERNE. Bedøm det intenderede snit: oversized, relaxed, regular,
   slim, croppet, longline? Hvordan falder stoffet på modellen (bredt/tætsiddende
   over skuldre, bryst, talje)? Dette er vigtigere end markedsføringstekst.
2. ANKER TIL MODELLEN. Modellen her er referencen for det intenderede look:
   ${modelHint && modelHint.height ? `${modelHint.height} cm` : "højde ukendt"}, bærer størrelse
   ${modelHint && modelHint.size ? modelHint.size : "ukendt"}. En model på den højde har typisk
   kendte kropsmål — brug det til at forankre din tabel, så modellens størrelse
   matcher den vidde man ser på billedet. ESTIMÉR modellens egne kropsmål (cm) ud fra
   højde + størrelse + det du ser — dem returnerer du i "modelEstimate" så brugeren kan
   sammenligne sin egen krop med modellens.
3. ESTIMÉR en tabel over de KROPSMÅL (cm) hver størrelse er skåret til at passe,
   forankret til modellen + den synlige vidde.
4. ANBEFAL den INTENDEREDE størrelse til DENNE bruger — dvs. den størrelse der giver
   brugeren SAMME look som tøjet er designet til (som modellen bærer det). VIGTIGT:
   for oversized/relaxed tøj må du IKKE skubbe brugeren en størrelse op bare fordi der
   er vidde — den vidde er designet ind. Hvis brugeren ligner modellens kropstype, og
   modellen bærer M, så er svaret typisk M. IGNORÉR brugerens personlige pasform-ønske
   (stram/løs) — det håndteres separat bagefter. Anbefal kun den intenderede pasform.

BRUGERENS MÅL (cm): ${JSON.stringify(measurements)}
Tøjtype: ${type} · Køn: ${gender} · Snit fra tekst: ${fit || "ukendt"}

Returnér KUN gyldig JSON, præcis dette format:
{
  "intendedFit": "oversized|relaxed|regular|slim|cropped|longline",
  "type": "top|bottom|full",
  "rows": [{"size":"S","chest":92,"waist":78,"hip":94,"shoulder":44}],
  "recommendedSize": "M",
  "confidence": 0.0-1.0,
  "modelEstimate": {"height":181,"chest":94,"waist":80,"hip":96,"shoulder":45},
  "zones": [{"zone":"chest","fit":"relaxed"},{"zone":"shoulder","fit":"regular"},{"zone":"waist","fit":"oversized"}],
  "reasoning": "3-4 sætninger på ${LANG_NAME}: 1) hvad du SER på billederne (snittet), 2) modellen som anker, 3) en KONKRET sammenligning af brugerens mål med modellens estimerede mål (fx 'din brystvidde er 4 cm større end modellens, så...'), 4) hvorfor pasformen derfor passer. Brug også længde-mål (overkrop/ben/ærme) hvis de er angivet. NÆVN IKKE størrelsesbogstavet (S/M/L) i teksten — beskriv kun pasformen.",
  "alternatives": [{"size":"S","when":"hvis du vil have et mindre oversized look"},{"size":"L","when":"hvis du vil have det endnu mere rummeligt"}]
}

I "zones" angiver du hvordan den ANBEFALEDE størrelse faktisk vil sidde på brugeren
pr. kropszone, ud fra det du ser på billederne. Brug KUN disse værdier for "fit":
"too-small", "tight", "snug", "regular", "relaxed", "oversized".

confidence skal afspejle reel usikkerhed: høj (>0.7) kun når billeder + model + mål peger samme vej; lav (<0.45) når data er sparsomme.

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
      // Sonnet = stærk billed-/snit-forståelse til lav pris. Skift til
      // "claude-opus-4-8" for maks. præcision.
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      temperature: 0, // deterministisk → samme produkt giver samme svar
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
        recommendedSize: json.recommendedSize || null,
        intendedFit: json.intendedFit || fit || null,
        modelEstimate: json.modelEstimate && typeof json.modelEstimate === "object" ? json.modelEstimate : null,
        zones: Array.isArray(json.zones) ? json.zones : [],
        confidence: typeof json.confidence === "number" ? json.confidence : null,
        reasoning: json.reasoning || "AI-vurdering ud fra billeder, model og dine mål.",
        alternatives: Array.isArray(json.alternatives) ? json.alternatives : [],
        note: json.reasoning || "AI-estimat ud fra produktets billeder og tekst.",
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: String(e) }) };
  }
};
