import assert from "node:assert/strict";
import test from "node:test";
import {
  BURST_WINDOWS, burstCapacity, currentBurst, dayCurve,
  effectiveInterval, hourWeight, intervalFactor, isDeadHour, burstsOutsideWindow
} from "../src/domain/timing.js";

// Horario de Brasilia = UTC-3.
const brt = (horaLocal) => new Date(Date.UTC(2026, 8, 2, horaLocal + 3, 0, 0));

test("as janelas vao das 5h ate a das 21h: o grupo fecha as 22h", () => {
  assert.equal(BURST_WINDOWS.length, 17);
  const horas = BURST_WINDOWS.map((j) => j.hora).sort((a, b) => a - b);
  assert.deepEqual(horas, Array.from({ length: 17 }, (_, i) => i + 5));
  assert.equal(new Set(horas).size, 17, "sem hora repetida");
});

test("a noite e morta: das 22h as 5h nada sai", () => {
  // O silencio da noite voltou por decisao do dono do canal em 14/09/2026. O
  // teste existe para que reabrir a madrugada seja escolha explicita, nao acidente.
  for (const hora of [22, 23, 0, 1, 2, 3, 4]) {
    assert.equal(isDeadHour(brt(hora)), true, `${hora}h deveria estar fechada`);
    assert.equal(effectiveInterval(12, brt(hora)), Infinity);
    assert.equal(intervalFactor(brt(hora)), Infinity);
  }
  for (const hora of [5, 12, 21]) assert.equal(isDeadHour(brt(hora)), false, `${hora}h deveria publicar`);
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

test("a conta do volume fecha com 17 rajadas", () => {
  // Seis destinos a 2 min: cada um solta 30 na hora da rajada.
  const destinos = Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, active: true, minMinutesBetweenPosts: 2 }));
  const { porRajada, porDia, rajadas } = burstCapacity(destinos);
  assert.equal(porRajada, 180);
  assert.equal(rajadas, 17);
  // Fechar a noite custa volume: 6 destinos a 2 min ja NAO sustentam 600 cada
  // (510). Quem quiser 600 por destino precisa encurtar o intervalo ou usar rajada.
  assert.equal(porDia, 3060);
});

test("destino desligado nao conta no volume", () => {
  const destinos = [
    { id: "a", active: true, minMinutesBetweenPosts: 12 },
    { id: "b", active: false, minMinutesBetweenPosts: 12 }
  ];
  assert.equal(burstCapacity(destinos).porRajada, 5);
});

test("a curva do dia marca so 5h-21h como rajada", () => {
  const curva = dayCurve(brt(13));
  assert.equal(curva.length, 24);
  assert.equal(curva.filter((h) => h.peso === 1).length, 17);
  assert.equal(curva[13].rajada, "tarde-13h");
  assert.equal(curva[5].rajada, "manha-5h");
  assert.equal(curva[21].rajada, "noite-21h");
  assert.equal(curva[3].rajada, null, "madrugada fechada");
  assert.equal(curva[22].rajada, null, "22h e hora do fechamento, nao de oferta");
});

test("a hora vem do fuso brasileiro, nao do da maquina", () => {
  // 22:00 UTC = 19:00 BRT: e rajada da noite, ainda que o UTC diga 22h.
  assert.equal(currentBurst(new Date("2026-09-02T22:00:00Z"))?.rotulo, "noite-19h");
  // 19:00 UTC = 16:00 BRT: rajada da tarde.
  assert.equal(currentBurst(new Date("2026-09-02T19:00:00Z"))?.rotulo, "tarde-16h");
});

test("denuncia as rajadas que a janela do agendador silencia", () => {
  // A checagem da fila e `hour < endHour`: a janela certa para estas rajadas e 5h-22h.
  assert.deepEqual(burstsOutsideWindow(5, 22), [], "5h-22h cobre as 17 rajadas");
  assert.deepEqual(burstsOutsideWindow(5, 21).map((j) => j.hora), [21], "fechar as 21h mata a ultima");
  assert.equal(burstsOutsideWindow(8, 22).length, 3, "comecar as 8h mata 5h, 6h e 7h");
  assert.deepEqual(burstsOutsideWindow(0, 24), [], "janela mais larga nao silencia nada");
});

test("o intervalo aceita fracao de minuto, sem piso escondido", () => {
  const naRajada = new Date("2026-09-08T16:00:00Z"); // 13h BRT
  // O arredondamento para 1 minuto que existia aqui era um teto invisivel:
  // quem pedisse 10 posts por minuto batia nele sem pista de onde vinha.
  assert.equal(effectiveInterval(0.1, naRajada), 0.1);
  assert.equal(effectiveInterval(6, naRajada), 6);
  assert.equal(effectiveInterval(0, naRajada), 0);
  // 04:00 UTC = 1h BRT: madrugada fechada.
  assert.equal(effectiveInterval(0.1, new Date("2026-09-08T04:00:00Z")), Infinity);
});

test("a capacidade conta a fracao em vez de mentir 60", () => {
  const { porRajada, porDia } = burstCapacity([{ active: true, minMinutesBetweenPosts: 0.1 }]);
  assert.equal(porRajada, 600, "0.1 min = 6s = 600 por hora");
  assert.equal(porDia, 10200, "600 por rajada x 17 rajadas");
});

test("a capacidade multiplica pela rajada do destino", () => {
  // #5 em 11/09/2026: 15 posts a cada 10 min = 6 liberacoes/hora x 15 = 90/hora.
  const { porRajada, porDia } = burstCapacity([{ active: true, minMinutesBetweenPosts: 10, burstSize: 15 }]);
  assert.equal(porRajada, 90, "6 liberacoes por hora x 15 posts");
  assert.equal(porDia, 1530, "90 por rajada x 17 rajadas");
});
