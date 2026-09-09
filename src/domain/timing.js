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

// Doze janelas de uma hora, das 6h as 23h: quatro de manha, quatro a tarde,
// quatro a noite. Espalhadas dentro de cada periodo para nao empilhar dois
// disparos seguidos — entre uma janela e a proxima ha pelo menos uma hora de
// silencio, que e o que separa "canal ativo" de "canal que so despeja".
export const BURST_WINDOWS = [
  { hora: 6, rotulo: "manha-1" },
  { hora: 8, rotulo: "manha-2" },
  { hora: 9, rotulo: "manha-3" },
  { hora: 11, rotulo: "manha-4" },
  { hora: 13, rotulo: "tarde-1" },
  { hora: 14, rotulo: "tarde-2" },
  { hora: 16, rotulo: "tarde-3" },
  { hora: 17, rotulo: "tarde-4" },
  { hora: 19, rotulo: "noite-1" },
  { hora: 20, rotulo: "noite-2" },
  { hora: 22, rotulo: "noite-3" },
  { hora: 23, rotulo: "noite-4" }
];

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

/** Quanto este destino deve esperar entre posts agora, em minutos. */
export function effectiveInterval(minMinutesBetweenPosts, date = new Date()) {
  if (!currentBurst(date)) return Infinity;
  return Math.max(1, Math.round(minMinutesBetweenPosts));
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
    .reduce((total, d) => total + Math.floor(60 / Math.max(1, d.minMinutesBetweenPosts || 1)), 0);
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
