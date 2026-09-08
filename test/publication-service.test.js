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
  clock: () => new Date("2026-09-02T16:00:00Z")
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
  const service = new PublicationService({ store, zapi: { sendImage: async () => ({ messageId: "x" }) }, config, clock: () => new Date("2026-09-02T16:00:00Z") });
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

test("dentro da rajada vale o intervalo do destino; fora, nada sai", () => {
  const destino = destination("g", ["electronics"], { minMinutesBetweenPosts: 12 });
  const estado = { destinations: [destino], publications: [], deliveryEvents: [], offers: [], queue: [] };
  const publicacoes = (iso) => [{ destinationId: "g", status: "sent", createdAt: iso, title: "Outro", nicheIds: ["home"] }];
  const motivo = (agoraIso, ultimaIso) => naHora(estado, agoraIso).blockReason({
    destination: destino, offer: OFFER, nicheIds: ["electronics"],
    publications: publicacoes(ultimaIso), now: new Date(agoraIso)
  });

  // 22:13 UTC = 19:13 BRT, rajada da noite: 13 min depois do ultimo, ja pode.
  assert.equal(motivo("2026-09-02T22:13:00Z", "2026-09-02T22:00:00Z"), null);
  // 22:05 UTC: ainda dentro dos 12 min.
  assert.match(String(motivo("2026-09-02T22:05:00Z", "2026-09-02T22:00:00Z")), /aguardando o intervalo de 12 min/);
  // 20:13 UTC = 17:13 BRT, fora de qualquer rajada.
  assert.match(String(motivo("2026-09-02T20:13:00Z", "2026-09-02T20:00:00Z")), /horario de baixa|fora de rajada/);
});

test("com a curva desligada o intervalo volta a ser fixo", () => {
  const destino = destination("g", ["electronics"], { minMinutesBetweenPosts: 12 });
  const estado = { destinations: [destino], publications: [], deliveryEvents: [], offers: [], queue: [] };
  const madrugada = new Date("2026-09-02T06:00:00Z"); // 3h BRT
  const motivo = naHora(estado, madrugada.toISOString(), { timingCurve: false }).blockReason({
    destination: destino, offer: OFFER, nicheIds: ["electronics"], publications: [], now: madrugada
  });
  assert.equal(motivo, null, "sem curva, a madrugada nao bloqueia");
});

test("o canal recusa o que nao serve ao publico dele", () => {
  // O nicho diz o assunto, nao para quem. Maquina de cortar cabelo, peruca,
  // cabeca de manequim e tenis masculino sao todos "beleza" ou "moda", e
  // nenhum serve a um canal feminino.
  const isa = destination("isa", ["beauty", "fashion"], {
    blockedKeywords: ["masculino", "unissex", "peruca", "manequim", "maquina de cortar cabelo", "barba"]
  });
  const estado = { destinations: [isa], publications: [], deliveryEvents: [], offers: [], queue: [] };
  const service = naHora(estado, "2026-09-02T16:00:00Z"); // 13h BRT, rajada
  const recusa = (title, nicheIds) => service.blockReason({
    destination: isa, offer: { ...OFFER, title }, nicheIds,
    publications: [], now: new Date("2026-09-02T16:00:00Z")
  });

  for (const [titulo, nichos] of [
    ["Maquina De Cortar Cabelo Profissional Barbeiro", ["beauty"]],
    ["Cabeca Manequim Isopor Branco Suporte Perucas", ["beauty"]],
    ["Tenis Aramis Masculino Casual Couro", ["fashion"]],
    ["Moletom Canguru Liso Algodao Unissex", ["fashion"]]
  ]) {
    assert.match(String(recusa(titulo, nichos)), /publico deste canal/, titulo);
  }

  // E deixa passar o que e do publico.
  assert.equal(recusa("Kerastase Nutritive Bain Satin 250ml", ["beauty"]), null);
  assert.equal(recusa("Base Liquida Vult Cobertura Alta", ["beauty"]), null);
});

test("o bloqueio casa palavra inteira, nao pedaco", () => {
  const isa = destination("isa", ["home"], { blockedKeywords: ["barba", "sunga"] });
  const estado = { destinations: [isa], publications: [], deliveryEvents: [], offers: [], queue: [] };
  const service = naHora(estado, "2026-09-02T16:00:00Z");
  const motivo = (title) => service.blockReason({
    destination: isa, offer: { ...OFFER, title }, nicheIds: ["home"],
    publications: [], now: new Date("2026-09-02T16:00:00Z")
  });
  // "barbante" contem "barba" mas nao e produto de barba.
  assert.equal(motivo("Barbante Colorido 200g Para Croche"), null);
  assert.match(String(motivo("Kit 3 Sungas Masculinas")), /publico deste canal/);
});

test("em roupa e calcado o canal exige marcacao feminina", () => {
  // Bloquear marca masculina uma a uma e enxugar gelo: nenhum destes diz
  // "masculino", e todos chegaram ao canal.
  const isa = destination("isa", ["fashion"], {
    requireAnyByNiche: { fashion: ["feminino", "feminina", "vestido", "calcinha", "sandalia"] }
  });
  const estado = { destinations: [isa], publications: [], deliveryEvents: [], offers: [], queue: [] };
  const service = naHora(estado, "2026-09-02T16:00:00Z");
  const motivo = (title) => service.blockReason({
    destination: isa, offer: { ...OFFER, title }, nicheIds: ["fashion"],
    publications: [], now: new Date("2026-09-02T16:00:00Z")
  });

  for (const titulo of ["Kit Camisetas Aramis Preta Branca Original",
                        "Tenis Reserva Go Troy Leve Confortavel",
                        "Tenis Smash V2 Puma Preto E Branco 41 Br",
                        "Mochila Tatica Impermeavel Militar Reforcada"]) {
    assert.match(String(motivo(titulo)), /marcacao de publico/, titulo);
  }
  for (const titulo of ["Tenis Feminino Vizzano Branco Casual",
                        "Calca Jeans Feminina Cos Alto",
                        "Sandalia Rasterinha Confortavel"]) {
    assert.equal(motivo(titulo), null, titulo);
  }
});

test("a exigencia so vale no nicho declarado", () => {
  const isa = destination("isa", ["fashion", "beauty"], {
    requireAnyByNiche: { fashion: ["feminino"] }
  });
  const estado = { destinations: [isa], publications: [], deliveryEvents: [], offers: [], queue: [] };
  const service = naHora(estado, "2026-09-02T16:00:00Z");
  // Beleza nao exige a marcacao: shampoo nao e peca de vestuario.
  assert.equal(service.blockReason({
    destination: isa, offer: { ...OFFER, title: "Kerastase Nutritive Bain Satin 250ml" },
    nicheIds: ["beauty"], publications: [], now: new Date("2026-09-02T16:00:00Z")
  }), null);
});
