import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AffiliateLinkService, SessionExpiredError } from "../src/services/affiliate-link-service.js";

class MemoryStore {
  constructor(extra = {}) { this.state = { affiliateLinks: [], affiliateRequests: [], affiliateStatus: null, queue: [], ...extra }; }
  async read() { return structuredClone(this.state); }
  async update(mutator) { return mutator(this.state); }
}

const offer = { marketplace: "Mercado Livre", externalId: "MLB1", title: "Air fryer", affiliateUrl: "https://www.mercadolivre.com.br/produto/p/MLB1" };
const clock = () => new Date("2026-09-02T12:00:00Z");
const missingBuilder = pathToFileURL(join(tmpdir(), "ofertaflow-sem-builder.json"));
const baseConfig = (extra = {}) => ({
  affiliates: {}, allowUntaggedLinks: false,
  affiliate: { allowParamLinks: true, extensionTimeoutMinutes: 10 },
  ...extra
});

const builderFileWith = async (content) => {
  const dir = await mkdtemp(join(tmpdir(), "ofertaflow-"));
  const file = join(dir, "linkbuilder.json");
  await writeFile(file, JSON.stringify(content), "utf8");
  return pathToFileURL(file);
};

test("bloqueia quando nao ha nenhuma forma de atribuir o link", async () => {
  const service = new AffiliateLinkService({ store: new MemoryStore(), config: baseConfig(), clock, builderFile: missingBuilder });
  assert.equal(await service.mode(), "none");
  await assert.rejects(() => service.linkFor(offer), /Configure o link de afiliado/);
});

test("usa os parametros configurados quando permitido", async () => {
  const service = new AffiliateLinkService({
    store: new MemoryStore(), clock, builderFile: missingBuilder,
    config: baseConfig({ affiliates: { "Mercado Livre": "matt_word=parceiro-demo&matt_tool=99999999" } })
  });
  const result = await service.linkFor(offer);
  assert.equal(result.mode, "params");
  assert.equal(result.url, "https://www.mercadolivre.com.br/produto/p/MLB1?matt_word=parceiro-demo&matt_tool=99999999");
});

test("recusa o modo params quando ele foi desligado", async () => {
  const service = new AffiliateLinkService({
    store: new MemoryStore(), clock, builderFile: missingBuilder,
    config: baseConfig({ affiliates: { "Mercado Livre": "matt_word=x&matt_tool=1" }, affiliate: { allowParamLinks: false, extensionTimeoutMinutes: 10 } })
  });
  assert.equal(await service.mode(), "none");
});

test("entra em modo extensao enquanto ela deu sinal de vida", async () => {
  const store = new MemoryStore();
  const service = new AffiliateLinkService({ store, config: baseConfig(), clock, builderFile: missingBuilder });
  await service.touchExtension();
  assert.equal(await service.mode(), "extension");

  const antiga = new AffiliateLinkService({ store, config: baseConfig(), clock: () => new Date("2026-09-02T12:30:00Z"), builderFile: missingBuilder });
  assert.equal(await antiga.mode(), "none");
});

test("pede o link para a extensao e devolve a oferta como pendente", async () => {
  const store = new MemoryStore();
  const service = new AffiliateLinkService({ store, config: baseConfig(), clock, builderFile: missingBuilder });
  await service.touchExtension();

  const result = await service.linkFor(offer);
  assert.equal(result.pending, true);
  assert.equal(result.attributed, false);

  const pending = await service.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].productUrl, offer.affiliateUrl);

  await service.linkFor(offer);
  assert.equal((await service.pending()).length, 1);
});

