import assert from "node:assert/strict";
import test from "node:test";
import {
  breakdownForDestination, destinationSweetSpot, nicheAffinity,
  priorityBonus, repetitionPenalty, scoreForDestination, significantTokens
} from "../src/domain/targeting.js";

const oferta = (extra = {}) => ({
  title: "Creatina Monohidratada Pura 1kg Dark Lab",
  currentPrice: 90, originalPrice: 150, soldCount: 5000, rating: 4.7, ...extra
});

const canal = (extra = {}) => ({ id: "d1", nicheIds: ["sports", "health"], ...extra });

test("a faixa de preco vem do destino, nao da media do sistema", () => {
  assert.deepEqual(destinationSweetSpot({ maxPrice: 80 }), { min: 25, max: 80 });
  assert.deepEqual(destinationSweetSpot({ sweetSpot: { min: 100, max: 900 } }), { min: 100, max: 900 });
  assert.deepEqual(destinationSweetSpot({}), { min: 25, max: 200 });
});

test("o mesmo produto vale mais no canal cuja faixa ele ocupa", () => {
  const caro = oferta({ title: "Ar Condicionado Split 12000 Btus", currentPrice: 1800, originalPrice: 2600 });
  const achadinhos = scoreForDestination(caro, canal({ nicheIds: ["home"], maxPrice: 150 }), { nicheIds: ["home"] });
  const eletro = scoreForDestination(caro, canal({ nicheIds: ["home"], sweetSpot: { min: 500, max: 3000 } }), { nicheIds: ["home"] });
  assert.ok(eletro > achadinhos, `esperava ${eletro} > ${achadinhos}`);
});

test("cair no miolo do canal vale mais que cair na borda", () => {
  const item = oferta();
  const miolo = scoreForDestination(item, canal(), { nicheIds: ["sports", "health"] });
  const borda = scoreForDestination(item, canal(), { nicheIds: ["sports"] });
  assert.ok(miolo > borda, `esperava ${miolo} > ${borda}`);
  assert.equal(nicheAffinity(["sports", "health"], canal()), 16);
  assert.equal(nicheAffinity(["general"], canal()), 0);
});

test("titulo quase igual ao recem-publicado leva a maior penalidade", () => {
  const recent = [{ title: "Creatina 1kg Suplemento Monohidratada Growth", nicheIds: ["sports"] }];
  const penalidade = repetitionPenalty(oferta(), ["sports"], recent);
  // 6 pelo nicho repetido + 30 pelo produto parecido.
  assert.equal(penalidade, 36);
});

test("nicho repetido penaliza, mas menos que produto repetido", () => {
  const recent = [{ title: "Bicicleta Aro 29 Freio a Disco", nicheIds: ["sports"] }];
  assert.equal(repetitionPenalty(oferta(), ["sports"], recent), 6);
});

test("palavra generica nao faz dois produtos diferentes parecerem o mesmo", () => {
  const tokens = significantTokens("Kit 10 Pote De Vidro Marmita Hermetico Original");
  assert.ok(!tokens.has("kit"), "kit deveria ser descartada");
  assert.ok(!tokens.has("original"), "original deveria ser descartada");
  assert.ok(tokens.has("vidro") && tokens.has("marmita"));
  // Sem descartar genericas, "kit" + "original" bastariam para estes dois
  // passarem por produtos iguais. Nicho diferente isola o efeito do titulo.
  const outro = [{ title: "Kit 4 Pecas Original Premium Para Cozinha", nicheIds: ["kids"] }];
  assert.equal(repetitionPenalty({ title: "Kit 10 Pote De Vidro Marmita Hermetico Original" }, ["home"], outro), 0);
});

test("marcas diferentes do mesmo produto sao pegas pela proporcao", () => {
  // O caso real da fila: duas creatinas so compartilham 2 palavras uteis, e
  // exigir 3 deixava passar exatamente o que mais incomoda num canal.
  const recent = [{ title: "Creatina 1kg Suplemento Monohidratada Growth", nicheIds: ["kids"] }];
  const p = repetitionPenalty({ title: "Creatina Monohidratada Pura 1kg Dark Lab" }, ["sports"], recent);
  assert.equal(p, 30, "so a penalidade de titulo, sem repetir nicho");
});

test("so a janela recente conta: o que saiu ha muitos posts nao pesa", () => {
  const antigos = Array.from({ length: 5 }, (_, i) => ({ title: `Produto Diferente Numero ${i}`, nicheIds: ["home"] }));
  const recent = [...antigos, { title: "Creatina Monohidratada Growth 1kg", nicheIds: ["sports"] }];
  assert.equal(repetitionPenalty(oferta(), ["sports"], recent), 0);
});

test("o detalhamento explica o total", () => {
  const recent = [{ title: "Creatina 1kg Suplemento Monohidratada Growth", nicheIds: ["sports"] }];
  const b = breakdownForDestination(oferta(), canal(), { nicheIds: ["sports", "health"], recent });
  assert.equal(b.base + b.afinidade + b.repeticao, b.total);
  assert.ok(b.repeticao < 0);
});

test("destino sem nicho declarado nao ganha bonus nem quebra", () => {
  assert.equal(nicheAffinity(["sports"], {}), 0);
  assert.equal(typeof scoreForDestination(oferta(), {}, { nicheIds: ["sports"] }), "number");
});

