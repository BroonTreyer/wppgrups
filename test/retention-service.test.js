import test from "node:test";
import assert from "node:assert/strict";
import { RetentionService } from "../src/services/retention-service.js";

class MemoryStore {
  constructor(state) { this.state = structuredClone(state); }
  async read() { return structuredClone(this.state); }
  async update(mutator) { return mutator(this.state); }
}

test("remove historico antigo e mantem o que ainda importa", async () => {
  const store = new MemoryStore({
    publications: [
      { id: "velha", createdAt: "2026-01-01T12:00:00Z" },
      { id: "recente", createdAt: "2026-08-30T12:00:00Z" }
    ],
    deliveryEvents: [{ id: "evento-velho", receivedAt: "2026-01-01T12:00:00Z" }],
    queue: [
      { id: "publicada-antiga", status: "published", createdAt: "2026-08-01T12:00:00Z", lastAttemptAt: "2026-08-01T12:00:00Z" },
      { id: "publicada-hoje", status: "published", createdAt: "2026-09-02T10:00:00Z", lastAttemptAt: "2026-09-02T10:00:00Z" },
      { id: "na-fila", status: "queued", createdAt: "2026-06-01T12:00:00Z" }
    ],
    offers: Array.from({ length: 12 }, (_, index) => ({ id: index })),
    alerts: [{ type: "source-empty", message: "x", at: "2026-06-01T12:00:00Z" }]
  });
  const service = new RetentionService({
    store,
    config: { retention: { publicationDays: 90, queueDays: 7, maxOffers: 10 } },
    clock: () => new Date("2026-09-02T12:00:00Z")
  });

  const pruned = await service.prune();
  assert.equal(pruned.publications, 1);
  assert.deepEqual(store.state.publications.map((item) => item.id), ["recente"]);
  assert.equal(store.state.deliveryEvents.length, 0);
  assert.deepEqual(store.state.queue.map((item) => item.id), ["publicada-hoje", "na-fila"]);
  assert.equal(store.state.offers.length, 10);
  assert.equal(store.state.alerts.length, 0);
});
