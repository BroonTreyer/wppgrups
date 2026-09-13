import { MAX_DAILY_POSTS, dailyCap, postsPerHour, semTeto } from "../domain/limits.js";

const today = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(date);

export class OperationService {
  constructor({ store, config, clock = () => new Date() }) {
    this.store = store;
    this.config = config;
    this.clock = clock;
  }

  async isRunning() {
    return (await this.store.read()).operation?.running === true;
  }

  async setRunning(running) {
    if (typeof running !== "boolean") throw new Error("running deve ser booleano");
    return this.store.update((state) => {
      state.operation = { running, updatedAt: this.clock().toISOString() };
      return state.operation;
    });
  }

  windowMinutes() {
    return Math.max(1, (this.config.scheduler.endHour - this.config.scheduler.startHour) * 60);
  }

  intervalFor(limit) {
    return Math.max(this.config.limits.minMinutesFloor, Math.floor(this.windowMinutes() / limit));
  }

  /**
   * `null` remove o teto diario; um inteiro o define.
   *
   * O teto daqui era 500 enquanto o do `destination-service` ja estava em 1000:
   * este caminho passou a RECUSAR o valor que o outro tinha gravado, e usar o
   * painel para qualquer ajuste ABAIXAVA o limite sem avisar. Os dois agora leem
   * o mesmo numero.
   *
   * Sem teto o intervalo fica como esta, de proposito. `intervalFor(null)`
   * dividiria por zero e devolveria Infinity, e o destino sairia daqui com o
   * espacamento destruido — mudanca que ninguem pediu e que cala o grupo.
   */
  async setDailyLimit(value, { onlyActive = true } = {}) {
    const remover = value === null;
    const limit = remover ? null : Number(value);
    if (!remover && (!Number.isInteger(limit) || limit < 1 || limit > MAX_DAILY_POSTS)) {
      throw new Error(`maxDailyPosts deve ser um inteiro entre 1 e ${MAX_DAILY_POSTS}, ou null para sem teto`);
    }
    const interval = remover ? null : this.intervalFor(limit);
    const feasible = remover ? null : Math.floor(this.windowMinutes() / interval);
    return this.store.update((state) => {
      const changed = [];
      for (const destination of state.destinations) {
        if (onlyActive && !destination.active) continue;
        destination.maxDailyPosts = limit;
        if (interval !== null) destination.minMinutesBetweenPosts = interval;
        changed.push(destination.id);
      }
      return {
        maxDailyPosts: limit,
        minMinutesBetweenPosts: interval,
        feasiblePerDay: remover ? null : Math.min(limit, feasible),
        destinations: changed.length
      };
    });
  }

