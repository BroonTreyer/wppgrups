import { minutesUntilExpiry, productKey, validateOffer } from "../domain/offer.js";
import { inferNiches } from "../domain/niches.js";
import { scoreOffer } from "../domain/scoring.js";
import { scoreForDestination } from "../domain/targeting.js";

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

  /**
   * O destino que deve receber agora, e a melhor oferta PARA ELE.
   *
   * Inverte o motor antigo, que escolhia a melhor oferta da fila e a mandava para
   * todos os destinos que casassem, no mesmo minuto — quatro canais recebendo o
   * mesmo produto as 01:56. Aqui a pergunta e por canal: de tudo que serve para
   * este publico, o que e melhor para ele agora?
   *
   * A vez e de quem esta esperando ha mais tempo. Assim os canais se revezam
   * sozinhos, sem precisar de rodizio explicito, e um canal com muita oferta
   * disponivel nao monopoliza os ciclos.
   */
  async selectTarget() {
    const now = this.clock();
    const state = await this.store.read();
    const prontos = state.queue.filter(
      (entry) => entry.status === "queued" && (!entry.nextAttemptAt || new Date(entry.nextAttemptAt) <= now)
    );
    if (!prontos.length) return null;

    const urgency = (entry) => {
      const restam = minutesUntilExpiry(entry.offer, now);
      return restam !== null && restam <= this.config.freshness.urgentMinutes ? restam : null;
    };

    const publicacoes = state.publications ?? [];
    const ultimaPublicacao = (destinationId) => publicacoes
      .filter((item) => (item.destinationId ?? item.groupId) === destinationId && item.status === "sent")
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));

    const candidatos = [];
    for (const destination of state.destinations ?? []) {
      const recentes = ultimaPublicacao(destination.id);
      const elegiveis = prontos
        // Onde a oferta ja foi entregue nao entra de novo. O `blockReason` tem o
        // cooldown de republicacao, mas ele le o historico de publicacoes — que a
        // retencao poda. O `deliveredTo` vive no proprio item e nao some antes dele.
        .filter((entry) => !(entry.deliveredTo ?? []).includes(destination.id))
        .map((entry) => ({
          entry,
          reason: this.publicationService.blockReason({
            destination, offer: entry.offer, nicheIds: entry.nicheIds,
            publications: publicacoes, now
          })
        }))
        .filter((item) => item.reason === null)
        .map(({ entry }) => ({
          entry,
          score: scoreForDestination(entry.offer, destination, { nicheIds: entry.nicheIds, recent: recentes }),
          urgencia: urgency(entry)
        }))
        // Promocao prestes a acabar fura a fila mesmo com score menor: publicar
        // depois que ela expirou nao vale nada, por melhor que fosse o produto.
        .toSorted((a, b) => {
          if (a.urgencia !== null && b.urgencia !== null) return a.urgencia - b.urgencia || b.score - a.score;
          if (a.urgencia !== null) return -1;
          if (b.urgencia !== null) return 1;
          return b.score - a.score || a.entry.createdAt.localeCompare(b.entry.createdAt);
        });
      if (!elegiveis.length) continue;
      const desde = recentes[0] ? now - new Date(recentes[0].createdAt) : Number.MAX_SAFE_INTEGER;
      candidatos.push({ destination, ...elegiveis[0], esperaMs: desde });
    }
    if (!candidatos.length) return null;
    // Quem espera ha mais tempo tem a vez; empate desfeito pelo score da oferta.
    return candidatos.toSorted((a, b) => b.esperaMs - a.esperaMs || b.score - a.score)[0];
  }

  /**
   * Nada pode sair agora: registra o porque e volta a tentar depois.
   *
   * Antes, "nenhum destino elegivel" so era descoberto DEPOIS de chamar o
   * publish, que devolvia zero destinos. Com a selecao por destino isso e
   * detectado antes — economiza a chamada, mas o motivo sumiria da tela se
   * ninguem o gravasse. Sem `nextAttemptAt` o agendador ainda tentaria a cada
   * ciclo, martelando a fila a cada poucos segundos.
   */
  async deferReady() {
    const now = this.clock();
    const proximaTentativa = new Date(now.getTime() + this.config.scheduler.retryDelayMinutes * 60_000).toISOString();
    const adiados = await this.store.update((state) => {
      let total = 0;
      for (const item of state.queue) {
        if (item.status !== "queued") continue;
        if (item.nextAttemptAt && new Date(item.nextAttemptAt) > now) continue;
        item.nextAttemptAt = proximaTentativa;
        item.lastDeferredReason = "Nenhum destino elegivel neste momento";
        total += 1;
      }
      return total;
    });
    return { processed: false, reason: adiados ? "no-destination" : "empty", deferred: adiados };
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
      let target = await this.selectTarget();
      if (!target) return this.deferReady();
      if (this.priceGuard && !this.priceGuard.isFresh(target.entry, this.clock())) {
        await this.refreshQueue();
        target = await this.selectTarget();
        if (!target) return this.deferReady();
      }
      const item = target.entry;
      const destination = target.destination;
      selectedItem = item;
      await this.store.update((current) => {
        const selected = current.queue.find((entry) => entry.id === item.id);
        selected.status = "processing";
        selected.attempts += 1;
      });
      const result = await this.publicationService.publish({
        ...item.offer, nicheIds: item.nicheIds, destinationId: destination.id
      });
      await this.store.update((current) => {
        const selected = current.queue.find((entry) => entry.id === item.id);
        if (!result.matchedDestinations) {
          selected.status = "queued";
          selected.attempts = Math.max(0, selected.attempts - 1);
          selected.nextAttemptAt = new Date(this.clock().getTime() + this.config.scheduler.retryDelayMinutes * 60_000).toISOString();
          selected.lastDeferredReason = "Nenhum destino elegivel neste momento";
        } else if (result.deliveredDestinations) {
          // A oferta foi para UM destino. Ela so encerra quando todos os canais
          // do nicho dela ja receberam — ate la volta para a fila e sera
          // reavaliada, em outro momento, pelo score do proximo canal. E isso
          // que escalona a mesma oferta entre os canais em vez de dispara-la
          // para todos no mesmo minuto.
          selected.deliveredTo = [...new Set([...(selected.deliveredTo ?? []), destination.id])];
          const faltam = current.destinations.filter((outro) =>
            outro.active && outro.available !== false
            && !selected.deliveredTo.includes(outro.id)
            && (outro.nicheIds ?? []).some((id) => (selected.nicheIds ?? []).includes(id)));
          selected.status = faltam.length ? "queued" : "published";
          selected.attempts = 0;
          selected.nextAttemptAt = null;
          selected.lastDeferredReason = faltam.length
            ? `Publicado em ${destination.name || destination.id}; faltam ${faltam.length} canal(is)`
            : null;
        } else {
          selected.status = selected.attempts >= 3 ? "failed" : "queued";
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
