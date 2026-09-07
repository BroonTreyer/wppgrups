/**
 * Quando publicar, e com que frequencia.
 *
 * O modelo e de RAJADAS, nao de gotejamento: seis janelas por dia — duas de
 * manha, duas a tarde, duas a noite — e fora delas ninguem publica. Dentro da
 * janela cada destino solta um post a cada `minMinutesBetweenPosts`, entao uma
 * janela de uma hora com 6 destinos a 12 min rende ~30 anuncios, e o dia fecha
 * em ~180.
 *
 * A conta e essa e vale conferir ao mexer:
 *
 *     posts por rajada = destinos ativos x (60 / minMinutesBetweenPosts)
 *     posts por dia    = posts por rajada x 6
 *
 * Os horarios vem de pratica de mercado, nao de medicao: enquanto os canais nao
 * tiverem membros nao existe engajamento para medir. Quando tiverem, e aqui que
 * se corrige com dado real.
 */

const FUSO = "America/Sao_Paulo";

// Seis janelas de uma hora. Manha: antes do trabalho e meio da manha. Tarde:
// pos-almoco e fim de expediente. Noite: depois do jantar e antes de dormir.
export const BURST_WINDOWS = [
  { hora: 8, rotulo: "manha-1" },
  { hora: 10, rotulo: "manha-2" },
  { hora: 13, rotulo: "tarde-1" },
  { hora: 16, rotulo: "tarde-2" },
  { hora: 19, rotulo: "noite-1" },
  { hora: 21, rotulo: "noite-2" }
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
