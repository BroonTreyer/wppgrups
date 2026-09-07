export const DEFAULT_NICHES = [
  { id: "electronics", name: "Eletronicos e celulares", keywords: ["celular", "smartphone", "iphone", "motorola", "samsung galaxy", "xiaomi", "redmi", "tv", "smart tv", "fone", "fone de ouvido", "airpods", "caixa de som", "audio", "camera", "tablet", "smartwatch", "carregador", "power bank", "eletronico", "projetor", "alexa"] },
  { id: "computing-gaming", name: "Informatica e games", keywords: ["notebook", "computador", "pc gamer", "monitor", "teclado", "mouse", "ssd", "hd externo", "memoria ram", "placa de video", "impressora", "roteador", "headset", "webcam", "console", "playstation", "xbox", "nintendo", "game", "cadeira gamer", "pendrive"] },
  { id: "home", name: "Casa, cozinha e decoracao", keywords: ["casa", "cozinha", "panela", "frigideira", "air fryer", "fritadeira", "liquidificador", "batedeira", "cafeteira", "geladeira", "fogao", "microondas", "aspirador", "lava roupas", "maquina de lavar", "ventilador", "ar condicionado", "purificador", "jogo de cama", "lencol", "edredom", "travesseiro", "colchao", "cama box", "cortina", "tapete", "toalha", "toalha de banho", "roupao", "jogo de toalhas", "cobertor", "manta", "protetor de colchao", "fronha", "sofa", "guarda roupa", "mesa", "cadeira", "luminaria", "organizador", "cesto", "pote", "jarra", "talher", "copo", "prato", "faqueiro", "moveis", "decoracao", "eletrodomestico", "utensilio", "utilidade domestica"] },
  { id: "beauty", name: "Beleza e cuidados pessoais", keywords: ["beleza", "cosmetico", "maquiagem", "skin care", "skincare", "dermocosmetico", "shampoo", "condicionador", "mascara capilar", "mascara de tratamento", "leave in", "finalizador", "oleo capilar", "ampola capilar", "progressiva", "botox capilar", "matizador", "tintura", "coloracao", "tonalizante", "cronograma capilar", "creme para pentear", "cachos", "antifrizz", "secador", "chapinha", "prancha", "babyliss", "modelador de cachos", "creme facial", "creme hidratante", "hidratante facial", "hidratante corporal", "serum", "serum facial", "acido hialuronico", "niacinamida", "retinol", "vitamina c facial", "protetor solar", "agua micelar", "demaquilante", "sabonete facial", "esfoliante", "tonico facial", "mascara facial", "anti idade", "antissinais", "olheiras", "acne", "batom", "gloss", "base liquida", "corretivo", "po compacto", "blush", "iluminador", "primer", "paleta de sombras", "sombra", "delineador", "mascara de cilios", "rimel", "cilios", "sobrancelha", "esmalte", "unha", "perfume", "colonia", "deo colonia", "eau de parfum", "eau de toilette", "body splash", "desodorante", "hidratante perfumado", "barbeador", "aparelho de barbear", "pos barba", "depilador", "cera depilatoria", "kerastase", "loreal", "l oreal", "elseve", "kerasys", "wella", "redken", "pantene", "tresemme", "seda", "dove", "nivea", "garnier", "ogx", "aussie", "salon line", "novex", "lola cosmetics", "inoar", "truss", "cadiveu", "brae", "widi care", "eudora", "natura", "boticario", "avon", "vult", "ruby rose", "maybelline", "revlon", "mari maria", "boca rosa", "bruna tavares", "dailus", "oceane", "quem disse berenice", "payot", "adcos", "creamy", "sallve", "principia", "la roche", "vichy", "cerave", "neutrogena", "bio extratus"] },
  { id: "fashion", name: "Moda e acessorios", keywords: ["roupa", "camiseta", "camisa", "blusa", "calca", "jeans", "short", "bermuda", "vestido", "saia", "jaqueta", "moletom", "cueca", "calcinha", "sutia", "meia", "pijama", "tenis", "sapato", "sandalia", "chinelo", "bota", "calcado", "bolsa", "mochila", "carteira", "relogio", "oculos", "cinto", "bone", "moda"] },
  { id: "kids", name: "Mamaes, bebes e criancas", keywords: ["bebe", "crianca", "infantil", "brinquedo", "boneca", "lego", "fralda", "carrinho de bebe", "berco", "chupeta", "mamadeira", "cadeirinha", "gestante", "gravida", "maternidade", "amamentacao", "bomba de leite", "body", "macacao", "enxoval", "mordedor", "banheira", "trocador", "papinha", "sling", "canguru", "cha de bebe", "pos parto", "cinta pos parto"] },
  { id: "tools-auto", name: "Ferramentas e automotivo", keywords: ["ferramenta", "furadeira", "parafusadeira", "esmerilhadeira", "serra", "chave de fenda", "trena", "automotivo", "carro", "pneu", "oleo de motor", "bateria automotiva", "capacete", "motocicleta", "retrovisor", "compressor"] },
  { id: "sports", name: "Esportes e fitness", keywords: ["esporte", "fitness", "academia", "musculacao", "halter", "anilha", "esteira", "bicicleta", "bike", "corrida", "chuteira", "futebol", "whey", "creatina", "suplemento", "camping", "pesca"] },
  { id: "market", name: "Mercado e utilidades", keywords: ["mercado", "alimento", "cafe", "creme de leite", "leite condensado", "arroz", "feijao", "azeite", "chocolate", "bebida", "cerveja", "limpeza", "detergente", "sabao", "amaciante", "desinfetante", "papel higienico", "racao", "utilidade"] },
  { id: "health", name: "Saude e bem-estar", keywords: ["saude", "vitamina", "colageno", "farmacia", "termometro", "massageador", "medidor de pressao", "oximetro", "balanca", "ortopedico", "fisioterapia", "primeiros socorros", "higiene", "absorvente", "fralda geriatrica", "nebulizador", "escova de dente eletrica", "suplemento", "omega", "magnesio", "melatonina", "probiotico"] },
  { id: "general", name: "Ofertas gerais", keywords: [] }
];

