import assert from "node:assert/strict";
import test from "node:test";
import {
  BURST_WINDOWS, burstCapacity, currentBurst, dayCurve,
  effectiveInterval, hourWeight, intervalFactor, isDeadHour, burstsOutsideWindow
} from "../src/domain/timing.js";

// Horario de Brasilia = UTC-3.
const brt = (horaLocal) => new Date(Date.UTC(2026, 8, 2, horaLocal + 3, 0, 0));

test("doze rajadas por dia: quatro de manha, quatro a tarde, quatro a noite", () => {
  assert.equal(BURST_WINDOWS.length, 12);
  const manha = BURST_WINDOWS.filter((j) => j.hora < 12).length;
  const tarde = BURST_WINDOWS.filter((j) => j.hora >= 12 && j.hora < 18).length;
  const noite = BURST_WINDOWS.filter((j) => j.hora >= 18).length;
  assert.deepEqual([manha, tarde, noite], [4, 4, 4]);
  // Comeca cedo e termina tarde.
  assert.equal(Math.min(...BURST_WINDOWS.map((j) => j.hora)), 6);
  assert.equal(Math.max(...BURST_WINDOWS.map((j) => j.hora)), 23);
  // Nenhuma janela colada na seguinte: sempre ha uma hora de silencio no meio.
  const horas = BURST_WINDOWS.map((j) => j.hora).sort((a, b) => a - b);
  assert.equal(new Set(horas).size, horas.length, "sem hora repetida");
});

test("fora da janela ninguem publica", () => {
  for (const hora of [0, 3, 5, 7, 10, 12, 15, 18, 21]) {
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

test("a conta do volume fecha: 30 por rajada, 360 no dia", () => {
  // Seis destinos a 12 min: cada um solta 5 na hora da rajada.
  const destinos = Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, active: true, minMinutesBetweenPosts: 12 }));
  const { porRajada, porDia, rajadas } = burstCapacity(destinos);
  assert.equal(porRajada, 30);
  assert.equal(rajadas, 12);
  assert.equal(porDia, 360);
  // Por destino sao 5 x 12 = 60 no dia, abaixo do teto de 70 que os canais usam.
  assert.ok(porDia / destinos.length <= 70, "estouraria o teto diario do destino");
});

test("destino desligado nao conta no volume", () => {
  const destinos = [
    { id: "a", active: true, minMinutesBetweenPosts: 12 },
    { id: "b", active: false, minMinutesBetweenPosts: 12 }
  ];
  assert.equal(burstCapacity(destinos).porRajada, 5);
});

test("a curva do dia marca as doze rajadas e mais nada", () => {
  const curva = dayCurve(brt(13));
  assert.equal(curva.length, 24);
  assert.equal(curva.filter((h) => h.peso === 1).length, 12);
  assert.equal(curva[13].rajada, "tarde-1");
  assert.equal(curva[3].rajada, null);
  assert.equal(curva[6].rajada, "manha-1");
  assert.equal(curva[23].rajada, "noite-4");
});

test("a hora vem do fuso brasileiro, nao do da maquina", () => {
  // 22:00 UTC = 19:00 BRT: e rajada da noite, ainda que o UTC diga 22h.
  assert.equal(currentBurst(new Date("2026-09-02T22:00:00Z"))?.rotulo, "noite-1");
  // 19:00 UTC = 16:00 BRT: rajada da tarde.
  assert.equal(currentBurst(new Date("2026-09-02T19:00:00Z"))?.rotulo, "tarde-3");
});

test("denuncia as rajadas que a janela do agendador silencia", () => {
  // O padrao antigo (8h-23h) matava as rajadas das 6h e das 23h: a checagem da
  // fila e `hour < endHour`, entao a hora 23 fica de fora mesmo com endHour 23.
  assert.deepEqual(burstsOutsideWindow(8, 23).map((j) => j.hora), [6, 23]);
  assert.deepEqual(burstsOutsideWindow(6, 24), [], "6h-24h cobre as doze rajadas");
  assert.deepEqual(burstsOutsideWindow(0, 24), [], "janela aberta nao silencia nada");
  assert.equal(burstsOutsideWindow(13, 18).length, 8, "janela estreita silencia oito");
});

test("o intervalo aceita fracao de minuto, sem piso escondido", () => {
  const naRajada = new Date("2026-09-08T16:00:00Z"); // 13h BRT
  // O arredondamento para 1 minuto que existia aqui era um teto invisivel:
  // quem pedisse 10 posts por minuto batia nele sem pista de onde vinha.
  assert.equal(effectiveInterval(0.1, naRajada), 0.1);
  assert.equal(effectiveInterval(6, naRajada), 6);
  assert.equal(effectiveInterval(0, naRajada), 0);
  assert.equal(effectiveInterval(0.1, new Date("2026-09-08T04:00:00Z")), Infinity, "fora de rajada continua fechado");
});

test("a capacidade conta a fracao em vez de mentir 60", () => {
  const { porRajada, porDia } = burstCapacity([{ active: true, minMinutesBetweenPosts: 0.1 }]);
  assert.equal(porRajada, 600, "0.1 min = 6s = 600 por hora");
  assert.equal(porDia, 7200);
});
