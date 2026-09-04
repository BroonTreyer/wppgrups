/**
 * Quando publicar, e com que frequencia.
 *
 * O intervalo era uniforme: `janela / limite diario` espalhava os posts por igual,
 * tratando 3 da manha como 20h de terca. Isso gasta oferta boa em horario morto e
 * chega ralo no horario em que o publico esta no celular.
 *
 * Aqui o dia tem peso. O intervalo minimo entre posts de um destino e dividido
 * pelo peso da hora: em pico ele encolhe (publica mais), em hora morta ele estica
 * (publica menos) e na madrugada zera (nao publica). O teto diario do destino
 * continua valendo por cima — isto redistribui o volume, nao o aumenta.
 *
 * Os pesos vem de pratica de mercado para canal de ofertas no Brasil, nao de
 * medicao: enquanto os canais nao tiverem membros nao existe engajamento para
 * medir. Quando tiverem, esta curva e o primeiro lugar a corrigir com dado real.
 */

const FUSO = "America/Sao_Paulo";

// 0 = nao publica. 1 = pico. Indice = hora local (0..23).
//        0h   1    2    3    4    5    6    7    8    9   10   11
const BASE = [0, 0, 0, 0, 0, 0, 0.2, 0.4, 0.6, 0.7, 0.8, 0.9,
//       12h  13   14   15   16   17   18   19   20   21   22   23
  1.0, 1.0, 0.7, 0.6, 0.6, 0.7, 0.9, 1.0, 1.0, 1.0, 0.8, 0.4];

// Ajuste por dia da semana (0 = domingo). Sabado de manha e forte para compra;
// segunda cedo e fraca, o publico esta voltando a rotina.
const POR_DIA = {
  0: 1.0,  // domingo: noite forte, dia fraco — o ajuste fino fica na curva horaria
  1: 0.9,  // segunda
  2: 1.0,
  3: 1.0,
  4: 1.0,
  5: 1.1,  // sexta: comeco de fim de semana
  6: 1.1   // sabado
};

const PESO_MINIMO = 0.15;
// Teto de esticamento: sem ele, uma hora de peso 0.2 daria intervalo 5x maior e
// um destino poderia atravessar a tarde inteira sem publicar nada.
const FATOR_MAXIMO = 3;

const partes = (date) => {
  const fmt = new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit", hourCycle: "h23", weekday: "short", timeZone: FUSO
  });
  const hora = Number(new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", hourCycle: "h23", timeZone: FUSO }).format(date));
  // `getDay` do proprio Date nao serve: ele usa o fuso da maquina, e o dia da
  // semana pode divergir do brasileiro perto da meia-noite.
  const nome = fmt.formatToParts(date).find((p) => p.type === "weekday")?.value ?? "";
  const dias = { "dom": 0, "seg": 1, "ter": 2, "qua": 3, "qui": 4, "sex": 5, "sáb": 6, "sab": 6 };
  const dia = dias[nome.toLowerCase().replace(".", "")] ?? date.getUTCDay();
  return { hora, dia };
};

/** Peso da hora corrente, 0 (nao publicar) a ~1.1 (pico de sexta/sabado). */
export function hourWeight(date = new Date()) {
  const { hora, dia } = partes(date);
  const base = BASE[hora] ?? 0;
  if (base === 0) return 0;
  return Number((base * (POR_DIA[dia] ?? 1)).toFixed(3));
}

/** Multiplicador do intervalo minimo entre posts. Infinity = nao publicar agora. */
export function intervalFactor(date = new Date()) {
  const peso = hourWeight(date);
  if (peso <= 0) return Infinity;
  return Math.min(FATOR_MAXIMO, Number((1 / Math.max(peso, PESO_MINIMO)).toFixed(3)));
}

/** Quanto tempo, em minutos, este destino deve esperar entre posts agora. */
export function effectiveInterval(minMinutesBetweenPosts, date = new Date()) {
  const fator = intervalFactor(date);
  if (fator === Infinity) return Infinity;
  return Math.round(Math.max(1, minMinutesBetweenPosts) * fator);
}

export function isDeadHour(date = new Date()) {
  return hourWeight(date) === 0;
}

/** Para o painel: a curva do dia, em uma linha por hora. */
export function dayCurve(date = new Date()) {
  const { dia } = partes(date);
  return BASE.map((base, hora) => ({ hora, peso: Number((base * (POR_DIA[dia] ?? 1)).toFixed(3)) }));
}
