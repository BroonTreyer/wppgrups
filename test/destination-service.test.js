import test from "node:test";
import assert from "node:assert/strict";
import { DestinationService } from "../src/services/destination-service.js";

class MemoryStore {
  constructor() { this.state = { destinations: [] }; }
  async read() { return structuredClone(this.state); }
  async update(mutator) { return mutator(this.state); }
}

test("sincroniza grupos e somente canais administrados", async () => {
  const service = new DestinationService({
    store: new MemoryStore(),
    zapi: {
      getGroups: async () => [{ phone: "group-1", name: "Eletronicos" }],
      getChannels: async () => [
        { id: "owner@newsletter", name: "Ofertas", state: "ACTIVE", viewMetadata: { role: "OWNER" } },
        { id: "followed@newsletter", name: "Outro", state: "ACTIVE", viewMetadata: { role: "SUBSCRIBER" } }
      ]
    },
    config: { limits: { maxPostsPerChannelPerDay: 40, maxPostsPerGroupPerDay: 12, channelMinutesBetweenPosts: 20, groupMinutesBetweenPosts: 45 } }
  });
  const destinations = await service.sync();
  assert.equal(destinations.length, 2);
  assert.equal(destinations.find((item) => item.type === "channel").maxDailyPosts, 40);
});
