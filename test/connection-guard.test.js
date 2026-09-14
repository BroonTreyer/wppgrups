import test from "node:test";
import assert from "node:assert/strict";
import { ConnectionGuard } from "../src/services/connection-guard.js";

function setup(respostas) {
  let chamadas = 0;
  const zapi = {
    async getStatus() {
      const r = respostas[Math.min(chamadas, respostas.length - 1)];
      chamadas += 1;
      if (r instanceof Error) throw r;
      return r;
    }
  };
  const tempo = { agora: 0 };
  const logs = [];
  const guard = new ConnectionGuard({ zapi, ttlMs: 30_000, clock: () => tempo.agora, logger: { log: (m) => logs.push(m), error: (m) => logs.push(m) } });
  return { guard, tempo, logs, chamadas: () => chamadas };
}

test("conectado com celular online libera os envios", async () => {
  const { guard } = setup([{ connected: true, smartphoneConnected: true }]);
  assert.equal(await guard.isConnected(), true);
});

test("a queda de 14/09 (connected false, celular offline) bloqueia", async () => {
  const { guard, logs } = setup([{ connected: false, smartphoneConnected: false, error: "You are not connected." }]);
  assert.equal(await guard.isConnected(), false);
  assert.match(logs.join("\n"), /DESCONECTADO/);
});

test("erro ao consultar o status conta como desconectado", async () => {
  const { guard } = setup([new Error("Z-API 500")]);
  assert.equal(await guard.isConnected(), false);
});

test("usa cache e so loga a transicao", async () => {
  const { guard, tempo, logs, chamadas } = setup([
    { connected: false, smartphoneConnected: false },
    { connected: false, smartphoneConnected: false },
    { connected: true, smartphoneConnected: true }
  ]);
  await guard.isConnected();
  tempo.agora = 10_000;
  await guard.isConnected();
  assert.equal(chamadas(), 1, "dentro de 30 s nao consulta de novo");

  tempo.agora = 40_000;
  await guard.isConnected();
  assert.equal(logs.filter((l) => /DESCONECTADO/.test(l)).length, 1, "desconectado repetido nao enche o log");

  tempo.agora = 80_000;
  assert.equal(await guard.isConnected(), true);
  assert.match(logs.at(-1), /reconectado/);
});
