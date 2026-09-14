import test from "node:test";
import assert from "node:assert/strict";
import { WelcomeResponder } from "../src/services/welcome-responder.js";

class MemoryStore {
  constructor(state = {}) { this.state = structuredClone(state); }
  async read() { return structuredClone(this.state); }
  async update(mutator) { return mutator(this.state); }
}

const INICIO = "2026-09-14T05:00:00Z";
const depois = (min) => String(Date.parse(INICIO) + min * 60_000);
const antes = String(Date.parse(INICIO) - 86_400_000);
const pessoa = (phone, extra = {}) => ({ phone, isGroup: false, messagesUnread: "0", lastMessageTime: antes, ...extra });

function setup({ chats = [], dryRun = false, maxPerTick = 10, send } = {}) {
  const store = new MemoryStore();
  const enviados = [];
  const zapi = {
    lista: chats,
    async getChats({ page }) { return page === 1 ? this.lista : []; },
    sendText: send ?? (async (payload) => { enviados.push(payload); })
  };
  const clock = { now: new Date(INICIO) };
  const config = { welcome: { enabled: true, dryRun, scanSize: 50, maxPerTick, message: "Entre: https://chat.whatsapp.com/ABC" } };
  const responder = new WelcomeResponder({ store, zapi, config, clock: () => clock.now, pause: async () => {} });
  return { responder, zapi, store, enviados, clock };
}

test("a foto inicial nunca responde conversa antiga, nem com mensagem nao lida", async () => {
  const { responder, zapi, enviados } = setup({ chats: [pessoa("5562911110001", { messagesUnread: "3", lastMessageTime: depois(1) })] });
  const foto = await responder.tick();
  assert.equal(foto.baseline, 1);
  zapi.lista = [pessoa("5562911110001", { messagesUnread: "5", lastMessageTime: depois(10) })];
  await responder.tick();
  assert.equal(enviados.length, 0, "quem ja conversava com o admin nao recebe o link");
});

test("a foto pega a lista inteira mesmo com a paginacao da Z-API repetindo conversas", async () => {
  const store = new MemoryStore();
  const todas = Array.from({ length: 230 }, (_, i) => pessoa(`55629${String(i).padStart(8, "0")}`));
  const enviados = [];
  const zapi = {
    lista: [],
    // Imita a Z-API real: com pagina pequena, cada pagina repete parte da anterior;
    // com pageSize grande, vem tudo de uma vez.
    async getChats({ page, pageSize }) {
      if (this.lista.length) return page === 1 ? this.lista : [];
      if (pageSize >= todas.length) return page === 1 ? todas : todas;
      return todas.slice(Math.max(0, (page - 1) * pageSize - 40), (page - 1) * pageSize - 40 + pageSize);
    },
    async sendText(payload) { enviados.push(payload); }
  };
  const config = { welcome: { enabled: true, dryRun: false, scanSize: 50, maxPerTick: 10, message: "https://chat.whatsapp.com/ABC" } };
  const responder = new WelcomeResponder({ store, zapi, config, clock: () => new Date(INICIO), pause: async () => {} });
  const foto = await responder.tick();
  assert.equal(foto.baseline, 230, "nenhum contato antigo fica de fora");

  // O contato mais antigo da lista escreve depois da foto: nao pode receber o link.
  zapi.lista = [{ ...todas[229], messagesUnread: "1", lastMessageTime: depois(5) }];
  await responder.tick();
  assert.equal(enviados.length, 0);
});

test("pessoa nova que escreveu recebe o link uma vez so", async () => {
  const { responder, zapi, enviados, store } = setup();
  await responder.tick();
  zapi.lista = [pessoa("5521999990005", { messagesUnread: "1", lastMessageTime: depois(2) })];
  await responder.tick();
  await responder.tick();
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].destinationId, "5521999990005");
  assert.match(enviados[0].message, /chat\.whatsapp\.com/);
  assert.doesNotMatch(JSON.stringify(store.state), /5521999990005/, "o store nao guarda telefone");
});

test("esquecer um contato da foto faz a proxima mensagem dele receber o link", async () => {
  const { responder, zapi, enviados } = setup({ chats: [pessoa("5562911110001")] });
  await responder.tick();
  zapi.lista = [pessoa("5562911110001", { messagesUnread: "1", lastMessageTime: depois(3) })];
  await responder.tick();
  assert.equal(enviados.length, 0, "contato da foto e ignorado");

  const r = await responder.forget({ phone: "+55 (62) 91111-0001" });
  assert.equal(r.forgotten, true);
  // Mensagem antiga (anterior ao esquecimento), ja lida: nao dispara e NAO desfaz o esquecimento.
  zapi.lista = [pessoa("5562911110001", { messagesUnread: "0", lastMessageTime: depois(3) })];
  await responder.tick();
  await responder.tick();
  assert.equal(enviados.length, 0);

  zapi.lista = [pessoa("5562911110001", { messagesUnread: "1", lastMessageTime: depois(10) })];
  await responder.tick();
  assert.equal(enviados.length, 1, "a primeira mensagem nova depois do esquecimento recebe o link");
  await responder.tick();
  assert.equal(enviados.length, 1, "e so uma vez");
  await assert.rejects(() => responder.forget({ phoneHash: "curto" }), /valido/);
});

test("grupo, canal e conversa aberta pelo admin nao recebem nada", async () => {
  const { responder, zapi, enviados } = setup();
  await responder.tick();
  zapi.lista = [
    { phone: "120363431078469154-group", isGroup: true, messagesUnread: "9", lastMessageTime: depois(1) },
    { phone: "120363400000000000@newsletter", isGroup: false, messagesUnread: "2", lastMessageTime: depois(1) },
    pessoa("5521999990007", { messagesUnread: "0", lastMessageTime: depois(1) })
  ];
  await responder.tick();
  assert.equal(enviados.length, 0);
});

test("ensaio registra quem receberia sem enviar", async () => {
  const { responder, zapi, enviados, store } = setup({ dryRun: true });
  await responder.tick();
  zapi.lista = [pessoa("5521999990005", { messagesUnread: "1", lastMessageTime: depois(2) })];
  const r = await responder.tick();
  assert.equal(enviados.length, 0);
  assert.equal(r.replied, 1);
  assert.equal(store.state.welcome.replies[0].status, "dry-run");
});

test("falha tenta de novo e desiste na terceira", async () => {
  let chamadas = 0;
  const { responder, zapi } = setup({ send: async () => { chamadas += 1; throw new Error("Z-API 500"); } });
  await responder.tick();
  zapi.lista = [pessoa("5521999990005", { messagesUnread: "1", lastMessageTime: depois(2) })];
  for (let i = 0; i < 6; i += 1) await responder.tick();
  assert.equal(chamadas, 3);
});

test("teto por rodada deixa o resto para a proxima, sem perder ninguem", async () => {
  const { responder, zapi, enviados } = setup({ maxPerTick: 2 });
  await responder.tick();
  zapi.lista = ["5521999990001", "5521999990002", "5521999990003"].map((p) => pessoa(p, { messagesUnread: "1", lastMessageTime: depois(2) }));
  await responder.tick();
  assert.equal(enviados.length, 2);
  await responder.tick();
  assert.equal(enviados.length, 3);
});
