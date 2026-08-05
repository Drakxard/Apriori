const test = require("node:test");
const assert = require("node:assert/strict");
const { acronym, calculateSchedule, hasCircularGap, nextOccurrenceDistance, parseLocalDate } = require("../scheduler.js");

const TODAY = new Date(2026, 6, 31, 12);
function subject(id, overrides = {}) {
  return { id, name: id, active: true, baseWeight: 1, classDays: [], evaluations: [], ...overrides };
}
function evaluation(date, name = "Parcial") { return { id: `${date}-${name}`, name, date }; }
function counts(schedule) { return Object.fromEntries(schedule.allocations.map((item) => [item.id, item.tickets])); }

test("distribuye exactamente 20 turnos y reserva uno por materia en regular", () => {
  const result = calculateSchedule([subject("A", { baseWeight: 9 }), subject("B", { baseWeight: 1 })]);
  assert.equal(result.mode, "regular");
  assert.equal(result.ring.length, 20);
  assert.deepEqual(counts(result), { A: 17, B: 3 });
});

test("respeta tamaño de ciclo, pesos y desempate estable", () => {
  const result = calculateSchedule([subject("A"), subject("B"), subject("C")], { cycleSize: 5, urgencyK: 14 });
  assert.deepEqual(counts(result), { A: 2, B: 2, C: 1 });
  assert.equal(result.ring.length, 5);
});

test("una materia inactiva no recibe turnos", () => {
  const result = calculateSchedule([subject("A"), subject("B", { active: false })]);
  assert.deepEqual(result.allocations.map((item) => item.id), ["A"]);
  assert.ok(result.ring.every((id) => id === "A"));
});

test("aplica los límites de regular, alerta y crítico", () => {
  const at = (date) => [subject("A", { evaluations: [evaluation(date)] }), subject("B")];
  assert.equal(calculateSchedule(at("2026-08-15"), {}, TODAY).mode, "regular");
  assert.equal(calculateSchedule(at("2026-08-14"), {}, TODAY).mode, "alert");
  assert.equal(calculateSchedule(at("2026-08-05"), {}, TODAY).mode, "alert");
  assert.equal(calculateSchedule(at("2026-08-04"), {}, TODAY).mode, "critical");
  assert.equal(calculateSchedule(at("2026-07-31"), {}, TODAY).mode, "critical");
  assert.equal(calculateSchedule(at("2026-07-30"), {}, TODAY).mode, "regular");
});

test("el modo crítico incluye todas y sólo las materias inminentes", () => {
  const result = calculateSchedule([
    subject("A", { evaluations: [evaluation("2026-08-01")] }),
    subject("B", { evaluations: [evaluation("2026-08-04")] }),
    subject("C", { evaluations: [evaluation("2026-08-10")] }),
  ], {}, TODAY);
  assert.equal(result.mode, "critical");
  assert.ok(counts(result).A > 0);
  assert.ok(counts(result).B > 0);
  assert.equal(counts(result).C, 0);
});

test("evita división por cero y K cero conserva el peso base", () => {
  const subjects = [subject("A", { evaluations: [evaluation("2026-07-31")] }), subject("B", { evaluations: [evaluation("2026-08-01")] })];
  const result = calculateSchedule(subjects, { urgencyK: 0 }, TODAY);
  assert.deepEqual(counts(result), { A: 10, B: 10 });
  assert.ok(result.allocations.every((item) => Number.isFinite(item.finalWeight)));
});

test("usa sólo la evaluación futura más próxima", () => {
  const result = calculateSchedule([subject("A", { evaluations: [evaluation("2026-07-01"), evaluation("2026-08-10"), evaluation("2026-08-02")] })], {}, TODAY);
  assert.equal(result.allocations[0].evaluation.date, "2026-08-02");
  assert.equal(result.allocations[0].daysRemaining, 2);
});

test("mantiene separación circular cuando es matemáticamente posible", () => {
  const result = calculateSchedule([subject("A"), subject("B"), subject("C")], { cycleSize: 6 });
  assert.equal(hasCircularGap(result.ring), true);
});

test("valida fechas, siglas y distancia circular", () => {
  assert.ok(parseLocalDate("2026-02-28"));
  assert.equal(parseLocalDate("2026-02-30"), null);
  assert.equal(acronym("Estructuras Organizacionales"), "EO");
  assert.equal(nextOccurrenceDistance(["A", "B", "C", "A"], "A"), 3);
});