const normalize = (text) => String(text ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const tokens = (text) => normalize(text).split(/[^a-z0-9]+/).filter(Boolean);
const singular = (token) => token.endsWith("s") ? token.slice(0, -1) : token;

export function matchesKeyword(haystack, words, keyword) {
  const target = normalize(keyword);
  if (target.includes(" ")) return haystack.includes(target);
  return words.some((word) => word === target || singular(word) === target);
}

/**
 * Palavras que descrevem FORMATO ou recipiente, nao categoria de produto.
 *
 * "Creatina Monohidratada em Pote 300g" casava com `home` por causa de "pote" e
 * com `sports` por causa de "creatina" — e como todo casamento valia o mesmo, o
 * suplemento foi parar num canal de casa/kids/beleza. Um pote pode conter
 * qualquer coisa; creatina so pode ser suplemento.
 */
const WEAK_KEYWORDS = new Set([
  "creme", "base", "sombra", "cilios", "unha", "cachos",
  "pote", "copo", "prato", "jarra", "cesto", "organizador", "mesa", "cadeira",
  "manta", "casa", "cozinha", "utensilio", "utilidade", "decoracao", "moveis",
  "eletrodomestico", "alimento", "bebida", "higiene", "moda", "esporte",
  "saude", "audio", "eletronico", "game", "carro", "crianca", "infantil", "beleza"
]);

// Marcas cujo nome e uma palavra comum. Sem neutraliza-las, "Maquininha de
// Cartao Mercado Pago" vira nicho de mercado por causa do nome do adquirente, e
// "Casas Bahia" viraria item de casa.
const BRAND_PHRASES = [
  "mercado pago", "mercado livre", "mercado envios", "casas bahia",
  "casa bahia", "vivo casa", "jogo aberto"
];

// Ligacoes que nao carregam sentido de produto. Servem para achar o "nucleo" do
// titulo — as primeiras palavras que dizem O QUE a coisa e.
const FILLERS = new Set(["de", "da", "do", "com", "sem", "para", "em", "kit", "pack", "und", "unidade", "unidades", "pecas", "peca"]);
const HEAD_SIZE = 3;

const semMarcas = (text) => BRAND_PHRASES.reduce((acc, marca) => acc.replaceAll(marca, " "), text);

/** As primeiras palavras uteis: em titulo de marketplace, e o tipo do produto. */
export function headTokens(text, size = HEAD_SIZE) {
  return tokens(text).filter((word) => word.length >= 3 && !FILLERS.has(word)).slice(0, size);
}

export function inferNiches(offer, niches = DEFAULT_NICHES) {
  const bruto = normalize([offer.title, offer.category, ...(offer.tags ?? [])].join(" "));
  const text = semMarcas(bruto);
  const words = tokens(text);
  // O nucleo sai do TITULO, nao do texto todo: categoria e tags vem depois e
  // deslocariam o que conta como comeco.
  const head = headTokens(semMarcas(normalize(offer.title)));
  const noNucleo = (keyword) => {
    const alvo = normalize(keyword);
    return alvo.includes(" ")
      ? head.join(" ").includes(alvo)
      : head.some((word) => word === alvo || (word.endsWith("s") ? word.slice(0, -1) : word) === alvo);
  };

  const porNicho = niches
    .filter((niche) => niche.id !== "general")
    .map((niche) => {
      const casadas = niche.keywords.filter((keyword) => matchesKeyword(text, words, keyword));
      return {
        id: niche.id,
        casadas,
        nucleo: casadas.some(noNucleo),
        forte: casadas.some((keyword) => !WEAK_KEYWORDS.has(normalize(keyword)))
      };
    })
    .filter((item) => item.casadas.length);

  // Regra 1, a mais decisiva: se algum nicho casou no NUCLEO do titulo, so ele
  // vale. "Mochila Viagem Executiva Grande Notebook" e mochila; "notebook" diz
  // o que ela carrega. "Creatina ... em Pote" e creatina; "pote" e a embalagem.
  //
  // A regra do sinal forte vale DENTRO do nucleo tambem: "Creatina Monohidratada
  // em Pote" tem os dois no comeco, e "Cadeira Gamer" casa com "cadeira" (fraca,
  // de casa) e com "cadeira gamer" (forte, de games). Sem isso, empatam.
  const noComeco = porNicho.filter((item) => item.nucleo);
  if (noComeco.length) {
    const fortesNoComeco = noComeco.filter((item) => item.forte);
    const vencedores = fortesNoComeco.length ? fortesNoComeco : noComeco;
    return [...new Set([...vencedores.map((item) => item.id), "general"])];
  }

  // Regra 2: sem nada no nucleo, sinal forte ainda vence palavra de formato.
  const temForte = porNicho.some((item) => item.forte);
  const matched = porNicho.filter((item) => !temForte || item.forte).map((item) => item.id);
  return [...new Set([...matched, "general"])];
}
