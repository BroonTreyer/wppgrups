import { parseAffiliateParams } from "./domain/affiliate.js";

const int = (value, fallback) => Number.isFinite(Number.parseInt(value ?? "", 10)) ? Number.parseInt(value, 10) : fallback;
const bool = (value, fallback = false) => value === undefined ? fallback : ["1", "true", "yes", "sim"].includes(value.toLowerCase());
const decimal = (value, fallback) => Number.isFinite(Number.parseFloat(value ?? "")) ? Number.parseFloat(value) : fallback;

export function loadConfig(env = process.env) {
  const affiliates = Object.fromEntries(
    [["Mercado Livre", parseAffiliateParams(env.MELI_AFFILIATE_PARAMS)]].filter(([, params]) => params)
  );
  return {
    port: int(env.PORT, 3000),
    appBaseUrl: env.APP_BASE_URL ?? "http://localhost:3000",
    adminToken: env.ADMIN_TOKEN ?? "development-only-token",
    dataFile: env.DATA_FILE ?? new URL("../data/store.json", import.meta.url),
    dryRun: bool(env.DRY_RUN, true),
    // Curva de cadencia por hora e dia da semana (src/domain/timing.js). Ligada,
    // ela concentra os posts no pico e fecha a madrugada. Desligar (`false`) volta
    // ao intervalo fixo — util para testar em volume fora do horario comercial.
    timingCurve: bool(env.TIMING_CURVE, true),
    scheduler: {
      enabled: bool(env.SCHEDULER_ENABLED, true),
      intervalSeconds: int(env.SCHEDULER_INTERVAL_SECONDS, 60),
      retryDelayMinutes: int(env.QUEUE_RETRY_DELAY_MINUTES, 5),
      startHour: int(env.PUBLISHING_START_HOUR, 8),
      endHour: int(env.PUBLISHING_END_HOUR, 23)
    },
    affiliates,
    allowUntaggedLinks: bool(env.ALLOW_UNTAGGED_LINKS, false),
    affiliate: {
      allowParamLinks: bool(env.ALLOW_PARAM_LINKS, true),
      extensionTimeoutMinutes: int(env.AFFILIATE_EXTENSION_TIMEOUT_MINUTES, 10)
    },
    ingestion: {
      enabled: bool(env.INGESTION_ENABLED, true),
      intervalMinutes: int(env.INGESTION_INTERVAL_MINUTES, 30),
      memoryHours: int(env.INGESTION_MEMORY_HOURS, 72),
      priceDropTolerance: decimal(env.INGESTION_PRICE_DROP_TOLERANCE, 0.05)
    },
    // Classificacao por IA. Desligada por padrao: sem chave, sem custo e sem
    // surpresa — a regra continua respondendo sozinha.
    ai: {
      enabled: bool(env.AI_CLASSIFIER_ENABLED, false),
      apiKey: env.ANTHROPIC_API_KEY ?? "",
      model: env.AI_CLASSIFIER_MODEL ?? "claude-opus-5",
      effort: env.AI_CLASSIFIER_EFFORT ?? "low",
      batchSize: int(env.AI_CLASSIFIER_BATCH_SIZE, 25),
      // Cada produto se paga uma vez por mes, nao a cada rodada de ingestao.
      memoryDays: int(env.AI_CLASSIFIER_MEMORY_DAYS, 30)
    },
    freshness: {
      minutes: int(env.PRICE_FRESHNESS_MINUTES, 25),
      maxAgeHours: int(env.QUEUE_MAX_AGE_HOURS, 6),
      priceRiseTolerance: decimal(env.PRICE_RISE_TOLERANCE, 0.02),
      minDiscountAfterRefresh: int(env.MIN_DISCOUNT_AFTER_REFRESH, 10),
      refreshPages: int(env.REFRESH_PAGES, 2),
      minValidityMinutes: int(env.MIN_OFFER_VALIDITY_MINUTES, 30),
      queueHorizonHours: decimal(env.QUEUE_HORIZON_HOURS, 2),
      urgentMinutes: int(env.URGENT_OFFER_MINUTES, 120)
    },
    retention: {
      publicationDays: int(env.RETENTION_PUBLICATION_DAYS, 90),
      queueDays: int(env.RETENTION_QUEUE_DAYS, 7),
      maxOffers: int(env.RETENTION_MAX_OFFERS, 5000)
    },
    limits: {
      maxPostsPerChannelPerDay: int(env.MAX_POSTS_PER_CHANNEL_PER_DAY, 40),
      maxPostsPerGroupPerDay: int(env.MAX_POSTS_PER_GROUP_PER_DAY, 12),
      channelMinutesBetweenPosts: int(env.CHANNEL_MINUTES_BETWEEN_POSTS, 20),
      groupMinutesBetweenPosts: int(env.GROUP_MINUTES_BETWEEN_POSTS, 45),
      deduplicationHours: int(env.DEDUPLICATION_HOURS, 24),
      republishCooldownDays: int(env.REPUBLISH_COOLDOWN_DAYS, 30),
      minMinutesFloor: int(env.MIN_MINUTES_BETWEEN_POSTS_FLOOR, 3)
    },
    zapi: {
      baseUrl: env.ZAPI_BASE_URL ?? "https://api.z-api.io",
      instanceId: env.ZAPI_INSTANCE_ID ?? "",
      instanceToken: env.ZAPI_INSTANCE_TOKEN ?? "",
      clientToken: env.ZAPI_CLIENT_TOKEN ?? "",
      webhookSecret: env.ZAPI_WEBHOOK_SECRET ?? "development-webhook-secret",
      channelImageEnabled: bool(env.ZAPI_CHANNEL_IMAGE_ENABLED, false)
    }
  };
}

