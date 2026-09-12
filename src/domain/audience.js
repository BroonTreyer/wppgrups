// Publico dos canais Achadinhos. Isto morava so no store, por destino, e sumiu
// junto com ele em 08/09/2026 — por isso agora vive no codigo, versionado e
// coberto por teste. O nicho continua dizendo o ASSUNTO; esta lista diz PARA QUEM.
//
// Regra de casamento (ver matchesTitle): palavra INTEIRA. "barba" nao pode
// bloquear "Barbante", "sunga" nao pode bloquear "Sungado".

const GENERO_MASCULINO = [
  // "unissex" saiu daqui em 08/09: barrava perfume arabe unissex, que e item de
  // canal feminino. Em roupa nao faz falta — requireAnyByNiche ja exige a
  // marcacao feminina, e "Moletom Unissex" continua barrado por la.
  "masculino", "masculina",
  "sunga", "cueca", "barba", "barbear", "barbeador", "pos barba"
];

const BARBEARIA_E_SALAO = [
  // "eudora club" e linha masculina, e a IA julgou os dois jeitos em rodadas
  // diferentes — barrou numa, liberou noutra. E para isso que a regra existe.
  "eudora club",
  "barbearia", "barbeiro", "maquina de cortar cabelo", "navalha",
  "peruca", "lace front", "mega hair", "aplique capilar",
  "manequim", "cabeca de manequim", "tela para peruca"
];

// Pedido explicito do usuario. Doze destes passavam apenas por FALTA de nicho:
// bastaria preencher uma lacuna de vocabulario para voltarem em silencio.
const TERCEIRA_IDADE_E_ENFERMAGEM = [
  "idoso", "geriatrico", "geriatrica", "andador", "muleta",
  "bengala", "cadeira de rodas", "cadeira de banho", "antiescara", "acamado",
  "incontinencia", "fralda geriatrica", "protese dentaria",
  "aparelho auditivo", "surdez", "hospitalar", "enfermagem", "urinol", "comadre"
];

const MATERIAL_MEDICO = [
  "seringa", "agulha", "insulina", "glicosimetro",
  "esfigmomanometro", "estetoscopio", "oximetro", "nebulizador", "inalador",
  "sonda", "cateter", "luva de procedimento", "mascara cirurgica"
];

const EQUIPAMENTO_COMERCIAL = [
  "industrial", "profissional comercial", "expositor", "balcao refrigerado",
  "freezer horizontal", "carrinho de lanche", "vitrine", "gondola",
  "estufa de salgados", "chapa para lanche"
];

const PET = [
  "cachorro", "gato", "caes", "canino", "felino",
  "racao", "coleira", "arranhador", "tapete higienico", "aquario",
  "caixa de transporte", "pet shop"
];

export const ACHADINHOS_BLOCKED_KEYWORDS = [
  ...GENERO_MASCULINO,
  ...BARBEARIA_E_SALAO,
  ...TERCEIRA_IDADE_E_ENFERMAGEM,
  ...MATERIAL_MEDICO,
  ...EQUIPAMENTO_COMERCIAL,
  ...PET
];

// Exigencia POSITIVA: em vestuario a marcacao de genero e a regra do mercado, e
// quando ela FALTA quase sempre e peca masculina. "bolsa" e "sapatilha" ficam de
// fora de proposito — ja deixaram passar um detector de metais "com bolsa".
export const ACHADINHOS_REQUIRE_BY_NICHE = {
  fashion: [
    "feminino", "feminina",
    // "blusa" saiu em 08/09: "Jaqueta Puffer De Frio Blusa Impermeavel Inverno
    // Intenso" e peca masculina e passou so por causa dela. Vendedor usa "blusa"
    // como sinonimo de qualquer peca de cima, sem genero — mesma armadilha de
    // "bolsa" e "sapatilha", que ja deixaram passar um detector de metais.
    "vestido", "saia", "cropped", "legging", "macacao", "body",
    "calcinha", "sutia", "camisola", "biquini", "maio",
    "sandalia", "rasteirinha", "salto", "scarpin"
  ]
};

