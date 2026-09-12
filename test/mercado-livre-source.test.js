import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { MercadoLivreSource, normalizeCard, parseDealsPage } from "../src/sources/mercado-livre.js";

const fixture = await readFile(new URL("./fixtures/mercado-livre-ofertas.html", import.meta.url), "utf8");


// Monta uma pagina de vitrine reaproveitando a fixture real: mesma estrutura
// que o parser ja sabe ler, com os ids trocados. Inventar o HTML a mao aqui
// testaria o meu palpite sobre o formato, nao o formato de verdade.
const paginaCom = (ids) => {
  const ctx = JSON.parse(fixture.slice(fixture.indexOf("_n.ctx.r=") + 9, fixture.indexOf("</" + "script>")).replace(/;s*$/, ""));
  const modelo = ctx.results[0];
  const results = ids.map((id, i) => {
    const card = structuredClone(modelo.card);
    card.metadata.id = id;
    card.unique_id = "u" + id;
    return { ...modelo, position: i + 1, card };
  });
  return "<html><body><script id=\"__NORDIC_RENDERING_CTX__\">_n.ctx.r=" + JSON.stringify({ results }) + ";<" + "/script></body></html>";
};
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

test("as paginas vao em blocos paralelos, sem perder a ordem da vitrine", async () => {
  let emVoo = 0;
  let pico = 0;
  const pedidas = [];
  const fetchImpl = async (url) => {
    emVoo += 1; pico = Math.max(pico, emVoo);
    const pagina = Number(new URL(url).searchParams.get("page") ?? 1);
    pedidas.push(pagina);
    await new Promise((r) => setTimeout(r, 10));
    emVoo -= 1;
    return { ok: true, text: async () => paginaCom([`MLB${pagina}a`, `MLB${pagina}b`]) };
  };
  const source = new MercadoLivreSource({ fetchImpl });
  const offers = await source.collect({ pages: 10, category: "MLB1246" });

  assert.equal(pico > 1, true, "as paginas precisam ir em paralelo");
  assert.ok(pico <= 5, "mas com teto de bloco");
  assert.deepEqual(offers.map((o) => o.externalId).slice(0, 4), ["MLB1a", "MLB1b", "MLB2a", "MLB2b"],
    "a ordem da vitrine e a ordem de relevancia: nao pode embaralhar");
  assert.equal(offers.length, 20);
});

test("pagina vazia encerra a coleta mesmo com o bloco em voo", async () => {
  const fetchImpl = async (url) => {
    const pagina = Number(new URL(url).searchParams.get("page") ?? 1);
    return { ok: true, text: async () => (pagina >= 3 ? paginaCom([]) : paginaCom([`MLB${pagina}`])) };
  };
  const source = new MercadoLivreSource({ fetchImpl });
  const offers = await source.collect({ pages: 20, category: "" });
  assert.deepEqual(offers.map((o) => o.externalId), ["MLB1", "MLB2"]);
});

test("uma pagina com erro nao derruba o bloco inteiro", async () => {
  const fetchImpl = async (url) => {
    const pagina = Number(new URL(url).searchParams.get("page") ?? 1);
    if (pagina === 2) throw new Error("500 do marketplace");
    return { ok: true, text: async () => paginaCom([`MLB${pagina}`]) };
  };
  const source = new MercadoLivreSource({ fetchImpl });
  const offers = await source.collect({ pages: 4, category: "" });
  assert.deepEqual(offers.map((o) => o.externalId), ["MLB1", "MLB3", "MLB4"]);
});

test("le a marca e o selo de loja oficial do card", () => {
  const offers = parseDealsPage(fixture);
  // A fixture real tem vendedor em pelo menos um card.
  const comVendedor = offers.filter((o) => o.sellerName);
  assert.ok(comVendedor.length >= 1, "nenhum card trouxe vendedor");
  for (const o of offers) {
    assert.equal(typeof o.officialStore, "boolean", "officialStore precisa existir sempre");
  }
});

test("o selo de loja oficial vem do icone, nao do texto do vendedor", () => {
  const card = {
    metadata: { id: "MLB1", url: "www.mercadolivre.com.br/p/MLB1" },
    pictures: { pictures: [{ id: "PIC1" }] },
    components: [
      { type: "title", title: { text: "Serum Facial" } },
      { type: "price", price: { current_price: { value: 50 } } },
      { type: "seller", seller: { values: [
        { type: "icon", icon: { icon_id: "icon_cockade", alt_text: "Loja oficial" } },
        { type: "label", label: { text: "NATURA" } }
      ] } }
    ]
  };
  const oficial = normalizeCard(card);
  assert.equal(oficial.sellerName, "NATURA");
  assert.equal(oficial.officialStore, true);

  // Mesmo vendedor, sem o selo: nao pode virar oficial.
  const semSelo = structuredClone(card);
  semSelo.components[2].seller.values = [{ type: "label", label: { text: "LOJA DO JOAO" } }];
  const comum = normalizeCard(semSelo);
  assert.equal(comum.sellerName, "LOJA DO JOAO");
  assert.equal(comum.officialStore, false);

  // Card sem bloco de vendedor nao quebra.
  const semVendedor = structuredClone(card);
  semVendedor.components.splice(2, 1);
  const anonimo = normalizeCard(semVendedor);
  assert.equal(anonimo.sellerName, null);
  assert.equal(anonimo.officialStore, false);
});

