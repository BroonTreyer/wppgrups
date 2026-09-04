const LINK_PATTERN = /https:\/\/(?:meli\.la\/[A-Za-z0-9]+|(?:www\.)?mercadolivre\.com(?:\.br)?\/sec\/[A-Za-z0-9]+|(?:www\.)?mercadolivre\.com\.br\/social\/[^\s"'<>]+ref=[^\s"'<>]+)/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const visible = (element) => element && element.offsetParent !== null && !element.disabled;

const injectHook = () => {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("injected.js");
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
};

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.source !== "ofertaflow-hook" || !event.data.payload) return;
  const link = String(event.data.payload).match(LINK_PATTERN)?.[0];
  if (link) chrome.runtime.sendMessage({ type: "captured-link", link, productUrl: window.__ofertaflowCurrentUrl ?? null });
});

// A busca do cabecalho do Mercado Livre existe em TODA pagina, inclusive na de
// afiliados, e e o primeiro input visivel do documento. Enquanto findInput caia
// nela por descarte, a extensao digitava a URL do produto na busca e ia parar em
// lista.mercadolivre.com.br/<url-codificada> — sem link nenhum e sem erro visivel.
const isSearchBox = (element) => {
  const marcas = `${element.name ?? ""} ${element.id ?? ""} ${element.placeholder ?? ""} ${element.getAttribute("aria-label") ?? ""}`.toLowerCase();
  if (/as_word|cb1-edit|buscar|busque|pesquis|search/.test(marcas)) return true;
  if (element.getAttribute("role") === "combobox") return true;
  const acao = (element.form?.getAttribute("action") ?? "").toLowerCase();
  if (acao.includes("/search") || acao.includes("lista.")) return true;
  // O cabecalho e o rodape nunca contem o campo do gerador.
  return Boolean(element.closest("header, nav, [class*=nav-search], [class*=header]"));
};

const DICAS = ["link", "url", "produto", "cole", "publica"];

const findInput = () => {
  const candidates = [...document.querySelectorAll("input[type=text], input[type=url], input:not([type]), textarea")]
    .filter(visible)
    .filter((element) => !isSearchBox(element));
  // So aceita campo que se identifique. Sem dica, devolve null e o chamador
  // reporta o erro: digitar no campo errado e pior que nao digitar, porque
  // dispara uma navegacao e some com a pagina do gerador.
  return candidates.find((element) => {
    const hint = `${element.placeholder ?? ""} ${element.getAttribute("aria-label") ?? ""} ${element.name ?? ""} ${element.id ?? ""}`.toLowerCase();
    return DICAS.some((dica) => hint.includes(dica));
  }) ?? null;
};

const findButton = (input) => {
  const words = ["gerar", "criar", "encurtar", "obter"];
  const rotulo = (element) => `${element.textContent ?? ""} ${element.value ?? ""} ${element.getAttribute("aria-label") ?? ""}`.toLowerCase();
  const combina = (element) => words.some((word) => rotulo(element).includes(word));
  // Procura primeiro DENTRO do bloco do campo: um "criar" de outra secao da
  // pagina levaria a extensao a clicar em qualquer coisa.
  const escopo = input?.closest("form, section, [class*=card], [class*=box]") ?? document;
  const perto = [...escopo.querySelectorAll("button, [role=button], input[type=submit]")].filter(visible).find(combina);
  if (perto) return perto;
  return [...document.querySelectorAll("button, [role=button], input[type=submit]")].filter(visible).find(combina) ?? null;
};

const readLinkFromPage = () => {
  const fields = [...document.querySelectorAll("input, textarea")].map((element) => element.value ?? "");
  const found = [...fields, document.body.innerText].map((text) => String(text).match(LINK_PATTERN)?.[0]).find(Boolean);
  return found ?? null;
};

const setValue = (element, value) => {
  const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, "value")?.set;
  setter ? setter.call(element, value) : (element.value = value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
};

async function generate(productUrl) {
  if (location.pathname.includes("/login") || document.body.innerText.includes("Iniciar sessão")) {
    return { error: "Voce nao esta logado no painel de afiliados do Mercado Livre", fatal: true };
  }
  // Sair da pagina de afiliados e sinal de que a extensao ja se perdeu (foi o
  // que aconteceu ao digitar na busca e cair em lista.mercadolivre.com.br).
  // Parar aqui evita interagir as cegas com uma pagina qualquer do site.
  if (!location.pathname.includes("/afiliados")) {
    return { error: `a aba saiu do painel de afiliados (esta em ${location.pathname}); abra o gerador de links e tente de novo`, fatal: true };
  }
  const input = findInput();
  if (!input) return { error: "Nao encontrei o campo de link nesta pagina. Abra o gerador de links do painel de afiliados.", fatal: true };

  window.__ofertaflowCurrentUrl = productUrl;
  const before = readLinkFromPage();
  input.focus();
  setValue(input, productUrl);
  await sleep(400);

  const button = findButton(input);
  if (button) button.click();
  else input.form?.requestSubmit?.();

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(500);
    const link = readLinkFromPage();
    if (link && link !== before) return { link };
  }
  return { error: "O painel nao devolveu o link em 15 segundos" };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "ping") { sendResponse({ pong: true, url: location.href }); return false; }
  if (message?.type !== "generate") return false;
  // Sem o catch, qualquer excecao dentro de generate() deixava o canal aberto e
  // sem resposta: o background recebia "the message channel closed before a
  // response was received", que nao diz nada sobre o produto. Responder sempre,
  // mesmo que seja com o erro, e o que torna a falha diagnosticavel.
  generate(message.url)
    .then((answer) => {
      // O link tambem vai por fora do canal de resposta. Clicar em "gerar" faz o
      // painel renavegar, e a navegacao DESTROI este content script no meio do
      // await — o link existia, mas morria junto com o port. Este empurrao chega
      // pelo runtime, que sobrevive a troca de pagina.
      if (answer?.link) {
        try {
          chrome.runtime.sendMessage({ type: "captured-link", link: answer.link, productUrl: message.url });
        } catch {}
      }
      sendResponse(answer);
    })
    .catch((error) => sendResponse({ error: String(error?.message ?? error) }));
  return true;
});

injectHook();
