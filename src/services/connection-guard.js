/**
 * Diz se o WhatsApp esta de fato conectado antes de qualquer envio.
 *
 * Existe por causa da queda de 14/09/2026: o celular do 62 9244-0098 desconectou
 * as 7h55 e, durante ~25 minutos, o bot "publicou" 41 ofertas. A Z-API nao
 * recusava nada — respondia 200 e guardava na fila, para despejar tudo no grupo
 * quando a sessao voltasse, com preco velho. A resposta automatica do anuncio
 * ia pelo mesmo caminho.
 *
 * O status fica em cache por `ttlMs` para nao consultar a Z-API a cada ciclo de
 * 6 segundos. Erro ao consultar conta como desconectado: enviar as cegas e
 * exatamente o que causou o problema.
 */
export class ConnectionGuard {
  constructor({ zapi, ttlMs = 30_000, clock = () => Date.now(), logger = console }) {
    this.zapi = zapi;
    this.ttlMs = ttlMs;
    this.clock = clock;
    this.logger = logger;
    this.cache = null;
    this.ultimoEstado = null;
  }

  async isConnected() {
    const agora = this.clock();
    if (this.cache && agora - this.cache.at < this.ttlMs) return this.cache.ok;

    let ok;
    let motivo = "";
    try {
      const status = await this.zapi.getStatus();
      ok = status?.connected === true && status?.smartphoneConnected !== false;
      if (!ok) motivo = status?.error ?? "sessao desconectada";
    } catch (error) {
      ok = false;
      motivo = `falha ao consultar status: ${error.message}`;
    }
    this.cache = { ok, at: agora };

    // Loga so a TRANSICAO: a cada 30 s repetindo "desconectado" o log vira ruido.
    if (ok !== this.ultimoEstado) {
      if (ok && this.ultimoEstado === false) this.logger.log("WhatsApp reconectado: envios retomados");
      if (!ok) this.logger.error(`WhatsApp DESCONECTADO (${motivo}): disparos, boas-vindas e fechamento suspensos ate reconectar`);
      this.ultimoEstado = ok;
    }
    return ok;
  }

  status() {
    return { connected: this.cache?.ok ?? null, checkedAt: this.cache ? new Date(this.cache.at).toISOString() : null };
  }
}
