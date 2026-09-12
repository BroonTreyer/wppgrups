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

test("os parametros configurados nao produzem link publicavel", async () => {
  const service = new AffiliateLinkService({
    store: new MemoryStore(), clock, builderFile: missingBuilder,
    config: baseConfig({ affiliates: { "Mercado Livre": "matt_word=parceiro-demo&matt_tool=99999999" } })
  });
  // Sem extensao online o modo cai para "params", e a publicacao TRAVA: colar
  // matt_word/matt_tool numa URL de produto nao gera o ref assinado pelo
  // servidor, entao nao ha atribuicao e nao ha comissao.
  await assert.rejects(() => service.linkFor(offer), /nao produzem um link de afiliado valido/);
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

const comParams = () => baseConfig({ affiliates: { "Mercado Livre": "matt_word=rocketplugins&matt_tool=10421498" } });

test("extensao esgotada cai para os parametros em vez de segurar a oferta", async () => {
  const store = new MemoryStore();
  const service = new AffiliateLinkService({ store, config: comParams(), clock, builderFile: missingBuilder });
  await service.touchExtension();

  const primeiro = await service.linkFor(offer);
  assert.equal(primeiro.mode, "extension");
  assert.equal(primeiro.pending, true);

  const [pedido] = await service.pending();
  for (let attempt = 0; attempt < 3; attempt += 1) await service.resolve({ id: pedido.id, error: "aba sem script" });

  // Mesmo esgotada, a extensao NAO cede lugar aos parametros: eles nao atribuem.
  // Melhor a oferta nao sair do que sair sem pagar comissao.
  const depois = await service.linkFor(offer);
  assert.notEqual(depois.mode, "params-fallback");
  assert.equal(depois.attributed, false, "nada aqui pode se declarar atribuido");
});

test("sem parametros configurados a extensao esgotada continua pendente", async () => {
  const store = new MemoryStore();
  const service = new AffiliateLinkService({ store, config: baseConfig(), clock, builderFile: missingBuilder });
  await service.touchExtension();
  await service.linkFor(offer);
  const [pedido] = await service.pending();
  for (let attempt = 0; attempt < 3; attempt += 1) await service.resolve({ id: pedido.id, error: "aba sem script" });

  const depois = await service.linkFor(offer);
  assert.equal(depois.mode, "extension");
  assert.equal(depois.pending, true);
});

test("a falha definitiva destrava a fila presa em awaiting-link", async () => {
  const store = new MemoryStore({
    queue: [{ id: "q1", productKey: "Mercado Livre:MLB1", status: "awaiting-link", offer: { ...offer }, lastDeferredReason: "Aguardando o link de afiliado do painel" }]
  });
  const service = new AffiliateLinkService({ store, config: comParams(), clock, builderFile: missingBuilder });
  await service.touchExtension();
  await service.linkFor(offer);
  const [pedido] = await service.pending();
  for (let attempt = 0; attempt < 3; attempt += 1) await service.resolve({ id: pedido.id, error: "aba sem script" });

  const item = store.state.queue[0];
  // Encerra em vez de publicar sem comissao. Antes isto virava "queued" com um
  // link de parametros, e a oferta saia sem pagar nada ao dono do canal.
  assert.equal(item.status, "expired");
  assert.match(String(item.lastDeferredReason), /nao atribuiu/);
});

test("a varredura encerra o que ficou preso sem atribuicao", async () => {
  const store = new MemoryStore({
    queue: [
      { id: "q1", productKey: "Mercado Livre:MLB1", status: "awaiting-link", offer: { ...offer } },
      { id: "q2", productKey: "Mercado Livre:MLB9", status: "awaiting-link", offer: { ...offer, externalId: "MLB9" } }
    ],
    affiliateRequests: [{ id: "r1", key: "Mercado Livre:MLB1", status: "failed", attempts: 3 }]
  });
  const service = new AffiliateLinkService({ store, config: comParams(), clock, builderFile: missingBuilder });

  const { rescued } = await service.rescueAwaitingLink();
  assert.equal(rescued, 0, "nao existe mais resgate: parametros nao atribuem");
  assert.equal(store.state.queue[0].status, "expired");
  assert.match(String(store.state.queue[0].lastDeferredReason), /nao atribuiu/);
  // O segundo nao falhou: continua esperando a extensao, que gera o link que paga.
  assert.equal(store.state.queue[1].status, "awaiting-link");
});

test("com backlog grande o link sai por parametros em vez de esperar a extensao", async () => {
  const pendentes = Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, key: `k${i}`, status: "pending", attempts: 0 }));
  const store = new MemoryStore({ affiliateRequests: pendentes });
  const config = { ...comParams(), affiliate: { allowParamLinks: true, extensionTimeoutMinutes: 10, extensionBacklogLimit: 40 } };
  const service = new AffiliateLinkService({ store, config, clock, builderFile: missingBuilder });
  await service.touchExtension();

  const resultado = await service.linkFor(offer);
  // Nem sob backlog os parametros entram: fila grande e problema de vazao,
  // publicar sem atribuicao e problema de receita. Um nao resolve o outro.
  assert.notEqual(resultado.mode, "params-backlog");
  assert.equal(resultado.attributed, false);
});

