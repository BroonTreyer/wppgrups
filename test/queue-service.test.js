import test from "node:test";
import assert from "node:assert/strict";
import { QueueService } from "../src/services/queue-service.js";
import { SAMPLE_OFFER } from "../src/mock/sample-offer.js";

// A selecao passou a ser POR DESTINO: sem destino cadastrado nada e publicavel,
// entao o store minimo dos testes precisa de um canal e das publicacoes dele.
const DESTINO = {
  id: "canal", name: "Canal de teste", type: "channel", active: true,
  nicheIds: ["general"], maxDailyPosts: 70, minMinutesBetweenPosts: 12
};

class MemoryStore {
  constructor(destinations = [DESTINO]) {
    this.state = { queue: [], destinations, publications: [] };
  }
  async read() { return structuredClone(this.state); }
  async update(mutator) { return mutator(this.state); }
}

// `blockReason` e consultado na selecao, antes de publicar; o padrao "nada
// bloqueia" isola o teste das regras de elegibilidade, que tem suite propria.
// `permanentBlockReason` e o subconjunto atemporal do mesmo julgamento — a fila
// usa ele para nao guardar oferta que nunca vai sair, entao o duble precisa ter
// os dois ou o teste passa a exercitar um contrato que nao existe.
const publisher = (overrides = {}) => ({ blockReason: () => null, permanentBlockReason: () => null, ...overrides });

const config = {
  scheduler: { startHour: 0, endHour: 24, retryDelayMinutes: 5 },
  limits: { deduplicationHours: 24 }
};

test("adia oferta sem consumir tentativa quando nenhum destino esta elegivel", async () => {
  const now = new Date("2026-08-27T17:00:00Z");
  const store = new MemoryStore();
  const service = new QueueService({
    store, config, clock: () => now,
    publicationService: publisher({
      blockReason: () => "nicho nao combina",
      // Bloqueio de nicho e permanente: o teste quer o caso de adiamento, entao
      // aqui ele nao pode ser permanente, senao a oferta nem entra na fila.
      permanentBlockReason: () => null,
      publish: async () => { throw new Error("nao deveria publicar sem destino elegivel"); }
    })
  });
  await service.enqueue(SAMPLE_OFFER);
  const result = await service.processNext();
  assert.equal(result.processed, false);
  assert.equal(store.state.queue[0].status, "queued");
  assert.equal(store.state.queue[0].attempts, 0);
  assert.equal(store.state.queue[0].nextAttemptAt, "2026-08-27T17:05:00.000Z");
});

test("uma falha afeta somente o item selecionado", async () => {
  const store = new MemoryStore();
  const service = new QueueService({
    store, config, clock: () => new Date("2026-08-27T17:00:00Z"),
    publicationService: publisher({ publish: async () => { throw new Error("falha simulada"); } })
  });
  const first = await service.enqueue(SAMPLE_OFFER);
  const second = await service.enqueue({ ...SAMPLE_OFFER, externalId: "outro", title: "Outro produto" });
  await service.processNext();
  assert.equal(store.state.queue.find((item) => item.id === first.id).attempts, 1);
  assert.equal(store.state.queue.find((item) => item.id === second.id).attempts, 0);
});

const freshness = { minutes: 25, maxAgeHours: 6, priceRiseTolerance: 0.02, minDiscountAfterRefresh: 10, refreshPages: 2 };
const guardConfig = { ...config, freshness };

class FakePriceGuard {
  constructor(results) { this.results = results; this.calls = 0; }
  isFresh(item, now) { return now - new Date(item.confirmedAt ?? item.createdAt) < freshness.minutes * 60000; }
  isExpired(item, now) { return now - new Date(item.createdAt) >= freshness.maxAgeHours * 3600000; }
  async refresh(items) { this.calls += 1; return items.map((item) => this.results(item)); }
}

const staleClock = () => new Date("2026-08-27T18:00:00Z");