  async setWindow({ start, end }) {
    const startHour = Number(start);
    const endHour = Number(end);
    if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) throw new Error("Hora inicial deve ser um inteiro entre 0 e 23");
    if (!Number.isInteger(endHour) || endHour < 1 || endHour > 24) throw new Error("Hora final deve ser um inteiro entre 1 e 24");
    if (endHour <= startHour) throw new Error("A hora final deve ser maior que a inicial");
    this.config.scheduler.startHour = startHour;
    this.config.scheduler.endHour = endHour;
    await this.store.update((state) => {
      state.operation = { ...(state.operation ?? { running: false }), window: { start: startHour, end: endHour } };
    });
    return { start: startHour, end: endHour, hours: endHour - startHour };
  }

  async restoreWindow() {
    const saved = (await this.store.read()).operation?.window;
    if (!saved) return null;
    this.config.scheduler.startHour = saved.start;
    this.config.scheduler.endHour = saved.end;
    return saved;
  }

  isWithinWindow(now = this.clock()) {
    const hour = Number(new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", hourCycle: "h23", timeZone: "America/Sao_Paulo" }).format(now));
    return hour >= this.config.scheduler.startHour && hour < this.config.scheduler.endHour;
  }

  async status() {
    const now = this.clock();
    const state = await this.store.read();
    const day = today(now);
    const sent = state.publications.filter((item) => item.status === "sent");
    const destinations = state.destinations.filter((item) => item.active).map((destination) => {
      const posts = sent.filter((item) => (item.destinationId ?? item.groupId) === destination.id);
      const last = posts.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const publishedToday = posts.filter((item) => today(new Date(item.createdAt)) === day).length;
      const nextAvailableAt = last ? new Date(new Date(last.createdAt).getTime() + destination.minMinutesBetweenPosts * 60000) : null;
      const minutesLeft = Math.max(0, (this.config.scheduler.endHour - Number(new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", hourCycle: "h23", timeZone: "America/Sao_Paulo" }).format(now))) * 60);
      const stillFits = Math.floor(minutesLeft / Math.max(1, destination.minMinutesBetweenPosts));
      // `stillFits` conta JANELAS restantes; cada uma solta `burstSize` posts.
      const cabeAinda = Math.floor(stillFits * Math.max(1, Number(destination.burstSize) || 1));
      return {
        minMinutesBetweenPosts: destination.minMinutesBetweenPosts,
        burstSize: destination.burstSize ?? 1,
        // Math.min com Infinity devolve o outro lado: sem teto, o que cabe hoje e
        // so o que o ritmo alcanca.
        feasibleToday: Math.min(dailyCap(destination), publishedToday + cabeAinda),
        id: destination.id,
        name: destination.name || destination.id,
        type: destination.type,
        // Na API o "sem teto" e `null`, nunca `Infinity`: JSON.stringify(Infinity)
        // vira `null` de qualquer jeito, mas por acidente — e `Infinity` num
        // campo numerico contamina qualquer soma que o painel faca com ele.
        maxDailyPosts: semTeto(destination) ? null : dailyCap(destination),
        publishedToday,
        remainingToday: semTeto(destination) ? null : Math.max(0, dailyCap(destination) - publishedToday),
        nextAvailableAt: nextAvailableAt && nextAvailableAt > now ? nextAvailableAt.toISOString() : null
      };
    });
    // Capacidade REAL do ritmo, com a rajada. Sem ela estes dois numeros diziam
    // 144/dia enquanto o grupo entregava 1.000 — e `overbooked` acusava de
    // "irrealista" justamente a configuracao que estava funcionando.
    const porHoraDaFrota = destinations.reduce((total, item) => total + postsPerHour(item), 0);
    const perDayByInterval = Math.floor(porHoraDaFrota * this.windowMinutes() / 60);
    const realista = (item) => Math.floor(postsPerHour(item) * this.windowMinutes() / 60);
    // Destino sem teto nunca esta "overbooked": nao ha numero prometido para o
    // ritmo deixar de cumprir.
    const overbooked = destinations.filter((item) => item.maxDailyPosts !== null && item.maxDailyPosts > realista(item));
    const queue = state.queue.reduce((totals, item) => ({ ...totals, [item.status]: (totals[item.status] ?? 0) + 1 }), {});
    return {
      running: state.operation?.running === true,
      updatedAt: state.operation?.updatedAt ?? null,
      dryRun: this.config.dryRun,
      withinWindow: this.isWithinWindow(now),
      window: { start: this.config.scheduler.startHour, end: this.config.scheduler.endHour },
      intervalMinutes: this.config.ingestion.intervalMinutes,
      queue,
      queued: queue.queued ?? 0,
      publishedToday: destinations.reduce((total, item) => total + item.publishedToday, 0),
      capacityToday: destinations.reduce((total, item) => total + item.feasibleToday, 0),
      // Um so destino sem teto torna a soma sem sentido: `null` diz "sem limite
      // de frota", enquanto somar tratando-o como zero inventaria um teto que
      // nao existe e faria o painel anunciar escassez no meio da fartura.
      limitToday: destinations.some((item) => item.maxDailyPosts === null)
        ? null
        : destinations.reduce((total, item) => total + item.maxDailyPosts, 0),
      perDayByInterval,
      overbooked: overbooked.map((item) => ({ name: item.name, maxDailyPosts: item.maxDailyPosts, minMinutesBetweenPosts: item.minMinutesBetweenPosts, realistic: realista(item) })),
      activeDestinations: destinations.length,
      destinations
    };
  }
}
