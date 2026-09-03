import { discountPercentage, minutesUntilExpiry, productKey, validateOffer } from "../domain/offer.js";
import { inferNiches } from "../domain/niches.js";
import { isRisky, scoreOffer } from "../domain/scoring.js";
import { SessionExpiredError } from "./affiliate-link-service.js";

const DEFAULT_FILTERS = { enabled: false, minDiscount: 20, maxDiscount: 90, minRating: 4.3, minSold: 500, minPrice: 0, maxPrice: 400, sweetSpotMin: 25, sweetSpotMax: 200, maxPerRun: 8, maxPerNiche: 2, blockedKeywords: [], categories: [] };
const INTEGER_FIELDS = [["minDiscount", 0, 100], ["maxDiscount", 0, 100], ["minSold", 0, 1000000], ["sweetSpotMin", 0, 100000], ["sweetSpotMax", 1, 100000], ["maxPerRun", 1, 50], ["maxPerNiche", 1, 50], ["pages", 1, 10]];
const NUMBER_FIELDS = [["minRating", 0, 5], ["minPrice", 0, 1000000], ["maxPrice", 0, 1000000]];
const CATEGORY_PATTERN = /^[A-Z0-9]{1,12}$/;
const MAX_MEMORY = 20000;
const MAX_ALERTS = 50;
const normalize = (text) => String(text ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
const mainNiche = (offer) => inferNiches(offer).find((niche) => niche !== "general") ?? "general";

export class IngestionService {
  constructor({ store, queueService, affiliateLinkService, sources = [], config, clock = () => new Date() }) {
    this.store = store;
    this.queueService = queueService;
    this.affiliateLinkService = affiliateLinkService;
    this.sources = new Map(sources.map((source) => [source.id, source]));
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
    if (settings.minSold && (offer.soldCount ?? 0) < settings.minSold) return "pouca gente comprou esse produto";
    if (isRisky(offer, settings.blockedKeywords ?? [])) return "categoria sensivel";
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
    const fastest = Math.max(1, Math.min(...actives.map((destination) => destination.minMinutesBetweenPosts || 1)));
    const horizon = Math.ceil((60 / fastest) * this.config.freshness.queueHorizonHours);
    const capacity = Math.max(1, Math.min(horizon, dailyRoom));
    return { queued, capacity, room: Math.max(0, capacity - queued) };
  }

  async runSource(settings) {
    const startedAt = this.clock();
    const category = this.nextCategory(settings);
    const stats = { sourceId: settings.id, category, collected: 0, rejected: 0, duplicated: 0, enqueued: 0, errors: [] };
    try {
      const { queued, capacity, room } = await this.queueRoom();
      if (capacity > 0 && room <= 0) {
        stats.skipped = `fila ja tem ${queued} ofertas para as proximas ${this.config.freshness.queueHorizonHours}h (alvo ${capacity})`;
        return this.finish(settings, startedAt, stats);
      }
      const limit = capacity > 0 ? Math.min(settings.maxPerRun ?? 8, room) : (settings.maxPerRun ?? 8);
      const collected = await this.sources.get(settings.id).collect({ pages: settings.pages, category });
      stats.collected = collected.length;
      if (!collected.length) await this.alert("source-empty", `${settings.label} nao devolveu nenhuma oferta. Verifique se o marketplace mudou a pagina.`);
      for (const offer of await this.select(collected, { ...settings, maxPerRun: limit }, stats)) {
        try {
          const link = await this.affiliateLinkService.linkFor(offer);
          await this.queueService.enqueue({ ...offer, affiliateUrl: link.url, affiliateTagged: link.attributed, awaitingLink: Boolean(link.pending) });
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
        source.cursor = ((source.cursor ?? 0) + 1) % Math.max(1, (source.categories ?? []).length);
      }
    });
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
      if (this.rejectionReason(offer, settings)) { stats.rejected += 1; continue; }
      const previous = memory.get(productKey(offer));
      if (previous && offer.currentPrice > previous.minPrice * (1 - this.config.ingestion.priceDropTolerance)) { stats.duplicated += 1; continue; }
      candidates.push(offer);
    }
    const scoring = { sweetSpot: { min: settings.sweetSpotMin ?? 25, max: settings.sweetSpotMax ?? 200 }, riskyKeywords: settings.blockedKeywords ?? [] };
    candidates.sort((a, b) => scoreOffer(b, scoring) - scoreOffer(a, scoring));
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
