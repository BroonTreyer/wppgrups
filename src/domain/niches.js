export const DEFAULT_NICHES = [
  { id: "electronics", name: "Eletronicos e celulares", keywords: ["celular", "smartphone", "iphone", "motorola", "samsung galaxy", "xiaomi", "redmi", "tv", "smart tv", "fone", "fone de ouvido", "airpods", "caixa de som", "audio", "camera", "tablet", "smartwatch", "carregador", "power bank", "eletronico", "projetor", "alexa"] },
  { id: "computing-gaming", name: "Informatica e games", keywords: ["notebook", "computador", "pc gamer", "monitor", "teclado", "mouse", "ssd", "hd externo", "memoria ram", "placa de video", "impressora", "roteador", "headset", "webcam", "console", "playstation", "xbox", "nintendo", "game", "cadeira gamer", "pendrive"] },
  { id: "home", name: "Casa, cozinha e decoracao", keywords: ["casa", "cozinha", "panela", "frigideira", "air fryer", "fritadeira", "liquidificador", "batedeira", "cafeteira", "geladeira", "fogao", "microondas", "aspirador", "lava roupas", "maquina de lavar", "ventilador", "ar condicionado", "purificador", "jogo de cama", "lencol", "edredom", "travesseiro", "colchao", "cama box", "cortina", "tapete", "toalha", "toalha de banho", "roupao", "jogo de toalhas", "cobertor", "manta", "protetor de colchao", "fronha", "sofa", "guarda roupa", "mesa", "cadeira", "luminaria", "organizador", "cesto", "pote", "jarra", "talher", "copo", "prato", "faqueiro", "moveis", "decoracao", "eletrodomestico", "utensilio", "utilidade domestica"] },
  { id: "beauty", name: "Beleza e cuidados pessoais", keywords: ["beleza", "perfume", "maquiagem", "batom", "base", "cabelo", "shampoo", "condicionador", "hidratante", "protetor solar", "skin care", "serum", "creme", "secador", "chapinha", "barbeador", "depilador", "esmalte"] },
  { id: "fashion", name: "Moda e acessorios", keywords: ["roupa", "camiseta", "camisa", "blusa", "calca", "jeans", "short", "bermuda", "vestido", "saia", "jaqueta", "moletom", "cueca", "calcinha", "sutia", "meia", "pijama", "tenis", "sapato", "sandalia", "chinelo", "bota", "calcado", "bolsa", "mochila", "carteira", "relogio", "oculos", "cinto", "bone", "moda"] },
  { id: "kids", name: "Mamaes, bebes e criancas", keywords: ["bebe", "crianca", "infantil", "brinquedo", "boneca", "lego", "fralda", "carrinho de bebe", "berco", "chupeta", "mamadeira", "cadeirinha", "gestante", "gravida", "maternidade", "amamentacao", "bomba de leite", "body", "macacao", "enxoval", "mordedor", "banheira", "trocador", "papinha", "sling", "canguru", "cha de bebe", "pos parto", "cinta pos parto"] },
  { id: "tools-auto", name: "Ferramentas e automotivo", keywords: ["ferramenta", "furadeira", "parafusadeira", "esmerilhadeira", "serra", "chave de fenda", "trena", "automotivo", "carro", "pneu", "oleo de motor", "bateria automotiva", "capacete", "motocicleta", "retrovisor", "compressor"] },
  { id: "sports", name: "Esportes e fitness", keywords: ["esporte", "fitness", "academia", "musculacao", "halter", "anilha", "esteira", "bicicleta", "bike", "corrida", "chuteira", "futebol", "whey", "creatina", "suplemento", "camping", "pesca"] },
  { id: "market", name: "Mercado e utilidades", keywords: ["mercado", "alimento", "cafe", "arroz", "feijao", "azeite", "chocolate", "bebida", "cerveja", "limpeza", "detergente", "sabao", "amaciante", "desinfetante", "papel higienico", "racao", "utilidade"] },
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

export function inferNiches(offer, niches = DEFAULT_NICHES) {
  const text = normalize([offer.title, offer.category, ...(offer.tags ?? [])].join(" "));
  const words = tokens(text);
  const matched = niches
    .filter((niche) => niche.id !== "general" && niche.keywords.some((keyword) => matchesKeyword(text, words, keyword)))
    .map((niche) => niche.id);
  return [...new Set([...matched, "general"])];
}
