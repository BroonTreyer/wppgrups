import { discountPercentage, offerFingerprint, validateOffer } from "../domain/offer.js";
import { inferNiches } from "../domain/niches.js";

function score(offer) {
  const discount = discountPercentage(offer);
  const rating = offer.rating ? offer.rating * 5 : 0;
  const reviews = offer.reviewCount ? Math.min(15, Math.log10(offer.reviewCount + 1) * 5) : 0;
  const shipping = offer.shipping?.toLowerCase().includes("gratis") ? 10 : 0;
  return Math.round(discount + rating + reviews + shipping);
}

export class QueueService {
  constructor({ store, publicationService, config, clock = () => new Date() }) {
    this.store = store;
    this.publicationService = publicationService;
    this.config = config;
    this.clock = clock;
    this.processing = false;
  }

  async enqueue(input) {
    const offer = validateOffer(input);
    const nicheIds = input.nicheIds?.length ? input.nicheIds : inferNiches(offer);
    const fingerprint = offerFingerprint(offer);
    return this.store.update((state) => {
      const existing = state.queue.find((item) => item.fingerprint === fingerprint && ["queued", "processing"].includes(item.status));
      if (existing) return existing;
      const queued = { id: crypto.randomUUID(), offer, nicheIds, fingerprint, score: score(offer), status: "queued", attempts: 0, createdAt: this.clock().toISOString() };
      state.queue.push(queued);
      return queued;
    });
  }

  isWithinPublishingWindow(now = this.clock()) {
    const hour = Number(new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", hourCycle: "h23", timeZone: "America/Sao_Paulo" }).format(now));
    return hour >= this.config.scheduler.startHour && hour < this.config.scheduler.endHour;
  }

  async processNext() {
    if (this.processing || !this.isWithinPublishingWindow()) return { processed: false, reason: this.processing ? "busy" : "outside-window" };
    this.processing = true;
    let selectedItem = null;
    try {
      const state = await this.store.read();
      const now = this.clock();
      const item = state.queue.filter((entry) => entry.status === "queued" && (!entry.nextAttemptAt || new Date(entry.nextAttemptAt) <= now)).toSorted((a, b) => b.score - a.score || a.createdAt.localeCompare(b.createdAt))[0];
      if (!item) return { processed: false, reason: "empty" };
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
      return { processed: Boolean(result.deliveredDestinations), itemId: item.id, result };
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
