/* FitMatch matching engine — pure functions, no DOM.
 * Exposed as window.FitMatch for the popup. Kept dependency-free so the same
 * logic can later run in a backend (Node) next to a real Claude call.
 */
(function (root) {
  "use strict";

  // Which body measurements matter for a given garment type, primary first.
  const ZONES_BY_TYPE = {
    top: ["chest", "shoulder", "waist"],
    bottom: ["waist", "hip"],
    full: ["chest", "waist", "hip"],
    unknown: ["chest", "waist", "hip", "shoulder"],
  };

  // Target "ease" (cm of room) the wearer wants on the PRIMARY zone,
  // for a size chart expressed as body-measurements-that-fit.
  const EASE_TARGET = {
    tight: 1,
    regular: 4,
    loose: 9,
  };

  const ZONE_LABEL = {
    chest: "Bryst",
    waist: "Talje",
    hip: "Hofte",
    shoulder: "Skulder",
  };

  function num(v) {
    return typeof v === "number" && isFinite(v) ? v : null;
  }

  // Classify how a single zone feels given the gap (chartValue - bodyValue), in cm.
  function classifyFit(gap) {
    if (gap === null) return { key: "unknown", label: "—", pct: 50 };
    if (gap < -2) return { key: "too-small", label: "For stram", pct: 5 };
    if (gap < 1) return { key: "tight", label: "Stram", pct: 22 };
    if (gap < 4) return { key: "snug", label: "Tætsiddende", pct: 40 };
    if (gap < 8) return { key: "regular", label: "Regulær", pct: 58 };
    if (gap < 13) return { key: "relaxed", label: "Løs", pct: 78 };
    return { key: "oversized", label: "Meget løs", pct: 94 };
  }

  // Per-zone fit breakdown for one size row vs the user's body (used by the UI bars).
  function makeBreakdown(profile, row, zones) {
    return zones
      .map((z) => {
        const bodyV = num(profile[z]);
        const chartV = num(row[z]);
        if (bodyV === null || chartV === null) return null;
        const fit = classifyFit(chartV - bodyV);
        return {
          zone: z,
          zoneLabel: ZONE_LABEL[z] || z,
          gap: chartV - bodyV,
          garmentValue: chartV,
          bodyValue: bodyV,
          key: fit.key,
          fitLabel: fit.label,
          pct: fit.pct,
        };
      })
      .filter(Boolean);
  }

  /**
   * @param {Object} profile  user body measurements + fit preference
   * @param {Object} garment  normalized garment data (see scrape.js / README)
   * @returns {Object} recommendation
   */
  function recommend(profile, garment) {
    if (!garment || !Array.isArray(garment.rows) || garment.rows.length === 0) {
      return {
        ok: false,
        reason: "no-chart",
        message: "Kunne ikke finde en størrelsestabel på siden.",
      };
    }

    const type = garment.type && ZONES_BY_TYPE[garment.type] ? garment.type : "unknown";
    const zones = ZONES_BY_TYPE[type];
    const easeTarget = EASE_TARGET[profile.fit] ?? EASE_TARGET.regular;

    // Pick the primary zone that exists in BOTH the user's profile and the chart.
    const chartHas = (z) => garment.rows.some((r) => num(r[z]) !== null);
    const primary = zones.find((z) => num(profile[z]) !== null && chartHas(z));

    if (!primary) {
      return {
        ok: false,
        reason: "no-overlap",
        message:
          "Tøjets tabel og din profil deler ikke nok mål til en sikker anbefaling. Udfyld flere mål i din profil.",
      };
    }

    // Score every size row. Lower score = better.
    const scored = garment.rows.map((row) => {
      const primGap = num(row[primary]) - num(profile[primary]);
      // Distance from the ideal ease on the primary zone drives the score.
      let penalty = Math.abs(primGap - easeTarget);
      // Hard penalty for sizes that are physically too small on the primary zone.
      if (primGap < -2) penalty += 8 + Math.abs(primGap);

      // Per-zone fit breakdown (for the UI bars).
      const breakdown = makeBreakdown(profile, row, zones);

      return { size: row.size, penalty, primGap, breakdown };
    });

    scored.sort((a, b) => a.penalty - b.penalty);
    const best = scored[0];
    const runnerUp = scored[1];

    // Confidence: blend of data completeness, source quality, and how clearly
    // the winner beats the runner-up.
    const relevantZones = zones.filter((z) => num(profile[z]) !== null && chartHas(z));
    const completeness = relevantZones.length / zones.length; // 0..1
    const sourceQuality =
      garment.source === "size-table" ? 1 : garment.source === "model-hint" ? 0.55 : 0.4;
    const separation = runnerUp
      ? Math.min(1, Math.abs(runnerUp.penalty - best.penalty) / 4)
      : 0.7;
    const fitQuality = Math.max(0, 1 - Math.abs(best.primGap - easeTarget) / 10);

    let confidence =
      0.34 * completeness + 0.3 * sourceQuality + 0.18 * separation + 0.18 * fitQuality;
    confidence = Math.max(0.08, Math.min(0.97, confidence));

    const level = confidence >= 0.7 ? "high" : confidence >= 0.45 ? "medium" : "low";

    // A short human reason.
    const primFit = best.breakdown.find((b) => b.zone === primary);
    let reasonText = `Bedste match på ${ZONE_LABEL[primary].toLowerCase()}`;
    if (primFit) reasonText += ` (${primFit.fitLabel.toLowerCase()})`;
    if (best.primGap < 0) reasonText += " — ligger lidt stramt, overvej en op";

    return {
      ok: true,
      size: best.size,
      confidence,
      level,
      reason: reasonText,
      primaryZone: primary,
      breakdown: best.breakdown,
      alternatives: scored.slice(1, 3).map((s) => ({ size: s.size, penalty: s.penalty })),
      source: garment.source,
    };
  }

  /**
   * Build a recommendation from the AI's anchored answer. The AI picks the size
   * (using model reference + the fit it sees in the images), and we render the
   * per-zone bars locally from its anchored chart so numbers stay consistent.
   * @param {Object} profile  user measurements
   * @param {Object} garment  must contain rows[] (AI-anchored chart) + type
   * @param {Object} ai       { size, confidence, reason, alternatives, intendedFit }
   */
  // Preset fit styling so the AI's own per-zone verdict (from the images) can
  // drive the bars directly, consistent with its overall judgment.
  const FIT_PRESET = {
    "too-small": { label: "For stram", pct: 5 },
    tight: { label: "Stram", pct: 22 },
    snug: { label: "Tætsiddende", pct: 40 },
    regular: { label: "Regulær", pct: 58 },
    relaxed: { label: "Løs", pct: 78 },
    oversized: { label: "Meget løs", pct: 94 },
  };

  function fromAI(profile, garment, ai) {
    const type = garment.type && ZONES_BY_TYPE[garment.type] ? garment.type : "unknown";
    const zones = ZONES_BY_TYPE[type];
    const rows = Array.isArray(garment.rows) ? garment.rows : [];
    const want = String(ai.size || "").toUpperCase();
    const row = rows.find((r) => String(r.size).toUpperCase() === want) || rows[0] || {};

    let breakdown = makeBreakdown(profile, row, zones);

    // If the AI graded each zone visually, use that for the bars (more accurate
    // for eased/oversized garments), keeping the chart numbers for transparency.
    if (Array.isArray(ai.zones) && ai.zones.length) {
      const byChart = Object.fromEntries(breakdown.map((b) => [b.zone, b]));
      breakdown = ai.zones
        .map((z) => {
          const key = FIT_PRESET[z.fit] ? z.fit : "regular";
          const preset = FIT_PRESET[key];
          const base = byChart[z.zone] || {};
          return {
            zone: z.zone,
            zoneLabel: ZONE_LABEL[z.zone] || z.zone,
            gap: base.gap ?? null,
            garmentValue: base.garmentValue ?? null,
            bodyValue: base.bodyValue ?? num(profile[z.zone]),
            key,
            fitLabel: preset.label,
            pct: preset.pct,
          };
        })
        .filter((b) => b.bodyValue != null);
    }
    let confidence = typeof ai.confidence === "number" ? ai.confidence : 0.6;
    confidence = Math.max(0.08, Math.min(0.97, confidence));
    const level = confidence >= 0.7 ? "high" : confidence >= 0.45 ? "medium" : "low";

    return {
      ok: true,
      size: ai.size,
      confidence,
      level,
      reason: ai.reason || "",
      intendedFit: ai.intendedFit || null,
      breakdown,
      alternatives: (ai.alternatives || []).map((a) =>
        typeof a === "string" ? { size: a } : { size: a.size, when: a.when }
      ),
      source: "ai-estimate",
    };
  }

  root.FitMatch = { recommend, fromAI, makeBreakdown, classifyFit, ZONE_LABEL };
})(typeof window !== "undefined" ? window : globalThis);
