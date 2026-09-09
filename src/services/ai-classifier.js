import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_NICHES, inferNiches } from "../domain/niches.js";
import { productKey } from "../domain/offer.js";

const MAX_MEMORY = 20000;

// O catalogo entra no prompt a partir da MESMA fonte que a regra usa. Se um nicho
// nascer ou mudar de nome, o modelo enxerga a mudanca sem ninguem lembrar de
// editar dois lugares.
const catalogo = () => DEFAULT_NICHES
  .filter((niche) => niche.id !== "general")
  .map((niche) => `- ${niche.id}: ${niche.name}`)
  .join("\n");

// Fica no topo do prompt e nao muda entre chamadas: e o prefixo que o cache guarda.
// Qualquer byte volatil aqui (data, contador) joga o cache fora.
const INSTRUCOES = `Voce classifica anuncios do Mercado Livre para os canais de ofertas "Achadinhos da Isa" no WhatsApp.

O canal e feminino: mulheres de 25 a 54 anos que garimpam desconto em casa, cozinha,
beleza, cuidados pessoais, moda feminina e coisas de crianca. Elas compram para a
propria casa e para a familia.

NICHOS DISPONIVEIS
${catalogo()}
- general: nao se encaixa em nenhum acima

COMO DECIDIR O NICHO

1. Titulo de marketplace comeca pelo TIPO do produto. "Mochila Executiva Grande
   Notebook" e mochila (fashion), nao informatica: "notebook" diz o que ela carrega.
   "Creatina Monohidratada em Pote" e suplemento (health), nao utensilio de cozinha:
   "pote" e a embalagem.
2. A categoria informada pelo marketplace e um sinal forte, porque quem classificou
   foi o proprio site. Use quando o titulo nao decidir sozinho. Mas o titulo manda:
   "Papel Higienico" listado em beleza continua sendo mercado.
3. No maximo dois nichos, o principal primeiro.
4. "general" e exclusivo: use SOZINHO e so quando nenhum outro nicho servir. Nunca
   junto com outro. Antes de recorrer a ele, procure de novo — "Barbante Para Croche"
   e artesanato para a casa (home), "Racao Para Caes" e mercado (market). Quase tudo
   que a vitrine lista cabe em algum nicho.

COMO DECIDIR O PUBLICO (campo servePublico)

Responda false quando o produto nao serve a esse canal, mesmo sendo uma boa oferta:

- Produto masculino ou dirigido a homens: barbeador, sunga, cueca, tenis masculino,
  perfume masculino, material de barbearia.
- Em roupa e calcado, a marcacao de genero e a regra do mercado. Quando ela FALTA,
  quase sempre e peca masculina ou unissex: "Kit Camisetas Aramis" e "Tenis Smash V2
  41 Br" sao false. "Vestido Midi Floral" e "Tenis Feminino Vizzano" sao true.
- Linha de terceira idade e enfermagem: cadeira de rodas, andador, muleta, fralda
  geriatrica, colchao antiescara, aparelho auditivo, material hospitalar.
- Material medico, equipamento comercial ou industrial.
- Produto para animais.
- Peruca, cabeca de manequim e material de salao profissional.
- LINHA masculina de marca feminina. A marca nao decide, a linha decide: "Eudora
  Club", "Malbec" e "Egeo Man" sao masculinos ainda que Eudora e Boticario
  vendam muito para mulher. Leia a linha, nao o fabricante.

NA DUVIDA EM VESTUARIO, RESPONDA false. Deixar passar uma peca masculina no canal
feminino custa mais caro que pular uma peca boa: a primeira o leitor ve, a segunda
ninguem sente falta. Peca de cima sem marcacao explicita de genero (jaqueta,
moletom, corta-vento, casaco, blusa) e quase sempre masculina ou unissex —
"Jaqueta Puffer De Frio Blusa Impermeavel Inverno Intenso" e false. "Blusa" e
"bolsa" nao sao marcacao de genero: vendedor usa para qualquer peca.

SEJA CONSISTENTE. O mesmo titulo tem que receber sempre a mesma resposta. Decida
pelo que esta escrito no titulo, nao por impressao geral do produto.

Responda true para o que uma mulher compraria para si, para a casa ou para os filhos.
Cosmetico, skincare, panela, roupa de cama, organizador, brinquedo, suplemento comum
(colageno, vitamina) e eletrodomestico de cozinha sao true.

O campo motivo tem no maximo 8 palavras e explica a decisao de publico, nao o nicho.`;

const FERRAMENTA = {
  name: "classificar_anuncios",
  description: "Devolve a classificacao de cada anuncio recebido, na mesma ordem da lista.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      itens: {
        type: "array",
        description: "Um item por anuncio recebido.",
        items: {
          type: "object",
          properties: {
            i: { type: "integer", description: "O numero do anuncio na lista recebida." },
            nicheIds: {
              type: "array",
              description: "Um ou dois nichos, o principal primeiro.",
              items: { type: "string", enum: DEFAULT_NICHES.map((niche) => niche.id) }
            },
            servePublico: { type: "boolean", description: "Serve ao canal feminino de achadinhos." },
            motivo: { type: "string", description: "Ate 8 palavras sobre a decisao de publico." }
          },
          required: ["i", "nicheIds", "servePublico", "motivo"],
          additionalProperties: false
        }
      }
    },
    required: ["itens"],
    additionalProperties: false
  }
};

