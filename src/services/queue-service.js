import { minutesUntilExpiry, productKey, validateOffer } from "../domain/offer.js";
import { inferNiches } from "../domain/niches.js";
import { scoreOffer } from "../domain/scoring.js";

export { scoreOffer };

export class QueueService {
  constructor({ store, publicationService, priceGuard = null, config, clock = () => new Date() }) {
    this.store = store;
    this.publicationService = publicationService;
    this.priceGuard = priceGuard;
    this.config = config;
    this.clock = clock;
    this.processing = false;
  }

  async enqueue(input) {
    const offer = validateOffer(input);
    const nicheIds = input.nicheIds?.length ? input.nicheIds : inferNiches(offer);
    const key = productKey(offer);
    return this.store.update((state) => {
      const existing = state.queue.find((item) => item.productKey === key && ["queued", "processing", "awaiting-link"].includes(item.status));
      if (existing) {
        if (offer.currentPrice < existing.offer.currentPrice) {
          existing.offer = offer;
          existing.score = scoreOffer(offer);
          existing.confirmedAt = offer.capturedAt;
        }
        return existing;
      }
      const queued = {
        id: crypto.randomUUID(), offer, nicheIds, productKey: key, score: scoreOffer(offer),
        status: input.awaitingLink ? "awaiting-link" : "queued", attempts: 0,
        createdAt: this.clock().toISOString(), confirmedAt: offer.capturedAt,
        lastDeferredReason: input.awaitingLink ? "Aguardando o link de afiliado do painel" : null
      };
      state.queue.push(queued);
      return queued;
    });
  }

  isWithinPublishingWindow(now = this.clock()) {
    const hour = Number(new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", hourCycle: "h23", timeZone: "America/Sao_Paulo" }).format(now));
    return hour >= this.config.scheduler.startHour && hour < this.config.scheduler.endHour;
  }

  async selectCandidate() {
    const now = this.clock();
    const state = await this.store.read();
    const urgency = (item) => {
      const restam = minutesUntilExpiry(item.offer, now);
      return restam !== null && restam <= this.config.freshness.urgentMinutes ? restam : null;
    };
    return state.queue
      .filter((entry) => entry.status === "queued" && (!entry.nextAttemptAt || new Date(entry.nextAttemptAt) <= now))
      .toSorted((a, b) => {
        const urgentA = urgency(a);
        const urgentB = urgency(b);
        if (urgentA !== null && urgentB !== null) return urgentA - urgentB || b.score - a.score;
        if (urgentA !== null) return -1;
        if (urgentB !== null) return 1;
        return b.score - a.score || a.createdAt.localeCompare(b.createdAt);
      })[0] ?? null;
  }

  async expireOldItems() {
    if (!this.priceGuard) return 0;
    return this.store.update((state) => {
      let expired = 0;
      const now = this.clock();
      for (const item of state.queue) {
        if (item.status !== "queued" && item.status !== "awaiting-link") continue;
        const restam = minutesUntilExpiry(item.offer, now);
        if (restam !== null && restam < this.config.freshness.minValidityMinutes) {
          item.status = "expired";
          item.lastDeferredReason = restam > 0 ? `Promocao termina em ${restam} min, tarde demais para publicar` : "Promocao encerrada";
          expired += 1;
        } else if (this.priceGuard.isExpired(item, now)) {
          item.status = "expired";
          item.lastDeferredReason = "Oferta ficou tempo demais na fila";
          expired += 1;
        }
      }
      return expired;
    });
  }

  async refreshQueue() {
    if (!this.priceGuard) return { checked: 0 };
    const now = this.clock();
    const state = await this.store.read();
    const pending = state.queue.filter((item) => item.status === "queued" && !this.priceGuard.isFresh(item, now));
    if (!pending.length) return { checked: 0 };
    const results = await this.priceGuard.refresh(pending);
    const summary = { checked: results.length, updated: 0, stale: 0, expired: 0, unavailable: 0 };
    await this.store.update((current) => {
      for (const result of results) {
        const item = current.queue.find((entry) => entry.id === result.id);
        if (!item || item.status !== "queued") continue;
        if (result.status === "expired" || result.status === "stale") {
          item.status = result.status;
          item.lastDeferredReason = result.status === "expired" ? "Oferta saiu da vitrine" : `Preco subiu para ${result.currentPrice}`;
          summary[result.status] += 1;
        } else if (result.status === "unavailable") {
          item.nextAttemptAt = new Date(now.getTime() + this.config.scheduler.retryDelayMinutes * 60_000).toISOString();
          item.lastDeferredReason = `Nao foi possivel revalidar o preco: ${result.error}`;
          summary.unavailable += 1;
        } else {
          item.offer = result.offer ?? item.offer;
          item.score = scoreOffer(item.offer);
          item.confirmedAt = now.toISOString();
          if (result.status === "updated") summary.updated += 1;
        }
      }
    });
    return summary;
  }

  async processNext() {
    if (this.processing || !this.isWithinPublishingWindow()) return { processed: false, reason: this.processing ? "busy" : "outside-window" };
    this.processing = true;
    let selectedItem = null;
    try {
      await this.expireOldItems();
      let item = await this.selectCandidate();
      if (!item) return { processed: false, reason: "empty" };
      if (this.priceGuard && !this.priceGuard.isFresh(item, this.clock())) {
        await this.refreshQueue();
        item = await this.selectCandidate();
        if (!item) return { processed: false, reason: "empty" };
      }
      selectedItem = item;
      await this.store.update((current) => {
        const selected = current.queue.find((entry) => entry.id === item.id);
        selected.status = "processing";
        selected.attempts += 1;
      });
      const result = await this.publicationService.publish({ ...item.offer, nicheIds: item.nicheIds });
      await this.store.update((current) => {
        const selected = current.queue.find((entry) => entry.id === item.id);
        if (!result.matchedDestinations) {
          selected.status = "queued";
          selected.attempts = Math.max(0, selected.attempts - 1);
          selected.nextAttemptAt = new Date(this.clock().getTime() + this.config.scheduler.retryDelayMinutes * 60_000).toISOString();
          selected.lastDeferredReason = "Nenhum destino elegivel neste momento";
        } else if (result.deliveredDestinations === result.matchedDestinations) {
          selected.status = "published";
          selected.nextAttemptAt = null;
        } else {
          selected.status = selected.attempts >= 3 ? (result.deliveredDestinations ? "partial" : "failed") : "queued";
          selected.nextAttemptAt = selected.status === "queued" ? new Date(this.clock().getTime() + this.config.scheduler.retryDelayMinutes * 60_000).toISOString() : null;
        }
        selected.lastAttemptAt = this.clock().toISOString();
      });
      return {
        processed: Boolean(result.deliveredDestinations),
        itemId: item.id,
        reason: result.deliveredDestinations ? null : (result.blocked?.length ? "destinos bloqueados" : "nenhum destino ativo aceita esta oferta"),
        blocked: result.blocked ?? [],
        result
      };
    } catch (error) {
      await this.store.update((current) => {
        const selected = current.queue.find((entry) => entry.id === selectedItem?.id);
        if (selected) {
          selected.status = selected.attempts >= 3 ? "failed" : "queued";
          selected.lastError = error.message;
          selected.nextAttemptAt = selected.status === "queued" ? new Date(this.clock().getTime() + this.config.scheduler.retryDelayMinutes * 60_000).toISOString() : null;
        }
      }).catch(() => {});
      return { processed: false, reason: "error", error: error.message };
    } finally {
      this.processing = false;
    }
  }

  async list() {
    return (await this.store.read()).queue.toSorted((a, b) => b.score - a.score);
  }
}
