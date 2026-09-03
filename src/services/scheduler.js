export function startScheduler({ queueService, ingestionService, retentionService, operationService, config, logger = console }) {
  const timers = [];
  const every = (seconds, task) => {
    const timer = setInterval(task, seconds * 1000);
    timer.unref();
    timers.push(timer);
  };

  const paused = async () => Boolean(operationService) && !(await operationService.isRunning());

  if (config.scheduler.enabled) every(config.scheduler.intervalSeconds, async () => {
    if (await paused()) return;
    const result = await queueService.processNext();
    if (result.processed) logger.log(`Oferta publicada pela fila: ${result.itemId}`);
    if (result.error) logger.error("Falha ao processar fila:", result.error);
  });

  if (config.ingestion.enabled && ingestionService) every(config.ingestion.intervalMinutes * 60, async () => {
    if (await paused() || !queueService.isWithinPublishingWindow()) return;
    try {
      for (const run of (await ingestionService.run()).runs ?? []) {
        logger.log(`Ingestao ${run.sourceId}: ${run.enqueued} na fila, ${run.rejected} filtradas, ${run.duplicated} repetidas`);
        for (const error of run.errors) logger.error(`Ingestao ${run.sourceId}:`, error);
      }
    } catch (error) {
      logger.error("Falha na ingestao de ofertas:", error.message);
    }
  });

  if (retentionService) every(6 * 3600, async () => {
    try {
      const pruned = await retentionService.prune();
      if (Object.values(pruned).some(Boolean)) logger.log("Limpeza do historico:", JSON.stringify(pruned));
    } catch (error) {
      logger.error("Falha na limpeza do historico:", error.message);
    }
  });

  return () => timers.forEach(clearInterval);
}
