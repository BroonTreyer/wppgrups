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
  assert.equal(destinations.find((item) => item.type === "channel").active, false);
  assert.equal(destinations.find((item) => item.name === "Eletronicos").active, false);
});

test("desativa destino que deixou de aparecer na sincronizacao", async () => {
  const store = new MemoryStore();
  store.state.destinations.push({ id: "old@newsletter", name: "Antigo", type: "channel", active: true, available: true });
  const service = new DestinationService({
    store,
    zapi: { getGroups: async () => [], getChannels: async () => [] },
    config: { limits: { maxPostsPerChannelPerDay: 40, maxPostsPerGroupPerDay: 12, channelMinutesBetweenPosts: 20, groupMinutesBetweenPosts: 45 } }
  });
  const [destination] = await service.sync();
  assert.equal(destination.active, false);
  assert.equal(destination.available, false);
});

test("burstSize so aceita inteiro entre 1 e 50", async () => {
  const store = new MemoryStore();
  store.state.destinations.push({ id: "g", type: "group", burstSize: 1 });
  const service = new DestinationService({ store, zapi: {}, config: { limits: {} } });
  await service.configure("g", { burstSize: 15 });
  assert.equal(store.state.destinations[0].burstSize, 15);
  await assert.rejects(() => service.configure("g", { burstSize: 0 }), /burstSize/);
  await assert.rejects(() => service.configure("g", { burstSize: 51 }), /burstSize/);
  assert.equal(store.state.destinations[0].burstSize, 15, "pedido invalido nao altera o destino");
});

test("aceita null como 'sem teto' e recusa numero fora da faixa", async () => {
  const store = new MemoryStore();
  store.state.destinations.push({ id: "g1", name: "Grupo", type: "group", active: true, maxDailyPosts: 1000, minMinutesBetweenPosts: 10 });
  const service = new DestinationService({
    store,
    zapi: { getGroups: async () => [], getChannels: async () => [] },
    config: { limits: { maxPostsPerChannelPerDay: 40, maxPostsPerGroupPerDay: 12, channelMinutesBetweenPosts: 20, groupMinutesBetweenPosts: 45 } }
  });

  // `null` precisa passar ANTES do laco de faixa: la `Number(null)` e 0, cai
  // fora de [1, MAX] e a unica forma de dizer "sem limite" seria recusada.
  await service.configure("g1", { maxDailyPosts: null });
  assert.equal(store.state.destinations[0].maxDailyPosts, null);

  await service.configure("g1", { maxDailyPosts: 1500 });
  assert.equal(store.state.destinations[0].maxDailyPosts, 1500);

  await assert.rejects(() => service.configure("g1", { maxDailyPosts: 0 }), /inteiro entre/);
  await assert.rejects(() => service.configure("g1", { maxDailyPosts: 99999 }), /inteiro entre/);
  // O patch do chamador nao pode ser mutado pelo caminho do null.
  const patch = { maxDailyPosts: null };
  await service.configure("g1", patch);
  assert.deepEqual(patch, { maxDailyPosts: null });
});
