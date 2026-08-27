import test from "node:test";
import assert from "node:assert/strict";
import { inferNiches } from "../src/domain/niches.js";

test("classifica uma TV em eletronicos e ofertas gerais", () => {
  assert.deepEqual(inferNiches({ title: "Smart TV 4K", category: "TV" }), ["electronics", "general"]);
});

test("sempre inclui ofertas gerais", () => {
  assert.deepEqual(inferNiches({ title: "Produto desconhecido" }), ["general"]);
});
