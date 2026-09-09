// Roda UMA rodada de ingestao e mostra o que entrou na fila. Nao publica nada.
//
//   node --env-file-if-exists=.env scripts/coletar-agora.js

import { loadConfig } from "../src/config.js";
import { JsonStore } from "../src/infra/json-store.js";
import { ZApiClient } from "../src/infra/zapi-client.js";
import { AiClassifier } from "../src/services/ai-classifier.js";
import { AffiliateLinkService } from "../src/services/affiliate-link-service.js";
import { PriceGuard } from "../src/services/price-guard.js";
import { PublicationService } from "../src/services/publication-service.js";
import { QueueService } from "../src/services/queue-service.js";
import { IngestionService } from "../src/services/ingestion-service.js";
import { MercadoLivreSource } from "../src/sources/mercado-livre.js";

const config = loadConfig();
const store = new JsonStore(config.dataFile, { onRecovery: (m) => console.warn(`[store] ${m}`) });
const zapi = new ZApiClient(config.zapi);
const sources = [new MercadoLivreSource()];
const publicationService = new PublicationService({ store, zapi, config });
const affiliateLinkService = new AffiliateLinkService({ store, config });
const queueService = new QueueService({ store, publicationService, priceGuard: new PriceGuard({ sources, config }), config });
const classifier = new AiClassifier({ store, config, onAlert: (m) => console.warn(`  [ia] ${m}`) });
const ingestionService = new IngestionService({ store, queueService, affiliateLinkService, sources, config, classifier });

console.log("Coletando do Mercado Livre...\n");
const { runs } = await ingestionService.run();

for (const stats of runs) {
  console.log(`categoria ${stats.category || "todas"}: ${stats.collected} coletadas, ${stats.rejected} recusadas, ${stats.duplicated} repetidas, ${stats.enqueued} na fila`);
  if (stats.classifiedByAi !== undefined) console.log(`   IA: ${stats.classifiedByAi} classificadas agora, ${stats.classifiedFromCache} do cache`);
  if (stats.skipped) console.log(`   pulou: ${stats.skipped}`);
  for (const erro of stats.errors ?? []) console.log(`   erro: ${erro}`);
}

const state = await store.read();
const fila = state.queue.filter((item) => ["queued", "awaiting-link"].includes(item.status));
const destino = state.destinations.find((d) => d.active);

console.log(`\nFILA: ${fila.length} oferta(s) para ${destino?.name ?? "nenhum destino ativo"}\n`);
for (const item of fila.toSorted((a, b) => b.score - a.score)) {
  const o = item.offer;
  const desconto = Math.round((1 - o.currentPrice / o.originalPrice) * 100);
  const veredito = o.audience ? (o.audience.serve ? "SERVE" : `NAO SERVE (${o.audience.motivo})`) : "sem julgamento";
  console.log(`R$ ${String(o.currentPrice).padStart(7)}  -${String(desconto).padStart(2)}%  [${item.nicheIds.join(",")}]  ${veredito}`);
  console.log(`         ${o.title.slice(0, 78)}`);
}

const bloqueadas = [];
if (destino) {
  const now = new Date();
  for (const item of fila) {
    const motivo = publicationService.blockReason({ destination: destino, offer: item.offer, nicheIds: item.nicheIds, publications: [], now });
    if (motivo) bloqueadas.push([item.offer.title, motivo]);
  }
}
console.log(`\n${fila.length - bloqueadas.length} de ${fila.length} passariam no destino agora.`);
for (const [titulo, motivo] of bloqueadas) console.log(`   barrada: ${titulo.slice(0, 55)} -> ${motivo}`);

const alertas = (state.alerts ?? []).slice(-5);
if (alertas.length) {
  console.log("\nALERTAS:");
  for (const a of alertas) console.log(`   ${a.type}: ${a.message}`);
}
