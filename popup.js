/* FitMatch popup controller. */
(function () {
  "use strict";

  const hasChrome = typeof chrome !== "undefined" && chrome.storage;
  const $ = (sel) => document.querySelector(sel);

  const FIELDS = ["height", "chest", "waist", "hip", "shoulder"];
  let profile = { fit: "regular", gender: "unisex" };
  let analyzeBtnHTML = "";

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
  async function loadProfile() {
    if (!hasChrome) return;
    const { profile: saved, apiEndpoint } = await chrome.storage.local.get(["profile", "apiEndpoint"]);
    if (saved) profile = saved;
    FIELDS.forEach((f) => {
      if (profile[f] != null) $(`#f-${f}`).value = profile[f];
    });
    if (apiEndpoint) $("#f-endpoint").value = apiEndpoint;
    setFit(profile.fit || "regular");
    setGender(profile.gender || "unisex");
  }

  async function saveProfile() {
    profile = { fit: profile.fit || "regular", gender: profile.gender || "unisex" };
    FIELDS.forEach((f) => {
      const v = parseFloat($(`#f-${f}`).value);
      if (!isNaN(v)) profile[f] = v;
    });
    const apiEndpoint = ($("#f-endpoint").value || "").trim();
    if (hasChrome) await chrome.storage.local.set({ profile, apiEndpoint });
    const msg = $("#saveMsg");
    msg.hidden = false;
    setTimeout(() => (msg.hidden = true), 1800);
  }

  function hasMeasurements() {
    return ["chest", "waist", "hip"].some((f) => profile[f] != null);
  }

  // ---- tabs + fit toggle -------------------------------------------------
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
      flashError("Udfyld mindst bryst/talje/hofte i din profil først.");
      return;
    }
    if (!hasChrome || !chrome.scripting) {
      showError("Åbn FitMatch på en almindelig produktside i Chrome for at analysere.");
      return;
    }

    const btn = $("#analyzeBtn");
    btn.disabled = true;
    btn.textContent = "Analyserer …";
    $("#resultCard").hidden = true; // clear any stale result immediately

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || /^(chrome|edge|about|chrome-extension):/.test(tab.url || "")) {
        throw new Error("Denne side kan ikke analyseres. Åbn en webshop-produktside.");
      }
      const host = (() => { try { return new URL(tab.url).hostname.replace(/^www\./, ""); } catch { return ""; } })();
      setAnalyzedPage(tab.title, host, "Læser siden …");

      const [{ result: garment } = {}] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["scrape.js"],
      });
      if (!garment || !garment.ok) throw new Error("Kunne ikke læse siden.");

      // No size table on the page → try the AI estimate, else a generic chart.
      if (!garment.rows || garment.rows.length === 0) {
        setAnalyzedPage(garment.title, garment.site, "AI analyserer billeder + tekst …");
        const ai = await tryAI(garment);
        if (ai && ai.ok && ai.rows && ai.rows.length) {
          garment.rows = ai.rows;
          garment.source = "ai-estimate";
          garment.note = ai.note || "AI-estimat ud fra produktets billeder og tekst.";
          if (ai.type) garment.type = ai.type;
        } else {
          const g = GENERIC[profile.gender] || GENERIC.unisex;
          const gType = garment.type === "bottom" ? "bottom" : "top";
          garment.rows = g[gType];
          garment.type = gType;
          garment.source = "generic";
          garment.note =
            ai && ai.reason === "no-endpoint"
              ? "Ingen tabel på siden, og AI-analyse er ikke sat op endnu – brugte en generisk standardtabel."
              : "Ingen tabel fundet, og AI kunne ikke estimere – brugte en generisk standardtabel.";
        }
      }

      const rec = window.FitMatch.recommend(profile, garment);
      if (!rec.ok) throw new Error(rec.message || "Ingen anbefaling mulig.");
      renderResult(rec, garment);
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
        },
      });
    } catch {
      return { ok: false, reason: "msg-failed" };
    }
  }

  let lastPage = { title: "", host: "" };
  function setAnalyzedPage(title, host, status) {
    const el = $("#analyzedPage");
    el.hidden = false;
    const name = (title || "").replace(/\s*[|–—·-].*$/, "").trim().slice(0, 52);
    lastPage = { title, host };
    el.innerHTML = status
      ? `<span class="spin">↻</span> ${status}`
      : `Analyseret: <b>${name || host || "siden"}</b>${host ? " · " + host : ""}`;
  }

  // ---- rendering ---------------------------------------------------------
  function gaugeSvg(pct, level) {
    const color = level === "high" ? "var(--good)" : level === "medium" ? "var(--mid)" : "var(--low)";
    const cap = level === "high" ? "Høj" : level === "medium" ? "Middel" : "Lav";
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

  function renderResult(rec, garment) {
    $("#resultEmpty").hidden = true;
    $("#resultError").hidden = true;
    const card = $("#resultCard");
    card.hidden = false;

    const pct = Math.round(rec.confidence * 100);
    $("#gauge").innerHTML = gaugeSvg(pct, rec.level);
    $("#resSize").textContent = rec.size;
    $("#resReason").textContent = rec.reason;

    $("#resBars").innerHTML = rec.breakdown
      .map(
        (b) => `
        <div class="zone fit-${b.key}">
          <div class="zone-head">
            <span class="zone-name">${b.zoneLabel}</span>
            <span class="zone-fit">${b.fitLabel}</span>
          </div>
          <div class="spectrum"><span class="spectrum-dot" style="left:${b.pct}%"></span></div>
          <div class="zone-nums">Tøj <b>${b.garmentValue}</b> · Dig <b>${b.bodyValue}</b> cm</div>
        </div>`
      )
      .join("");

    $("#resAlts").innerHTML =
      rec.alternatives && rec.alternatives.length
        ? `<span class="alts-label">Alternativer</span>` +
          rec.alternatives.map((a) => `<span class="alt-chip">${a.size}</span>`).join("")
        : "";

    let note;
    if (garment.source === "size-table") note = "Baseret på butikkens størrelsestabel.";
    else if (garment.source === "ai-estimate") note = garment.note || "AI-estimat ud fra billeder og tekst.";
    else if (garment.source === "generic") note = garment.note || "Generisk standardtabel brugt.";
    else note = "Baseret på estimat.";
    $("#resSource").innerHTML = `<span>›</span><span>${note}</span>`;

    setAnalyzedPage(garment.title, garment.site, null);
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

  // show an error tied to the result view after a forced tab switch
  function flashError(msg) {
    switchView("result");
    showError(msg);
  }

  // ---- wire up -----------------------------------------------------------
  document.addEventListener("DOMContentLoaded", () => {
    analyzeBtnHTML = $("#analyzeBtn").innerHTML;
    loadProfile();
    document.querySelectorAll(".tab").forEach((t) =>
      t.addEventListener("click", () => switchView(t.dataset.view))
    );
    document.querySelectorAll("#fitToggle button").forEach((b) =>
      b.addEventListener("click", () => setFit(b.dataset.fit))
    );
    document.querySelectorAll("#genderToggle button").forEach((b) =>
      b.addEventListener("click", () => setGender(b.dataset.gender))
    );
    $("#saveBtn").addEventListener("click", saveProfile);
    $("#analyzeBtn").addEventListener("click", analyze);
  });
})();
