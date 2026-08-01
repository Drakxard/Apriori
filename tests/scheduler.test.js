const test = require("node:test");
const assert = require("node:assert/strict");
const {
  acronym,
  arrangeTickets,
  buildRing,
  calculateWeight,
  hasCircularGap,
  nextOccurrenceDistance,
  parseLocalDate,
} = require("../scheduler.js");

const TODAY = new Date(2026, 6, 31, 12);

function subject(overrides = {}) {
  return {
    id: overrides.id || "A",
    name: overrides.name || "Algoritmos",
    classDay: overrides.classDay ?? null,
    examDate: overrides.examDate ?? null,
    createdAt: overrides.createdAt || new Date(2026, 6, 31, 9).toISOString(),
  };
}

function countIds(ring) {
  return ring.reduce((counts, id) => {
    counts[id] = (counts[id] || 0) + 1;
    return counts;
  }, {});
}

test("calcula ticket base y bono del día de cursado", () => {
  assert.equal(calculateWeight(subject(), TODAY).tickets, 1);
  assert.equal(calculateWeight(subject({ classDay: TODAY.getDay() }), TODAY).tickets, 2);
});

test("aplica los límites EDF de 14, 7 y 3 días", () => {
  const cases = [
    ["2026-08-14", 2],
    ["2026-08-08", 2],
    ["2026-08-07", 3],
    ["2026-08-04", 3],
    ["2026-08-03", 4],
    ["2026-07-31", 4],
    ["2026-07-30", 1],
    ["2026-08-15", 1],
  ];

  for (const [examDate, expected] of cases) {
    assert.equal(calculateWeight(subject({ examDate }), TODAY).tickets, expected, examDate);
  }
});

test("aplica aging desde 3 y 6 semanas", () => {
  assert.equal(
    calculateWeight(subject({ createdAt: new Date(2026, 6, 10, 9).toISOString() }), TODAY).tickets,
    2,
  );
  assert.equal(
    calculateWeight(subject({ createdAt: new Date(2026, 5, 19, 9).toISOString() }), TODAY).tickets,
    3,
  );
});

test("limita la suma de bonos a cuatro tickets", () => {
  const result = calculateWeight(
    subject({
      classDay: TODAY.getDay(),
      examDate: "2026-08-01",
      createdAt: new Date(2026, 4, 1, 9).toISOString(),
    }),
    TODAY,
  );
  assert.equal(result.tickets, 4);
  assert.ok(result.rawTickets > result.tickets);
  assert.match(result.reasons.join(" "), /tope/);
});

test("valida fechas locales sin aceptar desbordes", () => {
  assert.ok(parseLocalDate("2026-02-28"));
  assert.equal(parseLocalDate("2026-02-30"), null);
  assert.equal(parseLocalDate("31/07/2026"), null);
});

test("calcula los turnos hasta la próxima aparición circular", () => {
  assert.equal(nextOccurrenceDistance(["A", "B", "C", "A"], "B"), 1);
  assert.equal(nextOccurrenceDistance(["A", "B", "C", "A"], "A"), 3);
  assert.equal(nextOccurrenceDistance(["A", "B", "C"], "A"), 3);
  assert.equal(nextOccurrenceDistance(["A"], "A"), 1);
});

test("no calcula distancia para una cola vacía o una materia ausente", () => {
  assert.equal(nextOccurrenceDistance([], "A"), null);
  assert.equal(nextOccurrenceDistance(["A", "B"], "C"), null);
  assert.equal(nextOccurrenceDistance(null, "A"), null);
});

test("genera siglas compactas", () => {
  assert.equal(acronym("Estructuras Organizacionales"), "EO");
  assert.equal(acronym("Probabilidad"), "PRO");
  assert.equal(acronym("  ingeniería   de software "), "IS");
  assert.equal(acronym("Álgebra 2"), "A2");
  assert.equal(acronym("Ingeniería de Gestión"), "IG");
});

test("respeta dos elementos entre repeticiones cuando es posible", () => {
  const ring = arrangeTickets(
    [
      { id: "A", count: 2 },
      { id: "B", count: 2 },
      { id: "C", count: 2 },
    ],
    ["A", "B", "C"],
    "A",
  );
  assert.deepEqual(countIds(ring), { A: 2, B: 2, C: 2 });
  assert.equal(ring[0], "A");
  assert.equal(hasCircularGap(ring), true);
});

test("conserva todos los tickets y degrada de forma estable si el gap es imposible", () => {
  const counts = [
    { id: "A", count: 4 },
    { id: "B", count: 1 },
    { id: "C", count: 1 },
  ];
  const first = arrangeTickets(counts, ["A", "B", "C"], "A");
  const second = arrangeTickets(counts, ["A", "B", "C"], "A");
  assert.deepEqual(first, second);
  assert.deepEqual(countIds(first), { A: 4, B: 1, C: 1 });
});

test("buildRing refleja exactamente el peso calculado", () => {
  const subjects = [
    subject({ id: "A", classDay: TODAY.getDay() }),
    subject({ id: "B", examDate: "2026-08-07" }),
    subject({ id: "C" }),
  ];
  const ring = buildRing(subjects, TODAY, { preferredHead: "B" });
  assert.equal(ring[0], "B");
  assert.deepEqual(countIds(ring), { A: 2, B: 3, C: 1 });
});
