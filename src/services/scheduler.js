export function startScheduler({ queueService, ingestionService, retentionService, operationService, affiliateLinkService, memberTracker, dailyClosing, welcomeResponder, connectionGuard, config, logger = console }) {
  // Sem guarda (testes, dry-run antigo) tudo segue como antes.
  const conectado = async () => !connectionGuard || await connectionGuard.isConnected();
  const timers = [];
  const every = (seconds, task) => {
    const timer = setInterval(task, seconds * 1000);
    timer.unref();
    timers.push(timer);
  };

  const paused = async () => Boolean(operationService) && !(await operationService.isRunning());

  if (config.scheduler.enabled) every(config.scheduler.intervalSeconds, async () => {
    if (await paused()) return;
    if (!(await conectado())) return;
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

  // Fora do `paused()` e da janela de publicacao: o anuncio traz gente a qualquer
  // hora, e quem pediu o link as 23h nao pode esperar ate as 5h.
  let respondendo = false;
  if (welcomeResponder && config.welcome?.enabled) every(config.welcome.pollSeconds, async () => {
    if (respondendo) return;
    if (!(await conectado())) return;
    respondendo = true;
    try {
      const result = await welcomeResponder.tick();
      if (result.baseline !== undefined) logger.log(`Boas-vindas: foto inicial com ${result.baseline} conversas (nenhuma sera respondida)`);
      if (result.replied) logger.log(`Boas-vindas: ${result.replied} link(s) do grupo ${result.dryRun ? "que SERIAM enviados (ensaio)" : "enviados"}`);
      if (result.failed) logger.error(`Boas-vindas: ${result.failed} envio(s) falharam`);
    } catch (error) {
      logger.error("Falha nas boas-vindas:", error.message);
    } finally {
      respondendo = false;
    }
  });

  if (dailyClosing && config.dailyClosing?.groups?.length) every(60, async () => {
    // Desconectado nao conta tentativa: a janela de 45 min segue valendo e o
    // fechamento sai assim que a sessao voltar dentro dela.
    if (!(await conectado())) return;
    try {
      const result = await dailyClosing.tick();
      for (const item of result.results ?? []) {
        if (item.sent) logger.log(`Fechamento do dia enviado em ${item.groupId}`);
        if (item.error) logger.error(`Fechamento do dia em ${item.groupId} falhou (tentativa ${item.attempts}):`, item.error);
      }
    } catch (error) {
      logger.error("Falha no fechamento do dia:", error.message);
    }
  });

  // Fora do `paused()` de proposito: o anuncio gasta com a operacao pausada ou
  // nao, e a medicao de quem entrou nao pode parar junto com as publicacoes.
  if (memberTracker && config.meta?.trackedGroups?.length) every(config.meta.pollMinutes * 60, async () => {
    try {
      const result = await memberTracker.tick();
      for (const group of result.groups) {
        if (group.error) logger.error(`Membros ${group.groupId}:`, group.error);
        else if (group.ignored) logger.error(`Membros ${group.groupId}: leitura ignorada (${group.reason})`);
        else if (group.baseline) logger.log(`Membros ${group.groupId}: base fotografada com ${group.baseline}`);
        else if (group.joined || group.left) logger.log(`Membros ${group.groupId}: +${group.joined} entraram, -${group.left} sairam (${group.members} no grupo)`);
      }
      if (result.sent) logger.log(`Meta: ${result.sent} entrada(s) enviada(s) como conversao`);
      if (result.error) logger.error("Meta: falha ao enviar entradas:", result.error);
    } catch (error) {
      logger.error("Falha na medicao de membros:", error.message);
    }
  });

  return () => timers.forEach(clearInterval);
}
