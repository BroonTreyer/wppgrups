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

const findInput = () => {
  const candidates = [...document.querySelectorAll("input[type=text], input[type=url], input:not([type]), textarea")].filter(visible);
  const byHint = candidates.find((element) => {
    const hint = `${element.placeholder ?? ""} ${element.getAttribute("aria-label") ?? ""} ${element.name ?? ""} ${element.id ?? ""}`.toLowerCase();
    return hint.includes("link") || hint.includes("url") || hint.includes("produto") || hint.includes("cole");
  });
  return byHint ?? candidates[0] ?? null;
};

const findButton = () => {
  const words = ["gerar", "criar", "encurtar", "obter"];
  const candidates = [...document.querySelectorAll("button, [role=button], input[type=submit]")].filter(visible);
  return candidates.find((element) => {
    const label = `${element.textContent ?? ""} ${element.value ?? ""} ${element.getAttribute("aria-label") ?? ""}`.toLowerCase();
    return words.some((word) => label.includes(word));
  }) ?? null;
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
  const input = findInput();
  if (!input) return { error: "Nao encontrei o campo de link nesta pagina. Abra o gerador de links do painel de afiliados.", fatal: true };

  window.__ofertaflowCurrentUrl = productUrl;
  const before = readLinkFromPage();
  input.focus();
  setValue(input, productUrl);
  await sleep(400);

  const button = findButton();
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
  generate(message.url).then(sendResponse);
  return true;
});

injectHook();
