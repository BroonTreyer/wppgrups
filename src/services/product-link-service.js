import { createHash } from "node:crypto";

const MARKETPLACES = {
  "meli.la": "Mercado Livre",
  "mercadolivre.com.br": "Mercado Livre",
  "www.mercadolivre.com.br": "Mercado Livre",
  "produto.mercadolivre.com.br": "Mercado Livre",
  "amzn.to": "Amazon",
  "amazon.com.br": "Amazon",
  "www.amazon.com.br": "Amazon"
};

const entities = (value = "") => value
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
  .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const attribute = (html, marker, name) => {
  const tag = html.match(new RegExp(`<[^>]+${marker}[^>]*>`, "i"))?.[0];
  return tag?.match(new RegExp(`${name}=["']([^"']+)`, "i"))?.[1] ?? null;
};

const meta = (html, name) => [
  new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)`, "i"),
  new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name}["']`, "i")
].map((pattern) => html.match(pattern)?.[1]).find(Boolean) ?? null;

const amazonTitle = (html) => html.match(/<[^>]+id=["']productTitle["'][^>]*>([\s\S]*?)<\//i)?.[1] ?? null;
const amazonImage = (html) => attribute(html, `id=["']landingImage["']`, "data-old-hires")
  || attribute(html, `id=["']landingImage["']`, "src");

export class ProductLinkService {
  constructor({ fetchImpl = fetch } = {}) { this.fetch = fetchImpl; }

  async preview(input) {
    let source;
    try { source = new URL(String(input?.url ?? "")); } catch { throw new Error("Informe um link valido de produto"); }
    if (source.protocol !== "https:" || !MARKETPLACES[source.hostname]) throw new Error("Use um link da Amazon ou do Mercado Livre");
    const response = await this.fetch(source, {
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (compatible; OfertaFlow/1.0)", "accept-language": "pt-BR,pt;q=0.9" },
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) throw new Error(`Nao foi possivel consultar o produto (${response.status})`);
    const finalUrl = new URL(response.url);
    if (!MARKETPLACES[finalUrl.hostname]) throw new Error("O link redirecionou para um site nao permitido");
    const html = await response.text();
    if (html.length > 3_000_000) throw new Error("Pagina do produto excedeu o limite permitido");
    const marketplace = MARKETPLACES[finalUrl.hostname];
    const title = entities(meta(html, "og:title") || (marketplace === "Amazon" ? amazonTitle(html) : ""));
    const imageUrl = entities(meta(html, "og:image") || (marketplace === "Amazon" ? amazonImage(html) : ""));
    const asin = finalUrl.pathname.match(/\/dp\/([A-Z0-9]{10})/i)?.[1];
    const externalId = asin || createHash("sha256").update(finalUrl.origin + finalUrl.pathname).digest("hex").slice(0, 24);
    return {
      externalId,
      marketplace,
      title,
      affiliateUrl: source.toString(),
      resolvedUrl: finalUrl.toString(),
      imageUrl,
      requiresReview: true
    };
  }
}
