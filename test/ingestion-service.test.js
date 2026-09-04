import test from "node:test";
import assert from "node:assert/strict";
import { IngestionService } from "../src/services/ingestion-service.js";
import { SessionExpiredError } from "../src/services/affiliate-link-service.js";

class MemoryStore {
  constructor() { this.state = { sources: [], seenProducts: [], queue: [], alerts: [], affiliateLinks: [], destinations: [], publications: [] }; }
  async read() { return structuredClone(this.state); }
  async update(mutator) { return mutator(this.state); }
}

class FakeSource {
  static id = "fake";
  static label = "Loja de teste";
  static marketplace = "Loja";
  static defaults = { pages: 1 };
  constructor(offers) { this.offers = offers; this.calls = []; }
  get id() { return FakeSource.id; }
  async collect(params) { this.calls.push(params); return typeof this.offers === "function" ? this.offers(params) : this.offers; }
}

const product = (overrides = {}) => ({
  externalId: "P1", marketplace: "Loja", title: "Fone bluetooth", currentPrice: 100, originalPrice: 200, rating: 4.8, soldCount: 5000,
  affiliateUrl: "https://loja.example/p/1", imageUrl: "https://cdn.example/1.jpg", ...overrides
});

const config = { ingestion: { memoryHours: 72, priceDropTolerance: 0.05 }, freshness: { minValidityMinutes: 30, queueHorizonHours: 2 } };
const linkService = (impl) => ({ linkFor: impl ?? (async (offer) => ({ url: `https://meli.la/${offer.externalId}`, attributed: true, mode: "linkbuilder" })) });

const build = ({ offers, clock = () => new Date("2026-09-02T12:00:00Z"), settings = {}, store = new MemoryStore(), links } = {}) => {
  const enqueued = [];
  const source = new FakeSource(offers ?? []);
  const service = new IngestionService({
    store, config, clock, sources: [source], affiliateLinkService: linkService(links),
    queueService: { enqueue: async (offer) => { enqueued.push(offer); } }
  });
  return { service, store, enqueued, source, apply: async () => { await service.list(); Object.assign(store.state.sources[0], settings); } };
};

test("enfileira a oferta com o link de afiliado gerado", async () => {
  const { service, enqueued, apply } = build({ offers: [product()], settings: { enabled: true, minDiscount: 20 } });
  await apply();
  const [run] = (await service.run()).runs;
  assert.equal(run.enqueued, 1);
  assert.equal(enqueued[0].affiliateUrl, "https://meli.la/P1");
  assert.equal(enqueued[0].affiliateTagged, true);
});

test("aplica desconto minimo, faixa de preco, avaliacao e palavras bloqueadas", async () => {
  const offers = [
    product({ externalId: "A", title: "Sem desconto", originalPrice: 105 }),
    product({ externalId: "B", title: "Barato demais", currentPrice: 5, originalPrice: 50 }),
    product({ externalId: "C", title: "Caro demais", currentPrice: 9000, originalPrice: 20000 }),
    product({ externalId: "D", title: "Mal avaliado", rating: 3.1 }),
    product({ externalId: "E", title: "Capinha de celular" }),
    product({ externalId: "F", title: "Air fryer 5L" })
  ];
  const { service, enqueued, apply } = build({ offers, settings: { enabled: true, minDiscount: 20, minRating: 4, minPrice: 30, maxPrice: 5000, blockedKeywords: ["capinha"] } });
  await apply();
  const [run] = (await service.run()).runs;
  assert.equal(run.collected, 6);
  assert.equal(run.enqueued, 1);
  assert.equal(run.rejected, 5);
  assert.deepEqual(enqueued.map((offer) => offer.externalId), ["F"]);
});

test("publica os melhores primeiro e limita a repeticao de nicho na mesma rodada", async () => {
  const offers = [
    product({ externalId: "TV1", title: "Smart TV 50 polegadas", currentPrice: 90, originalPrice: 100 }),
    product({ externalId: "TV2", title: "Smart TV 65 polegadas", currentPrice: 50, originalPrice: 100 }),
    product({ externalId: "TV3", title: "Celular Galaxy A55", currentPrice: 30, originalPrice: 100 }),
    product({ externalId: "AF1", title: "Air fryer 5L", currentPrice: 60, originalPrice: 100 })
  ];
  const { service, enqueued, apply } = build({ offers, settings: { enabled: true, minDiscount: 10, minRating: 0, maxPerRun: 3, maxPerNiche: 2 } });
  await apply();
  await service.run();
  assert.deepEqual(enqueued.map((offer) => offer.externalId), ["TV3", "TV2", "AF1"]);
});

