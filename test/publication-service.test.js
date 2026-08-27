import test from "node:test";
import assert from "node:assert/strict";
import { PublicationService } from "../src/services/publication-service.js";
import { SAMPLE_OFFER } from "../src/mock/sample-offer.js";

class MemoryStore {
  constructor(state) { this.state = structuredClone(state); }
  async read() { return structuredClone(this.state); }
  async update(mutator) { return mutator(this.state); }
}

test("publica somente nos grupos com nicho correspondente", async () => {
  const store = new MemoryStore({
    destinations: [
      { id: "tv-group", name: "TV", type: "group", nicheIds: ["electronics"], active: true, minDiscount: 10, maxDailyPosts: 12, minMinutesBetweenPosts: 0 },
      { id: "beauty-group", name: "Beleza", type: "group", nicheIds: ["beauty"], active: true, minDiscount: 0, maxDailyPosts: 12, minMinutesBetweenPosts: 0 }
    ], publications: [], deliveryEvents: [], offers: [], queue: []
  });
  const service = new PublicationService({
    store,
    zapi: { sendImage: async () => ({ messageId: "sent" }) },
    config: { dryRun: true, zapi: { channelImageEnabled: false }, limits: { deduplicationHours: 24 } },
    clock: () => new Date("2026-08-27T17:00:00Z")
  });
  const result = await service.publish(SAMPLE_OFFER);
  assert.equal(result.matchedDestinations, 1);
  assert.equal(result.results[0].destinationId, "tv-group");
});
