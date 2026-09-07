import { DEFAULT_SWEET_SPOT, scoreOffer } from "./scoring.js";

/**
 * Score de uma oferta PARA UM DESTINO especifico.
 *
 * O `scoreOffer` puro responde "esta e uma boa oferta?". Aqui a pergunta e outra:
 * "esta e a melhor oferta para ESTE publico, AGORA?". Um ar-condicionado de
 * R$ 2.000 e a mesma oferta nos dois casos, mas otimo num canal de eletronicos e
 * pessimo num de achadinhos — e o score global nao sabia distinguir.
 *
 * Tres correcoes sobre o score global:
 *  - a faixa de preco passa a ser a do destino, nao a media do sistema;
 *  - afinidade de nicho premia quem cai no miolo do canal, nao na borda;
 *  - repeticao e penalizada, porque tres creatinas seguidas afundam um canal
 *    mesmo sendo, uma a uma, as tres melhores ofertas da fila.
 */

const NICHE_BONUS_PER_MATCH = 8;
const NICHE_BONUS_CAP = 16;
// Alto o bastante para vencer diferencas normais de desconto e demanda: se so
// desempatasse, a prioridade nao mudaria nada na pratica.
const PRIORITY_BONUS = 40;
const RECENT_WINDOW = 5;
const REPEATED_NICHE_PENALTY = 6;
const REPEATED_NICHE_CAP = 18;
const SIMILAR_TITLE_PENALTY = 30;
// Proporcao, nao contagem: titulo de produto e curto, e exigir 3 palavras iguais
// deixava passar o caso mais comum — duas creatinas de marcas diferentes so
// compartilham "creatina" e "monohidratada". Metade das palavras em comum ja e o
// mesmo tipo de produto.
const SIMILAR_TITLE_MIN_TOKENS = 2;
const SIMILAR_TITLE_MIN_RATIO = 0.4;

// Palavras curtas e genericas nao dizem nada sobre o produto: sem descarta-las,
// "kit" e "para" fariam qualquer par de titulos parecer o mesmo produto.
const STOPWORDS = new Set([
  "para", "com", "sem", "kit", "unidades", "unidade", "pack", "pcs", "und",
  "original", "premium", "novo", "nova", "cor", "tamanho", "modelo", "top",
  "the", "and", "de", "da", "do", "em", "no", "na", "por", "pro"
]);

const normalize = (text) => String(text ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

export function significantTokens(title) {
  return new Set(
    normalize(title)
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4 && !STOPWORDS.has(token))
  );
}

/** Faixa de preco do publico deste destino. */
export function destinationSweetSpot(destination = {}) {
  if (destination.sweetSpot?.min !== undefined && destination.sweetSpot?.max !== undefined) {
    return { min: Number(destination.sweetSpot.min), max: Number(destination.sweetSpot.max) };
  }
  // `maxPrice` ja e o teto declarado do destino; usar como topo da faixa evita
  // pedir ao usuario uma segunda configuracao dizendo quase a mesma coisa.
  if (destination.maxPrice) return { min: DEFAULT_SWEET_SPOT.min, max: Number(destination.maxPrice) };
  return DEFAULT_SWEET_SPOT;
}

/** Quanto a oferta cai no miolo do canal, e nao so na borda. */
export function nicheAffinity(offerNicheIds = [], destination = {}) {
  const alvo = (destination.nicheIds ?? []).filter((id) => id !== "general");
  if (!alvo.length) return 0;
  const overlap = alvo.filter((id) => offerNicheIds.includes(id)).length;
  return Math.min(NICHE_BONUS_CAP, overlap * NICHE_BONUS_PER_MATCH);
}

/**
 * Bonus para os nichos que o canal quer PRIORIZAR (`destination.priorityNiches`).
 *
 * Diferente de `nicheIds`, que e porteiro: o que nao casa nem entra. Este e
 * preferencia — o canal continua aceitando os outros nichos, mas quando ha
 * concorrencia o priorizado ganha a vez. E o que permite dizer "Achadinhos da
 * Isa e um canal de beleza" sem deixar casa e infantil de fora.
 *
 * O peso e alto de proposito: precisa vencer diferencas normais de desconto e
 * demanda, senao a prioridade so decidiria empate e nao mudaria nada na pratica.
 */
export function priorityBonus(offerNicheIds = [], destination = {}) {
  const preferidos = (destination.priorityNiches ?? []).filter((id) => id !== "general");
  if (!preferidos.length) return 0;
  return preferidos.some((id) => offerNicheIds.includes(id)) ? PRIORITY_BONUS : 0;
}

/**
 * Penalidade por parecer com o que este destino acabou de publicar.
 *
 * `recent` sao as ultimas publicacoes DESTE destino, mais novas primeiro, com
 * `nicheIds` e `title` — gravados na propria publicacao para nao depender de
 * cruzar com o historico de ofertas, que e podado pela retencao.
 */
export function repetitionPenalty(offer, offerNicheIds = [], recent = []) {
  const janela = recent.slice(0, RECENT_WINDOW);
  if (!janela.length) return 0;

  const nichos = offerNicheIds.filter((id) => id !== "general");
  const repetidos = janela.filter((item) => (item.nicheIds ?? []).some((id) => id !== "general" && nichos.includes(id))).length;
  let penalidade = Math.min(REPEATED_NICHE_CAP, repetidos * REPEATED_NICHE_PENALTY);

  // Produto quase igual (outra marca de creatina, outro kit de potes) e o caso
  // que mais incomoda quem le o canal: pesa mais que repetir o nicho.
  const meus = significantTokens(offer.title);
  const parecido = janela.some((item) => {
    const outros = significantTokens(item.title);
    if (!meus.size || !outros.size) return false;
    let comuns = 0;
    for (const token of meus) if (outros.has(token)) comuns += 1;
    const proporcao = comuns / Math.min(meus.size, outros.size);
    return comuns >= SIMILAR_TITLE_MIN_TOKENS && proporcao >= SIMILAR_TITLE_MIN_RATIO;
  });
  if (parecido) penalidade += SIMILAR_TITLE_PENALTY;

  return penalidade;
}

export function scoreForDestination(offer, destination, { nicheIds = [], recent = [], riskyKeywords = [] } = {}) {
  const base = scoreOffer(offer, { sweetSpot: destinationSweetSpot(destination), riskyKeywords });
  return base
    + nicheAffinity(nicheIds, destination)
    + priorityBonus(nicheIds, destination)
    - repetitionPenalty(offer, nicheIds, recent);
}

export function breakdownForDestination(offer, destination, { nicheIds = [], recent = [], riskyKeywords = [] } = {}) {
  return {
    base: scoreOffer(offer, { sweetSpot: destinationSweetSpot(destination), riskyKeywords }),
    afinidade: nicheAffinity(nicheIds, destination),
    prioridade: priorityBonus(nicheIds, destination),
    repeticao: -repetitionPenalty(offer, nicheIds, recent),
    faixa: destinationSweetSpot(destination),
    total: scoreForDestination(offer, destination, { nicheIds, recent, riskyKeywords })
  };
}
