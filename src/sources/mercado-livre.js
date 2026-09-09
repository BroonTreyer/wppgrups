const DEALS_URL = "https://www.mercadolivre.com.br/ofertas";
const IMAGE_BASE = "https://http2.mlstatic.com";
const MAX_HTML_BYTES = 4_000_000;

export const ML_CATEGORIES = [
  { id: "", name: "Todas as ofertas" },
  { id: "MLB1051", name: "Celulares e telefones" },
  { id: "MLB1648", name: "Informatica" },
  { id: "MLB1000", name: "Eletronicos, audio e video" },
  { id: "MLB1574", name: "Casa, moveis e decoracao" },
  { id: "MLB1246", name: "Beleza e cuidado pessoal" },
  { id: "MLB1430", name: "Calcados, roupas e bolsas" },
  { id: "MLB1132", name: "Brinquedos e hobbies" },
  { id: "MLB1276", name: "Esportes e fitness" },
  { id: "MLB5726", name: "Eletrodomesticos" }
];

const balancedObject = (text, open) => {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === "{") depth += 1;
    else if (char === "}") { depth -= 1; if (!depth) return text.slice(open, index + 1); }
  }
  return null;
};

const component = (card, type) => card.components?.find((item) => item.type === type) ?? null;

const previousPrice = (price) => {
  for (const label of price?.price_labels ?? []) {
    for (const value of label.values ?? []) {
      if (value.price?.previous && Number.isFinite(Number(value.price.value))) return Number(value.price.value);
    }
  }
  return null;
};

const shippingText = (card) => {
  const entries = component(card, "shipping_v2")?.shipping_v2 ?? [];
  const labels = entries.flatMap((entry) => (entry?.values ?? []).map((value) => value.label?.text ?? value.icon?.alt_text)).filter(Boolean);
  return labels.length ? labels.join(" ") : null;
};

const SOLD_UNITS = { mil: 1000, k: 1000, m: 1000000, mi: 1000000 };

export function parseSoldLabel(label) {
  const match = String(label ?? "").toLowerCase().replace(/\./g, "").match(/\+?\s*([\d,]+)\s*(mil|mi|m|k)?/);
  if (!match) return null;
  const base = Number(match[1].replace(",", "."));
  if (!Number.isFinite(base) || base <= 0) return null;
  return Math.round(base * (SOLD_UNITS[match[2]] ?? 1));
}

const review = (card) => {
  const values = component(card, "review_compacted")?.review_compacted?.values ?? [];
  const rating = Number(values.find((value) => value.key === "label")?.label?.text);
  const sold = values.find((value) => value.key === "label2")?.label?.text?.replace(/^\|\s*/, "") ?? null;
  return { rating: Number.isFinite(rating) && rating > 0 && rating <= 5 ? rating : null, soldLabel: sold, soldCount: parseSoldLabel(sold) };
};

const widgets = (card) => card.widget_components ?? [];

const expiresAt = (card) => {
  for (const widget of widgets(card)) {
    const end = widget.poly_label_component?.countdown?.period_end;
    if (!end) continue;
    const parsed = new Date(end);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
};

const highlight = (card) => {
  for (const widget of widgets(card)) {
    for (const label of widget.poly_label_component?.labels ?? []) {
      const text = String(label.text ?? "").replace(/{[^}]*}/g, "").trim();
      if (text) return text;
    }
  }
  return null;
};