test("so aceita o produto de novo quando bate o menor preco ja publicado", async () => {
  const store = new MemoryStore();
  const first = build({ offers: [product({ currentPrice: 100 })], store, settings: { enabled: true, minDiscount: 20, minRating: 0 } });
  await first.apply();
  await first.service.run();
  assert.equal(store.state.seenProducts[0].minPrice, 100);

  const cheaper = build({ offers: [product({ currentPrice: 80 })], store });
  assert.equal((await cheaper.service.run({ sourceId: "fake" })).runs[0].enqueued, 1);
  assert.equal(store.state.seenProducts[0].minPrice, 80);

  const backUp = build({ offers: [product({ currentPrice: 90 })], store });
  const [repeated] = (await backUp.service.run({ sourceId: "fake" })).runs;
  assert.equal(repeated.duplicated, 1);
  assert.equal(repeated.enqueued, 0);
});

test("gira as categorias configuradas a cada rodada", async () => {
  const { service, source, store, apply } = build({ offers: [], settings: { enabled: true, categories: ["MLB1051", "MLB1648", "MLB1574"] } });
  await apply();
  await service.run();
  await service.run();
  await service.run();
  await service.run();
  assert.deepEqual(source.calls.map((call) => call.category), ["MLB1051", "MLB1648", "MLB1574", "MLB1051"]);
  assert.equal(store.state.sources[0].cursor, 1);
});

test("registra alerta quando a fonte deixa de devolver ofertas", async () => {
  const { service, store, apply } = build({ offers: [], settings: { enabled: true } });
  await apply();
  await service.run();
  assert.equal(store.state.alerts[0].type, "source-empty");
  assert.match(store.state.alerts[0].message, /nao devolveu nenhuma oferta/);
});

test("para a rodada e alerta quando a sessao de afiliado expira", async () => {
  const { service, store, enqueued, apply } = build({
    offers: [product({ externalId: "A" }), product({ externalId: "B" })],
    settings: { enabled: true, minDiscount: 20, minRating: 0 },
    links: async () => { throw new SessionExpiredError("Sessao do painel de afiliados expirada"); }
  });
  await apply();
  const [run] = (await service.run()).runs;
  assert.equal(run.enqueued, 0);
  assert.equal(enqueued.length, 0);
  assert.equal(store.state.alerts.at(-1).type, "affiliate-session");
});

test("valida a configuracao enviada pelo painel", async () => {
  const { service } = build({ offers: [] });
  await assert.rejects(() => service.configure("fake", { minDiscount: 120 }), /minDiscount/);
  await assert.rejects(() => service.configure("fake", { pages: 99 }), /pages/);
  await assert.rejects(() => service.configure("fake", { categories: ["nao-valida"] }), /categories/);
  await assert.rejects(() => service.configure("desconhecida", { enabled: true }), /nao encontrada/);
  const updated = await service.configure("fake", { enabled: true, minDiscount: 35, categories: "MLB1051, MLB1648", blockedKeywords: "capinha, pelicula ,capinha" });
  assert.equal(updated.enabled, true);
  assert.equal(updated.minDiscount, 35);
  assert.deepEqual(updated.categories, ["MLB1051", "MLB1648"]);
  assert.deepEqual(updated.blockedKeywords, ["capinha", "pelicula"]);
});

test("nao busca mais ofertas quando a fila ja cobre a capacidade do dia", async () => {
  const store = new MemoryStore();
  store.state.destinations = [{ id: "g1", active: true, maxDailyPosts: 3 }];
  store.state.publications = [];
  store.state.queue = [{ status: "queued" }, { status: "queued" }, { status: "queued" }];
  const { service, source, apply } = build({ offers: [product()], store, settings: { enabled: true, minDiscount: 20 } });
  await apply();
  const [run] = (await service.run()).runs;
  assert.match(run.skipped, /fila ja tem 3 ofertas/);
  assert.equal(source.calls.length, 0);
});

