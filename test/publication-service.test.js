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

// --- curva de cadencia -------------------------------------------------------

const naHora = (state, isoUtc, overrides = {}) => new PublicationService({
  store: new MemoryStore(state),
  zapi: { sendImage: async () => ({ messageId: "sent" }) },
  config: { ...config, ...overrides },
  clock: () => new Date(isoUtc)
});

test("madrugada nao publica, mesmo com tudo o mais liberado", async () => {
  const estado = { destinations: [destination("g", ["electronics"])], publications: [], deliveryEvents: [], offers: [], queue: [] };
  // 06:00 UTC = 03:00 em Brasilia.
  const service = naHora(estado, "2026-09-02T06:00:00Z");
  const motivo = service.blockReason({
    destination: estado.destinations[0], offer: OFFER, nicheIds: ["electronics"], publications: [], now: new Date("2026-09-02T06:00:00Z")
  });
  assert.match(motivo, /horario de baixa/);
});

test("o intervalo estica na hora morna e encolhe no pico", () => {
  const destino = destination("g", ["electronics"], { minMinutesBetweenPosts: 12 });
  const estado = { destinations: [destino], publications: [], deliveryEvents: [], offers: [], queue: [] };
  const publicacoes = (iso) => [{ destinationId: "g", status: "sent", createdAt: iso, title: "Outro", nicheIds: ["home"] }];

  // 23:00 UTC = 20:00 BRT, pico: 12 min depois ja pode.
  const pico = new Date("2026-09-02T23:13:00Z");
  assert.equal(
    naHora(estado, pico.toISOString()).blockReason({
      destination: destino, offer: OFFER, nicheIds: ["electronics"],
      publications: publicacoes("2026-09-02T23:00:00Z"), now: pico
    }), null, "no pico o intervalo configurado basta");

  // 18:00 UTC = 15:00 BRT, peso 0.6: os mesmos 13 min ainda nao liberam.
  const morno = new Date("2026-09-02T18:13:00Z");
  const motivo = naHora(estado, morno.toISOString()).blockReason({
    destination: destino, offer: OFFER, nicheIds: ["electronics"],
    publications: publicacoes("2026-09-02T18:00:00Z"), now: morno
  });
  assert.match(motivo, /aguardando o intervalo de 2\d min/, motivo);
});

test("com a curva desligada o intervalo volta a ser fixo", () => {
  const destino = destination("g", ["electronics"], { minMinutesBetweenPosts: 12 });
  const estado = { destinations: [destino], publications: [], deliveryEvents: [], offers: [], queue: [] };
  const madrugada = new Date("2026-09-02T06:00:00Z");
  const motivo = naHora(estado, madrugada.toISOString(), { timingCurve: false }).blockReason({
    destination: destino, offer: OFFER, nicheIds: ["electronics"], publications: [], now: madrugada
  });
  assert.equal(motivo, null, "sem curva, a madrugada nao bloqueia");
});
