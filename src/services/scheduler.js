export function startScheduler({ queueService, ingestionService, retentionService, operationService, affiliateLinkService, config, logger = console }) {
  const timers = [];
  const every = (seconds, task) => {
    const timer = setInterval(task, seconds * 1000);
    timer.unref();
    timers.push(timer);
  };

  const paused = async () => Boolean(operationService) && !(await operationService.isRunning());

  if (config.scheduler.enabled) every(config.scheduler.intervalSeconds, async () => {
    if (await paused()) return;
    if (affiliateLinkService) {
      try {
        const { rescued } = await affiliateLinkService.rescueAwaitingLink();
        if (rescued) logger.log(`Link de afiliado: ${rescued} oferta(s) destravada(s) por parametros`);
      } catch (error) {
        logger.error("Falha ao destravar ofertas sem link:", error.message);
      }
    }
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

  // A cada 6 horas bastava quando o dia inteiro cabia em algumas centenas de
  // registros. A 1.200 posts por dia o estado cresce megabytes entre uma poda e a
  // seguinte, e cada gravacao copia o estado inteiro — a limpeza deixou de ser
  // arrumacao e virou parte da vazao.
  if (retentionService) every(config.retention.pruneIntervalMinutes * 60, async () => {
    try {
      const pruned = await retentionService.prune();
      if (Object.values(pruned).some(Boolean)) logger.log("Limpeza do historico:", JSON.stringify(pruned));
    } catch (error) {
      logger.error("Falha na limpeza do historico:", error.message);
    }
  });

  return () => timers.forEach(clearInterval);
}
