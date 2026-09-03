import { readFile } from "node:fs/promises";
import { decorateAffiliateUrl, isAttributedLink } from "../domain/affiliate.js";
import { productKey } from "../domain/offer.js";

const SESSION_MARKERS = ["/login", "identification_challenge", "captcha", "signin"];
const MAX_CACHE = 20_000;
const MAX_REQUESTS = 500;
const MAX_ATTEMPTS = 3;

const findLink = (payload, depth = 0) => {
  if (depth > 6 || payload === null || payload === undefined) return null;
  if (typeof payload === "string") return isAttributedLink(payload) ? payload : null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findLink(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof payload !== "object") return null;
  for (const value of Object.values(payload)) {
    const found = findLink(value, depth + 1);
    if (found) return found;
  }
  return null;
};

export class SessionExpiredError extends Error {
  constructor(message) { super(message); this.name = "SessionExpiredError"; }
}

export class AffiliateLinkService {
  constructor({ store, config, fetchImpl = fetch, clock = () => new Date(), builderFile } = {}) {
    this.store = store;
    this.config = config;
    this.fetch = fetchImpl;
    this.clock = clock;
    this.builderFile = builderFile ?? new URL("../../data/linkbuilder.json", import.meta.url);
    this.builder = undefined;
  }

  async loadBuilder() {
    if (this.builder !== undefined) return this.builder;
    try {
      const parsed = JSON.parse(await readFile(this.builderFile, "utf8"));
      this.builder = parsed?.url ? parsed : null;
    } catch {
      this.builder = null;
    }
    return this.builder;
  }

  async extensionOnline(state) {
    const seenAt = state.affiliateStatus?.extensionSeenAt;
    if (!seenAt) return false;
    return this.clock().getTime() - new Date(seenAt).getTime() < this.config.affiliate.extensionTimeoutMinutes * 60_000;
  }

  async mode(state) {
    const current = state ?? await this.store.read();
    if (await this.loadBuilder()) return "linkbuilder";
    if (await this.extensionOnline(current)) return "extension";
    if (this.config.affiliates?.["Mercado Livre"] && this.config.affiliate.allowParamLinks) return "params";
    if (this.config.allowUntaggedLinks) return "untagged";
    return "none";
  }

  async status() {
    const state = await this.store.read();
    const requests = state.affiliateRequests ?? [];
    return {
      mode: await this.mode(state),
      cachedLinks: state.affiliateLinks.length,
      pendingLinks: requests.filter((item) => item.status === "pending").length,
      failedLinks: requests.filter((item) => item.status === "failed").length,
      extensionSeenAt: state.affiliateStatus?.extensionSeenAt ?? null,
      extensionOnline: await this.extensionOnline(state),
      sessionValid: state.affiliateStatus?.sessionValid !== false,
      lastError: state.affiliateStatus?.lastError ?? null,
      lastErrorAt: state.affiliateStatus?.lastErrorAt ?? null
    };
  }

  async cached(key) {
    const state = await this.store.read();
    return state.affiliateLinks.find((item) => item.key === key)?.url ?? null;
  }

  async remember(key, url) {
    await this.store.update((state) => {
      state.affiliateLinks = state.affiliateLinks.filter((item) => item.key !== key).slice(-MAX_CACHE);
      state.affiliateLinks.push({ key, url, createdAt: this.clock().toISOString() });
    });
  }

  async markSession(valid, error = null) {
    await this.store.update((state) => {
      state.affiliateStatus = { ...(state.affiliateStatus ?? {}), sessionValid: valid, lastError: error, lastErrorAt: error ? this.clock().toISOString() : null };
    });
  }

  async touchExtension() {
    return this.store.update((state) => {
      state.affiliateStatus = { ...(state.affiliateStatus ?? {}), extensionSeenAt: this.clock().toISOString() };
      return state.affiliateStatus;
    });
  }

  async linkFor(offer) {
    const key = productKey(offer);
    const cachedUrl = await this.cached(key);
    if (cachedUrl) return { url: cachedUrl, attributed: true, mode: "cache", cached: true };

    const mode = await this.mode();
    if (mode === "untagged") return { url: offer.affiliateUrl, attributed: false, mode };
    if (mode === "none") throw new Error(`Configure o link de afiliado de ${offer.marketplace} antes de publicar`);
    if (mode === "params") {
      const url = decorateAffiliateUrl(offer.affiliateUrl, this.config.affiliates[offer.marketplace]);
      if (!isAttributedLink(url)) throw new Error("Os parametros configurados nao produzem um link de afiliado valido");
      return { url, attributed: true, mode };
    }
    if (mode === "extension") {
      await this.request(key, offer.affiliateUrl, offer.title);
      return { url: offer.affiliateUrl, attributed: false, mode, pending: true };
    }
    const url = await this.build(offer.affiliateUrl);
    await this.remember(key, url);
    await this.markSession(true);
    return { url, attributed: true, mode };
  }

