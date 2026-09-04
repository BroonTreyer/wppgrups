import test from "node:test";
import assert from "node:assert/strict";
import { inferNiches } from "../src/domain/niches.js";

test("classifica uma TV em eletronicos e ofertas gerais", () => {
  assert.deepEqual(inferNiches({ title: "Smart TV 4K", category: "TV" }), ["electronics", "general"]);
});

test("sempre inclui ofertas gerais", () => {
  assert.deepEqual(inferNiches({ title: "Produto desconhecido" }), ["general"]);
});

test("classifica titulos reais de marketplace nos nichos certos", () => {
  const niche = (title) => inferNiches({ title });
  assert.deepEqual(niche("Fritadeira Air Fryer 4,5l Widemax 1500w Midea"), ["home", "general"]);
  assert.deepEqual(niche("Kit 10 Cuecas Boxer Lisa Polo Wear Sortido"), ["fashion", "general"]);
  assert.deepEqual(niche("Whey Protein 900g Growth"), ["sports", "general"]);
  assert.deepEqual(niche("Fralda Pampers Confort Sec XG"), ["kids", "general"]);
});

test("nao confunde palavra contida em outra com o nicho", () => {
  assert.deepEqual(inferNiches({ title: "Celular Motorola Moto G54 5G 256gb" }), ["electronics", "general"]);
  assert.deepEqual(inferNiches({ title: "Capacete Para Motocicleta Pro Tork" }), ["tools-auto", "general"]);
});

test("separa o publico de mamaes, casa e saude do publico masculino", () => {
  const niche = (title) => inferNiches({ title }).filter((item) => item !== "general");
  assert.deepEqual(niche("Cinta Pos Parto Modeladora Gestante"), ["kids"]);
  assert.deepEqual(niche("Jogo de Toalhas Buddemeyer Fio Penteado Banho"), ["home"]);
  assert.deepEqual(niche("Colageno Verisol 300g Vitamina C"), ["health"]);
  assert.deepEqual(niche("Furadeira Parafusadeira 12v Bosch"), ["tools-auto"]);
  assert.deepEqual(niche("Batom Matte Ruby Rose Kit"), ["beauty"]);
});

test("palavra de formato nao rouba o produto do nicho certo", () => {
  // Caso real de 04/09: "pote" jogou creatina no nicho de casa, e ela foi
  // publicada num canal de kids/casa/beleza em vez do de esportes.
  const nichos = inferNiches({ title: "Creatina Monohidratada em Pote 300g 100% Pura" });
  assert.ok(nichos.includes("sports"), "creatina e sinal forte de esportes");
  assert.ok(!nichos.includes("home"), "'pote' sozinho nao faz de um suplemento item de casa");
});

test("sem sinal forte, a palavra fraca ainda vale", () => {
  // Um pote que e so um pote continua sendo item de casa: a regra descarta o
  // sinal fraco apenas quando existe um forte competindo.
  const nichos = inferNiches({ title: "Pote Organizador Empilhavel 2 Litros" });
  assert.ok(nichos.includes("home"), nichos.join(","));
});

test("produto de casa de verdade nao e afetado", () => {
  const nichos = inferNiches({ title: "Jogo De Toalhas Buddemeyer Bella Extra Macia" });
  assert.ok(nichos.includes("home"));
  assert.ok(!nichos.includes("sports"));
});