test("revalida o preco antes de publicar quando a oferta esfriou", async () => {
  const store = new MemoryStore();
  const published = [];
  const guard = new FakePriceGuard((item) => ({ id: item.id, status: "updated", offer: { ...item.offer, currentPrice: 1899 } }));
  const service = new QueueService({
    store, config: guardConfig, priceGuard: guard, clock: staleClock,
    publicationService: publisher({ publish: async (offer) => { published.push(offer); return { matchedDestinations: 1, deliveredDestinations: 1 }; } })
  });
  await service.enqueue({ ...SAMPLE_OFFER, capturedAt: "2026-08-27T17:00:00Z" });
  const result = await service.processNext();
  assert.equal(guard.calls, 1);
  assert.equal(result.processed, true);
  assert.equal(published[0].currentPrice, 1899);
  assert.equal(store.state.queue[0].status, "published");
});

test("nao publica oferta cujo preco subiu desde a coleta", async () => {
  const store = new MemoryStore();
  let publishes = 0;
  const guard = new FakePriceGuard((item) => ({ id: item.id, status: "stale", currentPrice: 2999 }));
  const service = new QueueService({
    store, config: guardConfig, priceGuard: guard, clock: staleClock,
    publicationService: publisher({ publish: async () => { publishes += 1; return { matchedDestinations: 1, deliveredDestinations: 1 }; } })
  });
  await service.enqueue({ ...SAMPLE_OFFER, capturedAt: "2026-08-27T17:00:00Z" });
  const result = await service.processNext();
  assert.equal(publishes, 0);
  assert.equal(result.reason, "empty");
  assert.equal(store.state.queue[0].status, "stale");
  assert.match(store.state.queue[0].lastDeferredReason, /Preco subiu/);
});

test("expira oferta que ficou tempo demais na fila", async () => {
  const store = new MemoryStore();
  const guard = new FakePriceGuard((item) => ({ id: item.id, status: "confirmed" }));
  const service = new QueueService({
    store, config: guardConfig, priceGuard: guard, clock: () => new Date("2026-08-28T02:00:00Z"),
    publicationService: publisher({ publish: async () => ({ matchedDestinations: 1, deliveredDestinations: 1 }) })
  });
  store.state.queue.push({
    id: "antiga", status: "queued", score: 50, createdAt: "2026-08-27T17:00:00Z", confirmedAt: "2026-08-27T17:00:00Z",
    productKey: "Marketplace Demo:demo", offer: SAMPLE_OFFER, nicheIds: ["general"], attempts: 0
  });
  const result = await service.processNext();
  assert.equal(result.reason, "empty");
  assert.equal(store.state.queue[0].status, "expired");
});

test("atualiza o item da fila quando o mesmo produto volta mais barato", async () => {
  const store = new MemoryStore();
  const service = new QueueService({ store, config: guardConfig, clock: () => new Date("2026-08-27T17:00:00Z"), publicationService: publisher({ publish: async () => ({}) }) });
  await service.enqueue(SAMPLE_OFFER);
  await service.enqueue({ ...SAMPLE_OFFER, currentPrice: 1799 });
  assert.equal(store.state.queue.length, 1);
  assert.equal(store.state.queue[0].offer.currentPrice, 1799);
});

test("publica primeiro a oferta que esta prestes a acabar", async () => {
  const store = new MemoryStore();
  const published = [];
  const agora = new Date("2026-08-27T17:00:00Z");
  const service = new QueueService({
    store, config: { ...guardConfig, freshness: { ...freshness, urgentMinutes: 120 } }, clock: () => agora,
    publicationService: publisher({ publish: async (offer) => { published.push(offer.externalId); return { matchedDestinations: 1, deliveredDestinations: 1 }; } })
  });
  await service.enqueue({ ...SAMPLE_OFFER, externalId: "score-alto", currentPrice: 500, originalPrice: 5000 });
  await service.enqueue({ ...SAMPLE_OFFER, externalId: "acabando", currentPrice: 2500, originalPrice: 2899, expiresAt: new Date(agora.getTime() + 40 * 60000).toISOString() });
  await service.processNext();
  assert.deepEqual(published, ["acabando"]);
});