// Teto por REGRA, nao por efeito da pontuacao. Era 400, quando a mediana publicada
// era R$ 108 e o maior R$ 247. Subiu para 700 a pedido do dono do canal em
// 10/09/2026, junto com a abertura de volume.
//
// Fica o registro de que o teto alto puxa o canal para longe do que ele e: no dia
// em que valeu 700, a mediana publicada foi R$ 65 e sairam quatro produtos acima de
// R$ 400 — um secador de R$ 599 entre batons de R$ 20. Teto e rede de seguranca; o
// que decide de verdade e a pontuacao, e ela ja prefere o barato.
export const ACHADINHOS_MAX_PRICE = 700;

// Liga o julgamento de publico da IA neste destino. Sem isto o campo e ignorado,
// e o canal masculino nao herda um veredito escrito para o canal feminino.
export const ACHADINHOS_REQUIRE_AUDIENCE_FIT = true;

// Saturacao, nao publico. Perfume arabe SERVE ao canal feminino — a IA acerta ao
// dizer que sim. O problema e volume: a vitrine de beleza do ML esta tomada por
// eles, e em 08/09/2026 seis dos vinte e tres posts do grupo #5 eram perfume
// arabe, 26% do que saiu. Por isso a lista e separada da de publico, e o motivo
// do bloqueio fala de saturacao em vez de dizer que nao serve a quem le.
const PERFUME_ARABE = [
  "arabe", "oud", "al oud",
  // "lataffa" e "latafa" nao sao erro meu: e como o vendedor escreve. Marca em
  // titulo de marketplace vem torta, e a lista tem que casar com o que esta la.
  "lattafa", "lataffa", "latafa", "mawwal", "sabah", "durrat", "armaf", "rasasi", "ajmal", "afnan",
  "khadlaj", "zimaya", "emper", "al haramain", "maison alhambra", "swiss arabian",
  "ard al zaafaran", "al wataniah", "fragrance world", "paris corner"
];

// Calcado esportivo, pelo mesmo motivo: 3 dos 23 primeiros posts do grupo #5, e a
// vitrine de moda do ML e quase so isso. Some o problema do numero — tenis se
// vende por tamanho, entao um anuncio de "37 Br" nao serve a quase ninguem da
// lista. "tenis" pega com e sem acento (matchesTitle tira o acento antes).
const CALCADO_ESPORTIVO = ["tenis"];

// Aparelho de cabelo, pelo mesmo motivo — e o caso mais grave que ja apareceu.
// Em 09/09/2026, 29 dos 196 posts do grupo #5 eram secador, prancha, modelador ou
// escova eletrica: 15% do canal, quase o dobro do que o tenis pesava quando entrou
// nesta lista. E dinheiro parado em produto que se compra UMA vez a cada tres anos;
// quem ja tem secador nao compra outro por causa do desconto, entao o post nao
// converte e ainda ocupa a vez de uma oferta que converteria.
//
// "alisadora" e "pente alisador" ficam aqui por saturacao. Nao confundir com a
// quimica de alisamento (btx, progressiva, reconstrucao), que e outra conversa:
// aquela e servico de salao e a IA barra por PUBLICO, nao por volume.
const APARELHO_DE_CABELO = [
  "secador", "prancha", "chapinha", "modelador", "alisadora", "pente alisador",
  "escova secadora", "escova rotativa", "escova modeladora", "escova eletrica"
];

export const ACHADINHOS_MUTED_KEYWORDS = [...PERFUME_ARABE, ...CALCADO_ESPORTIVO, ...APARELHO_DE_CABELO];

export const ACHADINHOS_PRESET = {
  requireAudienceFit: ACHADINHOS_REQUIRE_AUDIENCE_FIT,
  mutedKeywords: ACHADINHOS_MUTED_KEYWORDS,
  blockedKeywords: ACHADINHOS_BLOCKED_KEYWORDS,
  requireAnyByNiche: ACHADINHOS_REQUIRE_BY_NICHE,
  maxPrice: ACHADINHOS_MAX_PRICE
};