export function assertSafeConfig(config) {
  if (!config.dryRun && config.adminToken === "development-only-token") throw new Error("Defina ADMIN_TOKEN antes de ativar envios reais");
  if (!config.dryRun && config.zapi.webhookSecret === "development-webhook-secret") throw new Error("Defina ZAPI_WEBHOOK_SECRET antes de ativar envios reais");
  if (!config.dryRun && (!config.zapi.instanceId || !config.zapi.instanceToken || !config.zapi.clientToken)) {
    throw new Error("Defina todas as credenciais da Z-API antes de ativar envios reais");
  }
  if (config.scheduler.startHour < 0 || config.scheduler.startHour > 23 || config.scheduler.endHour < 1 || config.scheduler.endHour > 24) {
    throw new Error("A janela de publicacao deve usar horas entre 0 e 24");
  }
  if (config.scheduler.intervalSeconds < 10) throw new Error("SCHEDULER_INTERVAL_SECONDS deve ser pelo menos 10");
  if (config.ingestion.intervalMinutes < 5) throw new Error("INGESTION_INTERVAL_MINUTES deve ser pelo menos 5");
  if (config.freshness.minutes < 1) throw new Error("PRICE_FRESHNESS_MINUTES deve ser pelo menos 1");
  if (config.freshness.maxAgeHours < 1) throw new Error("QUEUE_MAX_AGE_HOURS deve ser pelo menos 1");
  if (config.freshness.priceRiseTolerance < 0 || config.freshness.priceRiseTolerance >= 1) throw new Error("PRICE_RISE_TOLERANCE deve estar entre 0 e 1");
  if (config.limits.republishCooldownDays < 0) throw new Error("REPUBLISH_COOLDOWN_DAYS nao pode ser negativo");
  if (config.ingestion.memoryHours < 1) throw new Error("INGESTION_MEMORY_HOURS deve ser pelo menos 1");
  if (config.ingestion.priceDropTolerance < 0 || config.ingestion.priceDropTolerance >= 1) throw new Error("INGESTION_PRICE_DROP_TOLERANCE deve estar entre 0 e 1");
  // Ligar a IA sem chave nao quebra nada — cai na regra em silencio. E o silencio
  // e o problema: quem ligou acha que esta usando IA e nao esta.
  if (config.ai.enabled && !config.ai.apiKey) throw new Error("Defina ANTHROPIC_API_KEY antes de ligar AI_CLASSIFIER_ENABLED");
  if (config.ai.batchSize < 1 || config.ai.batchSize > 50) throw new Error("AI_CLASSIFIER_BATCH_SIZE deve estar entre 1 e 50");
  if (!["low", "medium", "high", "xhigh", "max"].includes(config.ai.effort)) throw new Error("AI_CLASSIFIER_EFFORT deve ser low, medium, high, xhigh ou max");
}
