const int = (value, fallback) => Number.isFinite(Number.parseInt(value ?? "", 10)) ? Number.parseInt(value, 10) : fallback;
const bool = (value, fallback = false) => value === undefined ? fallback : ["1", "true", "yes", "sim"].includes(value.toLowerCase());

export function loadConfig(env = process.env) {
  return {
    port: int(env.PORT, 3000),
    appBaseUrl: env.APP_BASE_URL ?? "http://localhost:3000",
    adminToken: env.ADMIN_TOKEN ?? "development-only-token",
    dataFile: env.DATA_FILE ?? new URL("../data/store.json", import.meta.url),
    dryRun: bool(env.DRY_RUN, true),
    scheduler: {
      enabled: bool(env.SCHEDULER_ENABLED, true),
      intervalSeconds: int(env.SCHEDULER_INTERVAL_SECONDS, 60),
      startHour: int(env.PUBLISHING_START_HOUR, 8),
      endHour: int(env.PUBLISHING_END_HOUR, 23)
    },
    limits: {
      maxPostsPerChannelPerDay: int(env.MAX_POSTS_PER_CHANNEL_PER_DAY, 40),
      maxPostsPerGroupPerDay: int(env.MAX_POSTS_PER_GROUP_PER_DAY, 12),
      channelMinutesBetweenPosts: int(env.CHANNEL_MINUTES_BETWEEN_POSTS, 20),
      groupMinutesBetweenPosts: int(env.GROUP_MINUTES_BETWEEN_POSTS, 45),
      deduplicationHours: int(env.DEDUPLICATION_HOURS, 24)
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
}
