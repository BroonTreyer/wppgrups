const days = (value) => value * 24 * 60 * 60 * 1000;
const FINISHED = ["published", "failed", "partial", "expired", "stale"];
const MAX_REQUESTS_KEPT = 500;

export class RetentionService {
  constructor({ store, config, clock = () => new Date() }) {
    this.store = store;
    this.config = config;
    this.clock = clock;
  }

  async prune() {
    const now = this.clock();
    const publicationLimit = now.getTime() - days(this.config.retention.publicationDays);
    const queueLimit = now.getTime() - days(this.config.retention.queueDays);
    return this.store.update((state) => {
      const before = { publications: state.publications.length, queue: state.queue.length, offers: state.offers.length, deliveryEvents: state.deliveryEvents.length };
      state.publications = state.publications.filter((item) => new Date(item.createdAt).getTime() >= publicationLimit);
      state.deliveryEvents = state.deliveryEvents.filter((item) => new Date(item.receivedAt ?? now).getTime() >= publicationLimit);
      state.queue = state.queue.filter((item) => !FINISHED.includes(item.status) || new Date(item.lastAttemptAt ?? item.createdAt).getTime() >= queueLimit);
      state.offers = state.offers.slice(-this.config.retention.maxOffers);
      state.alerts = (state.alerts ?? []).filter((item) => new Date(item.at).getTime() >= queueLimit);
      state.affiliateRequests = (state.affiliateRequests ?? []).filter((item) => item.status !== "done").slice(-MAX_REQUESTS_KEPT);
      return {
        publications: before.publications - state.publications.length,
        queue: before.queue - state.queue.length,
        offers: before.offers - state.offers.length,
        deliveryEvents: before.deliveryEvents - state.deliveryEvents.length
      };
    });
  }
}
