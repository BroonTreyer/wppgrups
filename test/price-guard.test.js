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
  const results = await guard.refresh([item("A"), item("B"), item("C")]);
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
