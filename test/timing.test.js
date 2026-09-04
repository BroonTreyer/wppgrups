import assert from "node:assert/strict";
import test from "node:test";
import { dayCurve, effectiveInterval, hourWeight, intervalFactor, isDeadHour } from "../src/domain/timing.js";

// Horario de Brasilia = UTC-3. Uma quarta-feira, para fugir dos ajustes de
// sexta/sabado e medir a curva horaria pura.
const brt = (horaLocal) => new Date(Date.UTC(2026, 8, 2, horaLocal + 3, 0, 0));

test("madrugada nao publica", () => {
  for (const hora of [0, 1, 2, 3, 4, 5]) {
    assert.equal(hourWeight(brt(hora)), 0, `${hora}h deveria ser hora morta`);
    assert.equal(isDeadHour(brt(hora)), true);
    assert.equal(intervalFactor(brt(hora)), Infinity);
    assert.equal(effectiveInterval(12, brt(hora)), Infinity);
  }
});

test("almoco e noite sao pico", () => {
  for (const hora of [12, 13, 19, 20, 21]) {
    assert.equal(hourWeight(brt(hora)), 1, `${hora}h deveria ser pico`);
    assert.equal(effectiveInterval(12, brt(hora)), 12, "em pico o intervalo e o configurado");
  }
});

test("hora morna estica o intervalo, sem publicar menos que o teto", () => {
  // 15h tem peso 0.6: o intervalo cresce, mas o esticamento e limitado para o
  // destino nao atravessar a tarde calado.
  const meio = effectiveInterval(12, brt(15));
  assert.ok(meio > 12, `esperava mais que 12, veio ${meio}`);
  assert.ok(meio <= 36, `o teto de 3x deveria segurar em 36, veio ${meio}`);
});

test("a curva nunca estica alem do teto", () => {
  for (let hora = 0; hora < 24; hora += 1) {
    const fator = intervalFactor(brt(hora));
    assert.ok(fator === Infinity || fator <= 3, `${hora}h -> ${fator}`);
  }
});

test("sexta e sabado pesam mais que segunda no mesmo horario", () => {
  const segunda = new Date(Date.UTC(2026, 8, 7, 23, 0, 0)); // 20h BRT de segunda
  const sexta = new Date(Date.UTC(2026, 8, 4, 23, 0, 0));   // 20h BRT de sexta
  assert.ok(hourWeight(sexta) > hourWeight(segunda), `${hourWeight(sexta)} vs ${hourWeight(segunda)}`);
});

test("o dia da semana vem do fuso brasileiro, nao do da maquina", () => {
  // 01:00 UTC de segunda ainda e domingo 22h em Brasilia. Usar getDay() daria
  // segunda e aplicaria o ajuste errado.
  const madrugadaUtc = new Date(Date.UTC(2026, 8, 7, 1, 0, 0));
  const curva = dayCurve(madrugadaUtc);
  const domingo = dayCurve(new Date(Date.UTC(2026, 8, 6, 23, 0, 0)));
  assert.deepEqual(curva.map((c) => c.peso), domingo.map((c) => c.peso));
});

test("a curva do dia cobre as 24 horas", () => {
  const curva = dayCurve(brt(12));
  assert.equal(curva.length, 24);
  assert.equal(curva[3].peso, 0);
  assert.ok(curva[20].peso > 0.9);
});
