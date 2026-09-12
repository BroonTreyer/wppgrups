import { readFile } from "node:fs/promises";
import { decorateAffiliateUrl, isAttributedLink } from "../domain/affiliate.js";
import { productKey } from "../domain/offer.js";

const SESSION_MARKERS = ["/login", "identification_challenge", "captcha", "signin"];
const MAX_CACHE = 20_000;
const MAX_REQUESTS = 500;
const MAX_ATTEMPTS = 3;

const findLink = (payload, depth = 0) => {
  if (depth > 6 || payload === null || payload === undefined) return null;
  if (typeof payload === "string") return isAttributedLink(payload) ? payload : null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findLink(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof payload !== "object") return null;
  for (const value of Object.values(payload)) {
    const found = findLink(value, depth + 1);
    if (found) return found;
  }
  return null;
};

export class SessionExpiredError extends Error {
  constructor(message) { super(message); this.name = "SessionExpiredError"; }
}

export class AffiliateLinkService {
  constructor({ store, config, fetchImpl = fetch, clock = () => new Date(), builderFile } = {}) {
    this.store = store;
    this.config = config;
    this.fetch = fetchImpl;
    this.clock = clock;
    this.builderFile = builderFile ?? new URL("../../data/linkbuilder.json", import.meta.url);
    this.builder = undefined;
  }

  async loadBuilder() {
    if (this.builder !== undefined) return this.builder;
    try {
      const parsed = JSON.parse(await readFile(this.builderFile, "utf8"));
      this.builder = parsed?.url ? parsed : null;
    } catch {
      this.builder = null;
    }
    return this.builder;
  }

  async extensionOnline(state) {
    const seenAt = state.affiliateStatus?.extensionSeenAt;
    if (!seenAt) return false;
    return this.clock().getTime() - new Date(seenAt).getTime() < this.config.affiliate.extensionTimeoutMinutes * 60_000;
  }

  async mode(state) {
    const current = state ?? await this.store.read();
    if (await this.loadBuilder()) return "linkbuilder";
    if (await this.extensionOnline(current)) return "extension";
    if (this.config.affiliates?.["Mercado Livre"] && this.config.affiliate.allowParamLinks) return "params";
    if (this.config.allowUntaggedLinks) return "untagged";
    return "none";
  }

