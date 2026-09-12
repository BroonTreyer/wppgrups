import { discountPercentage, minutesUntilExpiry } from "../domain/offer.js";

export class PriceGuard {
  constructor({ sources = [], config, clock = () => new Date() }) {
    this.sources = new Map(sources.map((source) => [source.id, source]));
    this.config = config;
    this.clock = clock;
  }

  isFresh(item, now = this.clock()) {
    const confirmedAt = item.confirmedAt ?? item.offer?.capturedAt ?? item.createdAt;
    return now - new Date(confirmedAt) < this.config.freshness.minutes * 60_000;
  }

  /**
   * A oferta acabou?
   *
   * Quando o ML diz ate quando a promocao vale — e ele diz, quase sempre a
   * meia-noite do dia —, esse prazo manda. O teto de idade (`maxAgeHours`) e so
   * um proxy para "o preco ja deve estar velho", e proxy perde para o dado real.
   * O preco tambem nao envelhece na fila: quem tem `expiresAt` vem da vitrine e
   * e revalidado a cada PRICE_FRESHNESS_MINUTES.
   *
   * Media em 11/09/2026: 1.077 ofertas descartadas por idade, e de 192 que ainda
   * tinham payload, 166 continuavam VALIDAS segundo o proprio ML. Morreram vivas.
   *
   * Sem `expiresAt` o teto de idade continua valendo, e e o que segura a colheita
   * da extensao: ela nao traz prazo e nao e revalidavel, entao nao pode ficar
   * parada com um preco que ninguem confere.
   */
  isExpired(item, now = this.clock()) {
    const validade = item.offer?.expiresAt ? new Date(item.offer.expiresAt) : null;
    if (validade && !Number.isNaN(validade.getTime())) return now >= validade;
    return now - new Date(item.createdAt) >= this.config.freshness.maxAgeHours * 3_600_000;
  }

  async refresh(items) {
    const results = [];
    const groups = new Map();
    for (const item of items) {
      const sourceId = item.offer?.sourceId;
      if (!this.sources.has(sourceId)) { results.push({ id: item.id, status: "unchecked" }); continue; }
      // Colhida pela extensao: o produto veio de uma pagina de loja de marca, que
      // o servidor nao consegue ler (anti-bot). Procura-la na vitrine de ofertas e
      // garantia de nao achar — e "nao achei" viraria "expirada". Ausencia que
      // ninguem teve como checar nao prova nada: a oferta segue como veio, e quem
      // limita a idade dela e QUEUE_MAX_AGE_HOURS.
      // So a colheita da extensao nao vale nem consultar: a vitrine nunca tera um
      // produto de pagina de loja. Os demais SAO consultados normalmente — o que a
      // `naoVerificavel` muda e apenas o veredito quando a busca nao acha.
      if (item.offer?.sourceContext?.origem === "extensao") { results.push({ id: item.id, status: "unchecked" }); continue; }
      if (!groups.has(sourceId)) groups.set(sourceId, []);
      groups.get(sourceId).push(item);
    }
    for (const [sourceId, group] of groups) {
      let current;
      try {
        current = await this.sources.get(sourceId).refreshMany(group.map((item) => item.offer), { pages: this.config.freshness.refreshPages });
      } catch (error) {
        for (const item of group) results.push({ id: item.id, status: "unavailable", error: error.message });
        continue;
      }
      for (const item of group) results.push(this.evaluate(item, current.get(item.offer.externalId)));
    }
    return results;
  }

  /**
   * Ausencia so vale como prova quando alguem olhou onde a oferta estava.
   *
   * A revalidacao le a vitrine ate a pagina de onde a oferta veio. Se a oferta nao
   * diz de onde veio — foi coletada antes de `sourceContext.page` existir — a
   * busca cobriu apenas as primeiras paginas, e nao achar ali nao significa que a
   * promocao acabou. Declarar "saiu da vitrine" nesse caso foi o que matou 86% da
   * fila ate 11/09/2026.
   *
   * O que segura essas ofertas e QUEUE_MAX_AGE_HOURS: elas envelhecem e saem por
   * idade, em vez de sumirem por uma conclusao que ninguem verificou.
   */
  naoVerificavel(item) {
    const contexto = item.offer?.sourceContext;
    // Colhida pela extensao: veio de pagina de loja, que a vitrine nao tem.
    if (contexto?.origem === "extensao") return true;
    // Sem pagina de origem: coletada antes de o campo existir.
    if (contexto?.page === undefined) return true;
    // Fundo demais para a varredura barata. Ir busca-la la custava 163 requisicoes
    // sequenciais por ciclo e travava o agendador por minutos. Nao revalidar o
    // preco dela e barato; declara-la morta sem olhar e que nao pode.
    return Number(contexto.page) > Math.max(Number(this.config.freshness.refreshPages) || 1, 1);
  }

  evaluate(item, latest) {
    if (!latest) return { id: item.id, status: this.naoVerificavel(item) ? "unchecked" : "expired" };
    const restam = minutesUntilExpiry(latest, this.clock());
    if (restam !== null && restam < this.config.freshness.minValidityMinutes) return { id: item.id, status: "expired" };
    const rise = latest.currentPrice / item.offer.currentPrice - 1;
    if (rise > this.config.freshness.priceRiseTolerance) return { id: item.id, status: "stale", currentPrice: latest.currentPrice };
    const offer = { ...item.offer, expiresAt: latest.expiresAt ?? item.offer.expiresAt, currentPrice: latest.currentPrice, originalPrice: latest.originalPrice ?? item.offer.originalPrice, shipping: latest.shipping ?? item.offer.shipping, paymentMethod: latest.paymentMethod ?? item.offer.paymentMethod };
    if (discountPercentage(offer) < this.config.freshness.minDiscountAfterRefresh) return { id: item.id, status: "stale", currentPrice: latest.currentPrice };
    return { id: item.id, status: latest.currentPrice === item.offer.currentPrice ? "confirmed" : "updated", offer };
  }
}