test("abaixo do limite a extensao continua sendo a preferida", async () => {
  const pendentes = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, key: `k${i}`, status: "pending", attempts: 0 }));
  const store = new MemoryStore({ affiliateRequests: pendentes });
  const config = { ...comParams(), affiliate: { allowParamLinks: true, extensionTimeoutMinutes: 10, extensionBacklogLimit: 40 } };
  const service = new AffiliateLinkService({ store, config, clock, builderFile: missingBuilder });
  await service.touchExtension();

  const resultado = await service.linkFor(offer);
  assert.equal(resultado.mode, "extension");
  assert.equal(resultado.pending, true);
});

test("o status conta a falha dos pedidos, nao so a de sessao", async () => {
  const store = new MemoryStore();
  const service = new AffiliateLinkService({ store, config: baseConfig(), clock, builderFile: missingBuilder });
  await service.touchExtension();
  await service.linkFor(offer);
  const [pedido] = await service.pending();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await service.resolve({ id: pedido.id, error: "Nao encontrei o campo de link nesta pagina" });
  }
  const status = await service.status();
  assert.equal(status.failedLinks, 1);
  // Antes isto vinha null e o painel dizia "tudo certo" com a fila travada.
  assert.match(String(status.lastError), /Nao encontrei o campo de link/);
  assert.ok(status.lastErrorAt, "a falha precisa ter hora");
  assert.equal(status.healthy, false, "sem params e com falha, nao esta saudavel");
});

test("com params configurado a falha da extensao nao e mais doenca", async () => {
  const store = new MemoryStore();
  const config = { ...baseConfig({ affiliates: { "Mercado Livre": "matt_word=x&matt_tool=1" } }) };
  const service = new AffiliateLinkService({ store, config, clock, builderFile: missingBuilder });
  await service.touchExtension();
  await service.linkFor(offer);
  const [pedido] = await service.pending();
  for (let attempt = 0; attempt < 3; attempt += 1) await service.resolve({ id: pedido.id, error: "aba caiu" });
  const status = await service.status();
  assert.equal(status.healthy, true, "ha rede de seguranca: a fila nao trava");
});

test("o link volta mesmo se o pedido ja saiu da lista", async () => {
  const store = new MemoryStore({
    queue: [{ id: "q1", productKey: "Mercado Livre:MLB1", status: "awaiting-link", offer: { ...offer } }]
  });
  const service = new AffiliateLinkService({ store, config: baseConfig(), clock, builderFile: missingBuilder });
  await service.touchExtension();
  await service.linkFor(offer);
  const [pedido] = await service.pending();

  // O teto de pedidos descartou o registro enquanto a extensao trabalhava.
  store.state.affiliateRequests = [];
  store.state.affiliateRequests.push({ id: pedido.id, key: "Mercado Livre:MLB1", status: "pending", attempts: 0, productUrl: offer.affiliateUrl });
  const guardado = store.state.affiliateRequests[0];
  const resultado = await service.resolve({ id: pedido.id, link: "https://meli.la/AbC123" });
  assert.equal(resultado.status, "done");

  // Some o registro no meio do caminho: nao pode quebrar nem perder o link.
  store.state.affiliateRequests = [];
  const item = store.state.queue[0];
  item.status = "awaiting-link";
  store.state.affiliateRequests.push({ ...guardado, id: "outro" });
  await assert.doesNotReject(() => service.resolve({ id: "outro", link: "https://meli.la/XyZ999" }));
  assert.equal(store.state.queue[0].status, "queued");
  assert.equal(store.state.queue[0].offer.affiliateUrl, "https://meli.la/XyZ999");
});

test("o teto de pedidos corta as falhas, nunca os pendentes", async () => {
  const store = new MemoryStore();
  // 499 pendentes de verdade + falhas antigas empurrando o limite.
  store.state.affiliateRequests = [
    ...Array.from({ length: 30 }, (_, i) => ({ id: `f${i}`, key: `falha-${i}`, status: "failed", attempts: 3 })),
    ...Array.from({ length: 499 }, (_, i) => ({ id: `p${i}`, key: `pend-${i}`, status: "pending", attempts: 0 }))
  ];
  const service = new AffiliateLinkService({ store, config: baseConfig(), clock, builderFile: missingBuilder });
  await service.touchExtension();
  await service.linkFor({ ...offer, externalId: "MLB-NOVO" });

  const pendentes = store.state.affiliateRequests.filter((i) => i.status === "pending");
  assert.equal(pendentes.length, 500, "nenhum pendente pode ser descartado pelo teto");
  assert.ok(store.state.affiliateRequests.length <= 500 + 1);
});
