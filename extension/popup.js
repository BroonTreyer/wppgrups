const fields = ["server", "token", "builderUrl"];
const el = (id) => document.querySelector(`#${id}`);

const load = async () => {
  const saved = await chrome.storage.local.get([...fields, "status"]);
  el("server").value = saved.server ?? "http://localhost:3000";
  el("token").value = saved.token ?? "";
  el("builderUrl").value = saved.builderUrl ?? "https://www.mercadolivre.com.br/afiliados/linkbuilder";
  render(saved.status);
};

function render(status) {
  const box = el("status");
  if (!status) { box.textContent = "Ainda não rodou nesta sessão."; return; }
  const quando = status.lastRun ? new Date(status.lastRun).toLocaleTimeString("pt-BR") : "—";
  box.innerHTML = [
    `Última verificação: <b>${quando}</b>`,
    `Links gerados: <b class="ok">${status.resolved ?? 0}</b> · falhas: <b class="${status.failed ? "bad" : "ok"}">${status.failed ?? 0}</b>`,
    status.lastError ? `<span class="bad">${status.lastError}</span>` : `<span class="ok">sem erros</span>`
  ].join("<br>");
}

async function checarServidor() {
  const server = el("server").value.replace(/\/+$/, "");
  const token = el("token").value;
  try {
    const response = await fetch(`${server}/api/affiliate/status`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    el("status").innerHTML = `Conectado ao OfertaFlow.<br>Modo: <b>${body.mode}</b> · pendentes: <b>${body.pendingLinks}</b> · em cache: <b>${body.cachedLinks}</b>`;
  } catch (error) {
    el("status").innerHTML = `<span class="bad">Não conectou: ${error.message}</span>`;
  }
}

el("save").addEventListener("click", async () => {
  await chrome.storage.local.set(Object.fromEntries(fields.map((field) => [field, el(field).value.trim()])));
  await checarServidor();
});

el("run").addEventListener("click", () => {
  el("status").textContent = "Gerando…";
  chrome.runtime.sendMessage({ type: "run-now" }, (answer) => render(answer?.state));
});

load();
