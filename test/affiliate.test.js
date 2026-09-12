import test from "node:test";
import assert from "node:assert/strict";
import { decorateAffiliateUrl, hasAffiliateParams, isAttributedLink, parseAffiliateParams } from "../src/domain/affiliate.js";

test("normaliza e valida os parametros de afiliado", () => {
  assert.equal(parseAffiliateParams("?matt_word=parceiro-demo&matt_tool=99999999"), "matt_word=parceiro-demo&matt_tool=99999999");
  assert.equal(parseAffiliateParams("   "), null);
  assert.throws(() => parseAffiliateParams("link completo do painel"), /chave=valor/);
});

test("aplica os parametros preservando a query original do produto", () => {
  const url = decorateAffiliateUrl("https://www.mercadolivre.com.br/produto/p/MLB1?searchVariation=99", "matt_word=parceiro-demo&matt_tool=99999999");
  assert.equal(url, "https://www.mercadolivre.com.br/produto/p/MLB1?searchVariation=99&matt_word=parceiro-demo&matt_tool=99999999");
});

test("so reconhece link que realmente atribui", () => {
  // O que PAGA comissao carrega a marca do gerador do painel.
  assert.equal(isAttributedLink("https://meli.la/AbC123"), true);
  assert.equal(isAttributedLink("https://www.mercadolivre.com.br/sec/1AbC2d"), true);
  assert.equal(isAttributedLink("https://www.mercadolivre.com.br/social/parceiro-demo?ref=abc"), true);

  // O que NAO paga: parametros colados numa URL de produto. Parece link de
  // afiliado e nao e — falta o ref, assinado pelo servidor do Mercado Livre.
  // Este formato saiu em 786 publicacoes ate ser pego em 11/09/2026.
  assert.equal(isAttributedLink("https://www.mercadolivre.com.br/p/MLB1?matt_word=parceiro-demo&matt_tool=99999999"), false);
  assert.equal(isAttributedLink("https://produto.mercadolivre.com.br/MLB-1?matt_word=x&matt_tool=1"), false);
  // /social/ sem o ref tambem nao basta.
  assert.equal(isAttributedLink("https://www.mercadolivre.com.br/social/parceiro-demo?matt_word=x&matt_tool=1"), false);

  assert.equal(isAttributedLink("https://www.mercadolivre.com.br/p/MLB1"), false);
  assert.equal(isAttributedLink("https://www.mercadolivre.com.br/p/MLB1?matt_word=parceiro-demo"), false);
  assert.equal(isAttributedLink("nao e uma url"), false);
});

test("hasAffiliateParams serve a diagnostico, nunca a liberar publicacao", () => {
  const comParams = "https://produto.mercadolivre.com.br/MLB-1?matt_word=x&matt_tool=1";
  assert.equal(hasAffiliateParams(comParams), true, "carrega o codigo do afiliado");
  assert.equal(isAttributedLink(comParams), false, "mas nao atribui: nao pode publicar");
});
