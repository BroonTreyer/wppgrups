// API de Conversoes do Meta. Existe por um motivo so: o evento que o Meta
// otimiza precisa ser a ENTRADA NO GRUPO, e isso acontece dentro do WhatsApp,
// onde pixel nenhum alcanca. Em 10-13/09/2026 a campanha otimizou por um Lead
// disparado na pagina-ponte: 273 "leads" a R$0,78 e 5 ou 6 pessoas no grupo.
export class MetaConversionsClient {
  constructor({ pixelId, accessToken, testEventCode, apiVersion = "v21.0" }, fetchImpl = fetch) {
    this.pixelId = pixelId;
    this.accessToken = accessToken;
    this.testEventCode = testEventCode;
    this.apiVersion = apiVersion;
    this.fetch = fetchImpl;
  }

  get configured() {
    return Boolean(this.pixelId && this.accessToken);
  }

  async send(events) {
    if (!this.configured) throw new Error("API de Conversoes sem pixel ou token");
    const body = { data: events, access_token: this.accessToken };
    if (this.testEventCode) body.test_event_code = this.testEventCode;
    const response = await this.fetch(`https://graph.facebook.com/${this.apiVersion}/${encodeURIComponent(this.pixelId)}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Meta ${response.status}: ${result.error?.message ?? JSON.stringify(result)}`);
    return result;
  }
}
