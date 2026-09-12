import test from "node:test";
import assert from "node:assert/strict";
import { PriceGuard } from "../src/services/price-guard.js";

const config = { freshness: { minutes: 25, maxAgeHours: 6, priceRiseTolerance: 0.02, minDiscountAfterRefresh: 10, refreshPages: 2 } };
const now = new Date("2026-09-02T12:00:00Z");

class FakeSource {
  static id = "fake";
  constructor(map) { this.map = map; this.calls = 0; }
  get id() { return FakeSource.id; }
  async refreshMany(offers) {
    this.calls += 1;
    return new Map(offers.map((offer) => [offer.externalId, this.map[offer.externalId] ?? null]));
  }
}

const item = (id, overrides = {}) => ({
  id, status: "queued", createdAt: "2026-09-02T11:00:00Z", confirmedAt: "2026-09-02T11:00:00Z",
  offer: { externalId: id, marketplace: "Loja", sourceId: "fake", currentPrice: 100, originalPrice: 200, ...overrides }
});

test("considera fresca a oferta confirmada ha pouco tempo", () => {
  const guard = new PriceGuard({ config, clock: () => now });
  assert.equal(guard.isFresh({ confirmedAt: "2026-09-02T11:50:00Z" }, now), true);
  assert.equal(guard.isFresh({ confirmedAt: "2026-09-02T11:20:00Z" }, now), false);
});

test("expira a oferta que passou do tempo maximo na fila", () => {
  const guard = new PriceGuard({ config, clock: () => now });
  assert.equal(guard.isExpired({ createdAt: "2026-09-02T05:30:00Z" }, now), true);
  assert.equal(guard.isExpired({ createdAt: "2026-09-02T09:00:00Z" }, now), false);
});

test("descarta oferta que sumiu da vitrine e a que subiu de preco", async () => {
  const source = new FakeSource({
    A: { externalId: "A", currentPrice: 100, originalPrice: 200 },
    C: { externalId: "C", currentPrice: 130, originalPrice: 200 }
  });
  const guard = new PriceGuard({ sources: [source], config, clock: () => now });
  // `page` marca que a oferta veio da vitrine e que a revalidacao cobriu a
  // pagina de onde ela veio — e o que faz da ausencia uma prova.
  const daVitrine = (id) => item(id, { sourceContext: { category: "MLB1246", page: 1 } });
  const results = await guard.refresh([daVitrine("A"), daVitrine("B"), daVitrine("C")]);
  assert.deepEqual(results.map((result) => result.status), ["confirmed", "expired", "stale"]);
  assert.equal(source.calls, 1);
});

test("atualiza o preco quando a oferta ficou mais barata", async () => {
  const source = new FakeSource({ A: { externalId: "A", currentPrice: 80, originalPrice: 200, shipping: "Frete gratis" } });
  const guard = new PriceGuard({ sources: [source], config, clock: () => now });
  const [result] = await guard.refresh([item("A")]);
  assert.equal(result.status, "updated");
  assert.equal(result.offer.currentPrice, 80);
  assert.equal(result.offer.shipping, "Frete gratis");
});

test("descarta quando o desconto deixa de compensar depois da revalidacao", async () => {
  const source = new FakeSource({ A: { externalId: "A", currentPrice: 195, originalPrice: 200 } });
  const guard = new PriceGuard({ sources: [source], config, clock: () => now });
  const [result] = await guard.refresh([item("A", { currentPrice: 194 })]);
  assert.equal(result.status, "stale");
});

test("mantem a oferta na fila quando a revalidacao falha", async () => {
  const source = { id: "fake", refreshMany: async () => { throw new Error("rede indisponivel"); } };
  Object.defineProperty(source, "constructor", { value: { id: "fake" } });
  const guard = new PriceGuard({ sources: [source], config, clock: () => now });
  const [result] = await guard.refresh([item("A")]);
  assert.equal(result.status, "unavailable");
  assert.match(result.error, /rede indisponivel/);
});

