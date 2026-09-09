// Prova que a classificacao por IA funciona de ponta a ponta, com titulos reais
// e dificeis, antes de ligar no pipeline. Mostra a decisao lado a lado com a da
// regra e fecha com o custo medido da propria chamada.
//
//   node --env-file-if-exists=.env scripts/testa-classificador.js
//
// Nao grava nada no store e nao publica nada.

import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "../src/config.js";
import { AiClassifier } from "../src/services/ai-classifier.js";
import { inferNiches } from "../src/domain/niches.js";
import { productKey } from "../src/domain/offer.js";

// Os casos que a regra erra ou quase erra, tirados da auditoria de 07/09.
const AMOSTRA = [
  ["Mochila Executiva Grande Impermeavel Para Notebook 15,6", "Malas, Mochilas e Bolsas", 129.9],
  ["Creatina Monohidratada 300g Em Pote Growth", "Suplementos Alimentares", 89.9],
  ["Mascara Medicube Facial Gel Colageno Zero Poros", "Beleza e Cuidado Pessoal", 74.5],
  ["Kit 3 Camisetas Aramis Basicas Algodao Premium", "Roupas e Acessorios", 149.9],
  ["Tenis Smash V2 Puma Preto E Branco 41 Br", "Calcados", 199.9],
  ["Vestido Midi Floral Manga Bufante Verao", "Roupas e Acessorios", 89.9],
  ["Cadeira De Banho Dobravel Higienica Rodas Sanitaria Idoso", "Saude", 289.0],
  ["Manta Liquida Impermeabilizante 18l Telhado Laje", "Construcao", 219.0],
  ["Barbante Colorido 200g Para Croche Artesanato", "Artesanato", 18.9],
  ["Moletom Canguru Liso Algodao Unissex Inverno", "Roupas e Acessorios", 79.9],
  ["Smart Tv Philco 43 Polegadas Full Hd Roku", "Eletronicos, Audio e Video", 1399.0],
  ["Racao Premium Golden Para Caes Adultos 15kg", "Animais", 189.9]
];

const config = loadConfig();
if (!config.ai.apiKey) {
  console.error("Sem ANTHROPIC_API_KEY. Pegue uma em console.anthropic.com -> API Keys e ponha no .env.");
  process.exit(1);
}

const ofertas = AMOSTRA.map(([title, category, currentPrice], indice) => ({
  title, category, currentPrice,
  marketplace: "Mercado Livre", externalId: `AMOSTRA-${indice}`,
  originalPrice: Math.round(currentPrice * 1.6 * 100) / 100, soldCount: 900,
  url: "https://exemplo", capturedAt: new Date().toISOString()
}));

// Store de mentira: o teste nao deve sujar nem ler o store de verdade.
const memoria = { classifications: [] };
const store = {
  read: async () => structuredClone(memoria),
  update: async (mutator) => mutator(memoria)
};

let uso = null;
const client = new Anthropic({ apiKey: config.ai.apiKey });
const original = client.messages.create.bind(client.messages);
client.messages.create = async (params) => {
  const resposta = await original(params);
  uso = resposta.usage;
  return resposta;
};

const classifier = new AiClassifier({
  store,
  config: { ai: { ...config.ai, enabled: true } },
  client,
  onAlert: (mensagem) => console.error(`  aviso: ${mensagem}`)
});

console.log(`Modelo ${config.ai.model}, effort ${config.ai.effort}, ${ofertas.length} anuncios.\n`);
const decisoes = await classifier.classify(ofertas);

for (const offer of ofertas) {
  const ia = decisoes.get(productKey(offer));
  const regra = inferNiches(offer).filter((niche) => niche !== "general");
  const iguais = JSON.stringify(ia.nicheIds.filter((n) => n !== "general")) === JSON.stringify(regra);
  console.log(offer.title);
  console.log(`   regra: ${regra.join(", ") || "nenhum"}`);
  console.log(`   IA   : ${ia.nicheIds.join(", ")}${iguais ? "" : "   <- divergiu"}`);
  console.log(`   publico: ${ia.servePublico === true ? "SERVE" : ia.servePublico === false ? "NAO SERVE" : "sem opiniao"} (${ia.motivo})`);
  console.log();
}

if (uso) {
  const PRECO = { "claude-opus-5": [5, 25], "claude-sonnet-5": [2, 10], "claude-haiku-4-5": [1, 5] }[config.ai.model] ?? [5, 25];
  const entrada = (uso.input_tokens + (uso.cache_creation_input_tokens ?? 0)) / 1e6 * PRECO[0]
    + (uso.cache_read_input_tokens ?? 0) / 1e6 * PRECO[0] * 0.1;
  const saida = uso.output_tokens / 1e6 * PRECO[1];
  console.log(`tokens: ${uso.input_tokens} entrada, ${uso.cache_creation_input_tokens ?? 0} gravados em cache, ${uso.cache_read_input_tokens ?? 0} lidos do cache, ${uso.output_tokens} saida`);
  console.log(`custo desta chamada: US$ ${(entrada + saida).toFixed(4)} para ${ofertas.length} anuncios`);
  console.log(`por 1.000 anuncios: US$ ${((entrada + saida) / ofertas.length * 1000).toFixed(2)}`);
  if (!uso.cache_read_input_tokens) console.log("(cache_read zerado e normal na primeira chamada; rode de novo em seguida para ver o cache pegar)");
}
