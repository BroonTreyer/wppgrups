import test from "node:test";
import assert from "node:assert/strict";
import { QueueService } from "../src/services/queue-service.js";
import { SAMPLE_OFFER } from "../src/mock/sample-offer.js";

class MemoryStore {
  constructor() { this.state = { queue: [] }; }
  async read() { return structuredClone(this.state); }
  async update(mutator) { return mutator(this.state); }
}

const config = {
  scheduler: { startHour: 0, endHour: 24, retryDelayMinutes: 5 },
  limits: { deduplicationHours: 24 }
};

test("adia oferta sem consumir tentativa quando nenhum destino esta elegivel", async () => {
  const now = new Date("2026-08-27T17:00:00Z");
  const store = new MemoryStore();
  const service = new QueueService({
    store, config, clock: () => now,
    publicationService: { publish: async () => ({ matchedDestinations: 0, deliveredDestinations: 0 }) }
  });
  await service.enqueue(SAMPLE_OFFER);
  const result = await service.processNext();
  assert.equal(result.processed, false);
  assert.equal(store.state.queue[0].status, "queued");
  assert.equal(store.state.queue[0].attempts, 0);
  assert.equal(store.state.queue[0].nextAttemptAt, "2026-08-27T17:05:00.000Z");
});

test("uma falha afeta somente o item selecionado", async () => {
  const store = new MemoryStore();
  const service = new QueueService({
    store, config, clock: () => new Date("2026-08-27T17:00:00Z"),
    publicationService: { publish: async () => { throw new Error("falha simulada"); } }
  });
  const first = await service.enqueue(SAMPLE_OFFER);
  const second = await service.enqueue({ ...SAMPLE_OFFER, externalId: "outro", title: "Outro produto" });
  await service.processNext();
  assert.equal(store.state.queue.find((item) => item.id === first.id).attempts, 1);
  assert.equal(store.state.queue.find((item) => item.id === second.id).attempts, 0);
});

const freshness = { minutes: 25, maxAgeHours: 6, priceRiseTolerance: 0.02, minDiscountAfterRefresh: 10, refreshPages: 2 };
const guardConfig = { ...config, freshness };

class FakePriceGuard {
  constructor(results) { this.results = results; this.calls = 0; }
  isFresh(item, now) { return now - new Date(item.confirmedAt ?? item.createdAt) < freshness.minutes * 60000; }
  isExpired(item, now) { return now - new Date(item.createdAt) >= freshness.maxAgeHours * 3600000; }
  async refresh(items) { this.calls += 1; return items.map((item) => this.results(item)); }
}

const staleClock = () => new Date("2026-08-27T18:00:00Z");

test("revalida o preco antes de publicar quando a oferta esfriou", async () => {
  const store = new MemoryStore();
  const published = [];
  const guard = new FakePriceGuard((item) => ({ id: item.id, status: "updated", offer: { ...item.offer, currentPrice: 1899 } }));
  const service = new QueueService({
    store, config: guardConfig, priceGuard: guard, clock: staleClock,
    publicationService: { publish: async (offer) => { published.push(offer); return { matchedDestinations: 1, deliveredDestinations: 1 }; } }
  });
  await service.enqueue({ ...SAMPLE_OFFER, capturedAt: "2026-08-27T17:00:00Z" });
  const result = await service.processNext();
  assert.equal(guard.calls, 1);
  assert.equal(result.processed, true);
  assert.equal(published[0].currentPrice, 1899);
  assert.equal(store.state.queue[0].status, "published");
});

test("nao publica oferta cujo preco subiu desde a coleta", async () => {
  const store = new MemoryStore();
  let publishes = 0;
  const guard = new FakePriceGuard((item) => ({ id: item.id, status: "stale", currentPrice: 2999 }));
  const service = new QueueService({
    store, config: guardConfig, priceGuard: guard, clock: staleClock,
    publicationService: { publish: async () => { publishes += 1; return { matchedDestinations: 1, deliveredDestinations: 1 }; } }
  });
  await service.enqueue({ ...SAMPLE_OFFER, capturedAt: "2026-08-27T17:00:00Z" });
  const result = await service.processNext();
  assert.equal(publishes, 0);
  assert.equal(result.reason, "empty");
  assert.equal(store.state.queue[0].status, "stale");
  assert.match(store.state.queue[0].lastDeferredReason, /Preco subiu/);
});

test("expira oferta que ficou tempo demais na fila", async () => {
  const store = new MemoryStore();
  const guard = new FakePriceGuard((item) => ({ id: item.id, status: "confirmed" }));
  const service = new QueueService({
    store, config: guardConfig, priceGuard: guard, clock: () => new Date("2026-08-28T02:00:00Z"),
    publicationService: { publish: async () => ({ matchedDestinations: 1, deliveredDestinations: 1 }) }
  });
  store.state.queue.push({
    id: "antiga", status: "queued", score: 50, createdAt: "2026-08-27T17:00:00Z", confirmedAt: "2026-08-27T17:00:00Z",
    productKey: "Marketplace Demo:demo", offer: SAMPLE_OFFER, nicheIds: ["general"], attempts: 0
  });
  const result = await service.processNext();
  assert.equal(result.reason, "empty");
  assert.equal(store.state.queue[0].status, "expired");
});

test("atualiza o item da fila quando o mesmo produto volta mais barato", async () => {
  const store = new MemoryStore();
  const service = new QueueService({ store, config: guardConfig, clock: () => new Date("2026-08-27T17:00:00Z"), publicationService: { publish: async () => ({}) } });
  await service.enqueue(SAMPLE_OFFER);
  await service.enqueue({ ...SAMPLE_OFFER, currentPrice: 1799 });
  assert.equal(store.state.queue.length, 1);
  assert.equal(store.state.queue[0].offer.currentPrice, 1799);
});

test("publica primeiro a oferta que esta prestes a acabar", async () => {
  const store = new MemoryStore();
  const published = [];
  const agora = new Date("2026-08-27T17:00:00Z");
  const service = new QueueService({
    store, config: { ...guardConfig, freshness: { ...freshness, urgentMinutes: 120 } }, clock: () => agora,
    publicationService: { publish: async (offer) => { published.push(offer.externalId); return { matchedDestinations: 1, deliveredDestinations: 1 }; } }
  });
  await service.enqueue({ ...SAMPLE_OFFER, externalId: "score-alto", currentPrice: 500, originalPrice: 5000 });
  await service.enqueue({ ...SAMPLE_OFFER, externalId: "acabando", currentPrice: 2500, originalPrice: 2899, expiresAt: new Date(agora.getTime() + 40 * 60000).toISOString() });
  await service.processNext();
  assert.deepEqual(published, ["acabando"]);
});

test("expira item cuja promocao terminou antes da vez dele", async () => {
  const store = new MemoryStore();
  const agora = new Date("2026-08-27T17:00:00Z");
  const guard = new FakePriceGuard((item) => ({ id: item.id, status: "confirmed" }));
  const service = new QueueService({
    store, config: { ...guardConfig, freshness: { ...freshness, minValidityMinutes: 30, urgentMinutes: 120 } }, priceGuard: guard, clock: () => agora,
    publicationService: { publish: async () => ({ matchedDestinations: 1, deliveredDestinations: 1 }) }
  });
  await service.enqueue({ ...SAMPLE_OFFER, expiresAt: new Date(agora.getTime() + 5 * 60000).toISOString() });
  const result = await service.processNext();
  assert.equal(result.reason, "empty");
  assert.equal(store.state.queue[0].status, "expired");
  assert.match(store.state.queue[0].lastDeferredReason, /termina em 5 min/);
});
