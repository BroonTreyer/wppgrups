const DEALS_URL = "https://www.mercadolivre.com.br/ofertas";
const IMAGE_BASE = "https://http2.mlstatic.com";
const MAX_HTML_BYTES = 4_000_000;

// As vitrines que a coleta conhece. O `name` nao e enfeite: ele vira
// `offer.category` e alimenta `CATEGORY_NICHE`, que e o sinal mais confiavel de
// nicho que existe. Categoria fora desta lista chega sem nome e a oferta perde
// esse sinal — em 11/09/2026 as oito novas entraram justamente por isso.
//
// ATENCAO: codigo de categoria que o Mercado Livre nao reconhece NAO da erro —
// ele devolve a vitrine geral, e a coleta acha que filtrou. Antes de acrescentar
// uma aqui, compare os ids devolvidos com os da vitrine sem filtro; se a
// sobreposicao for alta, a categoria esta sendo ignorada.
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
  { id: "MLB5726", name: "Eletrodomesticos" },
  { id: "MLB1500", name: "Construcao" },
  { id: "MLB1499", name: "Industria e comercio" },
  { id: "MLB1384", name: "Bebes" },
  { id: "MLB1071", name: "Animais" },
  { id: "MLB264586", name: "Saude" },
  { id: "MLB3937", name: "Joias e relogios" },
  { id: "MLB1039", name: "Cameras e acessorios" },
  { id: "MLB1182", name: "Instrumentos musicais" }
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

/**
 * Quem vende, e se e loja oficial da marca.
 *
 * O card sempre trouxe isso e a coleta nunca leu. O componente `seller` traz o
 * nome do vendedor num `label`, e o selo de loja oficial vem como o icone
 * `icon_cockade` (alt_text "Loja oficial") ao lado. Ou seja: da para saber que
 * um produto e da NATURA oficial sem abrir a pagina da marca — que carrega por
 * JavaScript e nao serve para raspagem.
 *
 * Serve a dois propositos: filtrar so marca oficial (catalogo confiavel, sem
 * revenda duvidosa) e dar nome a marca para o canal poder priorizar as suas.
 */
const seller = (card) => {
  const bloco = component(card, "seller")?.seller;
  if (!bloco) return { sellerName: null, officialStore: false };
  const valores = bloco.values ?? [];
  const nome = valores.find((item) => item.type === "label")?.label?.text?.trim() ?? null;
  const oficial = valores.some((item) =>
    item.type === "icon" && (item.icon?.icon_id === "icon_cockade" || /loja oficial/i.test(item.icon?.alt_text ?? ""))
  );
  return { sellerName: nome, officialStore: oficial };
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
  const { sellerName, officialStore } = seller(card);
  return {
    externalId: String(externalId),
    marketplace: "Mercado Livre",
    title,
    sellerName,
    officialStore,
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
    // Ate onde a vitrine vai depende da categoria: medido em 11/09/2026, Beleza
    // seca na pagina 15 e Casa so na 23. O teto de 15 que existia aqui cortava
    // conteudo real — Casa entrega 1.015 produtos, e 15 paginas viam metade.
    const total = Math.min(Math.max(Number(pages) || 1, 1), 40);
    const categoryName = ML_CATEGORIES.find((item) => item.id === category)?.name ?? null;
    const offers = [];
    const seen = new Set();

    // Em blocos paralelos, nao uma pagina de cada vez. Dezessete vitrines a 40
    // paginas sao ate 680 idas ao Mercado Livre; em fila indiana a rodada passava
    // de 12 minutos e a coleta virava o gargalo do dia inteiro. O bloco mantem a
    // ordem das paginas (que e a ordem de relevancia da vitrine) e continua
    // parando assim que uma pagina vem vazia.
    const BLOCO = 5;
    for (let inicio = 1; inicio <= total; inicio += BLOCO) {
      const numeros = [];
      for (let p = inicio; p < inicio + BLOCO && p <= total; p += 1) numeros.push(p);
      const paginas = await Promise.all(numeros.map(async (numero) => {
        try {
          return parseDealsPage(await this.fetchPage(numero, category));
        } catch (error) {
          // Uma pagina que falha nao pode levar junto as outras quatro do bloco.
          return error;
        }
      }));
      // ...mas se o bloco INTEIRO falhou, o problema nao e a pagina: e o
      // marketplace recusando a consulta (429, anti-bot, vitrine fora do ar).
      // Engolir isso deixaria o sistema cego justamente no dia em que o ML
      // fechar a porta — a coleta voltaria vazia como se nao houvesse oferta.
      const todasFalharam = paginas.every((item) => item instanceof Error);
      if (todasFalharam) throw paginas[0];

      let acabou = false;
      for (const [indice, found] of paginas.entries()) {
        if (found instanceof Error) continue;
        if (!found.length) { acabou = true; break; }
        for (const offer of found) {
          if (seen.has(offer.externalId)) continue;
          seen.add(offer.externalId);
          // `page` e o que permite a revalidacao procurar a oferta ONDE ELA ESTA.
          // Sem isso a revalidacao lia 2 paginas, nao achava o que veio da pagina
          // 12 e declarava "saiu da vitrine" uma oferta perfeitamente viva.
          offers.push({ ...offer, ...(categoryName ? { category: categoryName } : {}), sourceContext: { category, page: numeros[indice] } });
        }
      }
      if (acabou) break;
    }
    return offers;
  }

  async refreshMany(offers, { pages = 2 } = {}) {
    // A profundidade da revalidacao acompanha a da COLETA, categoria por categoria.
    // Ler 2 paginas para revalidar uma oferta que veio da pagina 12 nao prova que
    // ela saiu da vitrine: prova que ninguem olhou onde ela estava. Era isso que
    // matava a fila como "Oferta saiu da vitrine" — 741 de 864 itens vindos da
    // vitrine (86%), medido em 11/09/2026, com coleta em 40 paginas e revalidacao
    // em 2.
    //
    // O custo e proporcional: so vai fundo na categoria que tem oferta funda no
    // lote, e a vitrine vai ate ~12 por categoria, entao na pratica sao 12, nao 40.
    const total = Math.min(Math.max(Number(pages) || 1, 1), 40);
    const found = new Map();
    for (const category of new Set(offers.map((offer) => offer.sourceContext?.category ?? ""))) {
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