// A leitura de prova social vive no coletor da extensao (extension/harvest.js),
// que roda no navegador e nao pode ser importado aqui. A regra e replicada para
// que a mudanca de formato do Mercado Livre quebre um teste, e nao a colheita.
const provaSocialDoTexto = (texto) => {
  const limpo = String(texto).replace(/\s+/g, " ");
  const nota = limpo.match(/(?:^|\s)([0-5][.,]\d)(?=\s|\()/);
  const rating = nota ? Number.parseFloat(nota[1].replace(",", ".")) : null;
  const vendas = limpo.match(/\+?\s*([\d.]+)\s*(mil|mi)?\s*vendid/i);
  let soldCount = null;
  if (vendas) {
    const base = Number.parseFloat(vendas[1].replace(/\./g, ""));
    const escala = /mil/i.test(vendas[2] ?? "") ? 1000 : /mi/i.test(vendas[2] ?? "") ? 1_000_000 : 1;
    if (Number.isFinite(base)) soldCount = Math.round(base * escala);
  }
  if (soldCount === null) {
    const av = limpo.match(/\((\d[\d.]*)\)/);
    if (av) { const t = Number.parseFloat(av[1].replace(/\./g, "")); if (Number.isFinite(t)) soldCount = t; }
  }
  return { rating: rating && rating > 0 && rating <= 5 ? rating : null, soldCount };
};

test("le nota e vendas do texto do card, nos formatos que o ML usa", () => {
  // Sem isto a colheita inteira e descartada por "pouca gente comprou": foi o
  // que aconteceu em 11/09/2026, com ~900 produtos lidos e zero enfileirados.
  assert.deepEqual(provaSocialDoTexto("Natura Tododia 400ml 4.8 (1.234) R$ 39,90"), { rating: 4.8, soldCount: 1234 });
  assert.deepEqual(provaSocialDoTexto("Shampoo Wella 4,7 +5mil vendidos"), { rating: 4.7, soldCount: 5000 });
  assert.deepEqual(provaSocialDoTexto("Serum 4.9 | +10mil vendidos"), { rating: 4.9, soldCount: 10000 });
  assert.deepEqual(provaSocialDoTexto("Creme 4.2 +1 mi vendidos"), { rating: 4.2, soldCount: 1000000 });
  assert.deepEqual(provaSocialDoTexto("Produto novo sem avaliacao"), { rating: null, soldCount: null });
});

test("preco nao pode ser confundido com nota", () => {
  // "R$ 2,99" tem a forma de uma nota valida. Se o preco virar nota, produto
  // barato passa a ser tratado como bem avaliado.
  assert.deepEqual(provaSocialDoTexto("Sabonete R$ 2,99 4.4 (12)"), { rating: 4.4, soldCount: 12 });
});

// Reconstrucao do preco "de" a partir do selo "X% OFF", replicada de
// extension/harvest.js (que roda no navegador e nao pode ser importado aqui).
const precoAnteriorPeloSelo = (texto, atual) => {
  const selo = String(texto).match(/(\d{1,2})\s*%\s*OFF/i);
  if (!selo || !atual) return null;
  const off = Number(selo[1]);
  if (!Number.isFinite(off) || off <= 0 || off >= 100) return null;
  return Math.round((atual / (1 - off / 100)) * 100) / 100;
};

test("o preco de antes sai do selo quando o riscado nao esta na tela", () => {
  // Sem isto o produto chega com desconto zero e e recusado por "desconto abaixo
  // do minimo" — ainda que tenha vindo de uma URL filtrada POR desconto. Foi o
  // caso de 16 dos 48 produtos do vult em 11/09/2026.
  const antes = precoAnteriorPeloSelo("Gloss Fran 72% OFF", 19.01);
  assert.equal(antes, 67.89);
  assert.equal(Math.round((1 - 19.01 / antes) * 100), 72, "o desconto reconstruido tem que bater com o selo");

  assert.equal(precoAnteriorPeloSelo("Shampoo 10% OFF", 90), 100);
});

test("sem selo, ou com selo impossivel, nao se inventa preco", () => {
  assert.equal(precoAnteriorPeloSelo("Produto sem desconto", 30), null);
  assert.equal(precoAnteriorPeloSelo("Produto 0% OFF", 30), null);
  // 100% de desconto faria divisao por zero.
  assert.equal(precoAnteriorPeloSelo("Produto 100% OFF", 30), null);
});

test("a revalidacao nao vai atras da pagina de origem, por custo", async () => {
  // Descer ate a pagina de onde cada oferta veio custava 163 buscas sequenciais
  // por ciclo e travava o agendador por minutos — o canal caiu para um post a
  // cada 7 min. Quem esta fundo demais nao e revalidado nem descartado: o
  // price-guard o deixa como "unchecked".
  const pedidas = [];
  const source = new MercadoLivreSource({ fetchImpl: async (url) => {
    pedidas.push(url.toString());
    return { ok: true, status: 200, text: async () => fixture };
  } });
  await source.refreshMany([
    { externalId: "MLB5457116760", sourceContext: { category: "MLB1246", page: 22 } },
    { externalId: "MLB5958307590", sourceContext: { category: "MLB1246", page: 2 } }
  ], { pages: 2 });
  assert.deepEqual(pedidas, [
    "https://www.mercadolivre.com.br/ofertas?category=MLB1246",
    "https://www.mercadolivre.com.br/ofertas?page=2&category=MLB1246"
  ], "duas paginas, mesmo com oferta vinda da 22");
});

