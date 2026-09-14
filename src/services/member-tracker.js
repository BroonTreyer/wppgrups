import { createHash } from "node:crypto";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const digits = (value) => String(value ?? "").replace(/\D/g, "");

const MAX_JOINS_KEPT = 5000;
const MAX_ATTEMPTS = 20;
const BATCH = 500;
// O Meta recusa evento com mais de 7 dias. Uma hora de folga para o relogio.
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000;
// Resposta que encolhe o grupo de uma vez e quase sempre falha da Z-API, nao
// debandada. Aceita-la faria a leitura cheia seguinte parecer uma leva de
// entradas — e cada uma viraria conversao paga no Meta.
const SUSPICIOUS_DROP = 0.3;

// Mede quem ENTROU de fato no grupo, comparando a lista de participantes entre
// uma leitura e a seguinte, e manda cada entrada ao Meta pela API de Conversoes.
// Por leitura periodica e nao por webhook: os webhooks da instancia pertencem a
// automacoes do Make e trocar a URL quebraria as duas coisas.
//
// Nenhum telefone e gravado: o store guarda so o hash, que e exatamente o que o
// Meta pede. Serve para comparar listas e para casar a pessoa com a conta dela.
export class MemberTracker {
  constructor({ store, zapi, capi, config, clock = () => new Date(), logger = console }) {
    this.store = store;
    this.zapi = zapi;
    this.capi = capi;
    this.config = config;
    this.clock = clock;
    this.logger = logger;
  }

  async tick() {
    const groups = [];
    for (const groupId of this.config.meta.trackedGroups) {
      groups.push(await this.syncGroup(groupId).catch((error) => ({ groupId, error: error.message })));
    }
    return { groups, ...(await this.flush()) };
  }

  async syncGroup(groupId) {
    const metadata = await this.zapi.getGroupMetadata(groupId);
    const phones = (metadata.participants ?? []).map((item) => digits(item.phone)).filter((phone) => phone.length >= 10);
    // Lista vazia nunca e "todo mundo saiu": e resposta quebrada.
    if (!phones.length) throw new Error(`Z-API devolveu o grupo ${groupId} sem participantes`);
    const now = this.clock().toISOString();
    const current = new Map(phones.map((phone) => [sha256(phone), phone]));

    return this.store.update((state) => {
      const tracking = (state.memberTracking ??= {});
      tracking.groups ??= {};
      tracking.joins ??= [];
      const group = tracking.groups[groupId];

      // Primeira leitura so fotografa. Quem ja estava no grupo nao veio do anuncio.
      if (!group) {
        tracking.groups[groupId] = { name: metadata.subject ?? null, members: [...current.keys()], baselineAt: now, lastSyncAt: now };
        return { groupId, baseline: current.size, joined: 0, left: 0 };
      }

      if (current.size < group.members.length * (1 - SUSPICIOUS_DROP)) {
        group.lastSuspiciousAt = now;
        return { groupId, ignored: true, reason: `leitura com ${current.size} de ${group.members.length} membros conhecidos` };
      }

      const known = new Set(group.members);
      const everJoined = new Set(tracking.joins.filter((join) => join.groupId === groupId).map((join) => join.phoneHash));
      let joined = 0;
      for (const [hash, phone] of current) {
        if (known.has(hash)) continue;
        // Quem sai e volta nao e membro novo: conta-lo de novo pagaria duas vezes a mesma pessoa.
        if (everJoined.has(hash)) continue;
        joined += 1;
        tracking.joins.push({
          id: `${groupId}:${hash.slice(0, 32)}`, groupId, phoneHash: hash,
          country: phone.startsWith("55") ? "br" : null,
          joinedAt: now, status: "pending", attempts: 0
        });
      }
      const left = group.members.filter((hash) => !current.has(hash)).length;
      group.members = [...current.keys()];
      group.name = metadata.subject ?? group.name;
      group.lastSyncAt = now;
      if (tracking.joins.length > MAX_JOINS_KEPT) tracking.joins = tracking.joins.slice(-MAX_JOINS_KEPT);
      return { groupId, members: current.size, joined, left };
    });
  }

  // Entradas ficam pendentes enquanto nao houver token: o Meta aceita ate 7 dias
  // de atraso, entao o que foi medido antes do token ainda chega a otimizacao.
  async flush() {
    const state = await this.store.read();
    const now = this.clock().getTime();
    const pending = (state.memberTracking?.joins ?? []).filter((join) => join.status === "pending");
    if (!pending.length) return { sent: 0, pending: 0 };

    const expired = pending.filter((join) => now - Date.parse(join.joinedAt) > MAX_EVENT_AGE_MS).map((join) => join.id);
    const ready = pending.filter((join) => !expired.includes(join.id)).slice(0, BATCH);
    if (expired.length) await this.mark(expired, { status: "expired", lastError: "mais de 7 dias sem envio; o Meta recusa" });
    if (!this.capi?.configured || !ready.length) return { sent: 0, pending: ready.length, expired: expired.length };

    const groupNames = state.memberTracking.groups ?? {};
    const events = ready.map((join) => ({
      event_name: this.config.meta.eventName,
      event_time: Math.floor(Date.parse(join.joinedAt) / 1000),
      event_id: join.id,
      action_source: "website",
      event_source_url: this.config.meta.eventSourceUrl,
      user_data: {
        ph: [join.phoneHash],
        external_id: [join.phoneHash],
        ...(join.country ? { country: [sha256(join.country)] } : {})
      },
      custom_data: { content_name: groupNames[join.groupId]?.name ?? join.groupId }
    }));

    try {
      await this.capi.send(events);
      await this.mark(ready.map((join) => join.id), { status: "sent", sentAt: this.clock().toISOString(), lastError: null });
      return { sent: ready.length, pending: 0, expired: expired.length };
    } catch (error) {
      await this.store.update((draft) => {
        for (const join of draft.memberTracking.joins) {
          if (!ready.some((item) => item.id === join.id)) continue;
          join.attempts += 1;
          join.lastError = error.message;
          if (join.attempts >= MAX_ATTEMPTS) join.status = "failed";
        }
      });
      return { sent: 0, pending: ready.length, expired: expired.length, error: error.message };
    }
  }

  async mark(ids, patch) {
    const wanted = new Set(ids);
    await this.store.update((state) => {
      for (const join of state.memberTracking?.joins ?? []) if (wanted.has(join.id)) Object.assign(join, patch);
    });
  }

  async status() {
    const tracking = (await this.store.read()).memberTracking ?? {};
    const joins = tracking.joins ?? [];
    const byDay = {};
    for (const join of joins) {
      const day = join.joinedAt.slice(0, 10);
      byDay[day] = (byDay[day] ?? 0) + 1;
    }
    const count = (status) => joins.filter((join) => join.status === status).length;
    return {
      capiConfigured: Boolean(this.capi?.configured),
      testMode: Boolean(this.config.meta.testEventCode),
      eventName: this.config.meta.eventName,
      groups: Object.fromEntries(Object.entries(tracking.groups ?? {}).map(([id, group]) => [id, {
        name: group.name, members: group.members.length, baselineAt: group.baselineAt, lastSyncAt: group.lastSyncAt, lastSuspiciousAt: group.lastSuspiciousAt ?? null
      }])),
      joins: { total: joins.length, sent: count("sent"), pending: count("pending"), failed: count("failed"), expired: count("expired"), byDay },
      lastError: joins.findLast((join) => join.lastError)?.lastError ?? null
    };
  }
}
