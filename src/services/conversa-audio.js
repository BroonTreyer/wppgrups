import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const soDigitos = (value) => String(value ?? "").replace(/\D/g, "");
const resolver = (value) => value instanceof URL ? fileURLToPath(value) : value;
const DIA = 86_400_000;
const MAX_MENSAGENS = 40;          // historico guardado por contato
const MAX_EVENTOS = 500;
const ESQUECER_DEPOIS_DIAS = 60;   // contato parado some do estado (e o telefone junto)
const ALERTA_CADA_HORAS = 6;

/**
 * Catalogo padrao: o dono grava `1-boas-vindas.ogg`, `2-como-funciona.ogg`...
 * O numero na frente do arquivo liga o audio a esta descricao. `catalogo.json`
 * na mesma pasta pode sobrescrever ou acrescentar (id, arquivo, titulo, quandoUsar).
 */
export const CATALOGO_PADRAO = [
  { numero: 1, id: "boas-vindas", titulo: "Boas-vindas", quandoUsar: "Primeira resposta para QUALQUER pessoa nova, sempre o primeiro audio da conversa. A Isa se apresenta e agradece o contato." },
  { numero: 2, id: "como-funciona", titulo: "Como o grupo funciona", quandoUsar: "A pessoa quer saber o que e o grupo, como funciona, o que e postado, em que horario, se e pago. Tambem serve como complemento natural logo apos as boas-vindas para quem ainda nao sabe nada." },
  { numero: 3, id: "e-confiavel", titulo: "E confiavel?", quandoUsar: "Desconfianca: pergunta se e golpe, se e seguro, se e original, se precisa pagar algo, como funciona a compra/entrega/pagamento." },
  { numero: 4, id: "link-do-grupo", titulo: "Vou te mandar o link", quandoUsar: "A pessoa quer entrar no grupo, pediu o link, ou ja entendeu e esta pronta. Sempre acompanhado do link em texto (mandar_link=true)." },
  { numero: 5, id: "preco-e-oferta", titulo: "Preco e oferta", quandoUsar: "Pergunta de preco, de um produto especifico, de cupom ou desconto, ou 'tem tal coisa?'. Explica que as ofertas saem no grupo e acabam rapido." },
  { numero: 6, id: "nao-consegui-entrar", titulo: "Nao consegui entrar", quandoUsar: "A pessoa diz que o link nao abre, nao consegue entrar, o grupo esta cheio ou deu erro. Normalmente acompanhado do link de novo (mandar_link=true)." },
  { numero: 7, id: "despedida", titulo: "Despedida", quandoUsar: "A pessoa agradeceu, disse que entrou, mandou 'ok', 'obrigada', emoji de joinha, ou encerrou a conversa." }
];

