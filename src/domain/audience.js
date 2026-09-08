// Publico dos canais Achadinhos. Isto morava so no store, por destino, e sumiu
// junto com ele em 08/09/2026 — por isso agora vive no codigo, versionado e
// coberto por teste. O nicho continua dizendo o ASSUNTO; esta lista diz PARA QUEM.
//
// Regra de casamento (ver matchesTitle): palavra INTEIRA. "barba" nao pode
// bloquear "Barbante", "sunga" nao pode bloquear "Sungado".

const GENERO_MASCULINO = [
  "masculino", "masculina", "unissex",
  "sunga", "cueca", "barba", "barbear", "barbeador", "pos barba"
];

const BARBEARIA_E_SALAO = [
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
    "vestido", "saia", "blusa", "cropped", "legging", "macacao", "body",
    "calcinha", "sutia", "camisola", "biquini", "maio",
    "sandalia", "rasteirinha", "salto", "scarpin"
  ]
};

// A mediana publicada foi R$ 108 e o maior R$ 247: o teto barra o eletrodomestico
// caro por REGRA, nao por efeito da pontuacao.
export const ACHADINHOS_MAX_PRICE = 400;

export const ACHADINHOS_PRESET = {
  blockedKeywords: ACHADINHOS_BLOCKED_KEYWORDS,
  requireAnyByNiche: ACHADINHOS_REQUIRE_BY_NICHE,
  maxPrice: ACHADINHOS_MAX_PRICE
};