const productUrl = (metadata) => {
  const path = String(metadata?.url ?? "").replace(/^https?:\/\//, "");
  if (!/^(www|produto)\.mercadolivre\.com\.br\//.test(path)) return null;
  const url = new URL(`https://${path}`);
  const variation = new URLSearchParams(String(metadata.url_params ?? "").replace(/^\?/, "")).get("searchVariation");
  if (variation) url.searchParams.set("searchVariation", variation);
  return url.toString();
};

/**
 * Imagem do produto, QUADRADA.
 *
 * O prefixo do mlstatic define o enquadramento: `D_NQ_NP_` devolve a proporcao
 * original (a do exemplo veio 837x1000, retrato) e `D_Q_NP_` devolve quadrada,
 * completando as bordas. Importa porque o WhatsApp ajusta a imagem pela LARGURA
 * da conversa: uma retrato de 837x1000 ocupa 1,19x a largura em altura, uma
 * quadrada ocupa 1x. Trocar a resolucao nao mudaria nada — o que manda e a
 * proporcao. `2X` mantem 1000px de lado, nitido em tela de celular.
 */
const imageUrl = (card) => {
  const pictureId = card.pictures?.pictures?.[0]?.id;
  return pictureId ? `${IMAGE_BASE}/D_Q_NP_2X_${encodeURIComponent(pictureId)}-O.jpg` : null;
};

export function normalizeCard(card) {
  const externalId = card?.metadata?.id;
  const title = component(card, "title")?.title?.text?.trim();
  const price = component(card, "price")?.price;
  const currentPrice = Number(price?.current_price?.value);
  const affiliateUrl = productUrl(card?.metadata);
  const image = imageUrl(card);
  if (!externalId || !title || !affiliateUrl || !image || !Number.isFinite(currentPrice) || currentPrice <= 0) return null;
  const original = previousPrice(price);
  const { rating, soldLabel, soldCount } = review(card);
  return {
    externalId: String(externalId),
    marketplace: "Mercado Livre",
    title,
    currentPrice,
    originalPrice: original && original > currentPrice ? original : null,
    paymentMethod: price?.unit_description?.text ?? null,
    rating,
    soldLabel,
    soldCount,
    shipping: shippingText(card),
    affiliateUrl,
    imageUrl: image,
    expiresAt: expiresAt(card),
    highlight: highlight(card),
    sourceId: "mercado-livre"
  };
}

export function parseDealsPage(html) {
  const offers = [];
  const seen = new Set();
  let cursor = 0;
  while (cursor >= 0) {
    const marker = html.indexOf('"type":"ORGANIC_ITEM"', cursor);
    if (marker < 0) break;
    cursor = marker + 1;
    const key = html.indexOf('"card":', marker);
    if (key < 0) break;
    const raw = balancedObject(html, html.indexOf("{", key));
    if (!raw) continue;
    let card;
    try { card = JSON.parse(raw); } catch { continue; }
    const offer = normalizeCard(card);
    if (offer && !seen.has(offer.externalId)) { seen.add(offer.externalId); offers.push(offer); }
  }
  return offers;
}

export class MercadoLivreSource {
  static id = "mercado-livre";
  static label = "Mercado Livre - Ofertas do dia";
  static marketplace = "Mercado Livre";
  static defaults = { pages: 2, category: "" };

  constructor({ fetchImpl = fetch } = {}) { this.fetch = fetchImpl; }

  get id() { return MercadoLivreSource.id; }

  async collect({ pages = 2, category = "" } = {}) {
    // A vitrine vai ate a pagina ~12 por categoria (medido em 09/09: a 11 ainda traz
    // 43 ineditos, a 15 ja repete). O teto de 10 cortava conteudo real.
    const total = Math.min(Math.max(Number(pages) || 1, 1), 15);
    const categoryName = ML_CATEGORIES.find((item) => item.id === category)?.name ?? null;
    const offers = [];
    const seen = new Set();
    for (let page = 1; page <= total; page += 1) {
      const found = parseDealsPage(await this.fetchPage(page, category));
      if (!found.length) break;
      for (const offer of found) {
        if (seen.has(offer.externalId)) continue;
        seen.add(offer.externalId);
        offers.push({ ...offer, ...(categoryName ? { category: categoryName } : {}), sourceContext: { category } });
      }
    }
    return offers;
  }

  async refreshMany(offers, { pages = 2 } = {}) {
    const categories = [...new Set(offers.map((offer) => offer.sourceContext?.category ?? ""))];
    // A vitrine vai ate a pagina ~12 por categoria (medido em 09/09: a 11 ainda traz
    // 43 ineditos, a 15 ja repete). O teto de 10 cortava conteudo real.
    const total = Math.min(Math.max(Number(pages) || 1, 1), 15);
    const found = new Map();
    for (const category of categories) {
      for (let page = 1; page <= total; page += 1) {
        for (const item of parseDealsPage(await this.fetchPage(page, category))) found.set(item.externalId, item);
      }
    }
    return new Map(offers.map((offer) => [offer.externalId, found.get(offer.externalId) ?? null]));
  }

  async fetchPage(page, category) {
    const url = new URL(DEALS_URL);
    if (page > 1) url.searchParams.set("page", String(page));
    if (category) url.searchParams.set("category", category);
    const response = await this.fetch(url, {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "accept-language": "pt-BR,pt;q=0.9"
      },
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`Mercado Livre respondeu ${response.status} ao listar ofertas`);
    const html = await response.text();
    if (html.length > MAX_HTML_BYTES) throw new Error("Pagina de ofertas excedeu o limite permitido");
    return html;
  }
}
