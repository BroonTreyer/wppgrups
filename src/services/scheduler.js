export function startScheduler({ queueService, config, logger = console }) {
  if (!config.scheduler.enabled) return () => {};
  const timer = setInterval(async () => {
    const result = await queueService.processNext();
    if (result.processed) logger.log(`Oferta publicada pela fila: ${result.itemId}`);
    if (result.error) logger.error("Falha ao processar fila:", result.error);
  }, config.scheduler.intervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
