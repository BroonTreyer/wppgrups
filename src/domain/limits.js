/**
 * Quanto um destino aguenta por dia, e a que ritmo — em numeros que dao para
 * comparar.
 *
 * Existe porque os campos crus MENTEM em silencio nas duas contas que importam.
 */

/**
 * Teto do proprio campo `maxDailyPosts` — guarda contra digito a mais, nao
 * politica de operacao. Quem quer operar sem limite usa `null`, que e explicito;
 * um numero absurdo digitado sem querer nao deve virar configuracao valida.
 *
 * Mora aqui porque ESTAVA em dois lugares com valores diferentes (1000 no
 * `destination-service`, 500 no `operation-service`) e os dois caminhos gravam o
 * mesmo campo: o painel recusava o valor que a outra porta tinha acabado de
 * salvar.
 */
export const MAX_DAILY_POSTS = 5000;

/**
 * O teto diario de um destino. `null` (ou ausente) significa SEM TETO.
 *
 * Precisa de tradutor porque o valor cru quebra as duas contas em que aparece, e
 * nenhuma das duas reclama:
 *
 *   - `enviadosHoje >= null` vira `>= 0` e passa a BLOQUEAR TUDO. O destino
 *     simplesmente emudece, com a fila cheia e sem nenhum erro.
 *   - `null - enviadosHoje` da negativo, o espaco diario da ingestao zera e a
 *     colheita para. O canal seca por falta de estoque enquanto o painel mostra
 *     um destino saudavel.
 *
 * Infinity atravessa as duas contas sem caso especial em cada chamador, que e o
 * que evita que a proxima conta nova esqueca do `null` de novo. Quem precisa
 * MOSTRAR o valor (API, painel) usa `semTeto` e devolve `null` de proposito.
 */
export function dailyCap(destination) {
  const valor = destination?.maxDailyPosts;
  if (valor === null || valor === undefined || valor === "") return Number.POSITIVE_INFINITY;
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : Number.POSITIVE_INFINITY;
}

/** Para quem exibe: teto ausente e `null` na tela, nunca `Infinity`. */
export function semTeto(destination) {
  return dailyCap(destination) === Number.POSITIVE_INFINITY;
}

/**
 * Quantos posts por hora este destino REALMENTE entrega.
 *
 * `60 / minMinutesBetweenPosts` sozinho responde a pergunta errada: ele mede o
 * espacamento das JANELAS, nao quantas mensagens saem em cada uma. Com rajada de
 * 25 a cada 10 min a conta antiga dava 6/h enquanto o grupo entregava 150/h — 25
 * vezes menos.
 *
 * Nao e detalhe de relatorio: e esta conta que dimensiona a fila na ingestao.
 * Subdimensionada, a fila esvazia entre colheitas e o grupo passa a hora em
 * branco com estoque sobrando no banco (medido em 12/09/2026: 6 posts as 10h e 1
 * as 11h, com 2.536 ofertas vivas paradas).
 */
export function postsPerHour(destination) {
  const intervalo = Math.max(1, Number(destination?.minMinutesBetweenPosts) || 1);
  const rajada = Math.max(1, Number(destination?.burstSize) || 1);
  return (60 / intervalo) * rajada;
}
