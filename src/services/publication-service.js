import { discountPercentage, offerFingerprint, validateOffer } from "../domain/offer.js";
import { inferNiches } from "../domain/niches.js";
import { formatOfferCaption } from "../domain/message.js";

const hours = (value) => value * 60 * 60 * 1000;
const minutes = (value) => value * 60 * 1000;

export class PublicationService {
  constructor({ store, zapi, config, clock = () => new Date() }) {
    this.store = store;
    this.zapi = zapi;
    this.config = config;
    this.clock = clock;
  }

  async publish(input) {
    const offer = validateOffer(input);
    const now = this.clock();
    const nicheIds = input.nicheIds?.length ? input.nicheIds : inferNiches(offer);
    const state = await this.store.read();
    const destinations = state.destinations.filter((destination) => this.isEligible({ destination, offer, nicheIds, publications: state.publications, now }));
    const caption = formatOfferCaption(offer, now);
    const results = [];
    for (const destination of destinations) {
      try {
        if (destination.type === "channel" && !this.config.dryRun && !this.config.zapi.channelImageEnabled) {
          throw new Error("Envio de imagem para canal ainda nao homologado");
        }
        const delivery = this.config.dryRun
          ? { id: `dry-${crypto.randomUUID()}`, dryRun: true }
          : await this.zapi.sendImage({ destinationId: destination.id, imageUrl: offer.imageUrl, caption });
        results.push({ destinationId: destination.id, destinationName: destination.name, destinationType: destination.type, status: "sent", delivery });
      } catch (error) {
        results.push({ destinationId: destination.id, destinationName: destination.name, destinationType: destination.type, status: "failed", error: error.message });
      }
    }
    await this.store.update((current) => {
      current.offers.push({ ...offer, nicheIds, fingerprint: offerFingerprint(offer) });
      for (const result of results) {
        current.publications.push({
          id: crypto.randomUUID(), offerFingerprint: offerFingerprint(offer), destinationId: result.destinationId,
          status: result.status, deliveryId: result.delivery?.messageId ?? result.delivery?.id ?? null,
          error: result.error ?? null, createdAt: now.toISOString()
        });
      }
    });
    return { offer, nicheIds, matchedDestinations: destinations.length, deliveredDestinations: results.filter((item) => item.status === "sent").length, caption, results };
  }

  isEligible({ destination, offer, nicheIds, publications, now }) {
    if (!destination.active || destination.available === false || !Array.isArray(destination.nicheIds) || !destination.nicheIds.some((id) => nicheIds.includes(id))) return false;
    if (discountPercentage(offer) < (destination.minDiscount ?? 0)) return false;
    const destinationPosts = publications.filter((item) => (item.destinationId ?? item.groupId) === destination.id && item.status === "sent");
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(now);
    const dailyCount = destinationPosts.filter((item) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date(item.createdAt)) === today).length;
    if (dailyCount >= destination.maxDailyPosts) return false;
    const lastPost = destinationPosts.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (lastPost && now - new Date(lastPost.createdAt) < minutes(destination.minMinutesBetweenPosts)) return false;
    const fingerprint = offerFingerprint(offer);
    return !destinationPosts.some((item) => item.offerFingerprint === fingerprint && now - new Date(item.createdAt) < hours(this.config.limits.deduplicationHours));
  }

  async recordDeliveryEvent(event) {
    await this.store.update((state) => state.deliveryEvents.push({ ...event, receivedAt: this.clock().toISOString() }));
  }
}
