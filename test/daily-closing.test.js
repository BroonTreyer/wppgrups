import test from "node:test";
import assert from "node:assert/strict";
import { DailyClosingService } from "../src/services/daily-closing.js";
import { CLOSING_MESSAGES, CLOSING_POLL, closingFor } from "../src/domain/closing.js";

class MemoryStore {
  constructor(state) { this.state = structuredClone(state); }
  async read() { return structuredClone(this.state); }
  async update(mutator) { return mutator(this.state); }
}

const GROUP = "120363431078469154-group";
// 22h05 em Sao Paulo = 01h05 UTC do dia seguinte.
const AS_22H05 = "2026-09-15T01:05:00Z";

function setup({ now = AS_22H05, running = true, active = true, dryRun = false, zapi } = {}) {
  const store = new MemoryStore({ destinations: [{ id: GROUP, active }] });
  const sent = [];
  const client = zapi ?? {
    async sendText(payload) { sent.push({ type: "text", ...payload }); },
    async sendPoll(payload) { sent.push({ type: "poll", ...payload }); }
  };
  const clock = { now: new Date(now) };
  const service = new DailyClosingService({
    store, zapi: client,
    operationService: { isRunning: async () => running },
    config: { dryRun, scheduler: { endHour: 22 }, dailyClosing: { groups: [GROUP], graceMinutes: 45 } },
    clock: () => clock.now, pause: async () => {}
  });
  return { service, sent, store, clock };
}

test("as 22h manda o texto e depois a enquete, uma vez so", async () => {
  const { service, sent } = setup();
  await service.tick();
  assert.deepEqual(sent.map((item) => item.type), ["text", "poll"]);
  assert.equal(sent[1].question, CLOSING_POLL.question);
  assert.equal(sent[1].maxOptions, CLOSING_POLL.options.length, "pode marcar mais de uma");

  await service.tick();
  assert.equal(sent.length, 2, "o segundo ciclo do mesmo dia nao repete");
});

test("antes das 22h e depois da tolerancia nao manda", async () => {
  const antes = setup({ now: "2026-09-15T00:59:00Z" });
  await antes.service.tick();
  assert.equal(antes.sent.length, 0);

  const tarde = setup({ now: "2026-09-15T01:50:00Z" });
  await tarde.service.tick();
  assert.equal(tarde.sent.length, 0, "22h50 ja passou da tolerancia de 45 min");
});

test("operacao pausada ou grupo desligado nao recebe fechamento", async () => {
  const pausada = setup({ running: false });
  await pausada.service.tick();
  assert.equal(pausada.sent.length, 0);

  const inativo = setup({ active: false });
  await inativo.service.tick();
  assert.equal(inativo.sent.length, 0);
});

test("se a enquete falha, a nova tentativa manda so a enquete", async () => {
  const sent = [];
  let falhar = true;
  const { service, store } = setup({
    zapi: {
      async sendText(payload) { sent.push({ type: "text", ...payload }); },
      async sendPoll(payload) {
        if (falhar) throw new Error("Z-API 500");
        sent.push({ type: "poll", ...payload });
      }
    }
  });
  const primeira = await service.tick();
  assert.match(primeira.results[0].error, /500/);
  assert.equal(store.state.dailyClosings[GROUP].done, false);

  falhar = false;
  await service.tick();
  assert.deepEqual(sent.map((item) => item.type), ["text", "poll"], "o texto nao sai duas vezes");
  assert.equal(store.state.dailyClosings[GROUP].done, true);
});

test("desiste depois de 3 falhas em vez de insistir a noite toda", async () => {
  let chamadas = 0;
  const { service } = setup({ zapi: { async sendText() { chamadas += 1; throw new Error("fora do ar"); }, async sendPoll() {} } });
  for (let i = 0; i < 5; i += 1) await service.tick();
  assert.equal(chamadas, 3);
});

test("no dia seguinte manda de novo", async () => {
  const { service, sent, clock } = setup();
  await service.tick();
  clock.now = new Date("2026-09-16T01:05:00Z");
  await service.tick();
  assert.equal(sent.filter((item) => item.type === "text").length, 2);
});

test("dry-run nao envia nada", async () => {
  const { service, sent } = setup({ dryRun: true });
  const result = await service.tick();
  assert.equal(sent.length, 0);
  assert.equal(result.results[0].dryRun, true);
});

test("a mensagem varia entre os dias e a enquete cabe no WhatsApp", () => {
  const textos = new Set(Array.from({ length: 5 }, (_, i) => closingFor(new Date(Date.UTC(2026, 8, 15 + i, 1, 5))).message));
  assert.equal(textos.size, CLOSING_MESSAGES.length);
  assert.ok(CLOSING_POLL.options.length >= 2 && CLOSING_POLL.options.length <= 12);
  assert.ok(CLOSING_POLL.options.every((opcao) => opcao.length <= 100));
  assert.ok(CLOSING_MESSAGES.every((texto) => texto.includes("5h")), "o texto promete a volta no horario real");
});
