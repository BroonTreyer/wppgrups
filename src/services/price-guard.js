import { discountPercentage, minutesUntilExpiry } from "../domain/offer.js";

export class PriceGuard {
  constructor({ sources = [], config, clock = () => new Date() }) {
    this.sources = new Map(sources.map((source) => [source.id, source]));
    this.config = config;
    this.clock = clock;
  }

  isFresh(item, now = this.clock()) {
    const confirmedAt = item.confirmedAt ?? item.offer?.capturedAt ?? item.createdAt;
    return now - new Date(confirmedAt) < this.config.freshness.minutes * 60_000;
  }

  isExpired(item, now = this.clock()) {
    return now - new Date(item.createdAt) >= this.config.freshness.maxAgeHours * 3_600_000;
  }

  async refresh(items) {
    const results = [];
    const groups = new Map();
    for (const item of items) {
      const sourceId = item.offer?.sourceId;
      if (!this.sources.has(sourceId)) { results.push({ id: item.id, status: "unchecked" }); continue; }
      if (!groups.has(sourceId)) groups.set(sourceId, []);
      groups.get(sourceId).push(item);
    }
    for (const [sourceId, group] of groups) {
      let current;
      try {
        current = await this.sources.get(sourceId).refreshMany(group.map((item) => item.offer), { pages: this.config.freshness.refreshPages });
      } catch (error) {
        for (const item of group) results.push({ id: item.id, status: "unavailable", error: error.message });
        continue;
      }
      for (const item of group) results.push(this.evaluate(item, current.get(item.offer.externalId)));
    }
    return results;
  }

  evaluate(item, latest) {
    if (!latest) return { id: item.id, status: "expired" };
    const restam = minutesUntilExpiry(latest, this.clock());
    if (restam !== null && restam < this.config.freshness.minValidityMinutes) return { id: item.id, status: "expired" };
    const rise = latest.currentPrice / item.offer.currentPrice - 1;
    if (rise > this.config.freshness.priceRiseTolerance) return { id: item.id, status: "stale", currentPrice: latest.currentPrice };
    const offer = { ...item.offer, expiresAt: latest.expiresAt ?? item.offer.expiresAt, currentPrice: latest.currentPrice, originalPrice: latest.originalPrice ?? item.offer.originalPrice, shipping: latest.shipping ?? item.offer.shipping, paymentMethod: latest.paymentMethod ?? item.offer.paymentMethod };
    if (discountPercentage(offer) < this.config.freshness.minDiscountAfterRefresh) return { id: item.id, status: "stale", currentPrice: latest.currentPrice };
    return { id: item.id, status: latest.currentPrice === item.offer.currentPrice ? "confirmed" : "updated", offer };
  }
}
