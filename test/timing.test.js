import assert from "node:assert/strict";
import test from "node:test";
import {
  BURST_WINDOWS, burstCapacity, currentBurst, dayCurve,
  effectiveInterval, hourWeight, intervalFactor, isDeadHour
} from "../src/domain/timing.js";

// Horario de Brasilia = UTC-3.
const brt = (horaLocal) => new Date(Date.UTC(2026, 8, 2, horaLocal + 3, 0, 0));

test("seis rajadas por dia: duas de manha, duas a tarde, duas a noite", () => {
  assert.equal(BURST_WINDOWS.length, 6);
  const manha = BURST_WINDOWS.filter((j) => j.hora < 12).length;
  const tarde = BURST_WINDOWS.filter((j) => j.hora >= 12 && j.hora < 18).length;
  const noite = BURST_WINDOWS.filter((j) => j.hora >= 18).length;
  assert.deepEqual([manha, tarde, noite], [2, 2, 2]);
});

test("fora da janela ninguem publica", () => {
  for (const hora of [0, 3, 7, 9, 11, 12, 14, 15, 17, 18, 20, 22, 23]) {
    assert.equal(isDeadHour(brt(hora)), true, `${hora}h deveria estar fora de rajada`);
    assert.equal(effectiveInterval(12, brt(hora)), Infinity);
    assert.equal(intervalFactor(brt(hora)), Infinity);
  }
});

test("dentro da janela o intervalo e o configurado", () => {
  for (const janela of BURST_WINDOWS) {
    const agora = brt(janela.hora);
    assert.equal(isDeadHour(agora), false, `${janela.hora}h deveria ser rajada`);
    assert.equal(effectiveInterval(12, agora), 12);
    assert.equal(hourWeight(agora), 1);
    assert.equal(currentBurst(agora).rotulo, janela.rotulo);
  }
});

test("a conta do volume fecha: 30 por rajada, 180 no dia", () => {
  // Seis destinos a 12 min: cada um solta 5 na hora da rajada.
  const destinos = Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, active: true, minMinutesBetweenPosts: 12 }));
  const { porRajada, porDia, rajadas } = burstCapacity(destinos);
  assert.equal(porRajada, 30);
  assert.equal(rajadas, 6);
  assert.equal(porDia, 180);
});

test("destino desligado nao conta no volume", () => {
  const destinos = [
    { id: "a", active: true, minMinutesBetweenPosts: 12 },
    { id: "b", active: false, minMinutesBetweenPosts: 12 }
  ];
  assert.equal(burstCapacity(destinos).porRajada, 5);
});

test("a curva do dia marca as seis rajadas e mais nada", () => {
  const curva = dayCurve(brt(13));
  assert.equal(curva.length, 24);
  assert.equal(curva.filter((h) => h.peso === 1).length, 6);
  assert.equal(curva[13].rajada, "tarde-1");
  assert.equal(curva[3].rajada, null);
});

test("a hora vem do fuso brasileiro, nao do da maquina", () => {
  // 22:00 UTC = 19:00 BRT: e rajada da noite, ainda que o UTC diga 22h.
  assert.equal(currentBurst(new Date("2026-09-02T22:00:00Z"))?.rotulo, "noite-1");
  // 19:00 UTC = 16:00 BRT: rajada da tarde.
  assert.equal(currentBurst(new Date("2026-09-02T19:00:00Z"))?.rotulo, "tarde-2");
});
