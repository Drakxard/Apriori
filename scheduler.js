(function exposeScheduler(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.StudyScheduler = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createScheduler() {
  "use strict";

  const DAY_MS = 24 * 60 * 60 * 1000;
  const MAX_TICKETS = 4;
  const MIN_GAP = 2;

  function localDay(date = new Date()) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function parseLocalDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return null;
    }

    const [year, month, day] = value.split("-").map(Number);
    const parsed = new Date(year, month - 1, day);
    if (
      parsed.getFullYear() !== year ||
      parsed.getMonth() !== month - 1 ||
      parsed.getDate() !== day
    ) {
      return null;
    }

    return parsed;
  }

  function differenceInDays(laterDate, earlierDate) {
    const laterUtc = Date.UTC(
      laterDate.getFullYear(),
      laterDate.getMonth(),
      laterDate.getDate(),
    );
    const earlierUtc = Date.UTC(
      earlierDate.getFullYear(),
      earlierDate.getMonth(),
      earlierDate.getDate(),
    );
    return Math.round((laterUtc - earlierUtc) / DAY_MS);
  }

  function getExamBonus(daysRemaining) {
    if (!Number.isInteger(daysRemaining) || daysRemaining < 0 || daysRemaining > 14) {
      return 0;
    }
    if (daysRemaining <= 3) return 3;
    if (daysRemaining <= 7) return 2;
    return 1;
  }

  function getAgingBonus(ageInDays) {
    if (ageInDays >= 42) return 2;
    if (ageInDays >= 21) return 1;
    return 0;
  }

  function calculateWeight(subject, today = new Date()) {
    const currentDay = localDay(today);
    const classDay = Number.isInteger(subject.classDay) ? subject.classDay : null;
    const createdAt = new Date(subject.createdAt);
    const validCreatedAt = Number.isNaN(createdAt.getTime()) ? currentDay : createdAt;
    const ageInDays = Math.max(0, differenceInDays(currentDay, localDay(validCreatedAt)));
    const examDate = parseLocalDate(subject.examDate);
    const daysUntilExam = examDate ? differenceInDays(examDate, currentDay) : null;

    const classBonus = classDay === currentDay.getDay() ? 1 : 0;
    const examBonus = getExamBonus(daysUntilExam);
    const agingBonus = getAgingBonus(ageInDays);
    const rawTickets = 1 + classBonus + examBonus + agingBonus;
    const tickets = Math.min(MAX_TICKETS, rawTickets);
    const reasons = ["prioridad base"];

    if (classBonus) reasons.push("cursado hoy");
    if (examBonus) {
      if (daysUntilExam === 0) reasons.push("examen hoy");
      else if (daysUntilExam === 1) reasons.push("examen mañana");
      else reasons.push(`examen en ${daysUntilExam} días`);
    }
    if (agingBonus === 1) reasons.push("3 semanas en espera");
    if (agingBonus === 2) reasons.push("6 semanas en espera");
    if (rawTickets > MAX_TICKETS) reasons.push(`tope de ${MAX_TICKETS}`);

    return {
      tickets,
      rawTickets,
      classBonus,
      examBonus,
      agingBonus,
      ageInDays,
      daysUntilExam,
      reasons,
    };
  }

  function acronym(name) {
    const clean = String(name || "").trim().replace(/\s+/g, " ");
    if (!clean) return "?";

    const withoutAccents = clean.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const allWords = withoutAccents.split(" ");
    const stopWords = new Set(["de", "del", "la", "las", "el", "los", "y", "e", "en"]);
    const relevantWords = allWords.filter((word) => !stopWords.has(word.toLocaleLowerCase("es")));
    const words = relevantWords.length ? relevantWords : allWords;
    if (words.length === 1) return words[0].slice(0, 3).toLocaleUpperCase("es");
    return words
      .slice(0, 3)
      .map((word) => word[0])
      .join("")
      .toLocaleUpperCase("es");
  }

  function ringGapScore(ring) {
    if (ring.length <= 1) return { violations: 0, distanceScore: ring.length };

    let violations = 0;
    let distanceScore = 0;
    for (let index = 0; index < ring.length; index += 1) {
      for (let offset = 1; offset <= Math.min(MIN_GAP, ring.length - 1); offset += 1) {
        if (ring[index] === ring[(index + offset) % ring.length]) {
          violations += MIN_GAP + 1 - offset;
        }
      }

      let distance = 1;
      while (distance < ring.length && ring[index] !== ring[(index + distance) % ring.length]) {
        distance += 1;
      }
      distanceScore += Math.min(distance, MIN_GAP + 1);
    }

    return { violations, distanceScore };
  }

  function hasCircularGap(ring) {
    return ringGapScore(ring).violations === 0;
  }

  function canPossiblyMeetGap(counts) {
    const total = counts.reduce((sum, item) => sum + item.count, 0);
    if (total < MIN_GAP + 1) {
      return counts.every((item) => item.count <= 1);
    }

    const limit = Math.floor(total / (MIN_GAP + 1));
    return counts.every((item) => item.count <= limit);
  }

  function exactCircularArrangement(counts, order, preferredHead) {
    const total = counts.reduce((sum, item) => sum + item.count, 0);
    if (!total || !canPossiblyMeetGap(counts)) return null;
    if (total > 32 || counts.length > 9) return null;

    const remaining = new Map(counts.map((item) => [item.id, item.count]));
    const orderIndex = new Map(order.map((id, index) => [id, index]));
    const firstCandidates = order
      .filter((id) => remaining.has(id))
      .sort((left, right) => {
        if (left === preferredHead) return -1;
        if (right === preferredHead) return 1;
        return (orderIndex.get(left) || 0) - (orderIndex.get(right) || 0);
      });

    function search(path, first, second, failedStates) {
      if (path.length === total) {
        return hasCircularGap(path) ? path.slice() : null;
      }

      const last = path.at(-1);
      const secondLast = path.at(-2);
      const key = `${Array.from(remaining.values()).join(",")}|${secondLast || ""}|${last || ""}`;
      if (failedStates.has(key)) return null;

      const candidates = order
        .filter((id) => (remaining.get(id) || 0) > 0 && id !== last && id !== secondLast)
        .sort((left, right) => {
          const countDifference = (remaining.get(right) || 0) - (remaining.get(left) || 0);
          if (countDifference) return countDifference;
          return (orderIndex.get(left) || 0) - (orderIndex.get(right) || 0);
        });

      for (const id of candidates) {
        const nextPosition = path.length;
        const isLast = nextPosition === total - 1;
        if (isLast && (id === first || id === second)) continue;
        if (nextPosition === total - 2 && id === first) continue;

        remaining.set(id, remaining.get(id) - 1);
        path.push(id);
        const found = search(path, first, second || id, failedStates);
        if (found) return found;
        path.pop();
        remaining.set(id, remaining.get(id) + 1);
      }

      failedStates.add(key);
      return null;
    }

    for (const first of firstCandidates) {
      remaining.set(first, remaining.get(first) - 1);
      const found = search([first], first, null, new Set());
      if (found) return found;
      remaining.set(first, remaining.get(first) + 1);
    }

    return null;
  }

  function greedyArrangement(counts, order, preferredHead, seedOffset = 0) {
    const remaining = new Map(counts.map((item) => [item.id, item.count]));
    const lastUsed = new Map(order.map((id) => [id, Number.NEGATIVE_INFINITY]));
    const total = counts.reduce((sum, item) => sum + item.count, 0);
    const ring = [];

    while (ring.length < total) {
      const eligible = order.filter((id) => {
        if ((remaining.get(id) || 0) <= 0) return false;
        return !ring.slice(-MIN_GAP).includes(id);
      });
      const candidates = eligible.length
        ? eligible
        : order.filter((id) => (remaining.get(id) || 0) > 0);

      candidates.sort((left, right) => {
        if (ring.length === 0) {
          if (left === preferredHead) return -1;
          if (right === preferredHead) return 1;
        }
        const remainingDifference = (remaining.get(right) || 0) - (remaining.get(left) || 0);
        if (remainingDifference) return remainingDifference;
        const ageDifference = (lastUsed.get(left) || 0) - (lastUsed.get(right) || 0);
        if (ageDifference) return ageDifference;
        const leftIndex = (order.indexOf(left) + seedOffset) % order.length;
        const rightIndex = (order.indexOf(right) + seedOffset) % order.length;
        return leftIndex - rightIndex;
      });

      const selected = candidates[0];
      ring.push(selected);
      remaining.set(selected, remaining.get(selected) - 1);
      lastUsed.set(selected, ring.length - 1);
    }

    return ring;
  }

  function rotateToHead(ring, preferredHead) {
    if (!preferredHead || !ring.includes(preferredHead)) return ring;
    const index = ring.indexOf(preferredHead);
    return ring.slice(index).concat(ring.slice(0, index));
  }

  function arrangeTickets(counts, preferredOrder = [], preferredHead = null) {
    const ids = counts.map((item) => item.id);
    const order = [
      ...preferredOrder.filter((id, index) => ids.includes(id) && preferredOrder.indexOf(id) === index),
      ...ids.filter((id) => !preferredOrder.includes(id)),
    ];

    const exact = exactCircularArrangement(counts, order, preferredHead);
    if (exact) return rotateToHead(exact, preferredHead);

    let best = null;
    let bestScore = null;
    const headCandidates = preferredHead ? [preferredHead, null] : [null];
    for (const head of headCandidates) {
      for (let seed = 0; seed < Math.max(1, order.length); seed += 1) {
        const candidate = greedyArrangement(counts, order, head, seed);
        const score = ringGapScore(candidate);
        if (
          !best ||
          score.violations < bestScore.violations ||
          (score.violations === bestScore.violations && score.distanceScore > bestScore.distanceScore)
        ) {
          best = candidate;
          bestScore = score;
        }
      }
    }

    return rotateToHead(best || [], preferredHead);
  }

  function buildRing(subjects, today = new Date(), options = {}) {
    const validSubjects = subjects.filter((subject) => subject && subject.id);
    const counts = validSubjects.map((subject) => ({
      id: subject.id,
      count: calculateWeight(subject, today).tickets,
    }));
    const existingOrder = Array.isArray(options.preferredOrder) ? options.preferredOrder : [];
    const preferredOrder = [
      ...existingOrder,
      ...validSubjects.map((subject) => subject.id),
    ];
    return arrangeTickets(counts, preferredOrder, options.preferredHead || null);
  }

  function weightSignature(subjects, today = new Date()) {
    const current = localDay(today);
    const dayKey = [
      current.getFullYear(),
      String(current.getMonth() + 1).padStart(2, "0"),
      String(current.getDate()).padStart(2, "0"),
    ].join("-");
    const weights = subjects
      .map((subject) => `${subject.id}:${calculateWeight(subject, current).tickets}`)
      .join("|");
    return `${dayKey}|${weights}`;
  }

  return {
    DAY_MS,
    MAX_TICKETS,
    MIN_GAP,
    acronym,
    arrangeTickets,
    buildRing,
    calculateWeight,
    differenceInDays,
    hasCircularGap,
    localDay,
    parseLocalDate,
    ringGapScore,
    weightSignature,
  };
});