test("libera o item da fila quando a extensao entrega o link", async () => {
  const store = new MemoryStore({
    queue: [{ id: "item-1", productKey: "Mercado Livre:MLB1", status: "awaiting-link", offer: { ...offer }, lastDeferredReason: "Aguardando o link de afiliado do painel" }]
  });
  const service = new AffiliateLinkService({ store, config: baseConfig(), clock, builderFile: missingBuilder });
  await service.touchExtension();
  await service.linkFor(offer);
  const [pedido] = await service.pending();

  const resolved = await service.resolve({ id: pedido.id, link: "https://meli.la/ABC123" });
  assert.equal(resolved.status, "done");
  assert.equal(store.state.queue[0].status, "queued");
  assert.equal(store.state.queue[0].offer.affiliateUrl, "https://meli.la/ABC123");
  assert.equal(store.state.affiliateLinks[0].url, "https://meli.la/ABC123");

  const reuso = await service.linkFor(offer);
  assert.equal(reuso.cached, true);
  assert.equal(reuso.url, "https://meli.la/ABC123");
});

test("recusa link que nao carrega atribuicao", async () => {
  const store = new MemoryStore();
  const service = new AffiliateLinkService({ store, config: baseConfig(), clock, builderFile: missingBuilder });
  await service.touchExtension();
  await service.linkFor(offer);
  const [pedido] = await service.pending();
  await assert.rejects(() => service.resolve({ id: pedido.id, link: "https://www.mercadolivre.com.br/produto/p/MLB1" }), /nao e um link de afiliado valido/);
  assert.equal(store.state.affiliateRequests[0].status, "pending");
});

test("desiste do pedido depois de tres falhas seguidas", async () => {
  const store = new MemoryStore();
  const service = new AffiliateLinkService({ store, config: baseConfig(), clock, builderFile: missingBuilder });
  await service.touchExtension();
  await service.linkFor(offer);
  const [pedido] = await service.pending();
  for (let attempt = 0; attempt < 3; attempt += 1) await service.resolve({ id: pedido.id, error: "painel nao respondeu" });
  assert.equal(store.state.affiliateRequests[0].status, "failed");
  assert.equal((await service.status()).failedLinks, 1);
});

test("gera o link pelo painel via http e reaproveita do cache", async () => {
  const builderFile = await builderFileWith({ url: "https://www.mercadolivre.com.br/affiliates/api/link", method: "POST", headers: { cookie: "sessao" }, body: { url: "{{url}}" } });
  const store = new MemoryStore();
  let calls = 0;
  const service = new AffiliateLinkService({
    store, clock, builderFile, config: baseConfig(),
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(JSON.parse(options.body).url, offer.affiliateUrl);
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { short: { link: "https://meli.la/ABC123" } } }) };
    }
  });
  assert.equal(await service.mode(), "linkbuilder");
  assert.equal((await service.linkFor(offer)).url, "https://meli.la/ABC123");
  assert.equal((await service.linkFor(offer)).cached, true);
  assert.equal(calls, 1);
});

test("reconhece sessao expirada no gerador http", async () => {
  const builderFile = await builderFileWith({ url: "https://www.mercadolivre.com.br/affiliates/api/link" });
  const store = new MemoryStore();
  const service = new AffiliateLinkService({
    store, clock, builderFile, config: baseConfig(),
    fetchImpl: async () => ({ ok: false, status: 302, text: async () => "" })
  });
  await assert.rejects(() => service.linkFor(offer), SessionExpiredError);
  assert.equal((await service.status()).sessionValid, false);
});

test("recoloca na fila os pedidos que falharam", async () => {
  const store = new MemoryStore();
  const service = new AffiliateLinkService({ store, config: baseConfig(), clock, builderFile: missingBuilder });
  await service.touchExtension();
  await service.linkFor(offer);
  const [pedido] = await service.pending();
  for (let attempt = 0; attempt < 3; attempt += 1) await service.resolve({ id: pedido.id, error: "aba sem script" });
  assert.equal((await service.status()).failedLinks, 1);

  const { reset } = await service.retryFailed();
  assert.equal(reset, 1);
  assert.equal((await service.pending()).length, 1);
  assert.equal(store.state.affiliateRequests[0].attempts, 0);
});
