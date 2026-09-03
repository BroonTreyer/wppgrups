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

test("troca a chamada conforme o nicho do destino", () => {
  assert.match(formatOfferCaption(SAMPLE_OFFER, agora, ["kids"]), /ACHADINHO PRA MAMÃE/);
  assert.match(formatOfferCaption(SAMPLE_OFFER, agora, ["home"]), /ACHADINHO PRA CASA/);
  assert.match(formatOfferCaption(SAMPLE_OFFER, agora, ["general"]), /ACHADINHO DO DIA/);
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
