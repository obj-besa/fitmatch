/* FitMatch page scraper — injected into the active tab via chrome.scripting.
 * Self-contained: returns a normalized "garment" object as its completion value.
 * Reads size tables (cm or inch) + model hints directly from the DOM so the MVP
 * works offline. The generic fallback + AI fallback are applied in the popup,
 * where the user's gender is known.
 */
(function () {
  "use strict";

  // ---- vocab -------------------------------------------------------------
  const ZONE_WORDS = {
    chest: ["chest", "bust", "bryst", "brystvidde", "brystmål", "brust", "poitrine", "torace"],
    waist: ["waist", "talje", "taille", "bund", "vita", "midje", "livvidde"],
    hip: ["hip", "hips", "hofte", "hoftevidde", "hüfte", "hanche", "fianchi", "seat", "sæde"],
    shoulder: ["shoulder", "skulder", "schulter", "épaule"],
  };
  const ALPHA_RE = /^(xxxs|xxs|xs|s|m|l|xl|xxl|xxxl|xxxxl|[2-5]xl)$/i;

  function detectZone(text) {
    const t = (text || "").toLowerCase();
    for (const zone in ZONE_WORDS) {
      if (ZONE_WORDS[zone].some((w) => t.includes(w))) return zone;
    }
    return null;
  }

  // Recognise both alpha (S/M/L) and numeric (EU 38, W32, 32/34, 8/10) sizes.
  function isSizeToken(text) {
    const t = (text || "").trim().toLowerCase().replace(/\s+/g, "");
    if (!t) return false;
    if (ALPHA_RE.test(t)) return true;
    if (/^(eu|uk|us|dk|de|it|fr)?\d{1,2}([\/-]\d{1,2})?$/.test(t)) return true; // 38, 38/40, 8-10
    if (/^w?\d{2}(\/?l?\d{2})?$/i.test(t)) return true; // W32, W32L34, 32/34
    return false;
  }

  // Decide the unit a table is expressed in.
  function tableUnit(table) {
    const t = (table.textContent || "").toLowerCase();
    const hasCm = /\bcm\b|centimeter/.test(t);
    const hasInch = /inch|\binches\b|["”]|\bin\b/.test(t);
    if (hasCm && !hasInch) return "cm";
    if (hasInch && !hasCm) return "inch";
    return null; // ambiguous → infer later from value magnitude
  }

  // Pull the meaningful measurement from a cell. "96-100 cm" -> 100 (upper bound
  // of a "to fit" range). Returns a number in the cell's own unit.
  function parseMeasure(text) {
    if (!text) return null;
    const nums = (text.match(/\d+(?:[.,]\d+)?/g) || []).map((n) =>
      parseFloat(n.replace(",", "."))
    );
    const plausible = nums.filter((n) => n >= 10 && n <= 200);
    if (plausible.length === 0) return null;
    return Math.max(...plausible);
  }

  function toCm(value, unit) {
    if (value == null) return null;
    if (unit === "inch") return Math.round(value * 2.54);
    // Unknown unit: a body chest/waist under ~70 is almost certainly inches.
    if (unit == null && value < 70) return Math.round(value * 2.54);
    return Math.round(value);
  }

  function cellText(cell) {
    return (cell.textContent || "").replace(/\s+/g, " ").trim();
  }

  // ---- table parsing -----------------------------------------------------
  function parseTable(table) {
    const unit = tableUnit(table);
    const rows = Array.from(table.querySelectorAll("tr"))
      .map((tr) => Array.from(tr.querySelectorAll("th,td")).map(cellText))
      .filter((r) => r.length > 1);
    if (rows.length < 2) return null;

    const header = rows[0];
    const headerSizes = header.slice(1).map(isSizeToken);
    const headerLooksLikeSizes =
      headerSizes.filter(Boolean).length >= Math.max(2, header.length - 2);

    let out = [];
    if (headerLooksLikeSizes) {
      // Orientation A: sizes across the header, measurement label per row.
      const sizes = header.slice(1).map((s) => s.trim().toUpperCase());
      const acc = sizes.map((size) => ({ size }));
      for (let r = 1; r < rows.length; r++) {
        const zone = detectZone(rows[r][0]);
        if (!zone) continue;
        rows[r].slice(1).forEach((cell, i) => {
          const v = toCm(parseMeasure(cell), unit);
          if (v !== null && acc[i]) acc[i][zone] = v;
        });
      }
      out = acc;
    } else {
      // Orientation B: measurement names across the header, size per row.
      const zoneCols = header.map((h, i) => (i === 0 ? null : detectZone(h)));
      if (!zoneCols.some(Boolean)) return null;
      for (let r = 1; r < rows.length; r++) {
        if (!isSizeToken(rows[r][0])) continue;
        const entry = { size: rows[r][0].trim().toUpperCase() };
        rows[r].forEach((cell, i) => {
          const zone = zoneCols[i];
          if (!zone) return;
          const v = toCm(parseMeasure(cell), unit);
          if (v !== null) entry[zone] = v;
        });
        out.push(entry);
      }
    }

    out = out.filter((row) => ["chest", "waist", "hip", "shoulder"].some((z) => row[z] != null));
    return out.length >= 2 ? out : null;
  }

  function findBestChart() {
    const tables = Array.from(document.querySelectorAll("table"));
    let best = null;
    for (const t of tables) {
      const txt = (t.textContent || "").toLowerCase();
      if (!/cm|inch|"|size|størrelse|größe|taille/.test(txt)) continue;
      const parsed = parseTable(t);
      if (parsed && (!best || parsed.length > best.length)) best = parsed;
    }
    return best;
  }

  // ---- garment type + model hint ----------------------------------------
  function detectType() {
    const hay = (
      document.title +
      " " +
      (document.querySelector("h1")?.textContent || "") +
      " " +
      (document.querySelector('[class*="breadcrumb" i]')?.textContent || "")
    ).toLowerCase();
    const bottom = /(jeans|trouser|pants|bukser|shorts|skirt|nederdel|hose|leggings|chino)/;
    const full = /(dress|kjole|jumpsuit|overall|kleid)/;
    const top = /(shirt|tee|t-shirt|sweater|hoodie|jacket|jakke|trøje|top|blouse|bluse|coat|knit|pullover|cardigan|polo)/;
    if (bottom.test(hay)) return "bottom";
    if (full.test(hay)) return "full";
    if (top.test(hay)) return "top";
    return "unknown";
  }

  function detectModelHint() {
    const body = (document.body?.innerText || "").slice(0, 20000);
    // Height: "181 cm", "Model: 181", "Model's height: 6'1", "height 185cm".
    let height = null;
    const cm = body.match(/(?:model|height|højde|größe)[^.\n]{0,30}?(\d{3})\s?cm/i) || body.match(/(\d{3})\s?cm/);
    const justNum = body.match(/model('s)?\s*(?:height)?\s*[:\-]?\s*(\d{3})\b/i);
    const feet = body.match(/(\d)\s?['’]\s?(\d{1,2})\s?["”]?/);
    if (cm) height = parseInt(cm[1], 10);
    else if (justNum) height = parseInt(justNum[2], 10);
    else if (feet) height = Math.round(parseInt(feet[1], 10) * 30.48 + parseInt(feet[2], 10) * 2.54);

    const s = body.match(
      /\b(wears|wearing|bærer|trägt|porte)\b[^.\n]{0,24}?\b(xxs|xs|s|m|l|xl|xxl)\b/i
    );
    if (!height && !s) return null;
    return { height, size: s ? s[2].toUpperCase() : null };
  }

  // The brand's own fit descriptor — a strong cue for the AI ("Oversized fit" vs
  // "Slim fit" shifts the garment's body measurements a lot).
  function detectFit() {
    const body = (document.body?.innerText || "").toLowerCase();
    const m = body.match(/\b(oversized|relaxed|loose|regular|classic|slim|skinny|muscle|tailored)\s+fit\b/);
    return m ? m[0] : null;
  }

  // ---- material for the AI fallback (images + text) ----------------------
  function collectImages() {
    const urls = new Set();
    const og = document.querySelector('meta[property="og:image"]')?.content;
    if (og && og.startsWith("http")) urls.add(og);
    Array.from(document.querySelectorAll("img"))
      .map((im) => ({
        im,
        area: (im.naturalWidth || im.width || 0) * (im.naturalHeight || im.height || 0),
      }))
      .filter((x) => x.area > 40000)
      .sort((a, b) => b.area - a.area)
      .slice(0, 6)
      .forEach(({ im }) => {
        const src = im.currentSrc || im.src;
        if (src && src.startsWith("http")) urls.add(src);
      });
    return Array.from(urls).slice(0, 4);
  }

  function pageText() {
    const h1 = document.querySelector("h1")?.textContent || "";
    const body = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    return (h1 + " \n " + body).slice(0, 6000);
  }

  // ---- assemble ----------------------------------------------------------
  const type = detectType();
  const chart = findBestChart();
  const modelHint = detectModelHint();
  const fit = detectFit();

  return {
    ok: true,
    type,
    unit: "cm",
    source: chart ? "size-table" : "none",
    rows: chart || [],
    modelHint,
    fit,
    images: collectImages(),
    text: pageText(),
    site: location.hostname,
    title: document.title,
  };
})();
