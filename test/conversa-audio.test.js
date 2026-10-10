import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversaAudio, textoDaMensagem } from "../src/services/conversa-audio.js";

class MemoryStore {
  constructor(state = {}) { this.state = structuredClone(state); }
  async read() { return structuredClone(this.state); }
  async update(mutator) { return mutator(this.state); }
}

const sha = (v) => createHash("sha256").update(v).digest("hex");
const INICIO = Date.parse("2026-10-09T15:00:00Z");
const PESSOA = "5562999990001";
const msg = (texto, extra = {}) => ({ type: "ReceivedCallback", phone: PESSOA, fromMe: false, isGroup: false, senderName: "Ana", text: { message: texto }, ...extra });

async function setup({ decisoes = [], cfg = {}, conhecidos = [], arquivos = ["1-boas-vindas.ogg", "2-como-funciona.ogg", "4-link.ogg", "7-despedida.ogg"] } = {}) {
  const pasta = await mkdtemp(join(tmpdir(), "audios-"));
  for (const nome of arquivos) await writeFile(join(pasta, nome), Buffer.from("OggS-falso"));
  const enviados = [];
  const zapi = {
    async sendAudio(p) { enviados.push({ tipo: "audio", ...p }); },
    async sendText(p) { enviados.push({ tipo: "texto", ...p }); }
  };
  const pedidos = [];
  const client = {
    messages: {
      async create(req) {
        pedidos.push(req);
        const input = decisoes.shift() ?? { audios: [], mandar_link: false, precisa_humano: false, motivo: "nada" };
        return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "decidir_resposta", input }] };
      }
    }
  };
  const relogio = { t: INICIO };
  const config = {
    audioFlow: {
      enabled: true, dryRun: false, onlyPhones: [], model: "m", debounceSeconds: 20, humanPauseHours: 24,
      maxAudiosPerTurn: 3, maxTurnsPerDay: 6, alertPhone: "", audiosDir: pasta,
      inviteLink: "https://chat.whatsapp.com/ABC", ...cfg
    }
  };
  const store = new MemoryStore();
  const conversa = new ConversaAudio({
    store, mainStore: new MemoryStore({ welcome: { known: conhecidos } }), zapi, config, client,
    clock: () => new Date(relogio.t), logger: { log() {}, error() {} }, ffprobe: async () => 20
  });
  const passar = (s) => { relogio.t += s * 1000; };
  return { conversa, enviados, pedidos, store, passar };
}

test("pessoa nova recebe os audios escolhidos e o link, so depois de parar de escrever", async () => {
  const { conversa, enviados, pedidos, passar } = await setup({
    decisoes: [{ audios: ["boas-vindas", "como-funciona", "link-do-grupo"], mandar_link: true, precisa_humano: false, motivo: "primeiro contato" }]
  });
  await conversa.receber(msg("oi"));
  passar(5);
  await conversa.receber(msg("vi o anuncio, quero participar"));
  passar(10);
  assert.equal((await conversa.tick()).respondidos, 0, "ainda escrevendo: espera");
  passar(15);
  assert.equal((await conversa.tick()).respondidos, 1);
  assert.deepEqual(enviados.map((e) => e.tipo), ["audio", "audio", "audio", "texto"]);
  assert.match(enviados[0].audio, /^data:audio\/ogg;base64,/);
  assert.ok(enviados.every((e) => e.destinationId === PESSOA));
  assert.equal(enviados[3].message, "https://chat.whatsapp.com/ABC");
  assert.match(pedidos[0].messages[0].content, /oi\nPESSOA: vi o anuncio/);
});

test("nunca repete audio, mesmo que a IA peca de novo", async () => {
  const { conversa, enviados, passar } = await setup({
    decisoes: [
      { audios: ["boas-vindas"], mandar_link: false, precisa_humano: false, motivo: "" },
      { audios: ["boas-vindas", "despedida"], mandar_link: false, precisa_humano: false, motivo: "" }
    ]
  });
  await conversa.receber(msg("oi"));
  passar(30);
  await conversa.tick();
  await conversa.receber(msg("obrigada"));
  passar(30);
  await conversa.tick();
  assert.equal(enviados.length, 2);
  assert.match(enviados[1].audio, /base64/);
  const c = Object.values((await conversa.store.read()).contatos)[0];
  assert.deepEqual(c.audiosEnviados, ["boas-vindas", "despedida"]);
});