const descreve = (offer, numero) => {
  const linhas = [`${numero}. ${offer.title}`];
  if (offer.category) linhas.push(`   categoria: ${offer.category}`);
  if (offer.currentPrice) linhas.push(`   preco: R$ ${offer.currentPrice}`);
  return linhas.join("\n");
};

// "general" ao lado de um nicho de verdade nao e so redundante: destino casa por
// intersecao de nichos, entao um general indevido faz a oferta entrar em qualquer
// destino que aceite ofertas gerais. O prompt pede exclusividade; isto garante.
const nichosLimpos = (nicheIds) => {
  const validos = [...new Set(nicheIds ?? [])].filter((id) => DEFAULT_NICHES.some((niche) => niche.id === id));
  const especificos = validos.filter((id) => id !== "general");
  return especificos.length ? especificos.slice(0, 2) : ["general"];
};

/** A regra continua sendo o chao: se a IA nao responder, a fila nao para. */
const pelaRegra = (offer) => ({ nicheIds: inferNiches(offer), servePublico: null, motivo: "classificado pela regra", por: "regra" });

export class AiClassifier {
  constructor({ store, config, client, clock = () => new Date(), onAlert = null }) {
    this.store = store;
    this.config = config.ai;
    this.clock = clock;
    this.onAlert = onAlert;
    this.client = client
      ?? (this.config.enabled && this.config.apiKey ? new Anthropic({ apiKey: this.config.apiKey }) : null);
  }

  get ativo() {
    return Boolean(this.config.enabled && this.client);
  }

  /** Map<productKey, {nicheIds, servePublico, motivo, por}> cobrindo TODAS as ofertas. */
  async classify(offers) {
    const resultado = new Map();
    if (!offers.length) return resultado;
    if (!this.ativo) {
      for (const offer of offers) resultado.set(productKey(offer), pelaRegra(offer));
      return resultado;
    }

    // Cada produto se paga uma vez so: a vitrine repete muito entre uma rodada e outra.
    const memoria = await this.lembradas();
    const pendentes = [];
    for (const offer of offers) {
      const chave = productKey(offer);
      const guardada = memoria.get(chave);
      if (guardada) resultado.set(chave, { ...guardada.decisao, por: "cache" });
      else pendentes.push(offer);
    }
    if (!pendentes.length) return resultado;

    const novas = [];
    for (let inicio = 0; inicio < pendentes.length; inicio += this.config.batchSize) {
      const lote = pendentes.slice(inicio, inicio + this.config.batchSize);
      let decisoes;
      try {
        decisoes = await this.perguntar(lote);
      } catch (error) {
        await this.avisar(`Classificacao por IA falhou (${error.message}). Este lote foi pela regra.`);
        for (const offer of lote) resultado.set(productKey(offer), pelaRegra(offer));
        continue;
      }
      for (const [posicao, offer] of lote.entries()) {
        const decisao = decisoes.get(posicao + 1);
        // Item que o modelo pulou volta para a regra, em vez de virar buraco na fila.
        if (!decisao) { resultado.set(productKey(offer), pelaRegra(offer)); continue; }
        resultado.set(productKey(offer), { ...decisao, por: "ia" });
        novas.push({ key: productKey(offer), decisao, at: this.clock().toISOString() });
      }
    }
    if (novas.length) await this.guardar(novas);
    return resultado;
  }

  async perguntar(lote) {
    const resposta = await this.client.messages.create({
      model: this.config.model,
      max_tokens: 16000,
      // Effort baixo: classificar titulo curto nao pede raciocinio longo, e o volume
      // diario e o que decide a conta no fim do mes.
      output_config: { effort: this.config.effort },
      system: [{ type: "text", text: INSTRUCOES, cache_control: { type: "ephemeral" } }],
      tools: [FERRAMENTA],
      messages: [{
        role: "user",
        content: `Classifique os ${lote.length} anuncios abaixo chamando a ferramenta classificar_anuncios uma unica vez, com um item para cada numero.\n\n${lote.map((offer, posicao) => descreve(offer, posicao + 1)).join("\n\n")}`
      }]
    });

    const chamada = resposta.content.find((bloco) => bloco.type === "tool_use" && bloco.name === FERRAMENTA.name);
    if (!chamada) throw new Error(`o modelo respondeu sem chamar a ferramenta (stop_reason: ${resposta.stop_reason})`);
    return new Map((chamada.input?.itens ?? []).map((item) => [item.i, {
      nicheIds: nichosLimpos(item.nicheIds),
      servePublico: item.servePublico,
      motivo: item.motivo
    }]));
  }

  async lembradas() {
    const limite = this.clock().getTime() - this.config.memoryDays * 86400000;
    const state = await this.store.read();
    return new Map((state.classifications ?? [])
      .filter((item) => new Date(item.at).getTime() >= limite)
      .map((item) => [item.key, item]));
  }

  async guardar(novas) {
    const limite = this.clock().getTime() - this.config.memoryDays * 86400000;
    const chaves = new Set(novas.map((item) => item.key));
    await this.store.update((state) => {
      const anteriores = (state.classifications ?? [])
        .filter((item) => !chaves.has(item.key) && new Date(item.at).getTime() >= limite);
      state.classifications = [...anteriores, ...novas].slice(-MAX_MEMORY);
    });
  }

  async avisar(mensagem) {
    if (this.onAlert) await this.onAlert(mensagem);
  }
}
