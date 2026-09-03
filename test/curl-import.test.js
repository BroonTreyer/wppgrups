import test from "node:test";
import assert from "node:assert/strict";
import { buildConfig, parseCurl } from "../src/infra/curl-import.js";

const PRODUCT = "https://www.mercadolivre.com.br/fritadeira/p/MLB51032488";

test("le um curl copiado do Chrome com aspas simples", () => {
  const command = `curl 'https://www.mercadolivre.com.br/affiliates/api/links' \\
  -H 'content-type: application/json' \\
  -H 'cookie: ssid=abc; orgnickp=parceiro-demo' \\
  --data-raw '{"urls":["${PRODUCT}"],"tag":"whatsapp"}' \\
  --compressed`;
  const request = parseCurl(command);
  assert.equal(request.url, "https://www.mercadolivre.com.br/affiliates/api/links");
  assert.equal(request.method, "POST");
  assert.equal(request.headers.cookie, "ssid=abc; orgnickp=parceiro-demo");

  const config = buildConfig(request, PRODUCT);
  assert.deepEqual(config.body, { urls: ["{{url}}"], tag: "whatsapp" });
  assert.equal(config.headers["content-type"], "application/json");
});

test("le curl com aspas duplas e a url do produto na query", () => {
  const command = `curl "https://www.mercadolivre.com.br/affiliates/api/link?url=${encodeURIComponent(PRODUCT)}" -H "cookie: ssid=abc"`;
  const config = buildConfig(parseCurl(command), PRODUCT);
  assert.equal(config.method, "GET");
  assert.equal(config.url, "https://www.mercadolivre.com.br/affiliates/api/link?url={{url}}");
});

test("recusa request sem cookie ou sem a url do produto", () => {
  assert.throws(
    () => buildConfig(parseCurl(`curl 'https://x.com/api' -H 'cookie: a=b' --data-raw '{"urls":["outra"]}'`), PRODUCT),
    /URL do produto nao apareceu/
  );
  assert.throws(
    () => buildConfig(parseCurl(`curl 'https://x.com/api' --data-raw '{"urls":["${PRODUCT}"]}'`), PRODUCT),
    /cookie de sessao/
  );
});

test("remove cabecalhos que nao devem ser repetidos", () => {
  const command = `curl 'https://x.com/api?u=${encodeURIComponent(PRODUCT)}' -H 'cookie: a=b' -H 'content-length: 42' -H 'host: x.com'`;
  const config = buildConfig(parseCurl(command), PRODUCT);
  assert.deepEqual(Object.keys(config.headers), ["cookie"]);
});
