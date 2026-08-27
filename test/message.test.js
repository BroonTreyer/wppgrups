import test from "node:test";
import assert from "node:assert/strict";
import { formatOfferCaption } from "../src/domain/message.js";
import { SAMPLE_OFFER } from "../src/mock/sample-offer.js";

test("legenda inclui preco, link e aviso de afiliado", () => {
  const caption = formatOfferCaption(SAMPLE_OFFER, new Date("2026-08-27T17:32:00Z"));
  assert.match(caption, /R\$\s2\.199,00/);
  assert.match(caption, /https:\/\/example\.com\/oferta/);
  assert.match(caption, /receber comissao/);
});
