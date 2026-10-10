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

  // Estado da sessao do WhatsApp. Com a sessao caida o /send-* NAO falha: a Z-API
  // enfileira e responde 200, e o bot contaria como publicado (14/09/2026).
  getStatus() {
    return this.request("/status", { method: "GET" });
  }

  getGroups() {
    return this.request("/groups", { method: "GET" });
  }

  // A listagem /chats mente sobre o grupo (ex.: isGroupAnnouncement); so o
  // metadata traz participantes e configuracao reais.
  getGroupMetadata(groupId) {
    return this.request(`/group-metadata/${encodeURIComponent(groupId)}`, { method: "GET" });
  }

  // Lista de conversas, da mais recente para a mais antiga. Nesta instancia
  // (multi-device) e o unico jeito de ver quem escreveu: /chat-messages responde
  // "Does not work in multi device version" e o webhook de recebidas pertence ao Make.
  getChats({ page = 1, pageSize = 50 } = {}) {
    return this.request(`/chats?page=${page}&pageSize=${pageSize}`, { method: "GET" });
  }

  // `typingSeconds` (1-15) mostra "digitando..." antes de entregar.
  sendText({ destinationId, message, typingSeconds }) {
    const extra = typingSeconds ? { delayTyping: Math.min(15, Math.max(1, Math.round(typingSeconds))) } : {};
    return this.request("/send-text", { method: "POST", body: JSON.stringify({ phone: destinationId, message, ...extra }) });
  }

  // Audio como mensagem de VOZ (waveform), igual a um gravado na hora. `audio` e
  // URL ou data URI base64. `delaySeconds` (1-15) e a espera antes da entrega,
  // com "gravando audio..." na conversa.
  sendAudio({ destinationId, audio, delaySeconds }) {
    const extra = delaySeconds ? { delayMessage: Math.min(15, Math.max(1, Math.round(delaySeconds))) } : {};
    return this.request("/send-audio", {
      method: "POST",
      body: JSON.stringify({ phone: destinationId, audio, waveform: true, viewOnce: false, ...extra })
    });
  }

  // Para onde a Z-API entrega as mensagens RECEBIDAS (e, com notifySentByMe, as
  // que o dono manda pelo celular — e assim que o robo sabe que ele assumiu).
  setReceivedWebhook(url) {
    return this.request("/update-webhook-received", { method: "PUT", body: JSON.stringify({ value: url }) });
  }

  setNotifySentByMe(enabled) {
    return this.request("/update-notify-sent-by-me", { method: "PUT", body: JSON.stringify({ notifySentByMe: Boolean(enabled) }) });
  }

  getInstanceInfo() {
    return this.request("/me", { method: "GET" });
  }

  // `pollMaxOptions` e quantas opcoes a pessoa pode marcar. Igual ao numero de
  // opcoes = marcar quantas quiser.
  sendPoll({ destinationId, question, options, maxOptions = 1 }) {
    return this.request("/send-poll", {
      method: "POST",
      body: JSON.stringify({ phone: destinationId, message: question, poll: options.map((name) => ({ name })), pollMaxOptions: maxOptions })
    });
  }

  updateGroupDescription({ groupId, description }) {
    return this.request("/update-group-description", { method: "POST", body: JSON.stringify({ groupId, groupDescription: description }) });
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
