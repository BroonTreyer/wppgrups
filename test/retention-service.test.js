import test from "node:test";
import assert from "node:assert/strict";
import { RetentionService } from "../src/services/retention-service.js";

class MemoryStore {
  constructor(state) { this.state = structuredClone(state); }
  async read() { return structuredClone(this.state); }
  async update(mutator) { return mutator(this.state); }
}

const config = { retention: { publicationDays: 90, queueDays: 7, maxOffers: 10 } };

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

test("item encerrado perde o payload da oferta mas guarda o diagnostico", async () => {
  const agora = new Date("2026-09-10T12:00:00Z");
  const store = new MemoryStore({
    publications: [], deliveryEvents: [], offers: [], alerts: [], affiliateRequests: [],
    queue: [
      { id: "vivo", status: "queued", createdAt: agora.toISOString(), offer: { title: "Fica inteiro", currentPrice: 10 } },
      { id: "morto", status: "expired", createdAt: agora.toISOString(), lastAttemptAt: agora.toISOString(),
        lastDeferredReason: "Oferta saiu da vitrine", nicheIds: ["beauty"],
        offer: { title: "Secador Taiff", currentPrice: 199, imageUrl: "https://x", affiliateUrl: "https://y" } }
    ]
  });
  const service = new RetentionService({ store, config, clock: () => agora });
  await service.prune();

  const vivo = store.state.queue.find((i) => i.id === "vivo");
  assert.ok(vivo.offer, "o que ainda pode publicar mantem a oferta inteira");

  const morto = store.state.queue.find((i) => i.id === "morto");
  assert.equal(morto.offer, undefined, "encerrado nao carrega mais a oferta");
  assert.equal(morto.titulo, "Secador Taiff", "mas o titulo sobrevive para diagnostico");
  assert.equal(morto.lastDeferredReason, "Oferta saiu da vitrine");
  assert.equal(morto.enxuto, true);
});

test("a fila encerrada respeita um teto, nao so a data", async () => {
  const agora = new Date("2026-09-10T12:00:00Z");
  const queue = Array.from({ length: 4500 }, (_, i) => ({
    id: `e${i}`, status: "expired", createdAt: agora.toISOString(), lastAttemptAt: agora.toISOString(),
    offer: { title: `Item ${i}` }
  }));
  queue.push({ id: "vivo", status: "queued", createdAt: agora.toISOString(), offer: { title: "Ativo" } });
  const store = new MemoryStore({ publications: [], deliveryEvents: [], offers: [], alerts: [], affiliateRequests: [], queue });
  const service = new RetentionService({ store, config, clock: () => agora });
  await service.prune();

  const encerrados = store.state.queue.filter((i) => i.status === "expired");
  assert.equal(encerrados.length, 4000, "teto absoluto aplicado");
  assert.ok(store.state.queue.some((i) => i.id === "vivo"), "o que trabalha nunca e cortado pelo teto");
});

test("pedido de link que falhou nao fica para sempre", async () => {
  const agora = new Date("2026-09-10T12:00:00Z");
  const velho = new Date("2026-08-01T12:00:00Z").toISOString();
  const store = new MemoryStore({
    publications: [], deliveryEvents: [], offers: [], alerts: [], queue: [],
    affiliateRequests: [
      { id: "a", status: "failed", createdAt: velho, updatedAt: velho },
      { id: "b", status: "failed", createdAt: agora.toISOString(), updatedAt: agora.toISOString() },
      { id: "c", status: "pending", createdAt: velho, updatedAt: velho }
    ]
  });
  const service = new RetentionService({ store, config, clock: () => agora });
  await service.prune();
  const ids = store.state.affiliateRequests.map((i) => i.id);
  assert.deepEqual(ids.sort(), ["b", "c"], "a falha velha sai; a recente e os pendentes ficam");
});
