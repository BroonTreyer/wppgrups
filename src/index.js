import { assertSafeConfig, loadConfig } from "./config.js";
import { JsonStore } from "./infra/json-store.js";
import { ZApiClient } from "./infra/zapi-client.js";
import { DestinationService } from "./services/destination-service.js";
import { PublicationService } from "./services/publication-service.js";
import { QueueService } from "./services/queue-service.js";
import { ProductLinkService } from "./services/product-link-service.js";
import { startScheduler } from "./services/scheduler.js";
import { createApp } from "./http/server.js";

const config = loadConfig();
assertSafeConfig(config);
const store = new JsonStore(config.dataFile);
const zapi = new ZApiClient(config.zapi);
const destinationService = new DestinationService({ store, zapi, config });
const publicationService = new PublicationService({ store, zapi, config });
const queueService = new QueueService({ store, publicationService, config });
const productLinkService = new ProductLinkService();
const stopScheduler = startScheduler({ queueService, config });
const server = createApp({ config, destinationService, publicationService, queueService, productLinkService });

server.listen(config.port, () => console.log(`OfertaFlow ativo em ${config.appBaseUrl} (dry-run: ${config.dryRun})`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  stopScheduler();
  server.close(() => process.exit(0));
});