  async request(key, productUrl, title = "") {
    return this.store.update((state) => {
      state.affiliateRequests = state.affiliateRequests ?? [];
      const existing = state.affiliateRequests.find((item) => item.key === key);
      if (existing) {
        if (existing.status === "failed" && existing.attempts < MAX_ATTEMPTS) existing.status = "pending";
        return existing;
      }
      const created = { id: crypto.randomUUID(), key, productUrl, title, status: "pending", attempts: 0, createdAt: this.clock().toISOString() };
      state.affiliateRequests = [...state.affiliateRequests.filter((item) => item.status === "pending" || item.status === "failed"), created].slice(-MAX_REQUESTS);
      return created;
    });
  }

  async retryFailed() {
    return this.store.update((state) => {
      let reset = 0;
      for (const item of state.affiliateRequests ?? []) {
        if (item.status !== "failed" && !(item.status === "pending" && item.attempts > 0)) continue;
        item.status = "pending";
        item.attempts = 0;
        item.error = null;
        reset += 1;
      }
      return { reset };
    });
  }

  async pending(limit = 5) {
    const state = await this.store.read();
    return (state.affiliateRequests ?? [])
      .filter((item) => item.status === "pending")
      .slice(0, Math.min(Math.max(Number(limit) || 1, 1), 25))
      .map(({ id, key, productUrl, title, attempts }) => ({ id, key, productUrl, title, attempts }));
  }

  async resolve({ id, link, error }) {
    const state = await this.store.read();
    const request = (state.affiliateRequests ?? []).find((item) => item.id === id);
    if (!request) throw new Error("Pedido de link nao encontrado");
    if (error) {
      await this.store.update((current) => {
        const target = current.affiliateRequests.find((item) => item.id === id);
        target.attempts += 1;
        target.status = target.attempts >= MAX_ATTEMPTS ? "failed" : "pending";
        target.error = String(error).slice(0, 300);
        target.updatedAt = this.clock().toISOString();
      });
      return { status: "failed", key: request.key };
    }
    if (!isAttributedLink(link)) throw new Error("O link recebido nao e um link de afiliado valido");
    await this.remember(request.key, link);
    await this.store.update((current) => {
      const target = current.affiliateRequests.find((item) => item.id === id);
      target.status = "done";
      target.link = link;
      target.updatedAt = this.clock().toISOString();
      for (const item of current.queue) {
        if (item.productKey !== request.key || item.status !== "awaiting-link") continue;
        item.offer.affiliateUrl = link;
        item.status = "queued";
        item.lastDeferredReason = null;
      }
    });
    return { status: "done", key: request.key, link };
  }

  async build(productUrl) {
    const builder = await this.loadBuilder();
    const body = builder.body ? JSON.stringify(JSON.parse(JSON.stringify(builder.body).replaceAll("{{url}}", productUrl))) : undefined;
    const target = builder.url.replaceAll("{{url}}", encodeURIComponent(productUrl));
    const response = await this.fetch(target, {
      method: builder.method ?? "POST",
      headers: builder.headers ?? {},
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(20_000)
    });
    const text = await response.text();
    if ([301, 302, 303, 307, 308, 401, 403].includes(response.status) || SESSION_MARKERS.some((marker) => text.includes(marker))) {
      await this.markSession(false, `Sessao do painel de afiliados expirada (HTTP ${response.status}). Atualize o cookie em data/linkbuilder.json.`);
      throw new SessionExpiredError("Sessao do painel de afiliados expirada");
    }
    if (!response.ok) {
      await this.markSession(false, `Gerador de links respondeu ${response.status}`);
      throw new Error(`Gerador de links respondeu ${response.status}`);
    }
    let payload;
    try { payload = JSON.parse(text); } catch { payload = text; }
    const link = findLink(payload);
    if (!link) {
      await this.markSession(false, "Resposta do gerador nao trouxe um link de afiliado reconhecivel");
      throw new Error("Resposta do gerador nao trouxe um link de afiliado reconhecivel");
    }
    return link;
  }
}
