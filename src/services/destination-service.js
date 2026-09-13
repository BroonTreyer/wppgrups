import { DEFAULT_NICHES } from "../domain/niches.js";
import { MAX_DAILY_POSTS } from "../domain/limits.js";

const defaultsFor = (type, config) => ({
  maxDailyPosts: type === "channel" ? config.limits.maxPostsPerChannelPerDay : config.limits.maxPostsPerGroupPerDay,
  minMinutesBetweenPosts: type === "channel" ? config.limits.channelMinutesBetweenPosts : config.limits.groupMinutesBetweenPosts,
  burstSize: config.limits.postsPerBurst
});

export class DestinationService {
  constructor({ store, zapi, config }) {
    this.store = store;
    this.zapi = zapi;
    this.config = config;
  }

  async sync() {
    const [groups, channels] = await Promise.all([this.zapi.getGroups(), this.zapi.getChannels()]);
    const remote = [
      ...groups.map((item) => ({ id: item.phone, name: item.name, type: "group" })),
      ...channels
        .filter((item) => item.state === "ACTIVE" && item.viewMetadata?.role === "OWNER")
        .map((item) => ({ id: item.id, name: item.name, type: "channel", inviteLink: item.inviteLink, subscribersCount: Number(item.subscribersCount ?? 0) }))
    ];

    await this.store.update((state) => {
      const remoteIds = new Set(remote.map((item) => item.id));
      for (const destination of state.destinations) {
        if (["group", "channel"].includes(destination.type) && !remoteIds.has(destination.id)) {
          destination.available = false;
          destination.active = false;
        }
      }
      for (const item of remote) {
        const existing = state.destinations.find((destination) => destination.id === item.id);
        if (existing) Object.assign(existing, item, { available: true, lastSyncedAt: new Date().toISOString() });
        else state.destinations.push({
          ...item,
          ...defaultsFor(item.type, this.config),
          nicheIds: ["general"],
          active: false,
          available: true,
          minDiscount: item.type === "channel" ? 5 : 10,
          lastSyncedAt: new Date().toISOString()
        });
      }
    });
    return this.list();
  }

  async list() {
    return (await this.store.read()).destinations;
  }

  async configure(id, patch) {
    return this.store.update((state) => {
      const destination = state.destinations.find((item) => item.id === id);
      if (!destination) throw new Error("Destino nao encontrado");
      if (patch.active !== undefined) {
        if (typeof patch.active !== "boolean") throw new Error("active deve ser booleano");
        if (patch.active && destination.available === false) throw new Error("Sincronize novamente antes de ativar um destino indisponivel");
        destination.active = patch.active;
      }
      // `maxDailyPosts: null` = SEM TETO, e precisa passar antes do laco: la o
      // `Number(null)` vira 0 e cai fora da faixa, entao a unica forma de dizer
      // "sem limite" seria recusada. Quem consome nao pode ler o campo cru — ver
      // `dailyCap` em domain/limits.js.
      //
      // O teto de `maxDailyPosts` era 500, de quando um canal fazia 60 por dia.
      // Subiu para 1000 em 11/09/2026, com a operacao indo para 600 por destino.
      // Hoje o numero e so guarda contra digito a mais: quem opera sem limite usa
      // `null`, que e explicito e nao se confunde com engano de digitacao.
      //
      // `burstSize` vai ate 50 e nao mais: sao mensagens seguidas na tela de quem
      // esta no grupo, e o custo de exagerar aqui aparece na saida de membro, nao
      // em nenhuma metrica do sistema.
      const semTetoPedido = patch.maxDailyPosts === null;
      if (semTetoPedido) destination.maxDailyPosts = null;
      for (const [field, min, max] of [["minDiscount", 0, 100], ["maxDailyPosts", 1, MAX_DAILY_POSTS], ["maxPrice", 0, 1000000], ["minSold", 0, 1000000], ["burstSize", 1, 50], ["brandCooldownPosts", 0, 20]]) {
        if (patch[field] === undefined) continue;
        if (field === "maxDailyPosts" && semTetoPedido) continue;
        const value = Number(patch[field]);
        if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${field} deve ser um inteiro entre ${min} e ${max}`);
        destination[field] = value;
      }
      // O intervalo aceita fracao: 0.1 = 6 segundos. Exigir inteiro aqui deixava o
      // painel sem como pedir rajada rapida, mesmo o motor ja sabendo faze-la.
      if (patch.minMinutesBetweenPosts !== undefined) {
        const value = Number(patch.minMinutesBetweenPosts);
        if (!Number.isFinite(value) || value < 0 || value > 1440) throw new Error("minMinutesBetweenPosts deve ser um numero entre 0 e 1440");
        destination.minMinutesBetweenPosts = value;
      }
      // Exigir loja oficial da marca. Serve a canal que se vende como curadoria
      // de marca ("so original"), ao preco de cortar ~70% da vitrine — por isso
      // e escolha por destino, nunca regra do sistema.
      if (patch.requireOfficialStore !== undefined) {
        if (typeof patch.requireOfficialStore !== "boolean") throw new Error("requireOfficialStore deve ser booleano");
        destination.requireOfficialStore = patch.requireOfficialStore;
      }
      if (patch.nicheIds !== undefined) {
        if (!Array.isArray(patch.nicheIds) || !patch.nicheIds.length) throw new Error("Selecione pelo menos um nicho");
        const validIds = new Set(DEFAULT_NICHES.map((item) => item.id));
        if (patch.nicheIds.some((item) => !validIds.has(item))) throw new Error("Um ou mais nichos sao invalidos");
        destination.nicheIds = [...new Set(patch.nicheIds)];
      }
      return destination;
    });
  }

  async addTestDestination(input) {
    if (!input.id || !input.name) throw new Error("id e name sao obrigatorios");
    return this.store.update((state) => {
      const existing = state.destinations.find((item) => item.id === input.id);
      if (existing) throw new Error("Destino ja cadastrado");
      const destination = {
        id: input.id, name: input.name, type: "test", nicheIds: input.nicheIds ?? ["general"],
        active: true, minDiscount: 0, maxDailyPosts: 100, minMinutesBetweenPosts: 0
      };
      state.destinations.push(destination);
      return destination;
    });
  }
}
