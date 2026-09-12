import assert from "node:assert/strict";
import test from "node:test";
import {
  BURST_WINDOWS, burstCapacity, currentBurst, dayCurve,
  effectiveInterval, hourWeight, intervalFactor, isDeadHour, burstsOutsideWindow
} from "../src/domain/timing.js";

// Horario de Brasilia = UTC-3.
const brt = (horaLocal) => new Date(Date.UTC(2026, 8, 2, horaLocal + 3, 0, 0));

test("as 24 horas sao janela: operacao full time", () => {
  assert.equal(BURST_WINDOWS.length, 24);
  const horas = BURST_WINDOWS.map((j) => j.hora).sort((a, b) => a - b);
  assert.deepEqual(horas, Array.from({ length: 24 }, (_, i) => i));
  assert.equal(new Set(horas).size, 24, "sem hora repetida");
});

test("em full time nenhuma hora e morta, madrugada inclusive", () => {
  // O silencio da madrugada foi removido por decisao do dono do canal. O teste
  // existe para que a volta dele seja uma escolha explicita, nao um acidente.
  for (const hora of [0, 1, 2, 3, 4, 5, 12, 22, 23]) {
    assert.equal(isDeadHour(brt(hora)), false, `${hora}h deveria ser rajada`);
    assert.equal(effectiveInterval(12, brt(hora)), 12);
    assert.equal(intervalFactor(brt(hora)), 1);
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

test("a conta do volume fecha: seis destinos a 2 min sustentam 600 cada", () => {
  // Seis destinos a 2 min: cada um solta 30 na hora da rajada.
  const destinos = Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, active: true, minMinutesBetweenPosts: 2 }));
  const { porRajada, porDia, rajadas } = burstCapacity(destinos);
  assert.equal(porRajada, 180);
  assert.equal(rajadas, 24);
  assert.equal(porDia, 4320, "teto da cadencia; o limite diario de cada destino corta antes");
  // O alvo e 600 por destino = 3.600 na frota. A cadencia tem que sobrar sobre o
  // teto diario, nunca o contrario: teto maior que cadencia e promessa vazia.
  assert.ok(porDia >= 3600, "a cadencia nao sustenta 600 por destino");
  assert.ok(porDia / destinos.length >= 600, "um destino sozinho nao alcanca 600");
});

test("destino desligado nao conta no volume", () => {
  const destinos = [
    { id: "a", active: true, minMinutesBetweenPosts: 12 },
    { id: "b", active: false, minMinutesBetweenPosts: 12 }
  ];
  assert.equal(burstCapacity(destinos).porRajada, 5);
});

test("a curva do dia marca as 24 horas como rajada", () => {
  const curva = dayCurve(brt(13));
  assert.equal(curva.length, 24);
  assert.equal(curva.filter((h) => h.peso === 1).length, 24);
  assert.equal(curva[13].rajada, "tarde-13h");
  assert.equal(curva[3].rajada, "manha-3h", "a madrugada tambem publica agora");
  assert.equal(curva[0].rajada, "manha-0h");
  assert.equal(curva[23].rajada, "noite-23h");
});

test("a hora vem do fuso brasileiro, nao do da maquina", () => {
  // 22:00 UTC = 19:00 BRT: e rajada da noite, ainda que o UTC diga 22h.
  assert.equal(currentBurst(new Date("2026-09-02T22:00:00Z"))?.rotulo, "noite-19h");
  // 19:00 UTC = 16:00 BRT: rajada da tarde.
  assert.equal(currentBurst(new Date("2026-09-02T19:00:00Z"))?.rotulo, "tarde-16h");
});

test("denuncia as rajadas que a janela do agendador silencia", () => {
  // O padrao antigo (8h-23h) matava as rajadas das 6h e das 23h: a checagem da
  // fila e `hour < endHour`, entao a hora 23 fica de fora mesmo com endHour 23.
  // Em full time so 0h-24h cobre tudo: qualquer recorte mata rajadas em silencio.
  assert.deepEqual(burstsOutsideWindow(0, 24), [], "0h-24h cobre as 24 rajadas");
  assert.deepEqual(burstsOutsideWindow(5, 23).map((j) => j.hora), [0, 1, 2, 3, 4, 23], "5h-23h mata seis");
  assert.equal(burstsOutsideWindow(8, 23).length, 9, "8h-23h mata nove");
  assert.equal(burstsOutsideWindow(13, 18).length, 19, "janela estreita silencia dezenove");
});

test("o intervalo aceita fracao de minuto, sem piso escondido", () => {
  const naRajada = new Date("2026-09-08T16:00:00Z"); // 13h BRT
  // O arredondamento para 1 minuto que existia aqui era um teto invisivel:
  // quem pedisse 10 posts por minuto batia nele sem pista de onde vinha.
  assert.equal(effectiveInterval(0.1, naRajada), 0.1);
  assert.equal(effectiveInterval(6, naRajada), 6);
  assert.equal(effectiveInterval(0, naRajada), 0);
  // 04:00 UTC = 1h BRT: em full time a madrugada tambem e rajada.
  assert.equal(effectiveInterval(0.1, new Date("2026-09-08T04:00:00Z")), 0.1);
});

test("a capacidade conta a fracao em vez de mentir 60", () => {
  const { porRajada, porDia } = burstCapacity([{ active: true, minMinutesBetweenPosts: 0.1 }]);
  assert.equal(porRajada, 600, "0.1 min = 6s = 600 por hora");
  assert.equal(porDia, 14400, "600 por rajada x 24 rajadas");
});

test("a capacidade multiplica pela rajada do destino", () => {
  // #5 em 11/09/2026: 15 posts a cada 10 min = 6 liberacoes/hora x 15 = 90/hora.
  const { porRajada, porDia } = burstCapacity([{ active: true, minMinutesBetweenPosts: 10, burstSize: 15 }]);
  assert.equal(porRajada, 90, "6 liberacoes por hora x 15 posts");
  assert.equal(porDia, 2160, "90 por rajada x 24 rajadas");
});
