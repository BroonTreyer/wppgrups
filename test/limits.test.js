import test from "node:test";
import assert from "node:assert/strict";
import { MAX_DAILY_POSTS, dailyCap, postsPerHour, semTeto } from "../src/domain/limits.js";

test("teto ausente vale como infinito, nao como zero", () => {
  // Este e o ponto inteiro do modulo. Em JS `10 >= null` e VERDADEIRO, porque
  // null vira 0 na comparacao: quem lesse o campo cru bloquearia toda publicacao
  // de um destino sem teto, sem erro nenhum na tela.
  assert.equal(dailyCap({ maxDailyPosts: null }), Number.POSITIVE_INFINITY);
  assert.equal(dailyCap({ maxDailyPosts: undefined }), Number.POSITIVE_INFINITY);
  assert.equal(dailyCap({}), Number.POSITIVE_INFINITY);
  assert.equal(dailyCap(undefined), Number.POSITIVE_INFINITY);
  // Campo de formulario vazio chega como string vazia, e `Number("")` e 0 —
  // outro jeito silencioso de zerar o teto de quem nao pediu teto nenhum.
  assert.equal(dailyCap({ maxDailyPosts: "" }), Number.POSITIVE_INFINITY);
});

test("teto definido e respeitado, inclusive vindo como texto", () => {
  assert.equal(dailyCap({ maxDailyPosts: 1000 }), 1000);
  assert.equal(dailyCap({ maxDailyPosts: "250" }), 250);
  // Zero e um teto de verdade: significa "nao publique", e nao "sem limite".
  assert.equal(dailyCap({ maxDailyPosts: 0 }), 0);
});

test("a comparacao que antes bloqueava tudo agora libera", () => {
  const semLimite = { maxDailyPosts: null };
  assert.equal(5000 >= semLimite.maxDailyPosts, true, "o campo cru bloqueia");
  assert.equal(5000 >= dailyCap(semLimite), false, "o tradutor libera");
});

test("a conta que antes zerava o espaco da ingestao agora nao zera", () => {
  const semLimite = { maxDailyPosts: null };
  // `null - 800` da -800; com Math.max(0, ...) o espaco vira 0 e a colheita para.
  assert.equal(Math.max(0, semLimite.maxDailyPosts - 800), 0, "o campo cru estrangula");
  assert.equal(dailyCap(semLimite) - 800, Number.POSITIVE_INFINITY);
});

test("semTeto separa quem exibe de quem calcula", () => {
  assert.equal(semTeto({ maxDailyPosts: null }), true);
  assert.equal(semTeto({ maxDailyPosts: 1000 }), false);
  assert.equal(semTeto({ maxDailyPosts: 0 }), false);
});

test("a vazao por hora multiplica pela rajada", () => {
  // 25 mensagens a cada 10 min sao 150/h, nao 6/h. A conta antiga media o
  // espacamento das janelas e ignorava quantas mensagens saem em cada uma.
  assert.equal(postsPerHour({ minMinutesBetweenPosts: 10, burstSize: 25 }), 150);
  assert.equal(postsPerHour({ minMinutesBetweenPosts: 10 }), 6);
  assert.equal(postsPerHour({ minMinutesBetweenPosts: 12, burstSize: 1 }), 5);
});

test("vazao sem configuracao nao vira zero nem divisao por zero", () => {
  assert.equal(postsPerHour({}), 60);
  assert.equal(postsPerHour({ minMinutesBetweenPosts: 0, burstSize: 0 }), 60);
  assert.equal(postsPerHour(undefined), 60);
});

test("o teto do campo e guarda de digitacao, nao politica", () => {
  // Se este numero virar politica de operacao de novo, quem quer operar sem
  // limite volta a empurra-lo para cima em vez de usar null — foi assim que ele
  // saiu de 500 para 1000 e que os dois caminhos de escrita se desencontraram.
  assert.equal(Number.isInteger(MAX_DAILY_POSTS), true);
  assert.ok(MAX_DAILY_POSTS > 1000);
});
