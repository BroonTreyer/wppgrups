export class ZApiClient {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  assertConfigured() {
    const { instanceId, instanceToken, clientToken } = this.config;
    if (!instanceId || !instanceToken || !clientToken) throw new Error("Credenciais da Z-API nao configuradas");
  }

  url(path) {
    const { baseUrl, instanceId, instanceToken } = this.config;
    return `${baseUrl}/instances/${encodeURIComponent(instanceId)}/token/${encodeURIComponent(instanceToken)}${path}`;
  }

  async request(path, options = {}) {
    this.assertConfigured();
    const response = await this.fetch(this.url(path), {
      ...options,
      headers: { "Client-Token": this.config.clientToken, "Content-Type": "application/json", ...options.headers },
      signal: AbortSignal.timeout(20_000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Z-API ${response.status}: ${JSON.stringify(body)}`);
    return body;
  }

  getGroups() {
    return this.request("/groups", { method: "GET" });
  }

  getChannels() {
    return this.request("/newsletter", { method: "GET" });
  }

  sendImage({ destinationId, imageUrl, caption }) {
    return this.request("/send-image", {
      method: "POST",
      body: JSON.stringify({ phone: destinationId, image: imageUrl, caption, viewOnce: false })
    });
  }
}
