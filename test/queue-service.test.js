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
