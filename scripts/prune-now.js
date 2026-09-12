// Poda o store uma vez, fora do ciclo de 6h do agendador.
//
// Existe para o dia em que a retencao muda: sem isto, o acumulo que motivou a
// mudanca so seria cortado na proxima varredura automatica, e ate la cada
// gravacao segue pagando o preco do estado inchado.
import { loadConfig } from "../src/config.js";
import { JsonStore } from "../src/infra/json-store.js";
import { RetentionService } from "../src/services/retention-service.js";

const config = loadConfig(process.env);
const store = new JsonStore(config.dataFile);
const antes = await store.read();
const tamanho = (estado) => (Buffer.byteLength(JSON.stringify(estado)) / 1024 / 1024).toFixed(2);

console.log("antes :", tamanho(antes), "MB |", `fila ${antes.queue.length}`,
  `| publicacoes ${antes.publications.length}`, `| pedidos ${(antes.affiliateRequests ?? []).length}`);

const podado = await new RetentionService({ store, config }).prune();
const depois = await store.read();

console.log("depois:", tamanho(depois), "MB |", `fila ${depois.queue.length}`,
  `| publicacoes ${depois.publications.length}`, `| pedidos ${(depois.affiliateRequests ?? []).length}`);
console.log("removidos:", JSON.stringify(podado));