test("expira item cuja promocao terminou antes da vez dele", async () => {
  const store = new MemoryStore();
  const agora = new Date("2026-08-27T17:00:00Z");
  const guard = new FakePriceGuard((item) => ({ id: item.id, status: "confirmed" }));
  const service = new QueueService({
    store, config: { ...guardConfig, freshness: { ...freshness, minValidityMinutes: 30, urgentMinutes: 120 } }, priceGuard: guard, clock: () => agora,
    publicationService: publisher({ publish: async () => ({ matchedDestinations: 1, deliveredDestinations: 1 }) })
  });
  await service.enqueue({ ...SAMPLE_OFFER, expiresAt: new Date(agora.getTime() + 5 * 60000).toISOString() });
  const result = await service.processNext();
  assert.equal(result.reason, "empty");
  assert.equal(store.state.queue[0].status, "expired");
  assert.match(store.state.queue[0].lastDeferredReason, /termina em 5 min/);
});

// --- selecao por destino -----------------------------------------------------
// O motor antigo escolhia a melhor oferta da fila e a mandava para todos os
// destinos que casassem, no mesmo minuto. Estes testes fixam o comportamento
// novo: cada canal recebe, na sua vez, a oferta escolhida para o publico dele.

const CANAIS = [
  { id: "casa", name: "Achadinhos", type: "channel", active: true, nicheIds: ["home"], maxDailyPosts: 70, minMinutesBetweenPosts: 12 },
  { id: "tech", name: "Achados Pro", type: "channel", active: true, nicheIds: ["electronics"], maxDailyPosts: 70, minMinutesBetweenPosts: 12 }
];

// Mock fiel ao que importa aqui: so o casamento de nicho bloqueia.
const porNicho = (extra = {}) => {
  const casa = ({ destination, nicheIds }) =>
    destination.nicheIds.some((id) => nicheIds.includes(id)) ? null : "nicho nao combina";
  return { blockReason: casa, permanentBlockReason: casa, ...extra };
};

test("cada canal recebe a oferta do nicho dele, nao a melhor da fila", async () => {
  const store = new MemoryStore(structuredClone(CANAIS));
  const enviados = [];
  const service = new QueueService({
    store, config: guardConfig, clock: () => new Date("2026-08-27T17:00:00Z"),
    publicationService: porNicho({
      publish: async (offer) => {
        enviados.push({ destino: offer.destinationId, produto: offer.externalId });
        return { matchedDestinations: 1, deliveredDestinations: 1 };
      }
    })
  });
  await service.enqueue({ ...SAMPLE_OFFER, externalId: "panela", title: "Panela de Pressao Eletrica", nicheIds: ["home"], currentPrice: 180, originalPrice: 300 });
  await service.enqueue({ ...SAMPLE_OFFER, externalId: "fone", title: "Fone de Ouvido Bluetooth", nicheIds: ["electronics"], currentPrice: 120, originalPrice: 260 });

  await service.processNext();
  await service.processNext();

  assert.equal(enviados.length, 2, "um envio por ciclo, nao um disparo para todos");
  const porDestino = Object.fromEntries(enviados.map((item) => [item.destino, item.produto]));
  assert.deepEqual(porDestino, { casa: "panela", tech: "fone" });
});

test("uma oferta vai para UM destino e encerra, sem se repetir noutro", async () => {
  const canais = structuredClone(CANAIS).map((canal) => ({ ...canal, nicheIds: ["home"] }));
  const store = new MemoryStore(canais);
  const enviados = [];
  const service = new QueueService({
    store, config: guardConfig, clock: () => new Date("2026-08-27T17:00:00Z"),
    publicationService: porNicho({
      publish: async (offer) => {
        enviados.push(offer.destinationId);
        // O servico real grava a publicacao; sem isso o mock esconderia o
        // rodizio, porque "quem espera ha mais tempo" le esse historico.
        store.state.publications.push({
          destinationId: offer.destinationId, status: "sent",
          createdAt: "2026-08-27T17:00:00Z", title: offer.title, nicheIds: offer.nicheIds
        });
        return { matchedDestinations: 1, deliveredDestinations: 1 };
      }
    })
  });
  await service.enqueue({ ...SAMPLE_OFFER, externalId: "panela", title: "Panela de Pressao", nicheIds: ["home"] });

  await service.processNext();
  assert.equal(enviados.length, 1, "so um canal recebe");
  assert.equal(store.state.queue[0].status, "published", "publicada uma vez, encerra");

  // Os dois canais aceitam o mesmo nicho, mas a oferta nao vai para o segundo:
  // quem estiver nos dois grupos veria o mesmo produto duas vezes.
  await service.processNext();
  assert.equal(enviados.length, 1, "nao repete em outro canal");
});

