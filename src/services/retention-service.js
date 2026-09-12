const days = (value) => value * 24 * 60 * 60 * 1000;
const FINISHED = ["published", "failed", "partial", "expired", "stale"];
const MAX_REQUESTS_KEPT = 500;

// Tetos absolutos, alem do corte por data.
//
// A poda era so por tempo, e tempo e uma medida ruim quando a vazao muda de ordem
// de grandeza: os mesmos 7 dias de fila que guardavam algumas centenas de itens
// passaram a guardar 35 mil quando o volume foi de 60 para 1.245 posts por dia.
// Cada escrita do store faz `structuredClone` do estado INTEIRO, e o agendador
// escreve a cada 6 segundos — store grande nao e so disco, e latencia em tudo.
const MAX_QUEUE_KEPT = 4000;
const MAX_PUBLICATIONS_KEPT = 60_000;

// Item ja encerrado nao precisa mais carregar a oferta inteira: o que sobrevive
// dele e o diagnostico. A `offer` completa custa ~1,2 KB por item e responde por
// mais da metade do store; o registro do que aconteceu cabe em uma fracao disso.
const enxugar = (item) => ({
  id: item.id,
  productKey: item.productKey,
  status: item.status,
  nicheIds: item.nicheIds,
  createdAt: item.createdAt,
  lastAttemptAt: item.lastAttemptAt,
  lastDeferredReason: item.lastDeferredReason,
  publishedTo: item.publishedTo,
  deliveredTo: item.deliveredTo,
  titulo: item.offer?.title ?? item.titulo ?? null,
  enxuto: true
});

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
      state.publications = state.publications
        .filter((item) => new Date(item.createdAt).getTime() >= publicationLimit)
        .slice(-MAX_PUBLICATIONS_KEPT);
      state.deliveryEvents = state.deliveryEvents.filter((item) => new Date(item.receivedAt ?? now).getTime() >= publicationLimit);

      const viva = (item) => !FINISHED.includes(item.status);
      const recente = (item) => new Date(item.lastAttemptAt ?? item.createdAt).getTime() >= queueLimit;
      // O que ainda pode publicar fica intacto e nunca entra no teto: a fila de
      // trabalho e pequena, quem cresce e o historico atras dela. O teto corta os
      // encerrados mais antigos, e a ordem original da fila e preservada — ela e
      // a ordem de chegada, e ha codigo e teste que contam com isso.
      const sobrevivem = new Set(
        state.queue.filter((item) => !viva(item) && recente(item)).slice(-MAX_QUEUE_KEPT)
      );
      state.queue = state.queue
        .filter((item) => viva(item) || sobrevivem.has(item))
        .map((item) => (viva(item) || item.enxuto ? item : enxugar(item)));

      state.offers = state.offers.slice(-this.config.retention.maxOffers);
      state.alerts = (state.alerts ?? []).filter((item) => new Date(item.at).getTime() >= queueLimit);
      // Pedido de link que falhou virou historico assim que o link saiu por
      // parametros. Sem corte por idade eles enchiam o teto de 500 e empurravam
      // para fora os pendentes de verdade.
      state.affiliateRequests = (state.affiliateRequests ?? [])
        .filter((item) => item.status !== "done")
        .filter((item) => item.status === "pending" || new Date(item.updatedAt ?? item.createdAt).getTime() >= queueLimit)
        .slice(-MAX_REQUESTS_KEPT);
      return {
        publications: before.publications - state.publications.length,
        queue: before.queue - state.queue.length,
        offers: before.offers - state.offers.length,
        deliveryEvents: before.deliveryEvents - state.deliveryEvents.length
      };
    });
  }
}