test("contato antigo do dono nunca recebe audio automatico", async () => {
  const { conversa, enviados, pedidos, passar } = await setup({ conhecidos: [sha(PESSOA)] });
  await conversa.receber(msg("oi amiga, tudo bem?"));
  passar(60);
  await conversa.tick();
  assert.equal(enviados.length, 0);
  assert.equal(pedidos.length, 0, "nem gasta IA");
});

test("quando a Isa responde pelo celular, o robo fica quieto naquela conversa", async () => {
  const { conversa, enviados, pedidos, passar } = await setup({
    decisoes: [{ audios: ["boas-vindas"], mandar_link: false, precisa_humano: false, motivo: "" }]
  });
  await conversa.receber(msg("oi"));
  passar(30);
  await conversa.tick();
  await conversa.receber(msg("Oi Ana! Sou eu, a Isa", { fromMe: true, fromApi: false }));
  await conversa.receber(msg("ah que legal"));
  passar(30);
  await conversa.tick();
  assert.equal(enviados.length, 1);
  assert.equal(pedidos.length, 1, "nao pergunta a IA enquanto a Isa conversa");
  passar(25 * 3600);
  await conversa.receber(msg("e ai?"));
  passar(30);
  await conversa.tick();
  assert.equal(pedidos.length, 2, "depois de 24h volta a responder");
});

test("mensagem enviada pelo proprio robo nao conta como a Isa assumindo", async () => {
  const { conversa, store, passar } = await setup();
  await conversa.receber(msg("oi"));
  await conversa.receber(msg("[audio]", { fromMe: true, fromApi: true }));
  passar(30);
  const c = Object.values(store.state.contatos)[0];
  assert.equal(c.humanoAte, undefined);
});

test("grupo, reacao e fora da lista de teste sao ignorados", async () => {
  const { conversa } = await setup({ cfg: { onlyPhones: ["5562988887777"] } });
  assert.ok((await conversa.receber(msg("oi", { isGroup: true, phone: "1203-group" }))).ignorado);
  assert.ok((await conversa.receber(msg("oi"))).ignorado, "fora da lista de teste");
  assert.equal(textoDaMensagem({ reaction: { value: "❤" } }), null);
  assert.equal(textoDaMensagem({ audio: {} }), "[a pessoa mandou um audio]");
});

test("ensaio decide mas nao envia nada", async () => {
  const { conversa, enviados, store, passar } = await setup({
    cfg: { dryRun: true },
    decisoes: [{ audios: ["boas-vindas"], mandar_link: true, precisa_humano: false, motivo: "x" }]
  });
  await conversa.receber(msg("oi"));
  passar(30);
  await conversa.tick();
  assert.equal(enviados.length, 0);
  assert.equal(store.state.eventos.at(-1).tipo, "ensaio");
  assert.deepEqual(store.state.eventos.at(-1).audios, ["boas-vindas"]);
});

test("precisa da Isa: avisa no numero de alerta, uma vez a cada 6h", async () => {
  const { conversa, enviados, passar } = await setup({
    cfg: { alertPhone: "5562911112222" },
    decisoes: [
      { audios: [], mandar_link: false, precisa_humano: true, motivo: "reclamacao de entrega" },
      { audios: [], mandar_link: false, precisa_humano: true, motivo: "de novo" }
    ]
  });
  await conversa.receber(msg("meu pedido nao chegou"));
  passar(30);
  await conversa.tick();
  await conversa.receber(msg("alguem?"));
  passar(30);
  await conversa.tick();
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].destinationId, "5562911112222");
  assert.match(enviados[0].message, /meu pedido nao chegou/);
});

test("audio que nao foi gravado nao entra no catalogo", async () => {
  const { conversa } = await setup({ arquivos: ["1-boas-vindas.ogg", "leia-me.txt"] });
  const status = await conversa.status();
  assert.deepEqual(status.audios.map((a) => a.id), ["boas-vindas"]);
  assert.ok(status.faltando.includes("2-como-funciona"));
});
