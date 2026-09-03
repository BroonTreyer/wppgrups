import test from "node:test";
import assert from "node:assert/strict";
import { PublicationService } from "../src/services/publication-service.js";
import { SAMPLE_OFFER } from "../src/mock/sample-offer.js";

class MemoryStore {
  constructor(state) { this.state = structuredClone(state); }
  async read() { return structuredClone(this.state); }
  async update(mutator) { return mutator(this.state); }
}

const OFFER = { ...SAMPLE_OFFER, affiliateUrl: "https://meli.la/AbC123" };
const config = { dryRun: true, allowUntaggedLinks: false, zapi: { channelImageEnabled: false }, limits: { deduplicationHours: 24, republishCooldownDays: 30 } };
const build = (state, overrides = {}) => new PublicationService({
  store: new MemoryStore(state),
  zapi: { sendImage: async () => ({ messageId: "sent" }) },
  config: { ...config, ...overrides },
  clock: () => new Date("2026-09-02T17:00:00Z")
});

const destination = (id, nicheIds, extra = {}) => ({ id, name: id, type: "group", nicheIds, active: true, minDiscount: 0, maxDailyPosts: 12, minMinutesBetweenPosts: 0, ...extra });

test("publica somente nos grupos com nicho correspondente", async () => {
  const service = build({
    destinations: [destination("tv-group", ["electronics"], { minDiscount: 10 }), destination("beauty-group", ["beauty"])],
    publications: [], deliveryEvents: [], offers: [], queue: []
  });
  const result = await service.publish(OFFER);
  assert.equal(result.matchedDestinations, 1);
  assert.equal(result.results[0].destinationId, "tv-group");
});

test("nao repete o mesmo produto no destino mesmo com preco diferente", async () => {
  const service = build({
    destinations: [destination("tv-group", ["electronics"])],
    publications: [{
      id: "anterior", productKey: "Marketplace Demo:demo-smart-tv-50", destinationId: "tv-group",
      status: "sent", createdAt: "2026-08-20T17:00:00Z"
    }],
    deliveryEvents: [], offers: [], queue: []
  });
  const result = await service.publish({ ...OFFER, currentPrice: 2098, originalPrice: 2899 });
  assert.equal(result.matchedDestinations, 0);
});

test("libera o produto depois do periodo de carencia", async () => {
  const service = build({
    destinations: [destination("tv-group", ["electronics"])],
    publications: [{
      id: "antigo", productKey: "Marketplace Demo:demo-smart-tv-50", destinationId: "tv-group",
      status: "sent", createdAt: "2026-06-01T17:00:00Z"
    }],
    deliveryEvents: [], offers: [], queue: []
  });
  const result = await service.publish(OFFER);
  assert.equal(result.matchedDestinations, 1);
});

test("reconhece publicacoes antigas gravadas so com fingerprint", async () => {
  const service = build({
    destinations: [destination("tv-group", ["electronics"])],
    publications: [{
      id: "legado", offerFingerprint: "Marketplace Demo:demo-smart-tv-50:2199.00", destinationId: "tv-group",
      status: "sent", createdAt: "2026-08-30T17:00:00Z"
    }],
    deliveryEvents: [], offers: [], queue: []
  });
  const result = await service.publish({ ...OFFER, currentPrice: 1999 });
  assert.equal(result.matchedDestinations, 0);
});

test("bloqueia publicacao de oferta sem link de afiliado atribuido", async () => {
  const service = build({ destinations: [destination("tv-group", ["electronics"])], publications: [], deliveryEvents: [], offers: [], queue: [] });
  await assert.rejects(
    () => service.publish({ ...OFFER, affiliateUrl: "https://www.mercadolivre.com.br/p/MLB1" }),
    /sem link de afiliado atribuido/
  );
});

test("guarda a chave do produto na publicacao", async () => {
  const store = new MemoryStore({ destinations: [destination("tv-group", ["electronics"])], publications: [], deliveryEvents: [], offers: [], queue: [] });
  const service = new PublicationService({ store, zapi: { sendImage: async () => ({ messageId: "x" }) }, config, clock: () => new Date("2026-09-02T17:00:00Z") });
  await service.publish(OFFER);
  assert.equal(store.state.publications[0].productKey, "Marketplace Demo:demo-smart-tv-50");
});

test("nao manda produto caro demais para o publico do destino", async () => {
  const service = build({
    destinations: [destination("tv-group", ["electronics"], { maxPrice: 300 })],
    publications: [], deliveryEvents: [], offers: [], queue: []
  });
  const result = await service.publish({ ...OFFER, currentPrice: 2199 });
  assert.equal(result.matchedDestinations, 0);
  assert.match(result.blocked[0].reason, /passa do teto/);
});

test("exige procura minima quando o destino pede", async () => {
  const service = build({
    destinations: [destination("tv-group", ["electronics"], { minSold: 5000 })],
    publications: [], deliveryEvents: [], offers: [], queue: []
  });
  const result = await service.publish({ ...OFFER, soldCount: 120 });
  assert.equal(result.matchedDestinations, 0);
  assert.match(result.blocked[0].reason, /pouca procura/);
});
