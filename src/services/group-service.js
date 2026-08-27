export class GroupService {
  constructor({ store, zapi }) {
    this.store = store;
    this.zapi = zapi;
  }

  async sync() {
    const remoteGroups = await this.zapi.getGroups();
    await this.store.update((state) => {
      for (const remote of remoteGroups) {
        const existing = state.groups.find((group) => group.id === remote.phone);
        if (existing) {
          existing.name = remote.name;
          existing.active = true;
          existing.lastSyncedAt = new Date().toISOString();
        } else {
          state.groups.push({
            id: remote.phone, name: remote.name, nicheIds: ["general"], active: true,
            minDiscount: 0, maxDailyPosts: null, lastSyncedAt: new Date().toISOString()
          });
        }
      }
    });
    return this.list();
  }

  async list() {
    return (await this.store.read()).groups;
  }

  async configure(groupId, patch) {
    return this.store.update((state) => {
      const group = state.groups.find((item) => item.id === groupId);
      if (!group) throw new Error("Grupo nao encontrado");
      if (patch.nicheIds) group.nicheIds = [...new Set(patch.nicheIds)];
      if (patch.active !== undefined) group.active = Boolean(patch.active);
      if (patch.minDiscount !== undefined) group.minDiscount = Number(patch.minDiscount);
      if (patch.maxDailyPosts !== undefined) group.maxDailyPosts = patch.maxDailyPosts === null ? null : Number(patch.maxDailyPosts);
      return group;
    });
  }
}
