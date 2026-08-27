const defaultsFor = (type, config) => ({
  maxDailyPosts: type === "channel" ? config.limits.maxPostsPerChannelPerDay : config.limits.maxPostsPerGroupPerDay,
  minMinutesBetweenPosts: type === "channel" ? config.limits.channelMinutesBetweenPosts : config.limits.groupMinutesBetweenPosts
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
      for (const item of remote) {
        const existing = state.destinations.find((destination) => destination.id === item.id);
        if (existing) Object.assign(existing, item, { lastSyncedAt: new Date().toISOString() });
        else state.destinations.push({
          ...item,
          ...defaultsFor(item.type, this.config),
          nicheIds: item.type === "channel" ? ["general"] : ["general"],
          active: true,
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
      const allowed = ["active", "minDiscount", "maxDailyPosts", "minMinutesBetweenPosts"];
      for (const field of allowed) if (patch[field] !== undefined) destination[field] = field === "active" ? Boolean(patch[field]) : Number(patch[field]);
      if (patch.nicheIds) destination.nicheIds = [...new Set(patch.nicheIds)];
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