test("oferta colhida pela extensao nao expira por ausencia na vitrine", async () => {
  // O servidor nao consegue ler a pagina da loja de marca (anti-bot), entao
  // procurar o produto na vitrine de ofertas e garantia de nao achar. Antes disso
  // aqui, "nao achei" virava "expirada" e matava toda a colheita da extensao.
  const source = new FakeSource({});
  const guard = new PriceGuard({ sources: [source], config, clock: () => now });
  const colhida = item("MLB-loja", { sourceContext: { origem: "extensao", url: "https://lista.mercadolivre.com.br/loja/avon" } });
  const [resultado] = await guard.refresh([colhida]);
  assert.equal(resultado.status, "unchecked");
  assert.equal(source.calls, 0, "nem chega a consultar a vitrine por ela");
});

test("oferta da vitrine que sumiu continua expirando", async () => {
  // A regra so afrouxa para quem a vitrine nao tem como responder. Para quem veio
  // da vitrine, ausencia continua significando oferta encerrada.
  const source = new FakeSource({});
  const guard = new PriceGuard({ sources: [source], config, clock: () => now });
  // page 1 = dentro das 2 paginas que a varredura le; a ausencia aqui e prova.
  const daVitrine = item("MLB-vitrine", { sourceContext: { category: "MLB1246", page: 1 } });
  const [resultado] = await guard.refresh([daVitrine]);
  assert.equal(resultado.status, "expired");
  assert.equal(source.calls, 1);
});

test("oferta sem pagina de origem nao expira por ausencia", async () => {
  // Coletada antes de `sourceContext.page` existir: a revalidacao so leu as
  // primeiras paginas, entao nao acha-la ali nao prova que a promocao acabou.
  // Sem esta regra, a fila que ja estava montada continuaria morrendo pelo
  // caminho antigo e o conserto so valeria para coleta nova.
  const source = new FakeSource({});
  const guard = new PriceGuard({ sources: [source], config, clock: () => now });
  const antiga = item("MLB-sem-page", { sourceContext: { category: "MLB1246" } });
  const [resultado] = await guard.refresh([antiga]);
  assert.equal(resultado.status, "unchecked");
  assert.equal(source.calls, 1, "ainda consulta a vitrine: se achar, revalida o preco");
});

test("a oferta vive ate o prazo do ML, nao ate o teto de idade", () => {
  // O ML marca a promocao ate a meia-noite. Descartar em 6h matou 1.077 ofertas
  // em 11/09/2026, das quais 166 (de 192 conferiveis) ainda estavam valendo.
  const guard = new PriceGuard({ config, clock: () => now });
  const daVitrine = {
    createdAt: "2026-09-02T02:00:00Z", // 10h atras, bem alem das 6h de teto
    offer: { expiresAt: "2026-09-03T03:00:00Z" }
  };
  assert.equal(guard.isExpired(daVitrine, now), false, "o ML ainda considera valida");
});

test("passado o prazo do ML, a oferta sai mesmo sendo recente", () => {
  const guard = new PriceGuard({ config, clock: () => now });
  const vencida = {
    createdAt: "2026-09-02T11:30:00Z", // meia hora de vida
    offer: { expiresAt: "2026-09-02T11:59:00Z" }
  };
  assert.equal(guard.isExpired(vencida, now), true);
});

test("sem prazo do ML, o teto de idade continua mandando", () => {
  // E o caso da colheita da extensao: nao traz prazo e nao e revalidavel, entao
  // nao pode ficar parada com um preco que ninguem confere.
  const guard = new PriceGuard({ config, clock: () => now });
  const daExtensao = { createdAt: "2026-09-02T05:30:00Z", offer: { sourceContext: { origem: "extensao" } } };
  assert.equal(guard.isExpired(daExtensao, now), true, "6h30 de fila, sem prazo declarado");
  assert.equal(guard.isExpired({ createdAt: "2026-09-02T09:00:00Z", offer: {} }, now), false);
});
