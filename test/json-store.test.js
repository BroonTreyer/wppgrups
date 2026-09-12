import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { JsonStore } from "../src/infra/json-store.js";

const newFile = async () => join(await mkdtemp(join(tmpdir(), "ofertaflow-store-")), "store.json");

test("cria o estado inicial quando o arquivo nao existe", async () => {
  const store = new JsonStore(await newFile());
  const state = await store.read();
  assert.deepEqual(state.queue, []);
  assert.deepEqual(state.operation, { running: false });
});

test("serializa gravacoes concorrentes sem perder nenhuma", async () => {
  const store = new JsonStore(await newFile());
  await Promise.all(Array.from({ length: 25 }, (_, index) => store.update((state) => { state.queue.push({ id: index }); })));
  const state = await store.read();
  assert.equal(state.queue.length, 25);
  assert.deepEqual([...new Set(state.queue.map((item) => item.id))].length, 25);
});

test("nao devolve a referencia interna do cache", async () => {
  const store = new JsonStore(await newFile());
  await store.update((state) => { state.queue.push({ id: "a" }); });
  const first = await store.read();
  first.queue.push({ id: "intruso" });
  assert.equal((await store.read()).queue.length, 1);
});

test("mantem o estado anterior quando o mutator falha", async () => {
  const store = new JsonStore(await newFile());
  await store.update((state) => { state.queue.push({ id: "ok" }); });
  await assert.rejects(() => store.update((state) => { state.queue.push({ id: "ruim" }); throw new Error("falhou"); }));
  const state = await store.read();
  assert.deepEqual(state.queue, [{ id: "ok" }]);
});

test("tenta de novo quando o Windows recusa o rename e grava mesmo assim", async () => {
  const file = await newFile();
  const real = { mkdir: (await import("node:fs/promises")).mkdir, readFile, readdir: (await import("node:fs/promises")).readdir, rm: (await import("node:fs/promises")).rm, stat, writeFile };
  let attempts = 0;
  const store = new JsonStore(file, {
    retries: 4,
    fs: {
      ...real,
      rename: async (from, to) => {
        attempts += 1;
        if (attempts < 3) { const error = new Error("EPERM"); error.code = "EPERM"; throw error; }
        return (await import("node:fs/promises")).rename(from, to);
      }
    }
  });
  await store.update((state) => { state.queue.push({ id: "resiliente" }); });
  assert.equal(attempts, 3);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).queue, [{ id: "resiliente" }]);
});

test("grava direto no arquivo quando o rename nunca funciona", async () => {
  const file = await newFile();
  const real = await import("node:fs/promises");
  const store = new JsonStore(file, {
    retries: 3,
    fs: {
      mkdir: real.mkdir, readFile: real.readFile, readdir: real.readdir, rm: real.rm, stat: real.stat, writeFile: real.writeFile,
      rename: async () => { const error = new Error("EPERM"); error.code = "EPERM"; throw error; }
    }
  });
  await store.update((state) => { state.queue.push({ id: "fallback" }); });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).queue, [{ id: "fallback" }]);
  assert.deepEqual((await store.read()).queue, [{ id: "fallback" }]);
});

test("recarrega quando o arquivo muda por fora", async () => {
  const file = await newFile();
  const store = new JsonStore(file);
  await store.update((state) => { state.queue.push({ id: "interno" }); });
  await new Promise((resolve) => setTimeout(resolve, 15));
  await writeFile(file, JSON.stringify({ queue: [{ id: "externo" }] }), "utf8");
  assert.deepEqual((await store.read()).queue, [{ id: "externo" }]);
});

test("remove arquivos temporarios abandonados", async () => {
  const file = await newFile();
  const store = new JsonStore(file);
  await store.update((state) => { state.queue.push({ id: "x" }); });
  await writeFile(`${file}.99999.tmp`, "{}", "utf8");
  assert.equal(await store.cleanupTemporaryFiles(Date.now() + 3600000), 1);
  assert.equal(await store.cleanupTemporaryFiles(Date.now() + 3600000), 0);
});

test("guarda um backup a cada gravacao", async () => {
  const file = await newFile();
  const store = new JsonStore(file);
  await store.update((state) => { state.queue.push({ id: "primeiro" }); });
  await store.update((state) => { state.queue.push({ id: "segundo" }); });
  assert.deepEqual(JSON.parse(await readFile(`${file}.bak`, "utf8")).queue, [{ id: "primeiro" }]);
  assert.equal(JSON.parse(await readFile(file, "utf8")).queue.length, 2);
});

test("restaura do backup quando o arquivo principal vira NUL", async () => {
  const file = await newFile();
  const primeiro = new JsonStore(file);
  await primeiro.update((state) => { state.queue.push({ id: "sobrevivente" }); });
  await primeiro.update((state) => { state.destinations.push({ id: "canal" }); });

  // Assinatura de queda de energia no Windows: tamanho certo, conteudo zerado.
  const tamanho = (await stat(file)).size;
  await writeFile(file, Buffer.alloc(tamanho));

  const avisos = [];
  const segundo = new JsonStore(file, { onRecovery: (mensagem) => { avisos.push(mensagem); } });
  const state = await segundo.read();
  assert.deepEqual(state.queue, [{ id: "sobrevivente" }]);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /restaurado do backup/);
});

test("poe o arquivo corrompido de quarentena em vez de sobrescrever", async () => {
  const file = await newFile();
  await writeFile(file, "{ isso nao e json", "utf8");
  const avisos = [];
  const store = new JsonStore(file, { onRecovery: (mensagem) => { avisos.push(mensagem); } });

  assert.deepEqual((await store.read()).queue, []);
  const restos = await readdir(dirname(file));
  const quarentena = restos.find((nome) => nome.includes(".corrompido-"));
  assert.ok(quarentena, "o arquivo corrompido precisa continuar no disco");
  assert.equal(await readFile(join(dirname(file), quarentena), "utf8"), "{ isso nao e json");
  assert.match(avisos[0], /sem backup/);
});

test("usa o backup quando o arquivo principal some", async () => {
  const file = await newFile();
  const primeiro = new JsonStore(file);
  await primeiro.update((state) => { state.queue.push({ id: "a" }); });
  await primeiro.update((state) => { state.queue.push({ id: "b" }); });
  await rm(file);

  const segundo = new JsonStore(file, { onRecovery: () => {} });
  assert.deepEqual((await segundo.read()).queue, [{ id: "a" }]);
});

test("um mutator que lanca nao derruba as gravacoes seguintes", async () => {
  const store = new JsonStore(await newFile());

  await assert.rejects(
    () => store.update((state) => { state.queue.find((i) => i.id === "sumiu").status = "x"; }),
    /Cannot (set|read) propert/
  );

  // O erro e de quem chamou, nao da fila de escrita: encadear a promise
  // rejeitada em `writeQueue` envenenava TODAS as escritas seguintes, e o
  // sistema inteiro parava de gravar reportando o erro de um mutator alheio.
  await store.update((state) => { state.queue.push({ id: "depois", status: "queued" }); });
  const state = await store.read();
  assert.deepEqual(state.queue.map((i) => i.id), ["depois"]);

  // E continua serializando normalmente depois do tropeco.
  await Promise.all([
    store.update((s) => { s.queue.push({ id: "a" }); }),
    store.update((s) => { s.queue.push({ id: "b" }); })
  ]);
  assert.equal((await store.read()).queue.length, 3);
});
