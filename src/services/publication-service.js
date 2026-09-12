import { discountPercentage, offerFingerprint, productKey, validateOffer } from "../domain/offer.js";
import { inferNiches } from "../domain/niches.js";
import { effectiveInterval, isDeadHour } from "../domain/timing.js";
import { formatOfferCaption } from "../domain/message.js";
import { isAttributedLink } from "../domain/affiliate.js";
import { marcaDe } from "../domain/targeting.js";

const days = (value) => value * 24 * 60 * 60 * 1000;
const hours = (value) => value * 60 * 60 * 1000;
const minutes = (value) => value * 60 * 1000;

// Construir um Intl.DateTimeFormat custa caro, e este era construido uma vez POR
// PUBLICACAO em cada chamada de blockReason: ~806 mil construcoes por selecao,
// que sozinhas respondiam pelos 15-30s de cada ciclo do agendador em 12/09/2026.
// Um formatador so, no modulo, resolve — ele nao guarda estado entre chamadas.
const DIA_BR = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" });
const diaBr = (valor) => DIA_BR.format(valor instanceof Date ? valor : new Date(valor));

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
          // Titulo, nichos e MARCA ficam NA publicacao para a regra de variedade
          // nao depender de cruzar com o historico de ofertas, que a retencao
          // poda. Sem `sellerName` aqui, a penalidade de marca repetida nao tem
          // com o que comparar e o canal volta a publicar em blocos da mesma loja.
          title: offer.title, nicheIds, sellerName: offer.sellerName ?? null
        });
      }
    });
    return { offer, nicheIds, matchedDestinations: destinations.length, deliveredDestinations: results.filter((item) => item.status === "sent").length, caption, results, blocked };
  }

  isEligible(params) {
    return this.blockReason(params) === null;
  }

  /**
   * O bloqueio que NAO passa com o tempo.
   *
   * Nicho, publico e saturacao sao propriedade do titulo: se barram hoje, barram
   * sempre. Teto diario, intervalo e madrugada sao o contrario — barram agora e
   * liberam depois. Misturar os dois entope a fila: oferta que nunca vai sair
   * fica ocupando vaga, a ingestao ve fila cheia e para de coletar, e o canal
   * seca com a fila lotada. Foi o que aconteceu em 08/09/2026, com 29 de 36.
   *
   * Preco (desconto, teto, vendas) fica de fora de proposito: a revalidacao pode
   * mudar qualquer um dos tres, entao nao e permanente.
   */
  permanentBlockReason({ destination, offer, nicheIds }) {
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

    // Exigencia de loja oficial da marca, quando o canal pede. Fica aqui, entre
    // os bloqueios PERMANENTES, porque quem vende um anuncio nao muda com o
    // tempo: se nao e loja oficial hoje, nao sera amanha.
    if (destination.requireOfficialStore && !offer.officialStore) {
      return "este canal so publica de loja oficial da marca";
    }

    // Publico do canal. O nicho diz o ASSUNTO ("beleza"), mas nao diz para quem:
    // maquina de cortar cabelo, peruca, cabeca de manequim e tenis masculino sao
    // todos "beleza" ou "moda" e nenhum serve a um canal feminino. A lista e por
    // destino porque e decisao editorial de cada canal, nao regra do sistema.
    const bloqueada = (destination.blockedKeywords ?? []).find((palavra) => matchesTitle(offer.title, palavra));
    if (bloqueada) return `"${bloqueada}" nao combina com o publico deste canal`;

    // Saturacao e outra coisa: o produto SERVE, mas o canal ja esta cheio dele.
    // Perfume arabe era 26% do que saia do grupo #5. O motivo precisa dizer isso,
    // e nao acusar o produto de nao servir a quem le.
    const saturada = (destination.mutedKeywords ?? []).find((palavra) => matchesTitle(offer.title, palavra));
    if (saturada) return `"${saturada}" esta saturado neste canal`;

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
    return null;
  }

  /**
   * `destinationPosts` e as publicacoes JA filtradas para este destino.
   *
   * Sem ele, cada chamada varre a lista inteira de publicacoes. Na selecao isso
   * vira destinos x ofertas prontas filtragens da mesma lista: medido em
   * 12/09/2026, 1.920 chamadas sobre 2.529 publicacoes custavam 14,6s por
   * `selectTarget` — e o `processNext` chama a selecao duas vezes. Era a conta
   * inteira dos ~45s por post, com o canal entregando 2 posts por janela de 10
   * min enquanto 198 ofertas estavam liberadas.
   *
   * Quem ja tem a lista pronta passa; quem nao tem, omite e ela e montada aqui.
   */
  blockReason({ destination, offer, nicheIds, publications, now, destinationPosts: destinationPostsParam }) {
    if (!destination.active) return "destino desativado";
    if (destination.available === false) return "destino indisponivel na Z-API";
    const permanente = this.permanentBlockReason({ destination, offer, nicheIds });
    if (permanente) return permanente;

    const discount = discountPercentage(offer);
    if (discount < (destination.minDiscount ?? 0)) return `desconto de ${discount}% abaixo do minimo do destino (${destination.minDiscount}%)`;
    if (destination.maxPrice && offer.currentPrice > destination.maxPrice) return `R$ ${offer.currentPrice} passa do teto de R$ ${destination.maxPrice} deste destino`;
    if (destination.minSold && (offer.soldCount ?? 0) < destination.minSold) return `produto com pouca procura para este destino (${offer.soldCount ?? 0} vendidos)`;
    const destinationPosts = destinationPostsParam ?? publications.filter((item) => (item.destinationId ?? item.groupId) === destination.id && item.status === "sent");
    const today = diaBr(now);
    const dailyCount = destinationPosts.filter((item) => diaBr(item.createdAt) === today).length;
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
    // O intervalo nao limita a UM post: limita a `burstSize` posts por janela.
    // Com burstSize 1 e o gotejamento de sempre. Com 15 e 10 min, o destino solta
    // os quinze seguidos (um por ciclo do agendador) e so volta a publicar 10 min
    // depois do PRIMEIRO dos quinze.
    //
    // A janela ancora no post mais ANTIGO dos ultimos `intervalo` minutos, nunca
    // no ultimo. Ancorada no ultimo, cada post novo empurraria a liberacao para a
    // frente e a rajada nunca terminaria — o destino publicaria sem parar.
    const rajada = Math.max(1, Number(destination.burstSize) || 1);
    const naJanela = destinationPosts
      .filter((item) => now - new Date(item.createdAt) < minutes(intervalo))
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (naJanela.length >= rajada) {
      const releaseAt = new Date(new Date(naJanela[0].createdAt).getTime() + minutes(intervalo));
      const daRajada = rajada === 1 ? "" : ` (${naJanela.length}/${rajada} da rajada)`;
      return `aguardando o intervalo de ${intervalo} min${daRajada}: liberado as ${releaseAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" })}`;
    }
    // Marca repetida em sequencia e o que mais denuncia canal automatico, e a
    // colheita traz a loja INTEIRA de uma vez — 13 VULT numa fila de 23 em
    // 11/09/2026. A penalidade de pontuacao (`repetitionPenalty`) nao resolve
    // sozinha: quando a fila e dominada por uma marca, a penalidade perde para
    // nada e o bloco sai igual. Por isso aqui e regra dura, nao desempate.
    //
    // Olha so os posts da JANELA atual: fechada a rajada, o bloqueio se solta.
    // Sem esse limite, um destino cuja fila so tem uma marca ficaria mudo para
    // sempre — e o certo e espacar a marca, nao calar o grupo.
    const marca = marcaDe(offer);
    const marcasAtras = destination.brandCooldownPosts ?? 1;
    if (marca && marcasAtras > 0) {
      const ultimas = naJanela.slice(-marcasAtras);
      if (ultimas.some((item) => marcaDe(item) === marca)) {
        return `marca ${offer.sellerName} acabou de sair aqui: intercalando com outra`;
      }
    }

    const key = productKey(offer);
    const cooldown = days(this.config.limits.republishCooldownDays);
    const publishedKey = (item) => item.productKey ?? item.offerFingerprint?.split(":").slice(0, 2).join(":");
    const dentroDoPrazo = (item) => now - new Date(item.createdAt) < cooldown;
    const repeated = destinationPosts.find((item) => publishedKey(item) === key && dentroDoPrazo(item));
    if (repeated) return `produto ja publicado aqui em ${new Date(repeated.createdAt).toLocaleDateString("pt-BR")}`;

    // O mesmo produto vive na vitrine sob varios anuncios, um por vendedor, cada
    // um com seu codigo. A chave e diferente, mas o TITULO e o mesmo — e titulo e
    // o que a pessoa le. O Secador Taiff Tourmaline saiu tres vezes no grupo #5
    // (08/09 e duas em 10/09) sob MLB5720580194, MLB5720592886 e MLB5717205762:
    // pelo codigo eram tres ofertas, na tela do WhatsApp era a mesma mensagem.
    const mesmoTexto = semAcento(offer.title).replace(/\s+/g, " ").trim();
    const repetidoNoTexto = destinationPosts.find(
      (item) => dentroDoPrazo(item) && semAcento(item.title ?? "").replace(/\s+/g, " ").trim() === mesmoTexto
    );
    if (repetidoNoTexto) {
      return `titulo identico ja publicado aqui em ${new Date(repetidoNoTexto.createdAt).toLocaleDateString("pt-BR")} (outro anuncio do mesmo produto)`;
    }
    return null;
  }

  async recordDeliveryEvent(event) {
    await this.store.update((state) => state.deliveryEvents.push({ ...event, receivedAt: this.clock().toISOString() }));
  }
}
