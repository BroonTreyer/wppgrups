import test from "node:test";
import assert from "node:assert/strict";
import { ProductLinkService } from "../src/services/product-link-service.js";

test("importa link curto da Amazon preservando o link afiliado", async () => {
  const service = new ProductLinkService({ fetchImpl: async () => ({
    ok: true, status: 200,
    url: "https://www.amazon.com.br/Produto/dp/B07XPC1ZNT?tag=parceiro-20",
    text: async () => '<span id="productTitle">Produto de teste</span><img id="landingImage" data-old-hires="https://images.example/produto.jpg">'
  }) });
  const result = await service.preview({ url: "https://amzn.to/abc123" });
  assert.equal(result.externalId, "B07XPC1ZNT");
  assert.equal(result.marketplace, "Amazon");
  assert.equal(result.title, "Produto de teste");
  assert.equal(result.affiliateUrl, "https://amzn.to/abc123");
});

test("bloqueia dominios externos antes de consultar", async () => {
  let called = false;
  const service = new ProductLinkService({ fetchImpl: async () => { called = true; } });
  await assert.rejects(() => service.preview({ url: "https://example.com/produto" }), /Amazon ou do Mercado Livre/);
  assert.equal(called, false);
});
