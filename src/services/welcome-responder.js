import { createHash } from "node:crypto";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const ehPessoa = (chat) => /^\d{10,15}$/.test(String(chat.phone ?? "")) && String(chat.isGroup) !== "true";
const MAX_ATTEMPTS = 3;
const MAX_REPLIES_KEPT = 5000;

/**
 * Responde quem chega pelo anuncio de clique para WhatsApp com o link do grupo.
 *
 * Existe porque o dono exigiu zero trabalho manual para quem clica: anuncio de
 * SITE nunca abre o convite de grupo dentro do Instagram no iPhone. O anuncio de
 * mensagem abre o WhatsApp nativo em qualquer celular; esta resposta entrega o
 * link, e link recebido DENTRO do WhatsApp abre o convite sem navegador nenhum.
 *
 * Por leitura da lista de conversas, nao por webhook: o webhook de mensagens
 * recebidas desta instancia pertence a uma automacao do Make, e /chat-messages
 * nao funciona em multi-device. Sem o texto da mensagem, o criterio e: conversa
 * com PESSOA que o bot nunca viu, com mensagem nao lida, chegada depois da foto
 * inicial. Na primeira execucao ele so fotografa — nenhuma conversa antiga recebe
 * resposta.
 *
 * O telefone nunca e gravado: o store guarda o hash, que basta para "ja vi".
 */
export class WelcomeResponder {
  constructor({ store, zapi, config, clock = () => new Date(), pause = (ms) => new Promise((r) => setTimeout(r, ms)), logger = console }) {
    this.store = store;
    this.zapi = zapi;
    this.config = config;
    this.clock = clock;
    this.pause = pause;
    this.logger = logger;
  }

  get cfg() {
    return this.config.welcome;
  }

  async tick() {
    const welcome = (await this.store.read()).welcome ?? {};
    if (!welcome.baselineAt) return this.baseline();

    const chats = await this.zapi.getChats({ page: 1, pageSize: this.cfg.scanSize });
    if (!Array.isArray(chats)) throw new Error("Z-API /chats nao devolveu uma lista");

    const conhecidos = new Set(welcome.known ?? []);
    const tentativas = welcome.attempts ?? {};
    const inicio = Date.parse(welcome.baselineAt);
    const vistos = [];
    const respostas = [];
    const falhas = {};
    let enviados = 0;

    for (const chat of chats) {
      if (!ehPessoa(chat)) continue;
      const hash = sha256(String(chat.phone));
      if (conhecidos.has(hash)) continue;

      const chegouDepois = Number(chat.lastMessageTime) >= inicio;
      const escreveu = Number(chat.messagesUnread) > 0 || String(chat.unread) === "true";
      if (!chegouDepois || !escreveu) {
        // Conversa antiga que estava fora da foto, ou aberta pelo proprio admin: nunca responder.
        vistos.push(hash);
        continue;
      }
      // Teto por rodada: o resto fica para a proxima, sem ser marcado como visto.
      if (enviados >= this.cfg.maxPerTick) continue;

      try {
        if (!this.cfg.dryRun) await this.zapi.sendText({ destinationId: String(chat.phone), message: this.cfg.message });
        enviados += 1;
        vistos.push(hash);
        respostas.push({ phoneHash: hash, at: this.clock().toISOString(), status: this.cfg.dryRun ? "dry-run" : "sent" });
        await this.pause(1200);
      } catch (error) {
        const n = (tentativas[hash] ?? 0) + 1;
        falhas[hash] = n;
        respostas.push({ phoneHash: hash, at: this.clock().toISOString(), status: "failed", attempt: n, error: error.message });
        if (n >= MAX_ATTEMPTS) vistos.push(hash);
      }
    }

    if (vistos.length || respostas.length) {
      await this.store.update((state) => {
        const w = (state.welcome ??= {});
        w.known = [...new Set([...(w.known ?? []), ...vistos])];
        w.attempts = { ...(w.attempts ?? {}), ...falhas };
        for (const hash of vistos) delete w.attempts[hash];
        w.replies = [...(w.replies ?? []), ...respostas].slice(-MAX_REPLIES_KEPT);
        w.lastTickAt = this.clock().toISOString();
      });
    }
    return {
      replied: respostas.filter((r) => r.status !== "failed").length,
      failed: respostas.filter((r) => r.status === "failed").length,
      dryRun: this.cfg.dryRun
    };
  }

  // Foto inicial: toda conversa com pessoa que ja existe fica marcada como vista.
  async baseline() {
    const hashes = [];
    for (let page = 1; page <= 100; page += 1) {
      const chats = await this.zapi.getChats({ page, pageSize: 100 });
      if (!Array.isArray(chats)) throw new Error("Z-API /chats nao devolveu uma lista na foto inicial");
      for (const chat of chats) if (ehPessoa(chat)) hashes.push(sha256(String(chat.phone)));
      if (chats.length < 100) break;
    }
    const agora = this.clock().toISOString();
    await this.store.update((state) => {
      state.welcome = { baselineAt: agora, known: [...new Set(hashes)], attempts: {}, replies: [] };
    });
    return { baseline: hashes.length };
  }

  async status() {
    const w = (await this.store.read()).welcome ?? {};
    const replies = w.replies ?? [];
    return {
      enabled: this.cfg.enabled,
      dryRun: this.cfg.dryRun,
      baselineAt: w.baselineAt ?? null,
      knownChats: (w.known ?? []).length,
      replies: {
        sent: replies.filter((r) => r.status === "sent").length,
        dryRun: replies.filter((r) => r.status === "dry-run").length,
        failed: replies.filter((r) => r.status === "failed").length,
        last: replies.slice(-5).map(({ at, status, error }) => ({ at, status, error }))
      }
    };
  }
}
