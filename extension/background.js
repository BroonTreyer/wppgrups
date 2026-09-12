const DEFAULTS = {
  server: "http://localhost:3000",
  token: "",
  builderUrl: "https://www.mercadolivre.com.br/afiliados/linkbuilder",
  enabled: true,
  // Paginas que o servidor NAO consegue ler sozinho e a extensao le: loja
  // oficial das marcas (lista montada por JavaScript) e busca (anti-bot).
  // Uma URL por linha no popup.
  harvestUrls: "",
  harvestEnabled: false,
  harvestPages: 3
};

const state = { busy: false, lastRun: null, lastError: null, resolved: 0, failed: 0, tab: null };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settings = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) });

async function api(path, options = {}) {
  const config = await settings();
  if (!config.token) throw new Error("Cole o ADMIN_TOKEN do OfertaFlow no popup da extensao");
  const response = await fetch(`${config.server.replace(/\/+$/, "")}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json", ...options.headers }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `OfertaFlow respondeu ${response.status}`);
  return body;
}

function send(tabId, message, timeout = 30000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ error: "a pagina do painel nao respondeu a tempo" }), timeout);
    try {
      chrome.tabs.sendMessage(tabId, message, (answer) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message, disconnected: true });
        else resolve(answer ?? { error: "sem resposta da pagina" });
      });
    } catch (error) {
      clearTimeout(timer);
      resolve({ error: error.message, disconnected: true });
    }
  });
}

async function waitForLoad(tabId, timeout = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return null;
    if (tab.status === "complete") return tab;
    await sleep(500);
  }
  return chrome.tabs.get(tabId).catch(() => null);
}

async function ensureContentScript(tabId) {
  const ping = await send(tabId, { type: "ping" }, 2000);
  if (ping?.pong) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await sleep(600);
    const again = await send(tabId, { type: "ping" }, 3000);
    return Boolean(again?.pong);
  } catch (error) {
    state.lastError = `nao consegui injetar o script na aba: ${error.message}`;
    return false;
  }
}

async function builderTab(config) {
  const abertas = await chrome.tabs.query({ url: ["https://www.mercadolivre.com.br/afiliados/*", "https://www.mercadolivre.com.br/l/afiliados*"] });
  // A busca casa /afiliados/* inteiro, e isso inclui o HUB — que nao tem campo
  // de link nenhum. Pegar "a primeira que aparecer" fazia a extensao tentar
  // gerar no hub e reportar "nao encontrei o campo de link", com o linkbuilder
  // aberto na aba do lado. Foi o ultimo no do servidor em 12/09/2026.
  //
  // Preferir a aba que casa com o builderUrl configurado; qualquer outra pagina
  // de afiliados so serve como segunda opcao.
  const alvo = (config.builderUrl || "").split("#")[0].split("?")[0];
  const vivas = abertas.filter((item) => !item.discarded);
  let tab = vivas.find((item) => alvo && (item.url || "").startsWith(alvo))
    ?? vivas.find((item) => /linkbuilder/i.test(item.url || ""))
    ?? vivas[0]
    ?? null;
  if (!tab) {
    tab = await chrome.tabs.create({ url: config.builderUrl, active: false });
    tab = await waitForLoad(tab.id);
  } else if (tab.status !== "complete") {
    tab = await waitForLoad(tab.id);
  }
  if (!tab) throw new Error("nao consegui abrir a pagina do painel de afiliados");
  if (/\/login|identification/.test(tab.url ?? "")) {
    throw new Error("faca login no painel de afiliados do Mercado Livre nessa aba e tente de novo");
  }
  if (!(await ensureContentScript(tab.id))) {
    // Quase sempre isto significa: a extensao acabou de ser recarregada e o
    // content script que estava naquela aba ficou orfao. O Chrome invalida a
    // conexao e so uma carga nova da pagina reconecta.
    //
    // O texto precisa dizer QUAL aba, e que nao e a extensao: em 12/09 o dono
    // leu "recarregue a pagina", recarregou a EXTENSAO de novo, e o problema
    // continuou — a aba do painel seguia com o script velho.
    throw new Error(
      "de um F5 na aba do painel de afiliados do Mercado Livre (a aba, nao a extensao). "
      + "Isso e normal logo depois de recarregar a extensao: a aba fica com o script antigo."
    );
  }
  state.tab = tab.id;
  return tab;
}

// Teto de tempo de uma drenagem. O alarme do Chrome nao desce de 30s, entao
// esperar o proximo ciclo a cada 5 links limitava a extensao a ~10 links por
// minuto por pura ociosidade. Aqui ela drena ate secar a fila ou bater o teto —
// e o teto existe para o service worker nao ser morto por rodar longo demais.
const DRAIN_MS = 4 * 60 * 1000;
const BATCH = 25;

async function processPending() {
  if (state.busy) return;
  const config = await settings();
  // Desligado ou sem token NAO pode sair em silencio.
  //
  // Em 12/09/2026 a extensao no servidor ficou viva, pingando e sem gerar um
  // link sequer, com zero erro em lugar nenhum — porque este retorno nao
  // deixava rastro. Uma extensao parada por configuracao e indistinguivel de
  // uma extensao quebrada, e as duas so aparecem quando o canal para de postar.
  if (!config.enabled) {
    state.lastError = "extensao DESLIGADA no popup — marque 'ativo' para voltar a gerar link";
    return;
  }
  if (!config.token) {
    state.lastError = "sem ADMIN_TOKEN no popup — cole o token do .env do OfertaFlow";
    return;
  }
  // O erro vale por UM ciclo. Sem isto ele gruda: a batida de coracao reenvia o
  // mesmo texto para sempre, com carimbo novo a cada ping, e um problema ja
  // resolvido continua aparecendo como se fosse de agora. Foi o que fez o
  // servidor acusar CAPTCHA por meia hora depois do captcha ter sumido da tela,
  // mandando o dono resolver um desafio que nao existia.
  state.lastError = null;
  state.busy = true;
  const ateQuando = Date.now() + DRAIN_MS;
  try {
    // O proprio estado vai junto: e assim que o servidor descobre POR QUE nao
    // ha link, agora que erro de ambiente nao vira falha de produto.
    const sinal = () => state.lastError ? "&erro=" + encodeURIComponent(String(state.lastError).slice(0, 200)) : "";
    let { pending } = await api(`/api/affiliate/pending?limit=${BATCH}${sinal()}`);
    state.lastRun = new Date().toISOString();
    if (!pending.length) { state.lastError = null; return; }

    const tab = await builderTab(config);
    let parar = false;
    while (pending.length && !parar && Date.now() < ateQuando) {
      for (const item of pending) {
        if (Date.now() >= ateQuando) { parar = true; break; }
        let answer = await send(tab.id, { type: "generate", url: item.productUrl });
        if (answer.disconnected && await ensureContentScript(tab.id)) {
          // SUBSTITUI a resposta em vez de mesclar: com Object.assign, o
          // 'disconnected: true' da primeira tentativa sobrevivia a uma segunda
          // que falhou por motivo real ("nao esta logado"), e o erro de verdade
          // era tratado como tropeco de canal — some da tela e nunca e reportado.
          answer = await send(tab.id, { type: "generate", url: item.productUrl });
        }
        if (answer.link) {
          await api("/api/affiliate/link", { method: "POST", body: JSON.stringify({ id: item.id, link: answer.link }) });
          state.resolved += 1;
          state.lastError = null;
        } else if (answer.timeout) {
          // Timeout do painel nao e defeito do produto — mesma logica do canal
          // caido logo abaixo. Reportar gastaria uma das 3 tentativas, e tres
          // lentidoes seguidas matavam a oferta para sempre: foram 39 perdidas
          // assim em 12/09, enquanto o painel seguia entregando link a quem
          // esperava.
          //
          // Parar a drenagem tambem e de proposito: se o Mercado Livre esta
          // limitando o ritmo, insistir piora. Espera o proximo alarme.
          state.lastError = "painel lento (" + answer.error + "); pauso e tento no proximo ciclo";
          parar = true;
          break;
        } else if (answer.disconnected) {
          // Canal morto nao e defeito do produto: a aba recarregou, o content
          // script caiu ou o service worker hibernou. Reportar isso ao servidor
          // gastava uma das 3 tentativas do pedido, e tres tropecos seguidos da
          // extensao marcavam o produto como 'failed' para sempre — foi o que
          // travou os 8 pedidos de 03/09. Deixa pendente: o proximo alarme tenta
          // de novo, e o link empurrado por 'captured-link' ainda pode chegar.
          state.lastError = "canal com a pagina caiu (" + answer.error + "); tento de novo no proximo ciclo";
          parar = true;
          break;
        } else if (answer.fatal) {
          // TODO o `fatal` daqui e ambiente, nunca o produto: captcha, sessao
          // caida, aba fora do painel, campo de link ausente. Reportar gastaria
          // uma das 3 tentativas do produto e o mataria por um problema que nao
          // e dele — foi o que matou 39 ofertas em 12/09 pela via do timeout,
          // e o captcha estava entrando pela mesma porta.
          //
          // Nao reporta, para a drenagem e deixa o motivo visivel no popup: sao
          // todos estados que so uma pessoa resolve.
          state.lastError = answer.error;
          parar = true;
          break;
        } else {
          await api("/api/affiliate/link", { method: "POST", body: JSON.stringify({ id: item.id, error: answer.error || "nao consegui gerar o link" }) });
          state.failed += 1;
          state.lastError = answer.error || "nao consegui gerar o link";
        }
        // O ritmo importa mais do que parecia. 250ms aguentaram enquanto o
        // volume era baixo; com ~700 links num dia (12/09) o Mercado Livre passou
        // a devolver CAPTCHA a cada poucos minutos, e captcha nao se resolve com
        // retentativa — trava a operacao ate alguem clicar.
        //
        // 1200ms da ~50 links/min, de sobra para os ~1000/dia que a operacao
        // consome, e para de provocar o desafio. Mil links passam a levar ~20min
        // em vez de ~4 — tempo que nao custa nada, porque a publicacao e o gargalo
        // seguinte, nao a geracao.
        await sleep(1200);
      }
      if (parar) break;
      ({ pending } = await api(`/api/affiliate/pending?limit=${BATCH}${sinal()}`));
    }
  } catch (error) {
    state.lastError = error.message;
  } finally {
    state.busy = false;
    await chrome.storage.local.set({ status: { ...state } });
  }
}

/**
 * Abre cada pagina configurada, colhe os produtos da tela e entrega ao servidor.
 *
 * A aba e aberta em segundo plano e FECHADA ao fim — a nao ser que ja estivesse
 * aberta antes, caso em que fica como estava. Mexer nas abas do dono e o tipo de
 * efeito colateral que faz desinstalarem a extensao.
 *
 * @param {boolean} forcado true quando veio do botao "Colher agora".
 *
 * O botao NAO pode depender de `harvestEnabled`: essa flag governa o alarme de
 * 30 min, nao o disparo manual. Ate 11/09/2026 ela governava os dois, e quem
 * clicava sem ter marcado o agendamento via o botao nao fazer absolutamente
 * nada — sem erro, sem log, sem pista.
 */
async function harvestPages({ forcado = false } = {}) {
  const config = await settings();
  if (!forcado && !config.harvestEnabled) { console.log("[colheita] agendamento desligado"); return; }
  if (!config.token) {
    state.lastError = "Cole o ADMIN_TOKEN no popup antes de colher";
    console.log("[colheita] sem token");
    await chrome.storage.local.set({ status: { ...state } });
    return;
  }
  const configuradas = String(config.harvestUrls || "").split(/\r?\n/).map((linha) => linha.trim()).filter(Boolean);
  if (!configuradas.length) {
    state.lastError = "Nenhuma pagina na lista de colheita";
    console.log("[colheita] lista vazia");
    await chrome.storage.local.set({ status: { ...state } });
    return;
  }
  console.log(`[colheita] comecando: ${configuradas.length} pagina(s)`);

  // Quantas paginas por marca. A fila e alimentada em profundidade: a pagina
  // seguinte so entra quando a atual termina, e o endereco dela vem do proprio
  // Mercado Livre (ver `proximaPagina` em harvest.js) — montar `_Desde_51` na
  // mao devolvia a MESMA pagina, com estatisticas identicas.
  const porMarca = Math.max(1, Math.min(Number(config.harvestPages) || 10, 40));
  const fila = configuradas.map((url) => ({ url, pagina: 1 }));
  // Endereco ja colhido nesta rodada nao se colhe de novo. Sem isto, um botao
  // "Seguinte" que aponta para a propria pagina faz a colheita repetir a mesma
  // lista ate bater o limite — foi o que aconteceu com avon e eudora, tres
  // passagens identicas em 11/09/2026.
  const visitados = new Set();

  while (fila.length) {
    const { url, pagina } = fila.shift();
    const chave = url.split("#")[0];
    if (visitados.has(chave)) {
      console.log(`[colheita] pulando pagina repetida: ${chave.slice(-60)}`);
      continue;
    }
    visitados.add(chave);
    let tab = null;
    let jaEstavaAberta = false;
    try {
      const abertas = await chrome.tabs.query({ url: url.split("#")[0] + "*" });
      tab = abertas.find((item) => !item.discarded) ?? null;
      jaEstavaAberta = Boolean(tab);
      if (!tab) tab = await chrome.tabs.create({ url, active: false });
      tab = await waitForLoad(tab.id, 40000);
      if (!tab) continue;

      // O coletor nao esta no manifesto: e injetado so quando ha colheita, para
      // nao rodar em toda navegacao do dono no Mercado Livre.
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["harvest.js"] });
      await sleep(800);
      const resultado = await send(tab.id, { type: "harvest" }, 90000);
      const produtos = resultado?.produtos ?? [];
      const curta = url.replace(/^https:\/\/[^/]+\/loja\//, "").split("/")[0];
      if (produtos.length) {
        const corpo = produtos.map((item) => ({ ...item, pageUrl: url }));
        const resposta = await api("/api/sources/harvest", { method: "POST", body: JSON.stringify({ produtos: corpo, origem: "extensao", diagnostico: resultado?.diagnostico }) });
        state.harvested = (state.harvested ?? 0) + (resposta?.enqueued ?? 0);
        state.lastHarvest = { url, lidos: produtos.length, enfileirados: resposta?.enqueued ?? 0, em: new Date().toISOString() };
        console.log(`[colheita] ${curta} p${pagina}: ${produtos.length} lidos, ${resposta?.enqueued ?? 0} na fila`);
        // A proxima pagina so entra na fila se o PROPRIO site apontou para ela.
        // Enquanto houver "Seguinte" e couber no limite, segue em frente.
        if (resultado?.proxima && pagina < porMarca) {
          fila.push({ url: resultado.proxima, pagina: pagina + 1 });
        }
      } else {
        state.lastHarvest = { url, lidos: 0, erro: resultado?.erro ?? "nenhum produto na tela", em: new Date().toISOString() };
        console.log(`[colheita] ${curta} p${pagina}: NADA na tela (${resultado?.erro ?? "sem cards"})`);
      }
    } catch (error) {
      state.lastError = `colheita em ${url}: ${error.message}`;
    } finally {
      if (tab && !jaEstavaAberta) await chrome.tabs.remove(tab.id).catch(() => {});
      await chrome.storage.local.set({ status: { ...state } });
    }
  }
}

const agendar = () => {
  chrome.alarms.create("ofertaflow", { periodInMinutes: 0.5 });
  // A colheita e cara (abre aba, rola a pagina inteira) e a vitrine de uma marca
  // nao muda de minuto em minuto: de 30 em 30 minutos e o suficiente.
  chrome.alarms.create("ofertaflow-harvest", { periodInMinutes: 30 });
};
chrome.runtime.onInstalled.addListener(agendar);
chrome.runtime.onStartup.addListener(agendar);
agendar();
/**
 * Batida de coracao: conta ao servidor como a extensao esta, mesmo quando ela
 * nao fez nada neste ciclo.
 *
 * O ping que carrega o erro vive DENTRO do laco de drenagem. Quando a extensao
 * sai cedo — desligada, sem token, sem aba do painel —, aquele ping nunca
 * acontece e o servidor fica vendo "viva e sem erro" justamente no caso em que
 * ela esta parada. Esta funcao cobre esse vao.
 *
 * Sem token nao ha como falar com o servidor; ai o popup e o unico canal.
 */
async function reportarSaude() {
  const config = await settings();
  if (!config.token) return;
  const erro = state.lastError ? "&erro=" + encodeURIComponent(String(state.lastError).slice(0, 200)) : "";
  try { await api(`/api/affiliate/pending?limit=1${erro}`); } catch {}
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "ofertaflow") processPending().then(reportarSaude, reportarSaude);
  if (alarm.name === "ofertaflow-harvest") harvestPages();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "run-now") { processPending().then(() => sendResponse({ ok: true, state })); return true; }
  if (message?.type === "harvest-now") {
    // Responde JA e deixa a colheita correndo. Esperar o fim significava segurar
    // o popup por dezenas de minutos — e o popup fecha ao perder o foco, entao a
    // resposta nunca chegava e o clique parecia nao ter feito nada.
    harvestPages({ forcado: true });
    sendResponse({ ok: true, iniciada: true, state });
    return false;
  }
  if (message?.type === "status") { sendResponse({ state }); return false; }
  if (message?.type === "captured-link" && message.link && message.productUrl) {
    api("/api/affiliate/pending?limit=25")
      .then(({ pending }) => {
        const match = pending.find((item) => item.productUrl === message.productUrl);
        if (match) return api("/api/affiliate/link", { method: "POST", body: JSON.stringify({ id: match.id, link: message.link }) });
      })
      .catch((error) => { state.lastError = error.message; });
    return false;
  }
  return false;
});
