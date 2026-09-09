// Prepara o teste focado no grupo "Achadinhos da Isa #5": beleza e moda feminina,
// so ele ativo, uma rajada de 10 posts.
//
//   node --env-file-if-exists=.env scripts/preparar-teste-grupo5.js            (ensaio)
//   node --env-file-if-exists=.env scripts/preparar-teste-grupo5.js --aplicar
//
// Nao publica nada e nao sobe o bot. Depois de aplicar, a coleta enche a fila e o
// bot despeja no ritmo configurado.

import { loadConfig } from "../src/config.js";
import { JsonStore } from "../src/infra/json-store.js";
import { ZApiClient } from "../src/infra/zapi-client.js";
import { DestinationService } from "../src/services/destination-service.js";
import { IngestionService } from "../src/services/ingestion-service.js";
import { MercadoLivreSource } from "../src/sources/mercado-livre.js";
import { ACHADINHOS_PRESET } from "../src/domain/audience.js";
import { BURST_WINDOWS, burstsOutsideWindow } from "../src/domain/timing.js";

const ALVO = /#\s*5\b/;                    // "Achadinhos da Isa #5"
const NICHOS = ["beauty", "fashion"];      // pele, cabelo, perfume, maquiagem, unha + roupa feminina
const CATEGORIAS = ["MLB1246", "MLB1430"]; // Beleza e cuidado pessoal / Calcados, roupas e bolsas
const POSTS_POR_RAJADA = 10;
const INTERVALO = Math.floor(60 / POSTS_POR_RAJADA);

const aplicar = process.argv.includes("--aplicar");
const config = loadConfig();
const store = new JsonStore(config.dataFile, { onRecovery: (m) => console.warn(`[store] ${m}`) });
const destinations = new DestinationService({ store, zapi: new ZApiClient(config.zapi), config });
// Semeia a fonte antes de configura-la: num store novo a linha so nasce aqui, e
// sem isto o Object.assign la embaixo nao encontrava nada e falhava calado.
const ingestion = new IngestionService({ store, queueService: null, affiliateLinkService: null, sources: [new MercadoLivreSource()], config });
await ingestion.list();

console.log("Sincronizando destinos com a Z-API...");
const lista = await destinations.sync();
const alvo = lista.find((destino) => ALVO.test(destino.name ?? ""));
if (!alvo) {
  console.error(`Nao achei o grupo #5 entre os ${lista.length} destinos: ${lista.map((d) => d.name).join(", ")}`);
  process.exit(1);
}
const outros = lista.filter((destino) => destino.id !== alvo.id);

console.log(`\nFOCO: ${alvo.name} (${alvo.type})`);
console.log(`   nichos: ${NICHOS.join(", ")}`);
console.log(`   filtro de publico: ${ACHADINHOS_PRESET.blockedKeywords.length} palavras + julgamento da IA + teto de R$ ${ACHADINHOS_PRESET.maxPrice}`);
console.log(`   ritmo: 1 post a cada ${INTERVALO} min = ${POSTS_POR_RAJADA} por rajada`);
console.log(`\nDESLIGADOS: ${outros.length ? outros.map((d) => d.name).join(", ") : "nenhum"}`);
console.log(`\nFONTE: Mercado Livre, categorias ${CATEGORIAS.join(" + ")}`);

const mudas = burstsOutsideWindow(config.scheduler.startHour, config.scheduler.endHour);
console.log(`\nJANELA: ${config.scheduler.startHour}h-${config.scheduler.endHour}h sobre ${BURST_WINDOWS.length} rajadas`);
console.log(mudas.length ? `   ATENCAO: ${mudas.length} rajada(s) silenciada(s): ${mudas.map((j) => `${j.hora}h`).join(", ")}` : "   todas as rajadas cabem na janela");
console.log(`CURVA DE HORARIO: ${config.timingCurve ? "ligada (so publica nas rajadas)" : "DESLIGADA (publica a qualquer hora, para o teste)"}`);
console.log(`MODO DE LINK: allowParamLinks=${config.affiliate.allowParamLinks}${config.affiliate.allowParamLinks ? "" : "  <- sem isto nada publica: sem extensao e sem linkbuilder, o modo cai em 'none'"}`);
console.log(`IA: ${config.ai.enabled ? `ligada (${config.ai.model})` : "desligada"}`);

if (!aplicar) { console.log("\nEnsaio. Rode de novo com --aplicar para gravar."); process.exit(0); }

await store.update((state) => {
  for (const destino of state.destinations) {
    const eAlvo = destino.id === alvo.id;
    destino.active = eAlvo;
    if (!eAlvo) continue;
    Object.assign(destino, {
      nicheIds: [...NICHOS],
      ...ACHADINHOS_PRESET,
      blockedKeywords: [...ACHADINHOS_PRESET.blockedKeywords],
      requireAnyByNiche: structuredClone(ACHADINHOS_PRESET.requireAnyByNiche),
      minMinutesBetweenPosts: INTERVALO,
      // Folga proposital: parte da fila e barrada pelo destino, e oferta barrada
      // ainda ocupa vaga no teto. Sem folga a rajada nunca fecha os 10.
      maxDailyPosts: Math.max(destino.maxDailyPosts ?? 0, POSTS_POR_RAJADA * 2),
      minDiscount: 10
    });
  }

  const fonte = state.sources.find((item) => item.id === MercadoLivreSource.id);
  if (!fonte) throw new Error("A fonte do Mercado Livre nao esta no store — a semeadura falhou");
  {
    Object.assign(fonte, {
      enabled: true,
      categories: [...CATEGORIAS],
      cursor: 0,
      pages: 4,
      maxPerRun: POSTS_POR_RAJADA + 4,
      // O padrao e 2 por nicho: num canal so de beleza isso limitaria a rodada a
      // dois itens de beleza e ela voltaria vazia.
      maxPerNiche: POSTS_POR_RAJADA + 4,
      minDiscount: 15,
      maxPrice: ACHADINHOS_PRESET.maxPrice
    });
  }
});

console.log("\nAplicado. A fonte ainda nao coletou nada: rode a ingestao para encher a fila.");
