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

test("varre varias categorias na mesma rodada e avanca o cursor por todas", async () => {
  const porCategoria = ({ category }) => [product({ externalId: `${category}-1`, title: `Item de ${category}` })];
  const { service, store, source, apply } = build({
    offers: porCategoria,
    settings: { enabled: true, minDiscount: 20, categories: ["MLB1", "MLB2", "MLB3", "MLB4"], categoriesPerRun: 3 }
  });
  await apply();

  const [run] = (await service.run()).runs;
  assert.deepEqual(run.categories, ["MLB1", "MLB2", "MLB3"]);
  assert.deepEqual(source.calls.map((c) => c.category), ["MLB1", "MLB2", "MLB3"]);
  assert.equal(run.collected, 3);
  // O cursor anda o tamanho da rodada: a proxima comeca onde esta parou e da a
  // volta, em vez de repetir a vitrine que acabou de sair.
  assert.equal(store.state.sources[0].cursor, 3);

  source.calls.length = 0;
  const [segunda] = (await service.run()).runs;
  assert.deepEqual(segunda.categories, ["MLB4", "MLB1", "MLB2"]);
});

test("o mesmo produto em duas vitrines e coletado uma vez so", async () => {
  const { service, apply } = build({
    offers: () => [product({ externalId: "REPETIDO" })],
    settings: { enabled: true, minDiscount: 20, categories: ["MLB1", "MLB2", "MLB3"], categoriesPerRun: 3 }
  });
  await apply();
  const [run] = (await service.run()).runs;
  assert.equal(run.collected, 1);
});

test("uma vitrine fora do ar nao derruba a rodada inteira", async () => {
  const offers = ({ category }) => {
    if (category === "MLB2") throw new Error("503 do marketplace");
    return [product({ externalId: `${category}-1` })];
  };
  const { service, apply } = build({
    offers,
    settings: { enabled: true, minDiscount: 20, categories: ["MLB1", "MLB2", "MLB3"], categoriesPerRun: 3 }
  });
  await apply();
  const [run] = (await service.run()).runs;
  assert.equal(run.collected, 2);
  assert.equal(run.errors.length, 1);
  assert.match(run.errors[0], /MLB2: 503 do marketplace/);
});

test("a colheita da extensao passa pelos mesmos filtros da vitrine", async () => {
  const { service, enqueued, store, apply } = build({
    offers: [],
    settings: { enabled: true, minDiscount: 20, minSold: 0, minRating: 0, maxPrice: 1000 }
  });
  await apply();
  store.state.destinations.push({ id: "d1", active: true, nicheIds: ["beauty", "general"], maxDailyPosts: 100, minMinutesBetweenPosts: 5 });

  const r = await service.harvest({ produtos: [
    // bom: 50% de desconto
    { externalId: "MLB111", title: "Serum Facial Vitamina C 30ml", currentPrice: 50, originalPrice: 100,
      imageUrl: "https://cdn/x.jpg", productUrl: "https://www.mercadolivre.com.br/p/MLB111", officialStore: true, sellerName: "NATURA" },
    // ruim: sem desconto, tem que ser recusado pelo MESMO filtro da vitrine
    { externalId: "MLB222", title: "Creme Qualquer", currentPrice: 99, originalPrice: 100,
      imageUrl: "https://cdn/y.jpg", productUrl: "https://www.mercadolivre.com.br/p/MLB222" }
  ] });

  assert.equal(r.collected, 2);
  assert.equal(r.enqueued, 1, "so o que passa no filtro entra");
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].externalId, "MLB111");
  // O selo de loja oficial sobrevive ate a fila: e ele que vira credibilidade
  // na mensagem e bonus na pontuacao.
  assert.equal(enqueued[0].officialStore, true);
  assert.equal(enqueued[0].sellerName, "NATURA");
});

test("colheita vazia nao faz nada e nao quebra", async () => {
  const { service, apply } = build({ offers: [], settings: { enabled: true } });
  await apply();
  assert.deepEqual(await service.harvest({ produtos: [] }), { recebidos: 0, enqueued: 0, rejected: 0 });
  assert.deepEqual(await service.harvest({}), { recebidos: 0, enqueued: 0, rejected: 0 });
});

test("a paginacao da listagem segue o padrao _Desde_ do Mercado Livre", () => {
  // Replica do que o background monta. Fica no teste para que a regra de
  // paginacao do ML nao dependa so de um comentario na extensao.
  const paginasDe = (url, quantas) => {
    const [base, fragmento] = url.split("#");
    const limpa = base.replace(/\/$/, "");
    const paginas = [url];
    for (let i = 1; i < quantas; i += 1) {
      paginas.push(`${limpa}_Desde_${i * 50 + 1}${fragmento ? "#" + fragmento : ""}`);
    }
    return paginas;
  };

  assert.deepEqual(paginasDe("https://lista.mercadolivre.com.br/loja/natura/_Discount_20-100", 3), [
    "https://lista.mercadolivre.com.br/loja/natura/_Discount_20-100",
    "https://lista.mercadolivre.com.br/loja/natura/_Discount_20-100_Desde_51",
    "https://lista.mercadolivre.com.br/loja/natura/_Discount_20-100_Desde_101"
  ]);
  // A barra final nao pode virar "_Desde_" colado numa barra.
  assert.equal(paginasDe("https://lista.mercadolivre.com.br/loja/vult/", 2)[1],
    "https://lista.mercadolivre.com.br/loja/vult_Desde_51");
  // Uma pagina so continua sendo uma pagina.
  assert.equal(paginasDe("https://x/y", 1).length, 1);
});

test("o piso de vendas pode ser afrouxado so para um nicho", async () => {
  // A colheita das lojas de marca de beleza trazia 1.200 produtos e enfileirava 0:
  // produto de loja oficial raramente exibe "+150 vendidos" no card. Afrouxar so
  // beleza deixa o #5 respirar sem encher a fila dos outros grupos com item que
  // eles nunca publicariam.
  const { service, enqueued, apply } = build({
    offers: [
      product({ externalId: "B1", title: "Serum Facial Vitamina C 30ml", soldCount: 50 }),
      product({ externalId: "E1", title: "Fone de ouvido bluetooth", soldCount: 50 })
    ],
    settings: { enabled: true, minDiscount: 20, minSold: 150, minSoldByNiche: { beauty: 30 } }
  });
  await apply();
  const [run] = (await service.run()).runs;
  assert.equal(run.enqueued, 1, "so a de beleza entra");
  assert.equal(enqueued[0].externalId, "B1");
  assert.equal(run.rejectedBy["pouca gente comprou esse produto"], 1);
});

test("sem override por nicho, o piso da fonte continua valendo para todos", async () => {
  const { service, enqueued, apply } = build({
    offers: [product({ externalId: "B1", title: "Serum Facial Vitamina C 30ml", soldCount: 50 })],
    settings: { enabled: true, minDiscount: 20, minSold: 150 }
  });
  await apply();
  const [run] = (await service.run()).runs;
  assert.equal(run.enqueued, 0);
  assert.equal(enqueued.length, 0);
});