  async status() {
    const state = await this.store.read();
    const requests = state.affiliateRequests ?? [];
    const falhas = requests.filter((item) => item.status === "failed");
    // O erro de um PEDIDO nunca subia para o status: `lastError` so era escrito
    // por `markSession`, que trata apenas sessao expirada. Em 09/09/2026 a aba
    // saiu do gerador e a extensao falhou 256 vezes seguidas com a mesma
    // mensagem — e o painel respondeu "online, sessao valida, sem erro" durante
    // as oito horas em que nada foi publicado. Status que mente e pior que
    // status nenhum: some o unico sinal de que ha algo para consertar.
    const ultimaFalha = falhas.toSorted((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)))[0];
    const erroDeSessao = state.affiliateStatus?.lastError ?? null;
    return {
      mode: await this.mode(state),
      cachedLinks: state.affiliateLinks.length,
      pendingLinks: requests.filter((item) => item.status === "pending").length,
      failedLinks: falhas.length,
      extensionSeenAt: state.affiliateStatus?.extensionSeenAt ?? null,
      extensionOnline: await this.extensionOnline(state),
      sessionValid: state.affiliateStatus?.sessionValid !== false,
      lastError: erroDeSessao ?? ultimaFalha?.error ?? null,
      lastErrorAt: erroDeSessao ? state.affiliateStatus?.lastErrorAt : (ultimaFalha?.updatedAt ?? null),
      // Quantas falhas seguem sem explicacao lida: e este numero que diz se a
      // extensao esta de fato trabalhando ou so respondendo ao ping.
      healthy: falhas.length === 0 || Boolean(this.paramLinkAvailable())
    };
  }

  /** Ha rede de seguranca por parametros para este marketplace? */
  paramLinkAvailable() {
    return this.config.affiliate.allowParamLinks && Object.keys(this.config.affiliates ?? {}).length > 0;
  }

  async cached(key) {
    const state = await this.store.read();
    return state.affiliateLinks.find((item) => item.key === key)?.url ?? null;
  }

  async remember(key, url) {
    await this.store.update((state) => {
      state.affiliateLinks = state.affiliateLinks.filter((item) => item.key !== key).slice(-MAX_CACHE);
      state.affiliateLinks.push({ key, url, createdAt: this.clock().toISOString() });
    });
  }

  async markSession(valid, error = null) {
    await this.store.update((state) => {
      state.affiliateStatus = { ...(state.affiliateStatus ?? {}), sessionValid: valid, lastError: error, lastErrorAt: error ? this.clock().toISOString() : null };
    });
  }

  async touchExtension(erro = null) {
    return this.store.update((state) => {
      const anterior = state.affiliateStatus ?? {};
      state.affiliateStatus = {
        ...anterior,
        extensionSeenAt: this.clock().toISOString(),
        // O erro so e sobrescrito quando ha um novo: assim o motivo da ultima
        // parada sobrevive aos pings seguintes, em vez de ser apagado pelo
        // primeiro ciclo silencioso depois dela.
        ...(erro ? { extensionError: erro, extensionErrorAt: this.clock().toISOString() } : {}),
      };
      return state.affiliateStatus;
    });
  }

  /**
   * O link por parametros — que NAO serve para publicar.
   *
   * Colar `matt_word`/`matt_tool` numa URL de produto nao gera atribuicao: falta
   * o `ref` assinado pelo servidor do Mercado Livre, e so o gerador do painel o
   * produz. Isto esteve ligado como rede de seguranca em 10 e 11/09/2026 e saiu
   * em 786 publicacoes que provavelmente nao pagaram comissao nenhuma.
   *
   * `isAttributedLink` passou a recusar esse formato, entao este metodo devolve
   * null na pratica. Fica aqui, e so aqui, para o dia em que houver um gerador
   * alternativo de verdade — e devolvendo null e o que garante que ninguem o use
   * por engano.
   */
  paramLink(offer) {
    if (!this.config.affiliate.allowParamLinks) return null;
    const params = this.config.affiliates?.[offer.marketplace];
    if (!params) return null;
    const url = decorateAffiliateUrl(offer.affiliateUrl, params);
    return isAttributedLink(url) ? url : null;
  }

  async linkFor(offer) {
    const key = productKey(offer);
    const cachedUrl = await this.cached(key);
    if (cachedUrl) return { url: cachedUrl, attributed: true, mode: "cache", cached: true };

    const mode = await this.mode();
    if (mode === "untagged") return { url: offer.affiliateUrl, attributed: false, mode };
    if (mode === "none") throw new Error(`Configure o link de afiliado de ${offer.marketplace} antes de publicar`);
    if (mode === "params") {
      const url = this.paramLink(offer);
      if (!url) throw new Error("Os parametros configurados nao produzem um link de afiliado valido");
      return { url, attributed: true, mode };
    }
    if (mode === "extension") {
      // A extensao gera um link por vez, presa a uma aba: na pratica algumas
      // centenas por hora, no melhor dia. Quando a fila de pedidos passa do que
      // ela consegue vazar, insistir so aumenta a espera de TODO mundo — o
      // volume do dia inteiro passa a depender de um gargalo de um item so.
      // Acima do limite, o link sai por parametros na hora; a extensao segue
      // cuidando do backlog que couber nela.
      const limite = this.config.affiliate.extensionBacklogLimit ?? 0;
      if (limite > 0) {
        const state = await this.store.read();
        const esperando = (state.affiliateRequests ?? []).filter((item) => item.status === "pending").length;
        if (esperando >= limite) {
          const url = this.paramLink(offer);
          if (url) return { url, attributed: true, mode: "params-backlog" };
        }
      }
      // A extensao gera o link MELHOR (o `ref` assinado do painel), mas gera um
      // de cada vez, presa a uma aba aberta: em 09/09 ela falhou 256 vezes
      // seguidas e a fila inteira ficou em `awaiting-link` por 8 horas. Quem ja
      // fracassou nao pode segurar a oferta de novo — cai para os parametros,
      // que atribuem igual e nunca dependem do navegador.
      const gastou = await this.exhaustedRequest(key);
      if (gastou) {
        const url = this.paramLink(offer);
        if (url) return { url, attributed: true, mode: "params-fallback" };
      }
      await this.request(key, offer.affiliateUrl, offer.title);
      return { url: offer.affiliateUrl, attributed: false, mode, pending: true };
    }
    const url = await this.build(offer.affiliateUrl);
    await this.remember(key, url);
    await this.markSession(true);
    return { url, attributed: true, mode };
  }

  /**
   * Destrava a fila parada por link que a extensao nunca vai entregar.
   *
   * Roda no ciclo do agendador porque a falha nem sempre passa por `resolve`:
   * a aba pode ter sumido no meio do pedido, e ai ninguem avisa nada. Sem esta
   * varredura o item so sairia de `awaiting-link` por intervencao manual.
   */
  async rescueAwaitingLink() {
    const state = await this.store.read();
    const presos = state.queue.filter((item) => item.status === "awaiting-link");
    if (!presos.length) return { rescued: 0 };
    const perdidas = new Set(
      (state.affiliateRequests ?? [])
        .filter((item) => item.status === "failed" && item.attempts >= MAX_ATTEMPTS)
        .map((item) => item.key)
    );
    return this.store.update((current) => {
      let rescued = 0;
      for (const item of current.queue) {
        if (item.status !== "awaiting-link" || !perdidas.has(item.productKey)) continue;
        const url = this.paramLink(item.offer);
        if (!url) {
          // Sem link que ATRIBUA, a oferta encerra. Publicar sem atribuicao e
          // pior que nao publicar: a oferta se gasta, o leitor compra e o dono
          // do canal nao recebe nada. Foi o que aconteceu em 786 publicacoes de
          // 10 e 11/09/2026, quando esta varredura trocava o link por um de
          // parametros e dava o item por resolvido.
          item.status = "expired";
          item.lastDeferredReason = "O gerador de links do painel nao atribuiu esta oferta";
          continue;
        }
        item.offer.affiliateUrl = url;
        item.status = "queued";
        item.lastDeferredReason = null;
        rescued += 1;
      }
      return { rescued };
    });
  }

  /** Este produto ja esgotou as tentativas da extensao? */
  async exhaustedRequest(key) {
    const state = await this.store.read();
    const request = (state.affiliateRequests ?? []).find((item) => item.key === key);
    return Boolean(request && request.status === "failed" && request.attempts >= MAX_ATTEMPTS);
  }

  async request(key, productUrl, title = "") {
    return this.store.update((state) => {
      state.affiliateRequests = state.affiliateRequests ?? [];
      const existing = state.affiliateRequests.find((item) => item.key === key);
      if (existing) {
        if (existing.status === "failed" && existing.attempts < MAX_ATTEMPTS) existing.status = "pending";
        return existing;
      }
      const created = { id: crypto.randomUUID(), key, productUrl, title, status: "pending", attempts: 0, createdAt: this.clock().toISOString() };
      const vivos = state.affiliateRequests.filter((item) => item.status === "pending" || item.status === "failed");
      // O teto corta pelas FALHAS, nunca pelos pendentes. O `slice(-500)` antigo
      // cortava os mais antigos fossem quais fossem, e um pedido pendente
      // descartado no meio do caminho e um link que a extensao vai devolver para
      // um registro que nao existe mais. Falha ja resolvida e historico; pedido
      // pendente e trabalho em andamento.
      const pendentes = vivos.filter((item) => item.status === "pending");
      const falhas = vivos.filter((item) => item.status === "failed");
      const espaco = Math.max(0, MAX_REQUESTS - pendentes.length - 1);
      // `slice(-0)` devolve o array INTEIRO, nao um vazio: sem este ternario, o
      // caso em que nao sobra espaco nenhum e justamente o que preserva todas as
      // falhas.
      state.affiliateRequests = [...(espaco > 0 ? falhas.slice(-espaco) : []), ...pendentes, created];
      return created;
    });
  }

  async retryFailed() {
    return this.store.update((state) => {
      let reset = 0;
      for (const item of state.affiliateRequests ?? []) {
        if (item.status !== "failed" && !(item.status === "pending" && item.attempts > 0)) continue;
        item.status = "pending";
        item.attempts = 0;
        item.error = null;
        reset += 1;
      }
      return { reset };
    });
  }

  async pending(limit = 5) {
    const state = await this.store.read();
    return (state.affiliateRequests ?? [])
      .filter((item) => item.status === "pending")
      .slice(0, Math.min(Math.max(Number(limit) || 1, 1), 25))
      .map(({ id, key, productUrl, title, attempts }) => ({ id, key, productUrl, title, attempts }));
  }

  async resolve({ id, link, error }) {
    const state = await this.store.read();
    const request = (state.affiliateRequests ?? []).find((item) => item.id === id);
    if (!request) throw new Error("Pedido de link nao encontrado");
    if (error) {
      const resgatados = await this.store.update((current) => {
        const target = current.affiliateRequests.find((item) => item.id === id);
        target.attempts += 1;
        target.status = target.attempts >= MAX_ATTEMPTS ? "failed" : "pending";
        target.error = String(error).slice(0, 300);
        target.updatedAt = this.clock().toISOString();
        if (target.status !== "failed") return 0;
        // Fim da linha para a extensao neste produto. Sem isto o item morre em
        // `awaiting-link` sem que nada o olhe de novo — foi assim que 71 ofertas
        // ficaram paradas enquanto a ingestao seguia enchendo a fila.
        let total = 0;
        for (const item of current.queue) {
          if (item.productKey !== request.key || item.status !== "awaiting-link") continue;
          const url = this.paramLink(item.offer);
          if (!url) {
            // Sem link que atribua, a oferta ENCERRA. Deixar em `awaiting-link`
            // a faria ocupar vaga para sempre; publicar com parametros a faria
            // sair sem comissao. Encerrar e a unica saida honesta das duas.
            item.status = "expired";
            item.lastDeferredReason = "O gerador de links do painel nao atribuiu esta oferta";
            continue;
          }
          item.offer.affiliateUrl = url;
          item.status = "queued";
          item.lastDeferredReason = null;
          total += 1;
        }
        return total;
      });
      return { status: "failed", key: request.key, rescued: resgatados };
    }
    if (!isAttributedLink(link)) throw new Error("O link recebido nao e um link de afiliado valido");
    await this.remember(request.key, link);
    await this.store.update((current) => {
      // O pedido pode ter saido da lista entre a leitura e esta escrita: o teto
      // de MAX_REQUESTS descarta os mais antigos, e a colheita da extensao cria
      // pedidos as dezenas. Quando isso acontecia, o caminho de SUCESSO quebrava
      // com "Cannot set properties of undefined (setting 'status')" — e o link,
      // que ja fora salvo no cache pela linha acima, aparecia como erro.
      const target = current.affiliateRequests.find((item) => item.id === id);
      if (target) {
        target.status = "done";
        target.link = link;
        target.updatedAt = this.clock().toISOString();
      }
      // A fila e destravada de qualquer forma: o que importa e o LINK, nao o
      // registro do pedido que o produziu.
      for (const item of current.queue) {
        if (item.productKey !== request.key || item.status !== "awaiting-link") continue;
        item.offer.affiliateUrl = link;
        item.status = "queued";
        item.lastDeferredReason = null;
      }
    });
    return { status: "done", key: request.key, link };
  }

  async build(productUrl) {
    const builder = await this.loadBuilder();
    const body = builder.body ? JSON.stringify(JSON.parse(JSON.stringify(builder.body).replaceAll("{{url}}", productUrl))) : undefined;
    const target = builder.url.replaceAll("{{url}}", encodeURIComponent(productUrl));
    const response = await this.fetch(target, {
      method: builder.method ?? "POST",
      headers: builder.headers ?? {},
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(20_000)
    });
    const text = await response.text();
    if ([301, 302, 303, 307, 308, 401, 403].includes(response.status) || SESSION_MARKERS.some((marker) => text.includes(marker))) {
      await this.markSession(false, `Sessao do painel de afiliados expirada (HTTP ${response.status}). Atualize o cookie em data/linkbuilder.json.`);
      throw new SessionExpiredError("Sessao do painel de afiliados expirada");
    }
    if (!response.ok) {
      await this.markSession(false, `Gerador de links respondeu ${response.status}`);
      throw new Error(`Gerador de links respondeu ${response.status}`);
    }
    let payload;
    try { payload = JSON.parse(text); } catch { payload = text; }
    const link = findLink(payload);
    if (!link) {
      await this.markSession(false, "Resposta do gerador nao trouxe um link de afiliado reconhecivel");
      throw new Error("Resposta do gerador nao trouxe um link de afiliado reconhecivel");
    }
    return link;
  }
}
