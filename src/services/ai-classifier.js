import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_NICHES, inferNiches } from "../domain/niches.js";
import { productKey } from "../domain/offer.js";

// Quantas decisoes o cache guarda. Era 20.000, dimensionado para uma coleta que
// via algumas centenas de produtos por dia. Com a operacao full time a mesma
// vitrine e varrida dezenas de vezes ao dia, e um cache que roda em menos de 24h
// faz o sistema PAGAR DE NOVO pelo mesmo titulo — o custo da IA e o maior do
// projeto, e quem o controla e a taxa de acerto daqui.
const MAX_MEMORY_PADRAO = 120_000;

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
- Peruca, cabeca de manequim e material de salao profissional. O que decide e o TIPO
  de produto, nao a litragem: quimica de PROCESSO — "btx", "botox capilar",
  "progressiva", "reconstrucao", "alinhamento", "redutor de volume", "selagem" — e
  servico de cabeleireiro e responde false, ainda que venha em 300ml. Ja cosmetico de
  uso diario (shampoo, condicionador, mascara, leave-in, oleo) e true em QUALQUER
  tamanho, 1L inclusive: litro de shampoo de marca conhecida e compra normal de quem
  lava o proprio cabelo. "Professional" no nome de linha comercial nao basta para
  barrar — pergunte se a leitora usa sozinha no banheiro ou se precisa de um
  profissional aplicando.
- Insumo e materia-prima de fabricacao: "base glicerinada para sabonete", "base de
  glicerina 1kg", essencia a granel, embalagem vazia para revenda. Quem compra isso
  esta produzindo para vender, nao se cuidando — false.
- Produto para TRATAR uma condicao: micose, psoriase, queda de cabelo, calvicie,
  alopecia, minoxidil, verruga, frieira, calo, unha encravada, tintura para cobrir
  fios brancos. Sao compras legitimas e ate comuns, mas ninguem quer ver pomada de
  micose no meio do canal de achadinhos, e anunciar isso a quem nao pediu constrange.
  Cosmetico que so hidrata, limpa ou embeleza continua true; o que promete curar ou
  corrigir um problema e false.
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

O teste final, antes de responder true: isto daria vontade de comprar aparecendo entre
um batom e um vestido? Oferta boa que quebra o clima do canal e false. Nao confunda
"uma mulher poderia comprar" com "serve a este canal" — quase tudo passa no primeiro
teste, e foi assim que pomada de micose, base de sabonete a granel e espuma de limpar
sofa entraram no canal de beleza e moda em 09/09/2026.

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
    const lotes = [];
    for (let inicio = 0; inicio < pendentes.length; inicio += this.config.batchSize) {
      lotes.push(pendentes.slice(inicio, inicio + this.config.batchSize));
    }

    // Os lotes eram resolvidos em fila indiana. Com `effort: high` cada chamada
    // leva dezenas de segundos, entao varrer nove vitrines custava mais de dez
    // minutos — e nesse tempo a coleta nao entrega NADA para a fila. Como um
    // lote nao depende do anterior, o unico motivo para serializar era nao
    // atropelar o limite de requisicoes da API; e para isso basta um teto de
    // chamadas simultaneas.
    const emVoo = new Set();
    const resolvidos = new Array(lotes.length);
    for (const [indice, lote] of lotes.entries()) {
      const tarefa = this.perguntar(lote)
        .then((decisoes) => { resolvidos[indice] = decisoes; })
        .catch(async (error) => {
          await this.avisar(`Classificacao por IA falhou (${error.message}). Este lote foi pela regra.`);
          resolvidos[indice] = null;
        })
        .finally(() => emVoo.delete(tarefa));
      emVoo.add(tarefa);
      // Sem teto configurado o certo e serializar, nao disparar tudo de uma vez:
      // um `undefined` aqui viraria paralelismo ilimitado contra a API.
      const teto = Math.max(1, Number(this.config.concurrency) || 1);
      if (emVoo.size >= teto) await Promise.race(emVoo);
    }
    await Promise.all(emVoo);

    for (const [indice, lote] of lotes.entries()) {
      const decisoes = resolvidos[indice];
      if (!decisoes) {
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
    const teto = Math.max(1, Number(this.config.memoryEntries) || MAX_MEMORY_PADRAO);
    // O `motivo` so e lido para EXPLICAR um bloqueio. Guarda-lo para as decisoes
    // aprovadas era 3/4 do texto do cache sem nunca chegar a ninguem — e cache
    // grande e exatamente o que se quer aqui.
    const enxutas = novas.map((item) => (
      item.decisao?.servePublico === false
        ? item
        : { ...item, decisao: { ...item.decisao, motivo: undefined } }
    ));
    await this.store.update((state) => {
      const anteriores = (state.classifications ?? [])
        .filter((item) => !chaves.has(item.key) && new Date(item.at).getTime() >= limite);
      state.classifications = [...anteriores, ...enxutas].slice(-teto);
    });
  }

  async avisar(mensagem) {
    if (this.onAlert) await this.onAlert(mensagem);
  }
}
