export const DEFAULT_NICHES = [
  { id: "electronics", name: "Eletronicos e celulares", keywords: ["celular", "smartphone", "tv", "fone", "audio", "camera", "eletronico"] },
  { id: "computing-gaming", name: "Informatica e games", keywords: ["notebook", "computador", "monitor", "teclado", "mouse", "console", "game", "ssd"] },
  { id: "home", name: "Casa, cozinha e decoracao", keywords: ["casa", "cozinha", "panela", "moveis", "decoracao", "eletrodomestico"] },
  { id: "beauty", name: "Beleza e cuidados pessoais", keywords: ["beleza", "perfume", "maquiagem", "cabelo", "skin care"] },
  { id: "fashion", name: "Moda e acessorios", keywords: ["roupa", "tenis", "calcado", "bolsa", "relogio", "moda"] },
  { id: "kids", name: "Bebes e criancas", keywords: ["bebe", "crianca", "brinquedo", "fralda", "carrinho"] },
  { id: "tools-auto", name: "Ferramentas e automotivo", keywords: ["ferramenta", "furadeira", "parafusadeira", "automotivo", "carro", "moto"] },
  { id: "sports", name: "Esportes e fitness", keywords: ["esporte", "fitness", "academia", "bicicleta", "corrida"] },
  { id: "market", name: "Mercado e utilidades", keywords: ["mercado", "alimento", "bebida", "limpeza", "utilidade"] },
  { id: "general", name: "Ofertas gerais", keywords: [] }
];

const normalize = (text) => String(text ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
export function inferNiches(offer, niches = DEFAULT_NICHES) {
  const haystack = normalize([offer.title, offer.category, ...(offer.tags ?? [])].join(" "));
  const matched = niches.filter((niche) => niche.id !== "general" && niche.keywords.some((keyword) => haystack.includes(normalize(keyword)))).map((niche) => niche.id);
  return [...new Set([...matched, "general"])];
}
