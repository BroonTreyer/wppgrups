import { discountPercentage, offerFingerprint, productKey, validateOffer } from "../domain/offer.js";
import { inferNiches } from "../domain/niches.js";
import { effectiveInterval, isDeadHour } from "../domain/timing.js";
import { formatOfferCaption } from "../domain/message.js";
import { isAttributedLink } from "../domain/affiliate.js";

const days = (value) => value * 24 * 60 * 60 * 1000;
const hours = (value) => value * 60 * 60 * 1000;
const minutes = (value) => value * 60 * 1000;

const semAcento = (texto) => String(texto ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

// Casa palavra inteira (ou frase). Sem isto, "barba" bloquearia "Barbante" e
// "sunga" nao pegaria "Sungas" — bloqueio errado e pior que bloqueio nenhum.
const matchesTitle = (title, keyword) => {
  const alvo = semAcento(keyword).trim();
  if (!alvo) return false;
  const texto = semAcento(title);
  if (alvo.includes(" ")) return texto.includes(alvo);
  return texto.split(/[^a-z0-9]+/).filter(Boolean)
    .some((palavra) => palavra === alvo || (palavra.endsWith("s") ? palavra.slice(0, -1) : palavra) === alvo);
};

export class PublicationService {
  constructor({ store, zapi, config, clock = () => new Date() }) {
    this.store = store;
    this.zapi = zapi;
    this.config = config;
    this.clock = clock;
  }

  async publish(input) {
    const offer = validateOffer(input);
    if (!this.config.allowUntaggedLinks && !isAttributedLink(offer.affiliateUrl)) {
      throw new Error("Oferta sem link de afiliado atribuido: publicacao bloqueada");
    }
    const now = this.clock();
    const nicheIds = input.nicheIds?.length ? input.nicheIds : inferNiches(offer);
    const state = await this.store.read();
    // Com `destinationId`, publica so nele. E o que permite a selecao por destino:
    // em vez de uma oferta ir para todos os canais que casam no mesmo minuto, cada
    // canal recebe, na sua vez, a oferta escolhida para o publico dele.
    const alvos = input.destinationId
      ? state.destinations.filter((destination) => destination.id === input.destinationId)
      : state.destinations;
    const evaluated = alvos.map((destination) => ({ destination, reason: this.blockReason({ destination, offer, nicheIds, publications: state.publications, now }) }));
    const destinations = evaluated.filter((item) => item.reason === null).map((item) => item.destination);
    const blocked = evaluated
      .filter((item) => item.reason !== null && item.destination.active && item.destination.available !== false)
      .map((item) => ({ destinationId: item.destination.id, name: item.destination.name || item.destination.id, reason: item.reason }));
    let caption = formatOfferCaption(offer, now, nicheIds);
    const results = [];
    for (const destination of destinations) {
      try {
        const foco = (destination.nicheIds ?? []).filter((id) => nicheIds.includes(id));
        caption = formatOfferCaption(offer, now, foco.length ? foco : nicheIds);
        if (destination.type === "channel" && !this.config.dryRun && !this.config.zapi.channelImageEnabled) {
          throw new Error("Envio de imagem para canal ainda nao homologado");
        }
        const delivery = this.config.dryRun
          ? { id: `dry-${crypto.randomUUID()}`, dryRun: true }
          : await this.zapi.sendImage({ destinationId: destination.id, imageUrl: offer.imageUrl, caption });
        results.push({ destinationId: destination.id, destinationName: destination.name, destinationType: destination.type, status: "sent", delivery });
      } catch (error) {
        results.push({ destinationId: destination.id, destinationName: destination.name, destinationType: destination.type, status: "failed", error: error.message });
      }
    }
    await this.store.update((current) => {
      current.offers.push({ ...offer, nicheIds, fingerprint: offerFingerprint(offer) });
      for (const result of results) {
        current.publications.push({
          id: crypto.randomUUID(), offerFingerprint: offerFingerprint(offer), productKey: productKey(offer), destinationId: result.destinationId,
          status: result.status, deliveryId: result.delivery?.messageId ?? result.delivery?.id ?? null,
          error: result.error ?? null, createdAt: now.toISOString(),
          // Titulo e nichos ficam NA publicacao para a regra de variedade nao
          // depender de cruzar com o historico de ofertas, que a retencao poda.
          title: offer.title, nicheIds
        });
      }
    });
    return { offer, nicheIds, matchedDestinations: destinations.length, deliveredDestinations: results.filter((item) => item.status === "sent").length, caption, results, blocked };
  }

  isEligible(params) {
    return this.blockReason(params) === null;
  }

  blockReason({ destination, offer, nicheIds, publications, now }) {
    if (!destination.active) return "destino desativado";
    if (destination.available === false) return "destino indisponivel na Z-API";
    if (!Array.isArray(destination.nicheIds) || !destination.nicheIds.some((id) => nicheIds.includes(id))) {
      return `nicho nao combina (destino aceita ${(destination.nicheIds ?? []).join(", ")})`;
    }
    // Julgamento da IA sobre o publico, quando existe. Vem antes da lista de
    // palavras porque pega o que nenhuma palavra pega: "Kit Camisetas Aramis" nao
    // diz "masculino" em lugar nenhum. So vale onde o destino pediu — o canal
    // masculino nao herda o julgamento escrito para o feminino.
    if (destination.requireAudienceFit && offer.audience?.serve === false) {
      return `a IA nao ve publico deste canal: ${offer.audience.motivo ?? "sem motivo declarado"}`;
    }

    // Publico do canal. O nicho diz o ASSUNTO ("beleza"), mas nao diz para quem:
    // maquina de cortar cabelo, peruca, cabeca de manequim e tenis masculino sao
    // todos "beleza" ou "moda" e nenhum serve a um canal feminino. A lista e por
    // destino porque e decisao editorial de cada canal, nao regra do sistema.
    const bloqueada = (destination.blockedKeywords ?? []).find((palavra) => matchesTitle(offer.title, palavra));
    if (bloqueada) return `"${bloqueada}" nao combina com o publico deste canal`;

    // Exigencia POSITIVA por nicho. Bloquear marca masculina uma a uma e enxugar
    // gelo: "Kit Camisetas Aramis", "Tenis Reserva Go Troy" e "Tenis Smash V2 41
    // Br" nao dizem "masculino" em lugar nenhum. Em roupa e calcado a marcacao de
    // genero e a regra do mercado — quando ela FALTA, quase sempre e peca
    // masculina ou unissex. Entao o canal exige o sinal feminino nesses nichos,
    // em vez de tentar adivinhar o masculino.
    for (const [nicho, exigidas] of Object.entries(destination.requireAnyByNiche ?? {})) {
      if (!nicheIds.includes(nicho)) continue;
      if (!exigidas.some((palavra) => matchesTitle(offer.title, palavra))) {
        return `${nicho}: falta a marcacao de publico que este canal exige`;
      }
    }

    const discount = discountPercentage(offer);
    if (discount < (destination.minDiscount ?? 0)) return `desconto de ${discount}% abaixo do minimo do destino (${destination.minDiscount}%)`;
    if (destination.maxPrice && offer.currentPrice > destination.maxPrice) return `R$ ${offer.currentPrice} passa do teto de R$ ${destination.maxPrice} deste destino`;
    if (destination.minSold && (offer.soldCount ?? 0) < destination.minSold) return `produto com pouca procura para este destino (${offer.soldCount ?? 0} vendidos)`;
    const destinationPosts = publications.filter((item) => (item.destinationId ?? item.groupId) === destination.id && item.status === "sent");
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(now);
    const dailyCount = destinationPosts.filter((item) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date(item.createdAt)) === today).length;
    if (dailyCount >= destination.maxDailyPosts) return `limite diario atingido (${dailyCount}/${destination.maxDailyPosts})`;
    // O intervalo respira com a hora: encolhe no pico, estica em hora morna e
    // fecha de madrugada. O teto diario acima continua valendo, entao isto
    // redistribui o volume do dia — nao aumenta.
    if (this.config.timingCurve !== false && isDeadHour(now)) {
      return "horario de baixa: publicar de madrugada gasta oferta boa sem audiencia";
    }
    const intervalo = this.config.timingCurve === false
      ? destination.minMinutesBetweenPosts
      : effectiveInterval(destination.minMinutesBetweenPosts, now);
    const lastPost = destinationPosts.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (lastPost && now - new Date(lastPost.createdAt) < minutes(intervalo)) {
      const releaseAt = new Date(new Date(lastPost.createdAt).getTime() + minutes(intervalo));
      return `aguardando o intervalo de ${intervalo} min: liberado as ${releaseAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" })}`;
    }
    const key = productKey(offer);
    const cooldown = days(this.config.limits.republishCooldownDays);
    const publishedKey = (item) => item.productKey ?? item.offerFingerprint?.split(":").slice(0, 2).join(":");
    const repeated = destinationPosts.find((item) => publishedKey(item) === key && now - new Date(item.createdAt) < cooldown);
    if (repeated) return `produto ja publicado aqui em ${new Date(repeated.createdAt).toLocaleDateString("pt-BR")}`;
    return null;
  }

  async recordDeliveryEvent(event) {
    await this.store.update((state) => state.deliveryEvents.push({ ...event, receivedAt: this.clock().toISOString() }));
  }
}
