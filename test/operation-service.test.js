import test from "node:test";
import assert from "node:assert/strict";
import { OperationService } from "../src/services/operation-service.js";

class MemoryStore {
  constructor(state) { this.state = structuredClone(state); }
  async read() { return structuredClone(this.state); }
  async update(mutator) { return mutator(this.state); }
}

const config = { dryRun: true, scheduler: { startHour: 8, endHour: 23 }, ingestion: { intervalMinutes: 30 }, limits: { minMinutesFloor: 3 } };
const clock = () => new Date("2026-09-02T17:00:00Z");

const baseState = {
  operation: { running: false },
  destinations: [
    { id: "g1", name: "Grupo 1", type: "group", active: true, maxDailyPosts: 12, minMinutesBetweenPosts: 45 },
    { id: "g2", name: "Grupo 2", type: "group", active: false, maxDailyPosts: 12, minMinutesBetweenPosts: 45 }
  ],
  publications: [
    { destinationId: "g1", status: "sent", createdAt: "2026-09-02T16:40:00Z" },
    { destinationId: "g1", status: "sent", createdAt: "2026-09-02T15:00:00Z" },
    { destinationId: "g1", status: "sent", createdAt: "2026-08-30T15:00:00Z" }
  ],
  queue: [{ status: "queued" }, { status: "queued" }, { status: "published" }]
};

test("liga e desliga a operacao", async () => {
  const store = new MemoryStore(baseState);
  const service = new OperationService({ store, config, clock });
  assert.equal(await service.isRunning(), false);
  await service.setRunning(true);
  assert.equal(await service.isRunning(), true);
  assert.equal(store.state.operation.updatedAt, "2026-09-02T17:00:00.000Z");
  await assert.rejects(() => service.setRunning("sim"), /booleano/);
});

test("resume o dia contando so as publicacoes de hoje no fuso de Sao Paulo", async () => {
  const service = new OperationService({ store: new MemoryStore(baseState), config, clock });
  const status = await service.status();
  assert.equal(status.activeDestinations, 1);
  assert.equal(status.publishedToday, 2);
  assert.equal(status.capacityToday, 12);
  assert.equal(status.queued, 2);
  assert.equal(status.withinWindow, true);
  assert.equal(status.destinations[0].remainingToday, 10);
  assert.equal(status.destinations[0].nextAvailableAt, "2026-09-02T17:25:00.000Z");
});

test("aplica o limite diario apenas nos destinos ativos", async () => {
  const store = new MemoryStore(baseState);
  const service = new OperationService({ store, config, clock });
  const result = await service.setDailyLimit(20);
  assert.equal(result.destinations, 1);
  assert.equal(store.state.destinations[0].maxDailyPosts, 20);
  assert.equal(store.state.destinations[1].maxDailyPosts, 12);
  assert.equal(result.minMinutesBetweenPosts, 45);
  assert.equal(store.state.destinations[0].minMinutesBetweenPosts, 45);
  await assert.rejects(() => service.setDailyLimit(0), /entre 1 e 500/);
});

test("indica quando esta fora da janela de publicacao", async () => {
  const service = new OperationService({ store: new MemoryStore(baseState), config, clock: () => new Date("2026-09-02T09:00:00Z") });
  const status = await service.status();
  assert.equal(status.withinWindow, false);
});

test("ajusta o intervalo para caber o volume pedido por dia", async () => {
  const store = new MemoryStore(baseState);
  const service = new OperationService({ store, config, clock });
  const result = await service.setDailyLimit(70);
  assert.equal(result.minMinutesBetweenPosts, 12);
  assert.equal(result.feasiblePerDay, 70);
  assert.equal(store.state.destinations[0].minMinutesBetweenPosts, 12);
});

test("respeita o piso de intervalo quando o volume pedido e alto demais", async () => {
  const store = new MemoryStore(baseState);
  const service = new OperationService({ store, config, clock });
  const result = await service.setDailyLimit(500);
  assert.equal(result.minMinutesBetweenPosts, 3);
  assert.equal(result.feasiblePerDay, 300);
});

test("aponta destinos com limite diario incompativel com o intervalo", async () => {
  const store = new MemoryStore(baseState);
  store.state.destinations[0].maxDailyPosts = 70;
  store.state.destinations[0].minMinutesBetweenPosts = 45;
  const status = await new OperationService({ store, config, clock }).status();
  assert.equal(status.overbooked.length, 1);
  assert.equal(status.overbooked[0].realistic, 20);
  assert.equal(status.limitToday, 70);
  assert.ok(status.capacityToday < 70);
});

