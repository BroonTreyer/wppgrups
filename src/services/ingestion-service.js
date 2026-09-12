import { discountPercentage, minutesUntilExpiry, productKey, validateOffer } from "../domain/offer.js";
import { inferNiches } from "../domain/niches.js";
import { isRisky, scoreOffer } from "../domain/scoring.js";
import { SessionExpiredError } from "./affiliate-link-service.js";

const DEFAULT_FILTERS = { enabled: false, minDiscount: 20, maxDiscount: 90, minRating: 4.3, minSold: 500, minPrice: 0, maxPrice: 400, sweetSpotMin: 25, sweetSpotMax: 200, maxPerRun: 8, maxPerNiche: 2, categoriesPerRun: 1, blockedKeywords: [], categories: [] };
// Os tetos de `maxPerRun` e `maxPerNiche` eram 50: suficiente para um destino,
// apertado para uma frota. Com sete canais consumindo ofertas proprias, 50 por
// rodada e menos do que a frota gasta entre duas coletas.
const INTEGER_FIELDS = [["minDiscount", 0, 100], ["maxDiscount", 0, 100], ["minSold", 0, 1000000], ["sweetSpotMin", 0, 100000], ["sweetSpotMax", 1, 100000], ["maxPerRun", 1, 300], ["maxPerNiche", 1, 300], ["pages", 1, 40], ["categoriesPerRun", 1, 30]];
const NUMBER_FIELDS = [["minRating", 0, 5], ["minPrice", 0, 1000000], ["maxPrice", 0, 1000000]];
const CATEGORY_PATTERN = /^[A-Z0-9]{1,12}$/;
const MAX_MEMORY = 20000;
const MAX_ALERTS = 50;
const normalize = (text) => String(text ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
// Ja classificada (por IA ou cache), a oferta traz os nichos consigo; sem isso, a regra decide.
const mainNiche = (offer) => (offer.nicheIds?.length ? offer.nicheIds : inferNiches(offer)).find((niche) => niche !== "general") ?? "general";

export class IngestionService {
  constructor({ store, queueService, affiliateLinkService, sources = [], config, classifier = null, clock = () => new Date() }) {
    this.store = store;
    this.queueService = queueService;
    this.affiliateLinkService = affiliateLinkService;
    this.sources = new Map(sources.map((source) => [source.id, source]));
    this.classifier = classifier;
    this.config = config;
    this.clock = clock;
    this.running = false;
  }

  descriptors() {
    return [...this.sources.values()].map((source) => ({
      id: source.id,
      label: source.constructor.label ?? source.id,
      marketplace: source.constructor.marketplace ?? source.id,
      defaults: source.constructor.defaults ?? {}
    }));
  }

  async list() {
    return this.store.update((state) => {
      for (const descriptor of this.descriptors()) {
        const existing = state.sources.find((item) => item.id === descriptor.id);
        if (existing) {
          Object.assign(existing, { label: descriptor.label, marketplace: descriptor.marketplace });
          if (!Array.isArray(existing.categories)) existing.categories = existing.category ? [existing.category] : [];
          for (const [field, value] of Object.entries(DEFAULT_FILTERS)) {
            if (existing[field] === undefined) existing[field] = value;
          }
        } else {
          state.sources.push({ id: descriptor.id, label: descriptor.label, marketplace: descriptor.marketplace, ...DEFAULT_FILTERS, ...descriptor.defaults, cursor: 0 });
        }
      }
      return state.sources.map((item) => ({ ...item }));
    });
  }

  async configure(id, patch) {
    await this.list();
    return this.store.update((state) => {
      const source = state.sources.find((item) => item.id === id);
      if (!source) throw new Error("Fonte de ofertas nao encontrada");
      if (patch.enabled !== undefined) {
        if (typeof patch.enabled !== "boolean") throw new Error("enabled deve ser booleano");
        source.enabled = patch.enabled;
      }
      for (const [field, min, max] of INTEGER_FIELDS) {
        if (patch[field] === undefined) continue;
        const value = Number(patch[field]);
        if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${field} deve ser um inteiro entre ${min} e ${max}`);
        source[field] = value;
      }
      for (const [field, min, max] of NUMBER_FIELDS) {
        if (patch[field] === undefined) continue;
        const value = Number(patch[field]);
        if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${field} deve ser um numero entre ${min} e ${max}`);
        source[field] = value;
      }
      if (patch.categories !== undefined) {
        const list = Array.isArray(patch.categories) ? patch.categories : String(patch.categories).split(",");
        const cleaned = [...new Set(list.map((item) => String(item).trim()).filter(Boolean))];
        if (cleaned.some((item) => !CATEGORY_PATTERN.test(item))) throw new Error("categories deve conter identificadores validos do marketplace");
        source.categories = cleaned.slice(0, 30);
        source.cursor = 0;
      }
      if (patch.blockedKeywords !== undefined) {
        const list = Array.isArray(patch.blockedKeywords) ? patch.blockedKeywords : String(patch.blockedKeywords).split(",");
        source.blockedKeywords = [...new Set(list.map((item) => String(item).trim()).filter(Boolean))].slice(0, 50);
      }
      if (source.maxPrice && source.minPrice && source.maxPrice < source.minPrice) throw new Error("maxPrice deve ser maior que minPrice");
      return source;
    });
  }

  rejectionReason(offer, settings) {
    const discount = discountPercentage(offer);
    if (discount < (settings.minDiscount ?? 0)) return "desconto abaixo do minimo";
    if (settings.maxDiscount && discount > settings.maxDiscount) return "desconto alto demais para ser real";
    // Piso de vendas POR NICHO, com o da fonte como padrao. Existe porque o piso
    // unico de 150 descartava a colheita inteira das lojas de marca de beleza —
    // 1.200 produtos lidos, 0 enfileirados em 11/09/2026: produto de loja oficial
    // raramente exibe "+150 vendidos" no card. Baixar o piso da fonte resolveria
    // beleza e entupiria a fila dos outros grupos com item que eles nunca
    // publicariam, porque o filtro de vendas do DESTINO so age na hora de
    // publicar — tarde demais, a vaga na fila ja foi ocupada.
    const pisoDeVendas = settings.minSoldByNiche?.[mainNiche(offer)] ?? settings.minSold;
    if (pisoDeVendas && (offer.soldCount ?? 0) < pisoDeVendas) return "pouca gente comprou esse produto";
    if (isRisky(offer, settings.blockedKeywords ?? [])) return "categoria sensivel";
    // Preco que so vale com cupom nao vai para o canal. Esconder a condicao e
    // anunciar um preco que a pagina desmente; anunciar a condicao e mandar o
    // leitor cacar um cupom que pode nao existir mais. Mesma regra do frete.
    if (/cupom/i.test(offer.paymentMethod ?? "")) return "preco depende de cupom";
    if (settings.minRating && (offer.rating ?? 0) < settings.minRating) return "avaliacao abaixo do minimo";
    if (settings.minPrice && offer.currentPrice < settings.minPrice) return "preco abaixo da faixa";
    if (settings.maxPrice && offer.currentPrice > settings.maxPrice) return "preco acima da faixa";
    const haystack = normalize(offer.title);
    if ((settings.blockedKeywords ?? []).some((keyword) => haystack.includes(normalize(keyword)))) return "palavra bloqueada";
    const restam = minutesUntilExpiry(offer, this.clock());
    if (restam !== null && restam < this.config.freshness.minValidityMinutes) return "promocao perto de acabar";
    return null;
  }

  async alert(type, message) {
    await this.store.update((state) => {
      const kept = (state.alerts ?? []).filter((item) => item.type !== type || item.message !== message);
      state.alerts = [...kept, { type, message, at: this.clock().toISOString() }].slice(-MAX_ALERTS);
    });
  }

  async alerts() {
    return ((await this.store.read()).alerts ?? []).toSorted((a, b) => b.at.localeCompare(a.at)).slice(0, 20);
  }

  nextCategory(settings) {
    const categories = settings.categories ?? [];
    if (!categories.length) return "";
    return categories[(settings.cursor ?? 0) % categories.length];
  }

  /**
   * As categorias desta rodada, a partir do cursor.
   *
   * Varrer uma categoria por vez amarra o volume do dia ao rodizio: com nove
   * categorias e uma rodada a cada 30 min, cada vitrine so era visitada cinco
   * vezes por dia, e a fila enchia de um nicho so — que e o que o destino
   * daquele nicho conseguia consumir. Varrendo varias de uma vez, a selecao
   * escolhe as melhores de TODO o espectro e cada destino encontra a sua.
   */
  categoriesForRun(settings) {
    const categories = settings.categories ?? [];
    if (!categories.length) return [""];
    const quantas = Math.min(Math.max(Number(settings.categoriesPerRun) || 1, 1), categories.length);
    const inicio = (settings.cursor ?? 0) % categories.length;
    return Array.from({ length: quantas }, (_, passo) => categories[(inicio + passo) % categories.length]);
  }

  async run({ sourceId } = {}) {
    if (this.running) return { started: false, reason: "busy" };
    this.running = true;
    try {
      const configured = await this.list();
      const targets = configured.filter((item) => (sourceId ? item.id === sourceId : item.enabled) && this.sources.has(item.id));
      if (!targets.length) return { started: true, runs: [] };
      const runs = [];
      for (const settings of targets) runs.push(await this.runSource(settings));
      return { started: true, runs };
    } finally {
      this.running = false;
    }
  }

  async queueRoom() {
    const state = await this.store.read();
    const queued = state.queue.filter((item) => item.status === "queued").length;
    const actives = state.destinations.filter((destination) => destination.active);
    if (!actives.length) return { queued, capacity: 0, room: Number.POSITIVE_INFINITY };
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(this.clock());
    const sentToday = state.publications.filter((item) => item.status === "sent" && new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date(item.createdAt)) === day);
    const dailyRoom = actives.reduce((total, destination) => total + Math.max(0, destination.maxDailyPosts - sentToday.filter((item) => (item.destinationId ?? item.groupId) === destination.id).length), 0);
    // Vazao da FROTA, nao de um destino. O calculo antigo usava so o canal mais
    // rapido — fazia sentido quando uma oferta ia para todos os destinos de uma
    // vez, porque uma oferta ocupava um slot de todo mundo. Com a regra de "uma
    // oferta, um destino", cada canal consome ofertas proprias: seis canais a 12
    // min pedem 30 ofertas por hora, e o horizonte de um so canal segurava a fila
    // em 10. A coleta varria 384 produtos e aprovava 1.
    const porHora = actives.reduce(
      (total, destination) => total + 60 / Math.max(1, destination.minMinutesBetweenPosts || 1), 0
    );
    const horizon = Math.ceil(porHora * this.config.freshness.queueHorizonHours);
    const capacity = Math.max(1, Math.min(horizon, dailyRoom));
    return { queued, capacity, room: Math.max(0, capacity - queued) };
  }

  async runSource(settings) {
    const startedAt = this.clock();
    const categorias = this.categoriesForRun(settings);
    const stats = { sourceId: settings.id, category: categorias.join(","), categories: categorias, collected: 0, rejected: 0, duplicated: 0, enqueued: 0, errors: [] };
    try {
      const { queued, capacity, room } = await this.queueRoom();
      if (capacity > 0 && room <= 0) {
        stats.skipped = `fila ja tem ${queued} ofertas para as proximas ${this.config.freshness.queueHorizonHours}h (alvo ${capacity})`;
        return this.finish(settings, startedAt, stats);
      }
      const limit = capacity > 0 ? Math.min(settings.maxPerRun ?? 8, room) : (settings.maxPerRun ?? 8);
      const source = this.sources.get(settings.id);
      const vistos = new Set();
      const collected = [];
      for (const category of categorias) {
        try {
          for (const offer of await source.collect({ pages: settings.pages, category })) {
            // O mesmo produto aparece em mais de uma vitrine (uma escova de
            // cabelo esta em Beleza e em Eletrodomesticos). Deduplicar aqui
            // evita pagar a IA duas vezes pelo mesmo titulo na mesma rodada.
            if (vistos.has(offer.externalId)) continue;
            vistos.add(offer.externalId);
            collected.push(offer);
          }
        } catch (error) {
          // Uma vitrine fora do ar nao pode derrubar a rodada inteira.
          if (stats.errors.length < 3) stats.errors.push(`${category || "todas"}: ${error.message}`);
        }
      }
      stats.collected = collected.length;
      if (!collected.length) await this.alert("source-empty", `${settings.label} nao devolveu nenhuma oferta. Verifique se o marketplace mudou a pagina.`);
      for (const offer of await this.select(collected, { ...settings, maxPerRun: limit }, stats)) {
        try {
          const link = await this.affiliateLinkService.linkFor(offer);
          const resultado = await this.queueService.enqueue({ ...offer, affiliateUrl: link.url, affiliateTagged: link.attributed, awaitingLink: Boolean(link.pending) });
          // Recusada na porta da fila: conta como filtrada, nao como enfileirada.
          // E memoriza mesmo assim, para nao voltar da vitrine a cada rodada.
          if (resultado?.skipped) {
            stats.rejected += 1;
            stats.noDestination = (stats.noDestination ?? 0) + 1;
            await this.remember(offer);
            continue;
          }
          if (link.pending) stats.awaitingLink = (stats.awaitingLink ?? 0) + 1;
          await this.remember(offer);
          stats.enqueued += 1;
        } catch (error) {
          if (error instanceof SessionExpiredError) {
            await this.alert("affiliate-session", "Sessao do painel de afiliados expirada. Atualize o cookie para voltar a publicar.");
            stats.errors.push(error.message);
            break;
          }
          stats.rejected += 1;
          if (stats.errors.length < 3) stats.errors.push(error.message);
        }
      }
    } catch (error) {
      stats.errors.push(error.message);
      await this.alert("source-error", `${settings.label}: ${error.message}`);
    }
    return this.finish(settings, startedAt, stats);
  }

  async finish(settings, startedAt, stats) {
    await this.store.update((state) => {
      const source = state.sources.find((item) => item.id === settings.id);
      if (source) {
        source.lastRunAt = startedAt.toISOString();
        source.lastRunStats = stats;
        // Avanca pelo que ESTA rodada varreu, senao a proxima repete o que
        // acabou de sair da vitrine e o rodizio nunca fecha a volta.
        const passo = Math.max(1, stats.categories?.length ?? 1);
        source.cursor = ((source.cursor ?? 0) + passo) % Math.max(1, (source.categories ?? []).length);
      }
    });
    return stats;
  }

  /**
   * Recebe produtos colhidos pela extensao no navegador do dono.
   *
   * O caminho normal le a vitrine `/ofertas` pelo servidor. Ele nao alcanca as
   * paginas de loja oficial das marcas, que montam a lista por JavaScript, nem
   * a busca, que responde com anti-bot a quem nao e navegador. A extensao ve as
   * duas, porque e um Chrome de verdade e ja logado.
   *
   * O que chega aqui e MATERIA-PRIMA, nao oferta pronta: passa pelos mesmos
   * filtros, pela mesma IA e pelas mesmas regras de destino da vitrine. A unica
   * diferenca e de onde veio — e quem manda continua sendo este servico.
   */
  async harvest({ produtos = [], origem = "extensao", sourceId = "mercado-livre" } = {}) {
    if (!Array.isArray(produtos) || !produtos.length) return { recebidos: 0, enqueued: 0, rejected: 0 };
    const configuradas = await this.list();
    // A fonte da colheita e a mesma da vitrine: e dela que vem o marketplace, os
    // filtros de preco e desconto e o teto por rodada. Se ela nao existe, nao ha
    // regra para aplicar, e enfileirar sem regra e pior do que nao enfileirar.
    const settings = configuradas.find((item) => item.id === sourceId) ?? configuradas[0];
    if (!settings) throw new Error(`Fonte ${sourceId} nao configurada`);

    const stats = { sourceId: settings.id, origem, collected: produtos.length, rejected: 0, duplicated: 0, enqueued: 0, errors: [] };
    const { capacity, room } = await this.queueRoom();
    const limite = capacity > 0 ? Math.max(0, room) : (settings.maxPerRun ?? 8);
    if (!limite) return { ...stats, skipped: "fila cheia" };

    const candidatos = produtos.map((item) => ({
      externalId: String(item.externalId ?? "").trim(),
      marketplace: settings.marketplace ?? "Mercado Livre",
      title: String(item.title ?? "").trim(),
      currentPrice: Number(item.currentPrice),
      originalPrice: Number(item.originalPrice) || null,
      imageUrl: item.imageUrl ?? null,
      affiliateUrl: item.productUrl ?? null,
      rating: Number(item.rating) || null,
      soldCount: Number(item.soldCount) || null,
      soldLabel: item.soldLabel ?? null,
      sellerName: item.sellerName ?? null,
      officialStore: Boolean(item.officialStore),
      category: item.category ?? null,
      sourceId: settings.id,
      sourceContext: { origem, url: item.pageUrl ?? null }
    }));

    for (const offer of await this.select(candidatos, { ...settings, maxPerRun: limite }, stats)) {
      try {
        const link = await this.affiliateLinkService.linkFor(offer);
        const resultado = await this.queueService.enqueue({
          ...offer, affiliateUrl: link.url, affiliateTagged: link.attributed, awaitingLink: Boolean(link.pending)
        });
        if (resultado?.skipped) {
          stats.rejected += 1;
          stats.noDestination = (stats.noDestination ?? 0) + 1;
          await this.remember(offer);
          continue;
        }
        if (link.pending) stats.awaitingLink = (stats.awaitingLink ?? 0) + 1;
        await this.remember(offer);
        stats.enqueued += 1;
      } catch (error) {
        stats.rejected += 1;
        if (stats.errors.length < 3) stats.errors.push(error.message);
      }
    }
    return stats;
  }

  async select(collected, settings, stats) {
    const memory = await this.recentProducts();
    const candidates = [];
    for (const candidate of collected) {
      let offer;
      try {
        offer = validateOffer(candidate);
      } catch {
        stats.rejected += 1;
        continue;
      }
      const motivo = this.rejectionReason(offer, settings);
      if (motivo) {
        stats.rejected += 1;
        // Contar POR MOTIVO, nao so o total. "47 filtrados" nao diz nada; "47
        // por falta de avaliacao" diz onde esta o problema. Foi o que revelou,
        // em 11/09/2026, que a colheita da extensao era descartada inteira por
        // nao trazer nota nem numero de vendas.
        stats.rejectedBy = stats.rejectedBy ?? {};
        stats.rejectedBy[motivo] = (stats.rejectedBy[motivo] ?? 0) + 1;
        continue;
      }
      const previous = memory.get(productKey(offer));
      if (previous && offer.currentPrice > previous.minPrice * (1 - this.config.ingestion.priceDropTolerance)) { stats.duplicated += 1; continue; }
      candidates.push(offer);
    }
    const scoring = { sweetSpot: { min: settings.sweetSpotMin ?? 25, max: settings.sweetSpotMax ?? 200 }, riskyKeywords: settings.blockedKeywords ?? [] };
    candidates.sort((a, b) => scoreOffer(b, scoring) - scoreOffer(a, scoring));
    // A IA entra so aqui, depois dos filtros baratos: nao se paga para classificar
    // o que preco, desconto ou repeticao ja descartaram.
    await this.classificar(candidates, stats);
    const perNiche = new Map();
    const selected = [];
    for (const offer of candidates) {
      if (selected.length >= (settings.maxPerRun ?? DEFAULT_FILTERS.maxPerRun)) break;
      const niche = mainNiche(offer);
      const used = perNiche.get(niche) ?? 0;
      if (used >= (settings.maxPerNiche ?? DEFAULT_FILTERS.maxPerNiche)) continue;
      perNiche.set(niche, used + 1);
      selected.push(offer);
    }
    return selected;
  }

  // Carimba nicho e julgamento de publico na propria oferta. Quem le depois
  // (mainNiche aqui, enqueue na fila, blockReason na publicacao) ja recebe pronto;
  // sem classificador, nada muda e a regra decide como sempre.
  async classificar(candidates, stats) {
    if (!this.classifier?.ativo || !candidates.length) return;
    const decisoes = await this.classifier.classify(candidates);
    let porIa = 0;
    for (const offer of candidates) {
      const decisao = decisoes.get(productKey(offer));
      if (!decisao) continue;
      offer.nicheIds = decisao.nicheIds;
      if (decisao.servePublico !== null && decisao.servePublico !== undefined) {
        offer.audience = { serve: decisao.servePublico, motivo: decisao.motivo, por: decisao.por };
      }
      if (decisao.por === "ia") porIa += 1;
    }
    stats.classifiedByAi = porIa;
    stats.classifiedFromCache = candidates.length - porIa;
  }

  async recentProducts() {
    const limit = this.clock().getTime() - this.config.ingestion.memoryHours * 3600000;
    const state = await this.store.read();
    return new Map(state.seenProducts.filter((item) => new Date(item.at).getTime() >= limit).map((item) => [item.key, item]));
  }

  async remember(offer) {
    const key = productKey(offer);
    const now = this.clock();
    const limit = now.getTime() - this.config.ingestion.memoryHours * 3600000;
    await this.store.update((state) => {
      const previous = state.seenProducts.find((item) => item.key === key);
      const minPrice = previous ? Math.min(previous.minPrice ?? previous.price, offer.currentPrice) : offer.currentPrice;
      state.seenProducts = state.seenProducts.filter((item) => item.key !== key && new Date(item.at).getTime() >= limit).slice(-MAX_MEMORY);
      state.seenProducts.push({ key, price: offer.currentPrice, minPrice, at: now.toISOString() });
    });
  }
}
