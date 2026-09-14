/**
 * Quando publicar, e com que frequencia.
 *
 * O modelo e de RAJADAS, nao de gotejamento: doze janelas por dia — quatro de
 * manha, quatro a tarde, quatro a noite — e fora delas ninguem publica. Dentro da
 * janela cada destino solta um post a cada `minMinutesBetweenPosts`, entao uma
 * janela de uma hora com 6 destinos a 12 min rende ~30 anuncios, e o dia fecha
 * em ~360.
 *
 * A conta e essa e vale conferir ao mexer:
 *
 *     posts por rajada = destinos ativos x (60 / minMinutesBetweenPosts)
 *     posts por dia    = posts por rajada x 12
 *
 * ATENCAO: a janela do agendador (PUBLISHING_START_HOUR/END_HOUR) e um segundo
 * portao, e o mais silencioso dos dois. Com 8h-23h as rajadas das 6h e das 23h
 * simplesmente nunca acontecem — 17% do dia perdido sem nenhuma mensagem de erro.
 * `burstsOutsideWindow` existe para que isso apareca na partida.
 *
 * Os horarios vem de pratica de mercado, nao de medicao: enquanto os canais nao
 * tiverem membros nao existe engajamento para medir. Quando tiverem, e aqui que
 * se corrige com dado real.
 */

const FUSO = "America/Sao_Paulo";

// Das 5h as 22h (17 janelas, a ultima e a das 21h), por decisao do dono do canal
// em 14/09/2026. As 22h o grupo recebe o fechamento do dia (mensagem + enquete,
// src/services/daily-closing.js) e so volta as 5h.
//
// A historia deste numero: eram 12 janelas alternadas (um canal, 60 posts/dia),
// viraram 16 coladas, depois 18 comecando as 5h, depois 24 (full time, 11/09) e
// agora voltaram a fechar a noite.
//
// Por que fechou: em 13/09 o grupo #5 mandou 1.563 mensagens, 139 por hora entre
// 0h e 2h — notificacao no telefone de quem dorme, enquanto anuncios pagos traziam
// gente nova para dentro. O custo disso nao aparece em metrica nenhuma do sistema;
// aparece na saida do grupo.
//
// Cuidado ao mexer: a janela do agendador (PUBLISHING_START_HOUR/END_HOUR, e a
// janela salva no store por /api/operation/window, que VENCE o .env) e um segundo
// portao. Precisa bater com estas janelas: 5h-22h. E o texto do fechamento diz
// "amanha as 5h" — mudou aqui, muda em src/domain/closing.js.
//
// Quem espaca as mensagens dentro da hora e o `minMinutesBetweenPosts` de cada
// destino, que e por canal e portanto nao se acumula entre eles.
export const BURST_WINDOWS = Array.from({ length: 17 }, (_, passo) => {
  const hora = passo + 5;
  const periodo = hora < 12 ? "manha" : hora < 18 ? "tarde" : "noite";
  return { hora, rotulo: `${periodo}-${hora}h` };
});

const partes = (date) => {
  const hora = Number(new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", hourCycle: "h23", timeZone: FUSO }).format(date));
  // `getDay` do proprio Date nao serve: ele usa o fuso da maquina, e o dia da
  // semana pode divergir do brasileiro perto da meia-noite.
  const nome = new Intl.DateTimeFormat("pt-BR", { weekday: "short", timeZone: FUSO })
    .formatToParts(date).find((p) => p.type === "weekday")?.value ?? "";
  const dias = { dom: 0, seg: 1, ter: 2, qua: 3, qui: 4, sex: 5, sab: 6 };
  const dia = dias[nome.toLowerCase().replace(".", "").replace("á", "a")] ?? date.getUTCDay();
  return { hora, dia };
};

/** A rajada em curso, ou null fora de janela. */
export function currentBurst(date = new Date()) {
  const { hora } = partes(date);
  return BURST_WINDOWS.find((janela) => janela.hora === hora) ?? null;
}

/** 1 dentro da rajada, 0 fora. Mantido para quem le "peso da hora". */
export function hourWeight(date = new Date()) {
  return currentBurst(date) ? 1 : 0;
}

/** Multiplicador do intervalo minimo. Infinity = fora de rajada, nao publica. */
export function intervalFactor(date = new Date()) {
  return currentBurst(date) ? 1 : Infinity;
}

/**
 * Quanto este destino deve esperar entre posts agora, em minutos.
 *
 * Aceita fracao de propósito: 0.1 = 6 segundos. O arredondamento para no minimo
 * 1 minuto que existia aqui era um teto escondido — quem pedisse rajada rapida
 * batia nele sem nenhuma pista de onde vinha.
 */
export function effectiveInterval(minMinutesBetweenPosts, date = new Date()) {
  if (!currentBurst(date)) return Infinity;
  return Math.max(0, Number(minMinutesBetweenPosts) || 0);
}

export function isDeadHour(date = new Date()) {
  return currentBurst(date) === null;
}

/** Para o painel: as 24 horas, marcando quais sao de rajada. */
export function dayCurve(date = new Date()) {
  return Array.from({ length: 24 }, (_, hora) => {
    const janela = BURST_WINDOWS.find((j) => j.hora === hora);
    return { hora, peso: janela ? 1 : 0, rajada: janela?.rotulo ?? null };
  });
}

/** Quantos anuncios uma rajada rende, dados os destinos ativos. */
export function burstCapacity(destinations = []) {
  const porRajada = destinations
    .filter((d) => d.active !== false)
    // Sem o piso de 1 minuto: um destino a 0.1 min rende 600 por hora, e a conta
    // precisa dizer isso em vez de mentir 60.
    // Cada liberacao solta `burstSize` posts, nao um. Sem isto a conta do painel
    // subestima em 15x um grupo em rajada.
    .reduce((total, d) => total
      + Math.floor(60 / Math.max(0.01, Number(d.minMinutesBetweenPosts) || 0.01)) * Math.max(1, Number(d.burstSize) || 1), 0);
  return { porRajada, porDia: porRajada * BURST_WINDOWS.length, rajadas: BURST_WINDOWS.length };
}

/**
 * As rajadas que a janela do agendador silencia. Vazio e o estado saudavel.
 *
 * Sao dois portoes independentes: a rajada diz QUANDO faz sentido publicar, e
 * `isWithinPublishingWindow` diz quando e permitido. Quando discordam, quem perde
 * e sempre a rajada — e em silencio.
 */
export function burstsOutsideWindow(startHour, endHour) {
  return BURST_WINDOWS.filter((janela) => janela.hora < startHour || janela.hora >= endHour);
}