test("altera a janela de publicacao e persiste para o proximo boot", async () => {
  const store = new MemoryStore(baseState);
  const runtime = structuredClone(config);
  const service = new OperationService({ store, config: runtime, clock });
  const result = await service.setWindow({ start: 0, end: 24 });
  assert.deepEqual(result, { start: 0, end: 24, hours: 24 });
  assert.equal(runtime.scheduler.startHour, 0);
  assert.equal(runtime.scheduler.endHour, 24);
  assert.deepEqual(store.state.operation.window, { start: 0, end: 24 });

  const outro = structuredClone(config);
  await new OperationService({ store, config: outro, clock }).restoreWindow();
  assert.equal(outro.scheduler.endHour, 24);
});

test("recusa janela invertida ou fora do dia", async () => {
  const service = new OperationService({ store: new MemoryStore(baseState), config: structuredClone(config), clock });
  await assert.rejects(() => service.setWindow({ start: 20, end: 8 }), /maior que a inicial/);
  await assert.rejects(() => service.setWindow({ start: -1, end: 10 }), /entre 0 e 23/);
  await assert.rejects(() => service.setWindow({ start: 8, end: 25 }), /entre 1 e 24/);
});

test("destino sem teto aparece como null na API, nunca como Infinity", async () => {
  // `JSON.stringify(Infinity)` ja vira `null`, mas por acidente — e enquanto o
  // valor circula do lado do servidor ele contamina qualquer soma que passe por
  // ele. O `null` aqui e deliberado e significa "sem limite".
  const store = new MemoryStore({
    ...baseState,
    destinations: [{ id: "g1", name: "Grupo 1", type: "group", active: true, maxDailyPosts: null, minMinutesBetweenPosts: 10, burstSize: 25 }]
  });
  const status = await new OperationService({ store, config, clock }).status();
  const [destino] = status.destinations;
  assert.equal(destino.maxDailyPosts, null);
  assert.equal(destino.remainingToday, null);
  assert.equal(status.limitToday, null, "somar teto ausente inventaria um limite que nao existe");
  assert.equal(Number.isFinite(destino.feasibleToday), true, "o que cabe hoje ainda e finito: o ritmo limita");
  assert.equal(status.overbooked.length, 0, "sem teto nao ha promessa que o ritmo deixe de cumprir");
});

test("a capacidade anunciada conta a rajada, nao so o intervalo", async () => {
  // Antes isto dizia 144/dia (1440 min / 10) enquanto o grupo entregava 1.000, e
  // `overbooked` acusava de irrealista exatamente a configuracao que funcionava.
  const store = new MemoryStore({
    ...baseState,
    destinations: [{ id: "g1", name: "Grupo 1", type: "group", active: true, maxDailyPosts: 1000, minMinutesBetweenPosts: 10, burstSize: 25 }]
  });
  const status = await new OperationService({ store, config, clock }).status();
  // Janela de 8h as 23h = 15h; 150 por hora.
  assert.equal(status.perDayByInterval, 2250);
  assert.equal(status.overbooked.length, 0, "1000 cabe em 2250");
});

test("sem teto e um inteiro sao dois jeitos validos de definir o limite", async () => {
  const store = new MemoryStore(baseState);
  const service = new OperationService({ store, config, clock });

  const definido = await service.setDailyLimit(300);
  assert.equal(definido.maxDailyPosts, 300);

  // Sem teto o intervalo NAO pode ser recalculado: `intervalFor(null)` divide
  // por zero e devolveria Infinity, destruindo o espacamento do destino.
  const antes = store.state.destinations[0].minMinutesBetweenPosts;
  const semLimite = await service.setDailyLimit(null);
  assert.equal(semLimite.maxDailyPosts, null);
  assert.equal(store.state.destinations[0].maxDailyPosts, null);
  assert.equal(store.state.destinations[0].minMinutesBetweenPosts, antes, "o intervalo foi destruido");

  await assert.rejects(() => service.setDailyLimit(0), /entre 1 e/);
  await assert.rejects(() => service.setDailyLimit(999999), /entre 1 e/);
});

test("o teto aceito aqui e o mesmo que o cadastro do destino aceita", async () => {
  // Este caminho recusava acima de 500 enquanto o cadastro ja gravava 1000: usar
  // o painel para qualquer ajuste ABAIXAVA o limite sem avisar ninguem.
  const store = new MemoryStore(baseState);
  const service = new OperationService({ store, config, clock });
  const alto = await service.setDailyLimit(1000);
  assert.equal(alto.maxDailyPosts, 1000);
});