test("nicho priorizado ganha a vez sem excluir os outros", () => {
  // "Achadinhos da Isa e um canal de beleza" — mas continua aceitando casa e
  // infantil. `nicheIds` e porteiro; `priorityNiches` e preferencia.
  const isa = { id: "isa", nicheIds: ["kids", "home", "beauty", "health"], priorityNiches: ["beauty"] };
  const shampoo = { title: "Kerastase Nutritive Bain Satin 250ml", currentPrice: 120, originalPrice: 200, soldCount: 800, rating: 4.7 };
  const panela = { title: "Panela De Pressao Eletrica 5L", currentPrice: 190, originalPrice: 380, soldCount: 9000, rating: 4.8 };

  const beleza = scoreForDestination(shampoo, isa, { nicheIds: ["beauty"] });
  const casa = scoreForDestination(panela, isa, { nicheIds: ["home"] });
  assert.ok(beleza > casa,
    `beleza deveria vencer mesmo com desconto e demanda menores (${beleza} vs ${casa})`);

  // Sem prioridade declarada, a panela venceria — e o bonus e o que inverte.
  const neutro = { id: "x", nicheIds: isa.nicheIds };
  assert.ok(scoreForDestination(panela, neutro, { nicheIds: ["home"] })
    > scoreForDestination(shampoo, neutro, { nicheIds: ["beauty"] }));
});

test("prioridade nao bloqueia quem nao e do nicho preferido", () => {
  const isa = { id: "isa", nicheIds: ["home", "beauty"], priorityNiches: ["beauty"] };
  const panela = { title: "Panela De Pressao 5L", currentPrice: 150, originalPrice: 300, soldCount: 500, rating: 4.6 };
  // Continua pontuando: o porteiro e o `nicheIds`, checado no blockReason.
  assert.ok(scoreForDestination(panela, isa, { nicheIds: ["home"] }) > 0);
  assert.equal(priorityBonus(["home"], isa), 0);
  assert.ok(priorityBonus(["beauty"], isa) > 0);
});

test("sem priorityNiches nada muda", () => {
  assert.equal(priorityBonus(["beauty"], { nicheIds: ["beauty"] }), 0);
  assert.equal(priorityBonus(["beauty"], {}), 0);
});

test("marca repetida perde a vez para outra marca", () => {
  // A colheita traz uma loja inteira de uma vez. Sem esta penalidade o canal
  // publica um bloco de Avon, depois um bloco de Eudora — foi o que o dono do
  // canal reclamou em 11/09/2026.
  const recentes = [
    { title: "Avon Care Hidratante 200ml", sellerName: "AVON", nicheIds: ["beauty"] },
    { title: "Avon Renew Serum 30ml", sellerName: "AVON", nicheIds: ["beauty"] }
  ];
  const outraAvon = { title: "Avon Match Batom Matte", sellerName: "AVON", currentPrice: 30, originalPrice: 60, soldCount: 900, rating: 4.7 };
  const naturaQualquer = { title: "Natura Tododia Creme 400ml", sellerName: "NATURA", currentPrice: 30, originalPrice: 60, soldCount: 900, rating: 4.7 };

  const penalAvon = repetitionPenalty(outraAvon, ["beauty"], recentes);
  const penalNatura = repetitionPenalty(naturaQualquer, ["beauty"], recentes);
  assert.ok(penalAvon > penalNatura, `a terceira Avon tem que ser penalizada: ${penalAvon} vs ${penalNatura}`);

  const destino = { id: "g", nicheIds: ["beauty"], minMinutesBetweenPosts: 5 };
  const scoreAvon = scoreForDestination(outraAvon, destino, { nicheIds: ["beauty"], recent: recentes });
  const scoreNatura = scoreForDestination(naturaQualquer, destino, { nicheIds: ["beauty"], recent: recentes });
  assert.ok(scoreNatura > scoreAvon, "com tudo igual, a outra marca tem que ganhar a vez");
});

test("uma marca sozinha no historico ainda pode repetir", () => {
  // Intercalar nao e proibir: duas da mesma marca em cinco posts e aceitavel.
  const recentes = [{ title: "Natura Tododia Creme", sellerName: "NATURA", nicheIds: ["beauty"] }];
  const outra = { title: "Natura Ekos Polpa", sellerName: "NATURA", currentPrice: 30, originalPrice: 60, soldCount: 900, rating: 4.7 };
  const penal = repetitionPenalty(outra, ["beauty"], recentes);
  assert.ok(penal < 60, `penalidade alta demais para a segunda da marca: ${penal}`);
});

test("sem vendedor nao ha penalidade de marca", () => {
  // A primeira palavra do titulo NAO serve como marca: em "Creatina 1kg Growth"
  // ela e o tipo do produto, e duas creatinas de fabricantes diferentes seriam
  // tratadas como a mesma loja. Sem vendedor, quem cobre o caso e a penalidade
  // de titulo parecido.
  const recentes = [{ title: "Wella Invigo Shampoo 1L", nicheIds: ["beauty"] }];
  const semVendedor = { title: "Truss Equilibrium Shampoo", currentPrice: 30, originalPrice: 60, soldCount: 900, rating: 4.7 };
  assert.equal(repetitionPenalty(semVendedor, ["beauty"], recentes), 6, "so a penalidade de nicho");
});
