import test from "node:test";
import assert from "node:assert/strict";
import { isRisky, priceScore, scoreBreakdown, scoreOffer } from "../src/domain/scoring.js";

const offer = (extra = {}) => ({ title: "Air fryer 5L", currentPrice: 100, originalPrice: 200, rating: 4.7, soldCount: 10000, ...extra });

test("produto que vende muito vence produto com desconto maior e sem procura", () => {
  const campeao = offer({ title: "Tenis Kappa Park", currentPrice: 78, originalPrice: 170, soldCount: 100000, rating: 4.7 });
  const desconhecido = offer({ title: "Suporte generico", currentPrice: 30, originalPrice: 150, soldCount: 50, rating: 4.5 });
  assert.ok(scoreOffer(campeao) > scoreOffer(desconhecido));
});

test("ticket alto perde para produto na faixa do grupo", () => {
  const barato = offer({ currentPrice: 90, originalPrice: 180 });
  const caro = offer({ currentPrice: 1389, originalPrice: 2800 });
  assert.ok(scoreOffer(barato) > scoreOffer(caro));
  assert.equal(priceScore(90), 20);
  assert.equal(priceScore(1389), -15);
});

test("respeita a faixa de preco configurada para o publico", () => {
  const premium = { min: 300, max: 2000 };
  assert.equal(priceScore(1200, premium), 20);
  assert.equal(priceScore(1200), -15);
});

test("nota baixa derruba o produto", () => {
  assert.ok(scoreOffer(offer({ rating: 3.5 })) < scoreOffer(offer({ rating: 4.9 })));
  assert.equal(scoreBreakdown(offer({ rating: 3.5 })).reputacao, -10);
});

test("desconto absurdo e tratado como suspeito, nao como oportunidade", () => {
  const critico = scoreBreakdown(offer({ currentPrice: 5, originalPrice: 200 })).desconto;
  const saudavel = scoreBreakdown(offer({ currentPrice: 120, originalPrice: 200 })).desconto;
  assert.ok(critico < saudavel);
});

test("bloqueia categoria sensivel sem pegar palavra parecida", () => {
  assert.equal(isRisky({ title: "TESTO ESSENCIAL Formula com Feno Grego" }), true);
  assert.equal(isRisky({ title: "Vape Pod Descartavel 8000 puffs" }), true);
  assert.equal(isRisky({ title: "Lixeira Automatica Branca Armazenamento" }), false);
  assert.equal(isRisky({ title: "Kit Armario Organizador Closet" }), false);
  assert.equal(isRisky({ title: "Body Bebe Kit 5 pecas" }), false);
});

test("produto de risco fica com score negativo e nunca sobe na fila", () => {
  const risco = offer({ title: "Testosterona natural 60 capsulas", soldCount: 500000, rating: 4.9 });
  assert.ok(scoreOffer(risco) < 0);
  assert.equal(scoreBreakdown(risco).risco, -100);
});

test("palavra bloqueada pelo usuario entra na conta do risco", () => {
  const item = offer({ title: "Capinha de silicone para celular" });
  assert.equal(isRisky(item), false);
  assert.equal(isRisky(item, ["capinha"]), true);
});
