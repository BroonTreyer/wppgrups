import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { MercadoLivreSource, parseDealsPage } from "../src/sources/mercado-livre.js";

const fixture = await readFile(new URL("./fixtures/mercado-livre-ofertas.html", import.meta.url), "utf8");

test("extrai ofertas da pagina publica com preco, imagem e link limpos", () => {
  const offers = parseDealsPage(fixture);
  assert.equal(offers.length, 3);
  const [airFryer] = offers;
  assert.equal(airFryer.externalId, "MLB5457116760");
  assert.equal(airFryer.marketplace, "Mercado Livre");
  assert.equal(airFryer.currentPrice, 199.9);
  assert.equal(airFryer.originalPrice, 289);
  assert.equal(airFryer.rating, 4.9);
  assert.equal(airFryer.soldLabel, "+10mil vendidos");
  assert.match(airFryer.shipping, /Frete gratis|Frete grátis/);
  assert.equal(airFryer.imageUrl, "https://http2.mlstatic.com/D_Q_NP_2X_733418-MLA99504461002_112025-O.jpg");
  assert.equal(airFryer.affiliateUrl, "https://www.mercadolivre.com.br/fritadeira-air-fryer-45l-widemax-com-interior-de-aluminio-1500w-midea/p/MLB51032488");
  assert.equal(offers[1].paymentMethod, "no Pix");
});

test("descarta cards sem preco ou sem link de produto", () => {
  const broken = '<script>_n.ctx.r={"results":[{"position":1,"type":"ORGANIC_ITEM","card":{"metadata":{"id":"MLB1","url":"site-externo.com/x"},"components":[{"type":"title","title":{"text":"Produto"}}]}}]}</script>';
  assert.deepEqual(parseDealsPage(broken), []);
});

test("percorre paginas e nao repete o mesmo produto", async () => {
  const requested = [];
  const source = new MercadoLivreSource({ fetchImpl: async (url) => {
    requested.push(url.toString());
    return { ok: true, status: 200, text: async () => fixture };
  } });
  const offers = await source.collect({ pages: 2, category: "MLB1051" });
  assert.equal(offers.length, 3);
  assert.equal(offers[0].category, "Celulares e telefones");
  assert.deepEqual(requested, [
    "https://www.mercadolivre.com.br/ofertas?category=MLB1051",
    "https://www.mercadolivre.com.br/ofertas?page=2&category=MLB1051"
  ]);
});

test("propaga erro quando o marketplace recusa a consulta", async () => {
  const source = new MercadoLivreSource({ fetchImpl: async () => ({ ok: false, status: 429, text: async () => "" }) });
  await assert.rejects(() => source.collect({ pages: 1 }), /respondeu 429/);
});

test("revalida precos relendo a vitrine da mesma categoria", async () => {
  const requested = [];
  const source = new MercadoLivreSource({ fetchImpl: async (url) => {
    requested.push(url.toString());
    return { ok: true, status: 200, text: async () => fixture };
  } });
  const offers = [
    { externalId: "MLB5457116760", sourceContext: { category: "" } },
    { externalId: "MLB0000000000", sourceContext: { category: "" } }
  ];
  const current = await source.refreshMany(offers, { pages: 1 });
  assert.equal(current.get("MLB5457116760").currentPrice, 199.9);
  assert.equal(current.get("MLB0000000000"), null);
  assert.deepEqual(requested, ["https://www.mercadolivre.com.br/ofertas"]);
});

test("agrupa a revalidacao por categoria de origem", async () => {
  const requested = [];
  const source = new MercadoLivreSource({ fetchImpl: async (url) => {
    requested.push(url.toString());
    return { ok: true, status: 200, text: async () => fixture };
  } });
  await source.refreshMany([
    { externalId: "MLB5457116760", sourceContext: { category: "MLB1051" } },
    { externalId: "MLB5958307590", sourceContext: { category: "MLB1051" } },
    { externalId: "MLB5318608904", sourceContext: { category: "MLB1574" } }
  ], { pages: 1 });
  assert.deepEqual(requested, [
    "https://www.mercadolivre.com.br/ofertas?category=MLB1051",
    "https://www.mercadolivre.com.br/ofertas?category=MLB1574"
  ]);
});
