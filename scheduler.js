(function exposeScheduler(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.StudyScheduler = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createScheduler() {
  "use strict";

  const DAY_MS = 24 * 60 * 60 * 1000;
  const MIN_GAP = 2;
  const DEFAULT_SETTINGS = Object.freeze({ cycleSize: 20, urgencyK: 14 });

  function localDay(date = new Date()) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function parseLocalDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split("-").map(Number);
    const parsed = new Date(year, month - 1, day);
    return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day
      ? parsed
      : null;
  }

  function differenceInDays(laterDate, earlierDate) {
    const later = Date.UTC(laterDate.getFullYear(), laterDate.getMonth(), laterDate.getDate());
    const earlier = Date.UTC(earlierDate.getFullYear(), earlierDate.getMonth(), earlierDate.getDate());
    return Math.round((later - earlier) / DAY_MS);
  }

  function normalizeSettings(settings = {}) {
    const cycleSize = Number.isInteger(Number(settings.cycleSize))
      ? Math.max(1, Math.min(100, Number(settings.cycleSize)))
      : DEFAULT_SETTINGS.cycleSize;
    const urgencyK = Number.isFinite(Number(settings.urgencyK))
      ? Math.max(0, Math.min(100, Number(settings.urgencyK)))
      : DEFAULT_SETTINGS.urgencyK;
    return { cycleSize, urgencyK };
  }

  function upcomingEvaluation(subject, today = new Date()) {
    const currentDay = localDay(today);
    let selected = null;
    for (const evaluation of Array.isArray(subject?.evaluations) ? subject.evaluations : []) {
      const date = parseLocalDate(evaluation?.date);
      if (!date) continue;
      const daysRemaining = differenceInDays(date, currentDay);
      if (daysRemaining < 0) continue;
      if (!selected || daysRemaining < selected.daysRemaining) selected = { evaluation, daysRemaining };
    }
    return selected;
  }

  function acronym(name) {
    const clean = String(name || "").trim().replace(/\s+/g, " ");
    if (!clean) return "?";
    const words = clean.normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(" ");
    const stopWords = new Set(["de", "del", "la", "las", "el", "los", "y", "e", "en"]);
    const relevant = words.filter((word) => !stopWords.has(word.toLocaleLowerCase("es")));
    const selected = relevant.length ? relevant : words;
    return selected.length === 1
      ? selected[0].slice(0, 3).toLocaleUpperCase("es")
      : selected.slice(0, 3).map((word) => word[0]).join("").toLocaleUpperCase("es");
  }

  function ringGapScore(ring) {
    if (ring.length <= 1) return { violations: 0, distanceScore: ring.length };
    let violations = 0;
    let distanceScore = 0;
    for (let index = 0; index < ring.length; index += 1) {
      for (let offset = 1; offset <= Math.min(MIN_GAP, ring.length - 1); offset += 1) {
        if (ring[index] === ring[(index + offset) % ring.length]) violations += MIN_GAP + 1 - offset;
      }
      let distance = 1;
      while (distance < ring.length && ring[index] !== ring[(index + distance) % ring.length]) distance += 1;
      distanceScore += Math.min(distance, MIN_GAP + 1);
    }
    return { violations, distanceScore };
  }

  function hasCircularGap(ring) {
    return ringGapScore(ring).violations === 0;
  }

  function exactArrangement(counts, order) {
    const total = counts.reduce((sum, item) => sum + item.count, 0);
    if (total > 32 || counts.some((item) => item.count > Math.floor(total / 3))) return null;
    const remaining = new Map(counts.map((item) => [item.id, item.count]));
    function search(path) {
      if (path.length === total) return hasCircularGap(path) ? path.slice() : null;
      const candidates = order
        .filter((id) => (remaining.get(id) || 0) > 0 && !path.slice(-2).includes(id))
        .sort((a, b) => remaining.get(b) - remaining.get(a) || order.indexOf(a) - order.indexOf(b));
      for (const id of candidates) {
        if (path.length === total - 1 && (id === path[0] || id === path[1])) continue;
        if (path.length === total - 2 && id === path[0]) continue;
        remaining.set(id, remaining.get(id) - 1);
        path.push(id);
        const result = search(path);
        if (result) return result;
        path.pop();
        remaining.set(id, remaining.get(id) + 1);
      }
      return null;
    }
    return search([]);
  }

  function greedyArrangement(counts, order) {
    const remaining = new Map(counts.map((item) => [item.id, item.count]));
    const total = counts.reduce((sum, item) => sum + item.count, 0);
    const ring = [];
    while (ring.length < total) {
      const eligible = order.filter((id) => (remaining.get(id) || 0) > 0 && !ring.slice(-2).includes(id));
      const candidates = eligible.length ? eligible : order.filter((id) => (remaining.get(id) || 0) > 0);
      candidates.sort((a, b) => remaining.get(b) - remaining.get(a) || order.indexOf(a) - order.indexOf(b));
      const id = candidates[0];
      ring.push(id);
      remaining.set(id, remaining.get(id) - 1);
    }
    return ring;
  }

  function rotateToHead(ring, preferredHead) {
    const index = preferredHead ? ring.indexOf(preferredHead) : -1;
    return index > 0 ? ring.slice(index).concat(ring.slice(0, index)) : ring;
  }

  function arrangeTickets(counts, preferredOrder = [], preferredHead = null) {
    const ids = counts.filter((item) => item.count > 0).map((item) => item.id);
    const order = [...preferredOrder, ...ids].filter((id, index, all) => ids.includes(id) && all.indexOf(id) === index);
    const normalized = counts.filter((item) => item.count > 0);
    return rotateToHead(exactArrangement(normalized, order) || greedyArrangement(normalized, order), preferredHead);
  }

  function largestRemainder(items, total, reserveOne = false) {
    const result = new Map(items.map((item) => [item.id, 0]));
    if (!items.length) return result;
    let distributable = total;
    if (reserveOne && items.length <= total) {
      for (const item of items) result.set(item.id, 1);
      distributable -= items.length;
    }
    const sum = items.reduce((value, item) => value + item.weight, 0);
    const ranked = items.map((item, index) => {
      const exact = sum ? (item.weight / sum) * distributable : distributable / items.length;
      const floor = Math.floor(exact);
      result.set(item.id, result.get(item.id) + floor);
      return { id: item.id, remainder: exact - floor, index };
    }).sort((a, b) => b.remainder - a.remainder || a.index - b.index);
    let assigned = Array.from(result.values()).reduce((value, count) => value + count, 0);
    for (let index = 0; assigned < total; index = (index + 1) % ranked.length) {
      result.set(ranked[index].id, result.get(ranked[index].id) + 1);
      assigned += 1;
    }
    return result;
  }

  function calculateSchedule(subjects, settings = {}, today = new Date(), options = {}) {
    const normalizedSettings = normalizeSettings(settings);
    const active = (Array.isArray(subjects) ? subjects : []).filter((subject) => subject?.id && subject.active !== false);
    const details = active.map((subject) => ({
      subject,
      baseWeight: Math.max(1, Math.min(100, Number(subject.baseWeight) || 1)),
      upcoming: upcomingEvaluation(subject, today),
    }));
    const mode = details.some((item) => item.upcoming && item.upcoming.daysRemaining <= 4)
      ? "critical"
      : details.some((item) => item.upcoming && item.upcoming.daysRemaining <= 14) ? "alert" : "regular";
    const included = mode === "critical"
      ? details.filter((item) => item.upcoming && item.upcoming.daysRemaining <= 4)
      : details;
    const weighted = included.map((item) => {
      const urgent = mode !== "regular" && item.upcoming && item.upcoming.daysRemaining <= 14;
      return {
        ...item,
        finalWeight: urgent
          ? item.baseWeight * (1 + normalizedSettings.urgencyK / Math.max(item.upcoming.daysRemaining, 1))
          : item.baseWeight,
      };
    });
    const counts = largestRemainder(
      weighted.map((item) => ({ id: item.subject.id, weight: item.finalWeight })),
      normalizedSettings.cycleSize,
      mode === "regular",
    );
    const allocations = active.map((subject) => {
      const detail = details.find((item) => item.subject.id === subject.id);
      const weightedDetail = weighted.find((item) => item.subject.id === subject.id);
      const daysRemaining = detail.upcoming?.daysRemaining ?? null;
      let reason = "Prioridad base";
      if (!weightedDetail) reason = "Pausada durante el modo crítico";
      else if (daysRemaining === 0) reason = "Evaluación hoy";
      else if (daysRemaining === 1) reason = "Evaluación mañana";
      else if (daysRemaining !== null && daysRemaining <= 14) reason = `Evaluación en ${daysRemaining} días`;
      return {
        id: subject.id,
        tickets: counts.get(subject.id) || 0,
        baseWeight: detail.baseWeight,
        finalWeight: weightedDetail?.finalWeight ?? detail.baseWeight,
        evaluation: detail.upcoming?.evaluation || null,
        daysRemaining,
        included: Boolean(weightedDetail),
        reason,
      };
    });
    const ring = arrangeTickets(
      allocations.filter((item) => item.tickets > 0).map((item) => ({ id: item.id, count: item.tickets })),
      [...(options.preferredOrder || []), ...active.map((subject) => subject.id)],
      options.preferredHead || null,
    );
    return { mode, settings: normalizedSettings, allocations, ring };
  }

  function buildRing(subjects, today = new Date(), options = {}) {
    return calculateSchedule(subjects, options.settings, today, options).ring;
  }

  function weightSignature(subjects, settings = {}, today = new Date()) {
    const current = localDay(today);
    const day = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}-${String(current.getDate()).padStart(2, "0")}`;
    return `${day}|${JSON.stringify(normalizeSettings(settings))}|${JSON.stringify(subjects)}`;
  }

  function nextOccurrenceDistance(ring, subjectId) {
    if (!Array.isArray(ring) || !ring.length || !subjectId) return null;
    const first = ring.indexOf(subjectId);
    if (first < 0) return null;
    if (first > 0) return first;
    const next = ring.indexOf(subjectId, 1);
    return next >= 0 ? next : ring.length;
  }

  return {
    DAY_MS, DEFAULT_SETTINGS, MIN_GAP, acronym, arrangeTickets, buildRing, calculateSchedule,
    differenceInDays, hasCircularGap, localDay, nextOccurrenceDistance, normalizeSettings,
    parseLocalDate, ringGapScore, upcomingEvaluation, weightSignature,
  };
});
