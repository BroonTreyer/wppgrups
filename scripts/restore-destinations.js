// Reconstroi os destinos e a configuracao editorial depois de uma perda do store.
//
// O store de 08/09/2026 virou 5 MB de NUL num desligamento abrupto e levou junto
// a lista de palavras bloqueadas, a exigencia de marcacao feminina e o teto de
// preco — configuracao que so existia como dado. Agora o preset vive em
// src/domain/audience.js e este script o reaplica.
//
//   node --env-file-if-exists=.env scripts/restore-destinations.js          (mostra o que faria)
//   node --env-file-if-exists=.env scripts/restore-destinations.js --aplicar
//
// Nao liga destino nenhum: `active` continua como esta. Ligar e decisao de quem opera.

import { loadConfig } from "../src/config.js";
import { JsonStore } from "../src/infra/json-store.js";
import { ZApiClient } from "../src/infra/zapi-client.js";
import { DestinationService } from "../src/services/destination-service.js";
import { ACHADINHOS_PRESET } from "../src/domain/audience.js";

const aplicar = process.argv.includes("--aplicar");
const config = loadConfig();
const store = new JsonStore(config.dataFile, {
  onRecovery: (mensagem) => console.warn(`[store] ${mensagem}`)
});
const zapi = new ZApiClient(config.zapi);
const destinations = new DestinationService({ store, zapi, config });

console.log("Sincronizando destinos com a Z-API...");
const lista = await destinations.sync();
console.log(`${lista.length} destino(s) encontrado(s).\n`);

const alvos = lista.filter((destino) => /achadinhos/i.test(destino.name ?? ""));
if (!alvos.length) {
  console.error("Nenhum destino Achadinhos veio da Z-API — nada a configurar.");
  process.exit(1);
}

for (const destino of alvos) {
  const faltando = ACHADINHOS_PRESET.blockedKeywords.length - (destino.blockedKeywords ?? []).length;
  console.log(`${destino.active ? "[ligado] " : "[parado] "}${destino.name} (${destino.type})`);
  console.log(`   nichos: ${(destino.nicheIds ?? []).join(", ") || "nenhum"}`);
  console.log(`   filtro de publico: ${(destino.blockedKeywords ?? []).length} palavras -> ${ACHADINHOS_PRESET.blockedKeywords.length} (${faltando >= 0 ? "+" : ""}${faltando})`);
  console.log(`   teto de preco: ${destino.maxPrice ?? "nenhum"} -> R$ ${ACHADINHOS_PRESET.maxPrice}`);
}

if (!aplicar) {
  console.log("\nEnsaio. Rode de novo com --aplicar para gravar.");
  process.exit(0);
}

await store.update((state) => {
  for (const alvo of alvos) {
    const destino = state.destinations.find((item) => item.id === alvo.id);
    if (!destino) continue;
    Object.assign(destino, {
      blockedKeywords: [...ACHADINHOS_PRESET.blockedKeywords],
      requireAnyByNiche: structuredClone(ACHADINHOS_PRESET.requireAnyByNiche),
      maxPrice: ACHADINHOS_PRESET.maxPrice
    });
  }
});

console.log(`\nPreset aplicado em ${alvos.length} destino(s). Os destinos seguem como estavam: ative no painel.`);
