const DEFAULTS = {
  server: "http://localhost:3000",
  token: "",
  builderUrl: "https://www.mercadolivre.com.br/afiliados/linkbuilder",
  enabled: true
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
  let tab = abertas.find((item) => !item.discarded) ?? null;
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
    throw new Error("a aba do painel nao aceitou o script da extensao; recarregue a pagina (F5) e tente de novo");
  }
  state.tab = tab.id;
  return tab;
}

async function processPending() {
  if (state.busy) return;
  const config = await settings();
  if (!config.enabled || !config.token) return;
  state.busy = true;
  try {
    const { pending } = await api("/api/affiliate/pending?limit=5");
    state.lastRun = new Date().toISOString();
    if (!pending.length) { state.lastError = null; return; }

    const tab = await builderTab(config);
    for (const item of pending) {
      const answer = await send(tab.id, { type: "generate", url: item.productUrl });
      if (answer.disconnected && await ensureContentScript(tab.id)) {
        const retry = await send(tab.id, { type: "generate", url: item.productUrl });
        Object.assign(answer, retry);
      }
      if (answer.link) {
        await api("/api/affiliate/link", { method: "POST", body: JSON.stringify({ id: item.id, link: answer.link }) });
        state.resolved += 1;
        state.lastError = null;
      } else {
        await api("/api/affiliate/link", { method: "POST", body: JSON.stringify({ id: item.id, error: answer.error || "nao consegui gerar o link" }) });
        state.failed += 1;
        state.lastError = answer.error || "nao consegui gerar o link";
        if (answer.fatal) break;
      }
      await sleep(1500);
    }
  } catch (error) {
    state.lastError = error.message;
  } finally {
    state.busy = false;
    await chrome.storage.local.set({ status: { ...state } });
  }
}

const agendar = () => chrome.alarms.create("ofertaflow", { periodInMinutes: 0.5 });
chrome.runtime.onInstalled.addListener(agendar);
chrome.runtime.onStartup.addListener(agendar);
agendar();
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "ofertaflow") processPending(); });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "run-now") { processPending().then(() => sendResponse({ ok: true, state })); return true; }
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
