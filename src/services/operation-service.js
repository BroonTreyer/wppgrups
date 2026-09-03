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

  async setDailyLimit(value, { onlyActive = true } = {}) {
    const limit = Number(value);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("maxDailyPosts deve ser um inteiro entre 1 e 500");
    const interval = this.intervalFor(limit);
    const feasible = Math.floor(this.windowMinutes() / interval);
    return this.store.update((state) => {
      const changed = [];
      for (const destination of state.destinations) {
        if (onlyActive && !destination.active) continue;
        destination.maxDailyPosts = limit;
        destination.minMinutesBetweenPosts = interval;
        changed.push(destination.id);
      }
      return { maxDailyPosts: limit, minMinutesBetweenPosts: interval, feasiblePerDay: Math.min(limit, feasible), destinations: changed.length };
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
      return {
        minMinutesBetweenPosts: destination.minMinutesBetweenPosts,
        feasibleToday: Math.min(destination.maxDailyPosts, publishedToday + stillFits),
        id: destination.id,
        name: destination.name || destination.id,
        type: destination.type,
        maxDailyPosts: destination.maxDailyPosts,
        publishedToday,
        remainingToday: Math.max(0, destination.maxDailyPosts - publishedToday),
        nextAvailableAt: nextAvailableAt && nextAvailableAt > now ? nextAvailableAt.toISOString() : null
      };
    });
    const perDayByInterval = destinations.length ? Math.floor(this.windowMinutes() / Math.max(1, Math.min(...destinations.map((item) => item.minMinutesBetweenPosts)))) : 0;
    const overbooked = destinations.filter((item) => item.maxDailyPosts > Math.floor(this.windowMinutes() / Math.max(1, item.minMinutesBetweenPosts)));
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
      limitToday: destinations.reduce((total, item) => total + item.maxDailyPosts, 0),
      perDayByInterval,
      overbooked: overbooked.map((item) => ({ name: item.name, maxDailyPosts: item.maxDailyPosts, minMinutesBetweenPosts: item.minMinutesBetweenPosts, realistic: Math.floor(this.windowMinutes() / Math.max(1, item.minMinutesBetweenPosts)) })),
      activeDestinations: destinations.length,
      destinations
    };
  }
}