test("busca so o que cabe na capacidade restante do dia", async () => {
  const store = new MemoryStore();
  store.state.destinations = [{ id: "g1", active: true, maxDailyPosts: 5 }];
  store.state.publications = [];
  store.state.queue = [{ status: "queued" }, { status: "queued" }, { status: "queued" }];
  const offers = [1, 2, 3, 4, 5].map((index) => product({ externalId: `P${index}`, title: `Air fryer ${index}` }));
  const { service, enqueued, apply } = build({ offers, store, settings: { enabled: true, minDiscount: 20, minRating: 0, maxPerRun: 8, maxPerNiche: 9 } });
  await apply();
  const [run] = (await service.run()).runs;
  assert.equal(run.enqueued, 2);
  assert.equal(enqueued.length, 2);
});

test("ignora a capacidade quando nao ha destino ativo", async () => {
  const store = new MemoryStore();
  store.state.destinations = [{ id: "g1", active: false, maxDailyPosts: 5 }];
  store.state.publications = [];
  const { service, apply } = build({ offers: [product()], store, settings: { enabled: true, minDiscount: 20 } });
  await apply();
  const [run] = (await service.run()).runs;
  assert.equal(run.enqueued, 1);
});

test("mantem na fila so o que sera publicado nas proximas horas", async () => {
  const store = new MemoryStore();
  store.state.destinations = [{ id: "g1", active: true, maxDailyPosts: 70, minMinutesBetweenPosts: 12 }];
  store.state.publications = [];
  const offers = Array.from({ length: 20 }, (_, index) => product({ externalId: `P${index}`, title: `Air fryer ${index}` }));
  const { service, enqueued, apply } = build({ offers, store, settings: { enabled: true, minDiscount: 20, minRating: 0, maxPerRun: 50, maxPerNiche: 50 } });
  await apply();
  const [run] = (await service.run()).runs;
  assert.equal(run.enqueued, 10);
  assert.equal(enqueued.length, 10);
});

test("descarta promocao que acaba antes de dar tempo de publicar", async () => {
  const agora = new Date("2026-09-02T12:00:00Z");
  const offers = [
    product({ externalId: "ACABANDO", title: "Air fryer relampago", expiresAt: new Date(agora.getTime() + 10 * 60000).toISOString() }),
    product({ externalId: "TEMPO", title: "Air fryer tranquila", expiresAt: new Date(agora.getTime() + 5 * 3600000).toISOString() })
  ];
  const { service, enqueued, apply } = build({ offers, clock: () => agora, settings: { enabled: true, minDiscount: 20, minRating: 0 } });
  await apply();
  const [run] = (await service.run()).runs;
  assert.equal(run.rejected, 1);
  assert.deepEqual(enqueued.map((offer) => offer.externalId), ["TEMPO"]);
});

test("a capacidade da fila acompanha a frota, nao o canal mais rapido", async () => {
  // Com "uma oferta, um destino", cada canal consome ofertas proprias. Seis
  // canais a 12 min pedem 30 por hora; o calculo antigo usava so o mais rapido
  // e segurava a fila em 10 — a coleta varria centenas de produtos e aprovava um.
  const store = new MemoryStore();
  store.state.destinations = Array.from({ length: 6 }, (_, i) => ({
    id: `d${i}`, active: true, maxDailyPosts: 70, minMinutesBetweenPosts: 12
  }));
  const { service } = build({ store });
  const { capacity } = await service.queueRoom();
  // 6 destinos x 5 posts/hora x 2h de horizonte.
  assert.equal(capacity, 60, `esperava 60, veio ${capacity}`);
});

test("o teto diario ainda limita a capacidade", async () => {
  const store = new MemoryStore();
  store.state.destinations = [{ id: "d0", active: true, maxDailyPosts: 3, minMinutesBetweenPosts: 12 }];
  const { service } = build({ store });
  const { capacity } = await service.queueRoom();
  // O horizonte daria 10, mas o destino so aceita 3 no dia.
  assert.equal(capacity, 3, `esperava 3, veio ${capacity}`);
});

test("sem destino ativo a coleta nao e limitada por capacidade", async () => {
  const { service } = build({ store: new MemoryStore() });
  const { capacity, room } = await service.queueRoom();
  assert.equal(capacity, 0);
  assert.equal(room, Number.POSITIVE_INFINITY);
});
