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
      const breakdown = zones
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

  root.FitMatch = { recommend, classifyFit, ZONE_LABEL };
})(typeof window !== "undefined" ? window : globalThis);
