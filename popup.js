/* FitMatch popup controller. */
(function () {
  "use strict";

  const hasChrome = typeof chrome !== "undefined" && chrome.storage;
  const $ = (sel) => document.querySelector(sel);

  const FIELDS = ["height", "chest", "waist", "hip", "shoulder"];
  let profile = { fit: "regular", gender: "unisex" };
  let lang = "en";
  let analyzeBtnHTML = "";
  let lastResult = null; // { rec, garment, ctx } — for re-render on language change

  const T = (key, vars) =>
    typeof window !== "undefined" && window.I18N ? window.I18N.t(key, lang, vars) : key;

  // Gender-aware generic "to fit body" fallback charts (cm), used only when the
  // page exposes no size table. Flagged low-confidence so the UI stays honest.
  const GENERIC = {
    herre: {
      top: [
        { size: "XS", chest: 86, waist: 72, shoulder: 42 },
        { size: "S", chest: 92, waist: 78, shoulder: 44 },
        { size: "M", chest: 100, waist: 86, shoulder: 46 },
        { size: "L", chest: 108, waist: 94, shoulder: 48 },
        { size: "XL", chest: 116, waist: 104, shoulder: 50 },
        { size: "XXL", chest: 124, waist: 114, shoulder: 52 },
      ],
      bottom: [
        { size: "S", waist: 78, hip: 94 },
        { size: "M", waist: 86, hip: 102 },
        { size: "L", waist: 94, hip: 110 },
        { size: "XL", waist: 104, hip: 118 },
        { size: "XXL", waist: 114, hip: 126 },
      ],
    },
    dame: {
      top: [
        { size: "XS", chest: 80, waist: 64, shoulder: 38 },
        { size: "S", chest: 84, waist: 68, shoulder: 39 },
        { size: "M", chest: 90, waist: 74, shoulder: 40 },
        { size: "L", chest: 96, waist: 80, shoulder: 41 },
        { size: "XL", chest: 104, waist: 88, shoulder: 42 },
        { size: "XXL", chest: 112, waist: 96, shoulder: 43 },
      ],
      bottom: [
        { size: "XS", waist: 64, hip: 90 },
        { size: "S", waist: 68, hip: 94 },
        { size: "M", waist: 74, hip: 100 },
        { size: "L", waist: 80, hip: 106 },
        { size: "XL", waist: 88, hip: 114 },
        { size: "XXL", waist: 96, hip: 122 },
      ],
    },
  };
  GENERIC.unisex = GENERIC.herre; // neutral default leans to the broader fit

  // ---- storage -----------------------------------------------------------
  async function loadSettings() {
    if (!hasChrome) {
      applyLang("en");
      return;
    }
    const { profile: saved, lang: savedLang } = await chrome.storage.local.get(["profile", "lang"]);
    if (saved) profile = saved;
    lang = savedLang || "en";
    FIELDS.forEach((f) => {
      if (profile[f] != null) $(`#f-${f}`).value = profile[f];
    });
    $("#f-lang").value = lang;
    setFit(profile.fit || "regular");
    setGender(profile.gender || "unisex");
    applyLang(lang);
  }

  async function saveProfile() {
    profile = { fit: profile.fit || "regular", gender: profile.gender || "unisex" };
    FIELDS.forEach((f) => {
      const v = parseFloat($(`#f-${f}`).value);
      if (!isNaN(v)) profile[f] = v;
    });
    if (hasChrome) await chrome.storage.local.set({ profile, lang });
    const msg = $("#saveMsg");
    msg.hidden = false;
    setTimeout(() => (msg.hidden = true), 1800);
  }

  function applyLang(l) {
    lang = l;
    if (window.I18N) window.I18N.apply(lang);
    analyzeBtnHTML = $("#analyzeBtn").innerHTML; // re-capture localized label
    if (lastResult && !$("#resultCard").hidden) {
      renderResult(lastResult.rec, lastResult.garment, lastResult.ctx);
    }
  }

  async function changeLang(l) {
    lang = l;
    applyLang(l);
    if (hasChrome) await chrome.storage.local.set({ lang });
  }

  function hasMeasurements() {
    return ["chest", "waist", "hip"].some((f) => profile[f] != null);
  }

  // ---- tabs + toggles ----------------------------------------------------
  function switchView(name) {
    document.querySelectorAll(".tab").forEach((t) =>
      t.classList.toggle("is-active", t.dataset.view === name)
    );
    document.querySelectorAll(".view").forEach((v) =>
      v.classList.toggle("is-active", v.id === `view-${name}`)
    );
    const pill = $("#tabPill");
    if (pill) pill.style.transform = name === "profile" ? "translateX(100%)" : "translateX(0)";
  }

  function setFit(fit) {
    profile.fit = fit;
    document.querySelectorAll("#fitToggle button").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.fit === fit)
    );
  }

  function setGender(gender) {
    profile.gender = gender;
    document.querySelectorAll("#genderToggle button").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.gender === gender)
    );
  }

  // ---- analyze -----------------------------------------------------------
  async function analyze() {
    showError(null);
    if (!hasMeasurements()) {
      switchView("profile");
      flashError(T("err.needMeasures"));
      return;
    }
    if (!hasChrome || !chrome.scripting) {
      showError(T("err.openInChrome"));
      return;
    }

    const btn = $("#analyzeBtn");
    btn.disabled = true;
    btn.textContent = T("btn.analyzing");
    $("#resultCard").hidden = true; // clear any stale result immediately

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || /^(chrome|edge|about|chrome-extension):/.test(tab.url || "")) {
        throw new Error(T("err.notProductPage"));
      }
      const host = (() => { try { return new URL(tab.url).hostname.replace(/^www\./, ""); } catch { return ""; } })();
      setAnalyzedPage(tab.title, host, T("analyzed.reading"));

      const [{ result: garment } = {}] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["scrape.js"],
      });
      if (!garment || !garment.ok) throw new Error(T("err.cannotRead"));

      const productKey = (tab.url || "").split("#")[0].split("?")[0];
      let rec;

      if (garment.rows && garment.rows.length) {
        // Real size table on the page → deterministic local match (no AI, no credits).
        rec = window.FitMatch.recommend(profile, garment);
      } else {
        // No table → model-anchored, image-aware AI advisor (cached per product+profile+lang).
        const cached = await getCached(productKey);
        if (cached) {
          garment.rows = cached.rows;
          garment.type = cached.type || garment.type;
          garment.source = "ai-estimate";
          rec = window.FitMatch.fromAI(profile, garment, cached.ai);
        } else {
          setAnalyzedPage(garment.title, garment.site, T("analyzed.ai"));
          const ai = await tryAI(garment);
          if (ai && ai.ok && ai.rows && ai.rows.length && ai.recommendedSize) {
            garment.rows = ai.rows;
            garment.type = ai.type || garment.type;
            garment.source = "ai-estimate";
            const aiRec = {
              size: ai.recommendedSize,
              confidence: ai.confidence,
              reason: ai.reasoning,
              alternatives: ai.alternatives,
              intendedFit: ai.intendedFit,
              zones: ai.zones,
            };
            rec = window.FitMatch.fromAI(profile, garment, aiRec);
            await setCached(productKey, { rows: ai.rows, type: garment.type, ai: aiRec });
          } else if (ai && ai.reason === "rate-limited") {
            throw new Error(T("err.rateLimited"));
          } else {
            const g = GENERIC[profile.gender] || GENERIC.unisex;
            const gType = garment.type === "bottom" ? "bottom" : "top";
            garment.rows = g[gType];
            garment.type = gType;
            garment.source = "generic";
            garment.noteKey =
              ai && ai.reason === "no-endpoint" ? "source.genericNoAI" : "source.generic";
            rec = window.FitMatch.recommend(profile, garment);
          }
        }
      }

      if (!rec.ok) throw new Error(rec.message || T("err.noRec"));
      renderResult(rec, garment, { productKey, host });
    } catch (e) {
      showError(e.message || String(e));
      setAnalyzedPage(lastPage.title, lastPage.host, null);
    } finally {
      btn.disabled = false;
      btn.innerHTML = analyzeBtnHTML;
    }
  }

  // Ask the service worker to run the AI estimate against the configured backend.
  async function tryAI(garment) {
    if (!hasChrome || !chrome.runtime) return null;
    try {
      return await chrome.runtime.sendMessage({
        type: "AI_ESTIMATE",
        payload: {
          pageText: garment.text,
          images: garment.images,
          type: garment.type,
          modelHint: garment.modelHint,
          fit: garment.fit,
          gender: profile.gender,
          fitPref: profile.fit,
          lang,
          measurements: {
            height: profile.height,
            chest: profile.chest,
            waist: profile.waist,
            hip: profile.hip,
            shoulder: profile.shoulder,
          },
        },
      });
    } catch {
      return { ok: false, reason: "msg-failed" };
    }
  }

  // ---- per-product cache (consistency + saves credits) -------------------
  function cacheKey(productKey) {
    // Note: fit preference is applied deterministically after the AI call, so it
    // is intentionally NOT part of the key — changing it reuses the cache.
    const p = profile;
    return [productKey, p.chest, p.waist, p.hip, p.shoulder, p.height, p.gender, lang].join("|");
  }
  async function getCached(productKey) {
    if (!hasChrome) return null;
    const { aiCache = {} } = await chrome.storage.local.get("aiCache");
    const entry = aiCache[cacheKey(productKey)];
    if (!entry) return null;
    if (Date.now() - (entry.ts || 0) > 30 * 864e5) return null; // 30-day freshness
    return entry;
  }
  async function setCached(productKey, data) {
    if (!hasChrome) return;
    const { aiCache = {} } = await chrome.storage.local.get("aiCache");
    aiCache[cacheKey(productKey)] = { ...data, ts: Date.now() };
    const keys = Object.keys(aiCache);
    if (keys.length > 60) {
      keys.sort((a, b) => (aiCache[a].ts || 0) - (aiCache[b].ts || 0));
      keys.slice(0, keys.length - 60).forEach((k) => delete aiCache[k]);
    }
    await chrome.storage.local.set({ aiCache });
  }

  // ---- feedback log (the seed of brand calibration / learning) -----------
  async function saveFeedback(entry) {
    if (!hasChrome) return;
    const { feedbackLog = [] } = await chrome.storage.local.get("feedbackLog");
    feedbackLog.push({ ...entry, ts: Date.now() });
    await chrome.storage.local.set({ feedbackLog: feedbackLog.slice(-500) });
  }

  let lastPage = { title: "", host: "" };
  function setAnalyzedPage(title, host, status) {
    const el = $("#analyzedPage");
    el.hidden = false;
    const name = (title || "").replace(/\s*[|–—·-].*$/, "").trim().slice(0, 52);
    lastPage = { title, host };
    el.innerHTML = status
      ? `<span class="spin">↻</span> ${status}`
      : `${T("analyzed.prefix")} <b>${name || host || ""}</b>${host ? " · " + host : ""}`;
  }

  // ---- rendering ---------------------------------------------------------
  function gaugeSvg(pct, level) {
    const color = level === "high" ? "var(--good)" : level === "medium" ? "var(--mid)" : "var(--low)";
    const cap = T("cap." + level);
    const r = 32, c = 2 * Math.PI * r, off = c * (1 - pct / 100);
    return `
      <svg viewBox="0 0 78 78" width="78" height="78">
        <circle cx="39" cy="39" r="${r}" fill="none" stroke="var(--line)" stroke-width="7"/>
        <circle cx="39" cy="39" r="${r}" fill="none" stroke="${color}" stroke-width="7"
          stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${off}"/>
      </svg>
      <div class="gauge-label">
        <span class="gauge-pct" style="color:${color}">${pct}%</span>
        <span class="gauge-cap" style="color:${color}">${cap}</span>
      </div>`;
  }

  function reasonText(rec) {
    if (rec.source === "ai-estimate") {
      let r = rec.reason || "";
      let note = "";
      if (rec.prefShift < 0) note = T("reason.prefDown");
      else if (rec.prefShift > 0) note = T("reason.prefUp");
      else if (rec.prefRequested === "tight") note = T("reason.heldTight");
      else if (rec.prefRequested === "loose") note = T("reason.heldLoose");
      return note ? note + (r ? " " + r : "") : r;
    }
    if (rec.reasonKey === "bestMatch" && rec.primaryZone) {
      let s = T("reason.bestMatch", {
        zone: T("zone." + rec.primaryZone).toLowerCase(),
        fit: rec.primaryFitKey ? T("fit." + rec.primaryFitKey).toLowerCase() : "",
      });
      if (rec.tight) s += T("reason.tightSuffix");
      return s;
    }
    return rec.reason || "";
  }

  function renderResult(rec, garment, ctx = {}) {
    lastResult = { rec, garment, ctx };
    $("#resultEmpty").hidden = true;
    $("#resultError").hidden = true;
    $("#resultCard").hidden = false;

    const pct = Math.round(rec.confidence * 100);
    $("#gauge").innerHTML = gaugeSvg(pct, rec.level);
    $("#resSize").textContent = rec.size;
    const chip = rec.intendedFit ? `<span class="fit-chip">${rec.intendedFit}</span> ` : "";
    $("#resReason").innerHTML = chip + reasonText(rec);

    const gW = T("nums.garment"), yW = T("nums.you");
    const approx = garment.source !== "size-table"; // AI/generic numbers are estimates
    const pre = approx ? "~" : "";
    $("#resBars").innerHTML = rec.breakdown
      .map(
        (b) => `
        <div class="zone fit-${b.key}">
          <div class="zone-head">
            <span class="zone-name">${T("zone." + b.zone)}</span>
            <span class="zone-fit">${T("fit." + b.key)}</span>
          </div>
          <div class="spectrum"><span class="spectrum-dot" style="left:${b.pct}%"></span></div>
          ${
            b.garmentValue != null
              ? `<div class="zone-nums">${gW} <b>${pre}${b.garmentValue}</b> · ${yW} <b>${b.bodyValue}</b> cm</div>`
              : ""
          }
        </div>`
      )
      .join("");

    const approxEl = $("#resApprox");
    approxEl.hidden = !approx;
    approxEl.textContent = approx ? T("res.approx") : "";

    $("#resAlts").innerHTML =
      rec.alternatives && rec.alternatives.length
        ? `<span class="alts-label">${T("alts.label")}</span>` +
          rec.alternatives
            .map(
              (a) =>
                `<span class="alt-chip"${a.when ? ` title="${String(a.when).replace(/"/g, "")}"` : ""}>${a.size}</span>`
            )
            .join("")
        : "";

    let note;
    if (garment.source === "size-table") note = T("source.sizeTable");
    else if (garment.source === "ai-estimate") note = T("source.aiEstimate");
    else note = T(garment.noteKey || "source.generic");
    $("#resSource").innerHTML = `<span>›</span><span>${note}</span>`;

    renderFeedback(rec, garment);
    setAnalyzedPage(garment.title, garment.site, null);
  }

  function renderFeedback(rec, garment) {
    const el = $("#resFeedback");
    if (!el) return;
    el.innerHTML = `
      <span class="fb-q">${T("feedback.q", { size: rec.size })}</span>
      <div class="fb-btns">
        <button data-v="small">${T("feedback.small")}</button>
        <button data-v="perfect">${T("feedback.perfect")}</button>
        <button data-v="big">${T("feedback.big")}</button>
      </div>`;
    el.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        saveFeedback({
          site: garment.site,
          product: garment.title,
          size: rec.size,
          source: garment.source,
          intendedFit: rec.intendedFit || null,
          verdict: b.dataset.v,
        });
        el.innerHTML = `<span class="fb-thanks">${T("feedback.thanks")}</span>`;
      })
    );
  }

  function showError(msg) {
    const box = $("#resultError");
    if (!msg) {
      box.hidden = true;
      return;
    }
    $("#resultCard").hidden = true;
    $("#resultEmpty").hidden = true;
    box.hidden = false;
    box.textContent = msg;
  }

  function flashError(msg) {
    switchView("result");
    showError(msg);
  }

  // ---- wire up -----------------------------------------------------------
  document.addEventListener("DOMContentLoaded", async () => {
    await loadSettings();
    analyzeBtnHTML = $("#analyzeBtn").innerHTML;
    document.querySelectorAll(".tab").forEach((t) =>
      t.addEventListener("click", () => switchView(t.dataset.view))
    );
    document.querySelectorAll("#fitToggle button").forEach((b) =>
      b.addEventListener("click", () => setFit(b.dataset.fit))
    );
    document.querySelectorAll("#genderToggle button").forEach((b) =>
      b.addEventListener("click", () => setGender(b.dataset.gender))
    );
    $("#f-lang").addEventListener("change", (e) => changeLang(e.target.value));
    $("#saveBtn").addEventListener("click", saveProfile);
    $("#analyzeBtn").addEventListener("click", analyze);

    const overlay = $("#howOverlay");
    $("#infoBtn").addEventListener("click", () => (overlay.hidden = false));
    $("#howClose").addEventListener("click", () => (overlay.hidden = true));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.hidden = true;
    });
  });
})();