const MIME = { ".ogg": "audio/ogg", ".opus": "audio/ogg", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav" };

const INSTRUCOES = `Voce decide como responder, com AUDIOS JA GRAVADOS pela Isa, quem chama no WhatsApp
privado do "Achadinhos da Isa" — um grupo de WhatsApp com ofertas de BELEZA do Mercado Livre
(maquiagem, skincare, cabelo, perfume), com links de afiliada. O objetivo da conversa e a pessoa
entrar no grupo, bem atendida e sem se sentir falando com robo.

Voce NAO escreve texto livre. Voce escolhe:
- quais audios do catalogo mandar AGORA, na ordem (no maximo {MAX});
- se manda o link do grupo em texto (mandar_link) — e o unico texto que sai;
- se a conversa precisa da Isa em pessoa (precisa_humano).

Regras:
1. Leia o historico: nunca repita um audio que ja foi enviado (eles aparecem como [audio enviado: ...]).
2. Primeira mensagem de uma pessoa nova: comece por "boas-vindas" e acrescente o que responde ao que ela
   escreveu. Se ela so disse "oi"/"quero participar"/veio do anuncio, um bom caminho e boas-vindas +
   como-funciona + link-do-grupo com mandar_link=true.
3. Responda ao que a pessoa PERGUNTOU. Pergunta de preco -> audio de preco; desconfianca -> e-confiavel;
   problema com link -> nao-consegui-entrar + link. Nao empurre audio que nao tem a ver.
4. mandar_link=true sempre que mandar o audio "link-do-grupo" ou "nao-consegui-entrar", ou quando a pessoa
   pedir o link de novo. Nao mande o link se ja mandou e ela nao pediu de novo.
5. "ok", "obrigada", emoji, "entrei": despedida (se ainda nao foi), sem link. Se a despedida ja foi, nada.
6. precisa_humano=true (e nenhum audio) quando: reclamacao, problema com compra ou entrega, pedido que
   nenhum audio cobre, assunto pessoal, parceria/publicidade, a pessoa pede para falar com a Isa, ou
   parece alguem que ja conhece a Isa e nao esta falando do grupo. Na duvida entre audio errado e humano,
   escolha humano.
7. Se a pessoa pedir para parar ou disser que nao quer, nenhum audio, precisa_humano=false.
8. Audio de pessoa chega como [a pessoa mandou um audio] — voce nao sabe o conteudo; trate como
   "quer conversar": se ja recebeu as boas-vindas, precisa_humano=true.

Chame a ferramenta decidir_resposta uma unica vez.`;

const FERRAMENTA = (ids) => ({
  name: "decidir_resposta",
  description: "Decide quais audios gravados mandar agora, se manda o link do grupo e se precisa da Isa.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      audios: { type: "array", items: { type: "string", enum: ids }, description: "Ids dos audios, na ordem de envio. Vazio = nenhum." },
      mandar_link: { type: "boolean" },
      precisa_humano: { type: "boolean" },
      motivo: { type: "string", description: "Uma frase explicando a decisao (para o painel)." }
    },
    required: ["audios", "mandar_link", "precisa_humano", "motivo"],
    additionalProperties: false
  }
});

/** Texto da mensagem recebida, ou null se ela nao deve acordar o robo. */
export function textoDaMensagem(evento) {
  if (evento.reaction || evento.isEdit || evento.waitingMessage) return null;
  if (evento.text?.message) return String(evento.text.message).slice(0, 1500);
  if (evento.audio) return "[a pessoa mandou um audio]";
  if (evento.image) return evento.image.caption ? `[imagem] ${evento.image.caption}` : "[a pessoa mandou uma imagem]";
  if (evento.video) return evento.video.caption ? `[video] ${evento.video.caption}` : "[a pessoa mandou um video]";
  if (evento.buttonsResponseMessage?.message) return String(evento.buttonsResponseMessage.message);
  if (evento.listResponseMessage?.title) return String(evento.listResponseMessage.title);
  if (evento.sticker) return "[figurinha]";
  if (evento.document) return "[a pessoa mandou um arquivo]";
  if (evento.contact || evento.location) return "[a pessoa mandou um contato/localizacao]";
  return null;
}

const ehConversaPrivada = (evento) => evento.type === "ReceivedCallback" && evento.phone
  && !evento.isGroup && !evento.isNewsletter && !evento.broadcast && !evento.isStatusReply
  && !String(evento.phone).includes("-group") && !String(evento.phone).endsWith("@newsletter");