test("nao repete produto parecido no canal que acabou de publicar um igual", async () => {
  const store = new MemoryStore([structuredClone(CANAIS[0])]);
  store.state.publications.push({
    destinationId: "casa", status: "sent", createdAt: "2026-08-27T16:00:00Z",
    title: "Kit 10 Potes De Vidro Hermetico Para Marmita", nicheIds: ["home"]
  });
  const enviados = [];
  const service = new QueueService({
    store, config: guardConfig, clock: () => new Date("2026-08-27T17:00:00Z"),
    publicationService: porNicho({
      publish: async (offer) => { enviados.push(offer.externalId); return { matchedDestinations: 1, deliveredDestinations: 1 }; }
    })
  });
  // O pote tem desconto melhor, mas o canal acabou de publicar um quase igual.
  await service.enqueue({ ...SAMPLE_OFFER, externalId: "potes", title: "Kit 6 Potes De Vidro Hermetico Marmita", nicheIds: ["home"], currentPrice: 60, originalPrice: 150 });
  await service.enqueue({ ...SAMPLE_OFFER, externalId: "toalha", title: "Jogo De Toalhas Buddemeyer Bella", nicheIds: ["home"], currentPrice: 90, originalPrice: 160 });

  await service.processNext();
  assert.deepEqual(enviados, ["toalha"], "a variedade venceu o desconto maior");
});

test("nao entra na fila o que nenhum destino ativo aceita", async () => {
  const store = new MemoryStore();
  store.state.destinations = [{ id: "isa", active: true, nicheIds: ["beauty"] }];
  const service = new QueueService({
    store, config, clock: () => new Date("2026-08-27T17:00:00Z"),
    publicationService: publisher({ permanentBlockReason: () => "\"masculino\" nao combina com o publico deste canal" })
  });

  const resultado = await service.enqueue(SAMPLE_OFFER);
  assert.equal(resultado.skipped, true);
  assert.match(resultado.reason, /Nenhum destino ativo aceita/);
  assert.equal(store.state.queue.length, 0, "fila e estoque do que sera publicado, nao deposito");
});

test("oferta que perdeu o destino sai da fila quando a regra muda", async () => {
  const store = new MemoryStore();
  store.state.destinations = [{ id: "isa", active: true, nicheIds: ["beauty"] }];
  let permanente = null;
  const service = new QueueService({
    store, config, clock: () => new Date("2026-08-27T17:00:00Z"),
    priceGuard: { isExpired: () => false, isFresh: () => true },
    publicationService: publisher({ permanentBlockReason: () => permanente })
  });

  await service.enqueue(SAMPLE_OFFER);
  assert.equal(store.state.queue.filter((i) => i.status === "queued").length, 1);

  // O usuario acrescenta "tenis" a lista de saturacao depois da oferta ja estar
  // na fila. Sem esta varredura ela ficaria ate expirar, segurando a vaga.
  permanente = "\"tenis\" esta saturado neste canal";
  const expirados = await service.expireOldItems();

  assert.equal(expirados, 1);
  assert.equal(store.state.queue.filter((i) => i.status === "queued").length, 0);
  assert.match(store.state.queue[0].lastDeferredReason, /Nenhum destino ativo aceita/);
});

test("sem destino ativo nenhum, a fila continua aceitando", async () => {
  // Fila vazia com destinos desligados e cenario normal de configuracao: barrar
  // aqui deixaria o operador sem como preparar nada antes de ligar o canal.
  const store = new MemoryStore();
  store.state.destinations = [{ id: "isa", active: false, nicheIds: ["beauty"] }];
  const service = new QueueService({
    store, config, clock: () => new Date("2026-08-27T17:00:00Z"),
    publicationService: publisher({ permanentBlockReason: () => "nicho nao combina" })
  });

  const resultado = await service.enqueue(SAMPLE_OFFER);
  assert.ok(!resultado.skipped);
  assert.equal(store.state.queue.length, 1);
});
