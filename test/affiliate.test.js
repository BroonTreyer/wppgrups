import test from "node:test";
import assert from "node:assert/strict";
import { decorateAffiliateUrl, isAttributedLink, parseAffiliateParams } from "../src/domain/affiliate.js";

test("normaliza e valida os parametros de afiliado", () => {
  assert.equal(parseAffiliateParams("?matt_word=parceiro-demo&matt_tool=99999999"), "matt_word=parceiro-demo&matt_tool=99999999");
  assert.equal(parseAffiliateParams("   "), null);
  assert.throws(() => parseAffiliateParams("link completo do painel"), /chave=valor/);
});

test("aplica os parametros preservando a query original do produto", () => {
  const url = decorateAffiliateUrl("https://www.mercadolivre.com.br/produto/p/MLB1?searchVariation=99", "matt_word=parceiro-demo&matt_tool=99999999");
  assert.equal(url, "https://www.mercadolivre.com.br/produto/p/MLB1?searchVariation=99&matt_word=parceiro-demo&matt_tool=99999999");
});

test("reconhece os formatos de link que carregam atribuicao", () => {
  assert.equal(isAttributedLink("https://meli.la/AbC123"), true);
  assert.equal(isAttributedLink("https://www.mercadolivre.com.br/social/parceiro-demo?ref=abc"), true);
  assert.equal(isAttributedLink("https://www.mercadolivre.com.br/p/MLB1?matt_word=parceiro-demo&matt_tool=99999999"), true);
  assert.equal(isAttributedLink("https://www.mercadolivre.com.br/p/MLB1"), false);
  assert.equal(isAttributedLink("https://www.mercadolivre.com.br/p/MLB1?matt_word=parceiro-demo"), false);
  assert.equal(isAttributedLink("nao e uma url"), false);
});