export class ConversaAudio {
  constructor({ store, mainStore, zapi, config, client, clock = () => new Date(), logger = console, ffprobe }) {
    this.store = store;            // data/conversas.json (separado: o store.json tem megabytes)
    this.mainStore = mainStore;    // so para ler os contatos que o dono ja tinha (welcome.known)
    this.zapi = zapi;
    this.config = config;
    this.clock = clock;
    this.logger = logger;
    this.client = client ?? (this.cfg.apiKey ? new Anthropic({ apiKey: this.cfg.apiKey }) : null);
    this.ffprobe = ffprobe ?? (async (arquivo) => {
      const { stdout } = await promisify(execFile)("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", arquivo]);
      return Number.parseFloat(stdout) || 0;
    });
    this.processando = new Set();
    this.duracoes = new Map();
  }

  get cfg() {
    return this.config.audioFlow;
  }

  // ------------------------------------------------------------ catalogo

  /** Audios disponiveis agora: catalogo + arquivo existente na pasta. Relido a cada uso. */
  async catalogo() {
    const pasta = resolver(this.cfg.audiosDir);
    const arquivos = await readdir(pasta).catch(() => []);
    let extra = [];
    try {
      extra = JSON.parse(await readFile(join(pasta, "catalogo.json"), "utf8")).audios ?? [];
    } catch {
      extra = [];
    }
    const porId = new Map(CATALOGO_PADRAO.map((item) => [item.id, { ...item }]));
    for (const item of extra) if (item?.id) porId.set(item.id, { ...porId.get(item.id), ...item });
    const lista = [];
    for (const item of porId.values()) {
      if (item.ativo === false) continue;
      const arquivo = item.arquivo
        ?? arquivos.find((nome) => MIME[extname(nome).toLowerCase()] && Number.parseInt(nome, 10) === item.numero);
      if (!arquivo || !arquivos.includes(arquivo)) continue;
      const caminho = join(pasta, arquivo);
      if (!this.duracoes.has(caminho)) this.duracoes.set(caminho, await this.ffprobe(caminho).catch(() => 0));
      lista.push({ ...item, arquivo, caminho, segundos: this.duracoes.get(caminho) });
    }
    return lista.sort((a, b) => (a.numero ?? 99) - (b.numero ?? 99));
  }

  // ------------------------------------------------------------ entrada

  /** Webhook de mensagem recebida da Z-API. Nunca lanca: o webhook responde 200 sempre. */
  async receber(evento) {
    if (!this.cfg.enabled || !evento || !ehConversaPrivada(evento)) return { ignorado: "fora do fluxo" };
    const phone = String(evento.phone);
    const chave = sha256(soDigitos(phone) || phone);
    const agora = this.clock().toISOString();

    if (evento.fromMe) {
      // Mandada pela API (o proprio robo) nao conta; pelo celular = o dono assumiu.
      if (evento.fromApi) return { ignorado: "enviada pelo robo" };
      const texto = textoDaMensagem(evento);
      await this.store.update((state) => {
        const c = (state.contatos ??= {})[chave];
        if (!c) return;
        c.humanoAte = new Date(this.clock().getTime() + this.cfg.humanPauseHours * 3_600_000).toISOString();
        c.pendente = false;
        if (texto) c.mensagens = [...(c.mensagens ?? []), { de: "isa", texto, at: agora }].slice(-MAX_MENSAGENS);
        this.registrar(state, { chave, tipo: "isa-assumiu" });
      });
      return { humano: true };
    }

    const texto = textoDaMensagem(evento);
    if (!texto) return { ignorado: "sem conteudo" };
    if (this.cfg.onlyPhones.length && !this.cfg.onlyPhones.includes(soDigitos(phone))) return { ignorado: "fora da lista de teste" };

    const conhecidos = new Set(((await this.mainStore.read()).welcome?.known) ?? []);
    return this.store.update((state) => {
      const contatos = (state.contatos ??= {});
      let c = contatos[chave];
      if (!c) {
        // Quem ja conversava com o dono antes do robo existir nunca recebe audio
        // automatico: e cliente, amiga, fornecedor — nao lead.
        const antigo = conhecidos.has(chave) && !this.cfg.onlyPhones.includes(soDigitos(phone));
        c = contatos[chave] = { phone, nome: evento.senderName || evento.chatName || "", criadoEm: agora, mensagens: [], audiosEnviados: [], turnos: [], ignorado: antigo ? "contato antigo do dono" : null };
        this.registrar(state, { chave, tipo: antigo ? "contato-antigo" : "novo-contato" });
      }
      c.phone = phone;
      c.mensagens = [...(c.mensagens ?? []), { de: "pessoa", texto, at: agora }].slice(-MAX_MENSAGENS);
      c.ultimaEntrada = agora;
      if (!c.ignorado) c.pendente = true;
      return { pendente: Boolean(c.pendente) };
    });
  }

  // ------------------------------------------------------------ resposta

  /** Responde quem parou de escrever ha `debounceSeconds`. Chamado pelo agendador. */
  async tick() {
    if (!this.cfg.enabled) return { respondidos: 0 };
    const agora = this.clock().getTime();
    const state = await this.store.read();
    const prontos = Object.entries(state.contatos ?? {}).filter(([chave, c]) => c.pendente && !this.processando.has(chave)
      && agora - Date.parse(c.ultimaEntrada) >= this.cfg.debounceSeconds * 1000);
    let respondidos = 0;
    for (const [chave] of prontos) {
      this.processando.add(chave);
      try {
        if (await this.responder(chave)) respondidos += 1;
      } catch (error) {
        this.logger.error(`Conversa por audio: falha ao responder ${chave.slice(0, 8)}:`, error.message);
        await this.store.update((s) => {
          const c = s.contatos?.[chave];
          if (c) c.pendente = false;
          this.registrar(s, { chave, tipo: "erro", detalhe: error.message });
        });
      } finally {
        this.processando.delete(chave);
      }
    }
    if (respondidos || Math.random() < 0.01) await this.podar();
    return { respondidos };
  }

  async responder(chave) {
    const state = await this.store.read();
    const c = state.contatos?.[chave];
    if (!c?.pendente) return false;
    // Mensagem que chegar DURANTE a resposta (audios levam segundos para sair)
    // deixa o contato pendente de novo, em vez de ser engolida.
    const marco = c.ultimaEntrada;
    const agora = this.clock();
    const parar = (motivo) => this.store.update((s) => {
      const atual = s.contatos[chave];
      atual.pendente = atual.ultimaEntrada !== marco;
      this.registrar(s, { chave, tipo: "sem-resposta", detalhe: motivo });
      return false;
    });
    if (c.humanoAte && Date.parse(c.humanoAte) > agora.getTime()) return parar("a Isa assumiu esta conversa");
    const hoje = (c.turnos ?? []).filter((t) => agora.getTime() - Date.parse(t) < DIA).length;
    if (hoje >= this.cfg.maxTurnsPerDay) return parar(`teto de ${this.cfg.maxTurnsPerDay} respostas por dia`);

    const catalogo = await this.catalogo();
    if (!catalogo.length) return parar("nenhum audio gravado na pasta");
    const decisao = await this.decidir(c, catalogo);

    const porId = new Map(catalogo.map((item) => [item.id, item]));
    const audios = [...new Set(decisao.audios)]
      .filter((id) => porId.has(id) && !(c.audiosEnviados ?? []).includes(id))
      .slice(0, this.cfg.maxAudiosPerTurn)
      .map((id) => porId.get(id));
    const mandarLink = Boolean(decisao.mandar_link);

    const enviados = [];
    if (!this.cfg.dryRun) {
      for (const [i, audio] of audios.entries()) {
        const dados = (await readFile(audio.caminho)).toString("base64");
        const mime = MIME[extname(audio.arquivo).toLowerCase()] ?? "audio/ogg";
        // "gravando audio..." proporcional ao tamanho, como quem grava na hora;
        // o primeiro um pouco mais curto (a pessoa acabou de escrever).
        const gravando = Math.min(15, Math.max(3, (audio.segundos || 10) * (i === 0 ? 0.25 : 0.4)));
        await this.zapi.sendAudio({ destinationId: c.phone, audio: `data:${mime};base64,${dados}`, delaySeconds: gravando });
        enviados.push(audio.id);
      }
      if (mandarLink) await this.zapi.sendText({ destinationId: c.phone, message: this.cfg.inviteLink, typingSeconds: 3 });
      if (decisao.precisa_humano) await this.alertar(c, decisao.motivo);
    }

    return this.store.update((s) => {
      const atual = s.contatos[chave];
      const at = this.clock().toISOString();
      atual.pendente = atual.ultimaEntrada !== marco;
      if (!this.cfg.dryRun) {
        atual.audiosEnviados = [...new Set([...(atual.audiosEnviados ?? []), ...enviados])];
        for (const id of enviados) atual.mensagens.push({ de: "robo", texto: `[audio enviado: ${porId.get(id).titulo}]`, at });
        if (mandarLink) {
          atual.mensagens.push({ de: "robo", texto: "[link do grupo enviado]", at });
          atual.linkEnviadoEm = at;
        }
        if (enviados.length || mandarLink) atual.turnos = [...(atual.turnos ?? []), at].slice(-20);
        if (decisao.precisa_humano) atual.precisaHumanoEm = at;
        atual.mensagens = atual.mensagens.slice(-MAX_MENSAGENS);
      }
      this.registrar(s, {
        chave,
        tipo: this.cfg.dryRun ? "ensaio" : "resposta",
        audios: audios.map((a) => a.id),
        link: mandarLink,
        humano: Boolean(decisao.precisa_humano),
        detalhe: decisao.motivo
      });
      return true;
    });
  }

  async decidir(contato, catalogo) {
    if (!this.client) throw new Error("sem cliente da IA (ANTHROPIC_API_KEY)");
    const lista = catalogo.map((a) => `- ${a.id} (${Math.round(a.segundos || 0)}s) — ${a.titulo}: ${a.quandoUsar}`).join("\n");
    const historico = (contato.mensagens ?? []).map((m) => `${{ pessoa: "PESSOA", robo: "ROBO", isa: "ISA (em pessoa)" }[m.de] ?? m.de}: ${m.texto}`).join("\n");
    const ja = (contato.audiosEnviados ?? []).join(", ") || "nenhum";
    const resposta = await this.client.messages.create({
      model: this.cfg.model,
      max_tokens: 2000,
      system: [{ type: "text", text: INSTRUCOES.replace("{MAX}", String(this.cfg.maxAudiosPerTurn)), cache_control: { type: "ephemeral" } }],
      tools: [FERRAMENTA(catalogo.map((a) => a.id))],
      messages: [{
        role: "user",
        content: `Audios disponiveis:\n${lista}\n\nAudios ja enviados a esta pessoa: ${ja}\nLink do grupo ja enviado: ${contato.linkEnviadoEm ? "sim" : "nao"}\nNome no WhatsApp: ${contato.nome || "(sem nome)"}\n\nConversa (a mais recente por ultimo):\n${historico}\n\nDecida a resposta chamando decidir_resposta.`
      }]
    });
    const chamada = resposta.content.find((bloco) => bloco.type === "tool_use" && bloco.name === "decidir_resposta");
    if (!chamada) throw new Error(`a IA respondeu sem decidir (stop_reason: ${resposta.stop_reason})`);
    return { audios: [], mandar_link: false, precisa_humano: false, motivo: "", ...chamada.input };
  }

  async alertar(contato, motivo) {
    if (!this.cfg.alertPhone) return;
    if (contato.alertadoEm && this.clock().getTime() - Date.parse(contato.alertadoEm) < ALERTA_CADA_HORAS * 3_600_000) return;
    const ultima = [...(contato.mensagens ?? [])].reverse().find((m) => m.de === "pessoa")?.texto ?? "";
    await this.zapi.sendText({
      destinationId: this.cfg.alertPhone,
      message: `🔔 *Achadinhos — precisa de você*\n${contato.nome || "Sem nome"} (+${soDigitos(contato.phone)})\n\n"${ultima.slice(0, 300)}"\n\n${motivo}`
    }).catch((error) => this.logger.error("Conversa por audio: alerta falhou:", error.message));
    await this.store.update((s) => {
      const c = Object.values(s.contatos ?? {}).find((x) => x.phone === contato.phone);
      if (c) c.alertadoEm = this.clock().toISOString();
    });
  }

  // ------------------------------------------------------------ manutencao e painel

  registrar(state, evento) {
    state.eventos = [...(state.eventos ?? []), { at: this.clock().toISOString(), ...evento }].slice(-MAX_EVENTOS);
  }

  async podar() {
    const limite = this.clock().getTime() - ESQUECER_DEPOIS_DIAS * DIA;
    await this.store.update((state) => {
      for (const [chave, c] of Object.entries(state.contatos ?? {})) {
        if (Date.parse(c.ultimaEntrada ?? c.criadoEm) < limite) delete state.contatos[chave];
      }
    });
  }

  chaveDe(phone) {
    const digitos = soDigitos(phone);
    if (!digitos) throw new Error("Informe phone valido");
    return sha256(digitos);
  }

  /** Recomeca a conversa como pessoa nova (para testar com o proprio numero). */
  async esquecer({ phone }) {
    const chave = this.chaveDe(phone);
    return this.store.update((state) => {
      const existia = Boolean(state.contatos?.[chave]);
      if (existia) delete state.contatos[chave];
      return { esquecido: existia };
    });
  }

  /** A Isa assume (ou devolve, com horas=0) uma conversa. */
  async humano({ phone, horas }) {
    const chave = this.chaveDe(phone);
    const h = Number.isFinite(Number(horas)) ? Number(horas) : this.cfg.humanPauseHours;
    return this.store.update((state) => {
      const c = state.contatos?.[chave];
      if (!c) throw new Error("Contato nao encontrado");
      c.humanoAte = h > 0 ? new Date(this.clock().getTime() + h * 3_600_000).toISOString() : null;
      return { humanoAte: c.humanoAte };
    });
  }

  /** O que a IA faria com uma conversa inventada, sem enviar nada. */
  async simular({ mensagens = [], audiosEnviados = [], nome = "" } = {}) {
    const catalogo = await this.catalogo();
    if (!catalogo.length) throw new Error("Nenhum audio gravado na pasta: a simulacao precisa do catalogo");
    const contato = { nome, audiosEnviados, mensagens: mensagens.map((texto) => (typeof texto === "string" ? { de: "pessoa", texto } : texto)) };
    return this.decidir(contato, catalogo);
  }

  async status() {
    const state = await this.store.read();
    const contatos = Object.values(state.contatos ?? {});
    const catalogo = await this.catalogo();
    const mascara = (phone) => `+${soDigitos(phone).slice(0, 4)}…${soDigitos(phone).slice(-4)}`;
    const porChave = new Map(Object.entries(state.contatos ?? {}));
    return {
      enabled: this.cfg.enabled,
      dryRun: this.cfg.dryRun,
      somenteTeste: this.cfg.onlyPhones.length ? this.cfg.onlyPhones.map((p) => mascara(p)) : null,
      modelo: this.cfg.model,
      audios: catalogo.map(({ id, titulo, arquivo, segundos }) => ({ id, titulo, arquivo, segundos: Math.round(segundos || 0) })),
      faltando: CATALOGO_PADRAO.filter((item) => !catalogo.some((a) => a.id === item.id)).map((item) => `${item.numero}-${item.id}`),
      contatos: {
        total: contatos.length,
        emAtendimento: contatos.filter((c) => !c.ignorado).length,
        antigosIgnorados: contatos.filter((c) => c.ignorado).length,
        comIsa: contatos.filter((c) => c.humanoAte && Date.parse(c.humanoAte) > this.clock().getTime()).length,
        precisamDaIsa: contatos.filter((c) => c.precisaHumanoEm).length
      },
      ultimos: (state.eventos ?? []).slice(-30).toReversed().map((e) => {
        const c = porChave.get(e.chave);
        return { ...e, chave: undefined, contato: c ? `${c.nome || "sem nome"} ${mascara(c.phone)}` : "(esquecido)" };
      })
    };
  }
}
