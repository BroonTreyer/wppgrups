import test from "node:test";
import assert from "node:assert/strict";
import { validateOffer } from "../src/domain/offer.js";
import { SAMPLE_OFFER } from "../src/mock/sample-offer.js";

test("rejeita links inseguros e avaliacao fora da faixa", () => {
  assert.throws(() => validateOffer({ ...SAMPLE_OFFER, affiliateUrl: "javascript:alert(1)" }), /http ou https/);
  assert.throws(() => validateOffer({ ...SAMPLE_OFFER, rating: 6 }), /entre 0 e 5/);
});
