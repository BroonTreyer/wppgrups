import test from "node:test";
import assert from "node:assert/strict";
import { formatOfferCaption } from "../src/domain/message.js";
import { SAMPLE_OFFER } from "../src/mock/sample-offer.js";

const agora = new Date("2026-09-02T20:00:00Z");

test("legenda traz preco, desconto, prova social e link", () => {
  const caption = formatOfferCaption(SAMPLE_OFFER, agora, ["electronics"]);
  assert.match(caption, /R\$\s2\.199,00/);
  assert.match(caption, /~R\$\s2\.899,00~/);
  assert.match(caption, /24% OFF/);
  assert.match(caption, /⭐ 4\.8/);
  assert.match(caption, /1240 avaliações/);
  assert.match(caption, /👉 https:\/\/example\.com\/oferta/);
});

test("nunca menciona comissao para o assinante", () => {
  const caption = formatOfferCaption(SAMPLE_OFFER, agora, ["electronics"]);
  assert.doesNotMatch(caption, /comissao|comissão|afiliad/i);
  assert.doesNotMatch(caption, /sujeito a alteracao/i);
});

test("so o canal masculino tem chamada de nicho", () => {
  assert.match(formatOfferCaption(SAMPLE_OFFER, agora, ["kids"]), /ACHADINHO PRA MAMÃE/);
  assert.match(formatOfferCaption(SAMPLE_OFFER, agora, ["electronics"]), /ACHADO TECH/);
  // home, beauty, health e fashion publicam SEM manchete: a mensagem abre no
  // nome do produto. Nao ha mais chamada geral.
  for (const nicho of ["home", "beauty", "health", "fashion", "general"]) {
    const texto = formatOfferCaption(SAMPLE_OFFER, agora, [nicho]);
    assert.ok(!/ACHADINHO DO DIA/.test(texto), nicho);
    assert.ok(texto.startsWith("*"), `${nicho}: deveria abrir no nome do produto`);
  }
});

test("desconto agressivo vira manchete de urgencia", () => {
  const caption = formatOfferCaption({ ...SAMPLE_OFFER, currentPrice: 999 }, agora, ["home"]);
  assert.match(caption, /PREÇO ABSURDO/);
});

test("mostra a contagem regressiva quando a promocao esta acabando", () => {
  const acabando = { ...SAMPLE_OFFER, expiresAt: new Date(agora.getTime() + 45 * 60000).toISOString() };
  assert.match(formatOfferCaption(acabando, agora, ["home"]), /CORRE, ACABA ÀS/);
  const tranquila = { ...SAMPLE_OFFER, expiresAt: new Date(agora.getTime() + 5 * 3600000).toISOString() };
  assert.match(formatOfferCaption(tranquila, agora, ["home"]), /Só até/);
});

test("o desconto nao apaga a identidade do post", () => {
  // Um impermeabilizante com 55% saiu com a manchete "PRECO ABSURDO" num canal
  // de achadinhos: o desconto trocava a manchete e o post perdia o assunto.
  const oferta = { title: "Kerastase Nutritive Bain Satin 250ml", currentPrice: 90, originalPrice: 200, affiliateUrl: "https://meli.la/x" };
  const texto = formatOfferCaption(oferta, new Date("2026-09-07T18:00:00Z"), ["electronics"]);
  assert.match(texto.split("\n")[0], /ACHADO TECH/, "a manchete continua sendo a do nicho, nao a do desconto");
  assert.match(texto, /PRECO ABSURDO|PREÇO ABSURDO/, "a enfase do desconto continua, na linha do preco");
});

test("desconto modesto usa a etiqueta discreta", () => {
  const oferta = { title: "Perfume Malbec 100ml", currentPrice: 180, originalPrice: 220, affiliateUrl: "https://meli.la/y" };
  const texto = formatOfferCaption(oferta, new Date("2026-09-07T18:00:00Z"), ["beauty"]);
  assert.match(texto, /🏷️ 18% OFF/);
  assert.ok(!/ABSURDO/.test(texto));
});

test("frete fica fora da mensagem", () => {
  // O selo "Enviado pelo FULL" nao diz nada a quem le, e "frete gratis" muda
  // por CEP e valor de carrinho: prometer na legenda o que a pagina pode
  // desmentir custa confianca no canal.
  for (const frete of ["Enviado pelo FULL", "Frete grátis Enviado pelo FULL", "Frete grátis"]) {
    const texto = formatOfferCaption(
      { title: "Perfume X", currentPrice: 100, originalPrice: 120, shipping: frete, affiliateUrl: "https://meli.la/a" },
      new Date(), ["beauty"]
    );
    assert.ok(!/FULL/i.test(texto), frete);
    assert.ok(!/🚚/.test(texto), frete);
    assert.ok(!/[Ff]rete/.test(texto), frete);
  }
});

test("sem manchete, a mensagem abre no nome do produto", () => {
  const oferta = { title: "Air Fryer 5L", currentPrice: 300, originalPrice: 340, affiliateUrl: "https://meli.la/b" };
  for (const n of ["home", "beauty", "health", "fashion"]) {
    const [primeira] = formatOfferCaption(oferta, new Date(), [n]).split(/\r?\n/);
    assert.equal(primeira, "*Air Fryer 5L*", n);
  }
});
