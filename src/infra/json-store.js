import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const INITIAL_STATE = { destinations: [], publications: [], deliveryEvents: [], offers: [], queue: [], sources: [], seenProducts: [], affiliateLinks: [], affiliateRequests: [], affiliateStatus: null, alerts: [], operation: { running: false } };
const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY", "ENOENT"]);
const TEMP_MAX_AGE = 10 * 60 * 1000;
const resolveFile = (value) => value instanceof URL ? fileURLToPath(value) : value;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-");

export class JsonStore {
  constructor(file, { fs = { copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile }, retries = 6, onRecovery = null } = {}) {
    this.file = resolveFile(file);
    this.backupFile = `${this.file}.bak`;
    this.fs = fs;
    this.retries = retries;
    this.onRecovery = onRecovery;
    this.writeQueue = Promise.resolve();
    this.cache = null;
    this.lastMtime = null;
  }

  async load() {
    const current = await this.fs.stat(this.file).catch(() => null);
    if (this.cache && current && current.mtimeMs === this.lastMtime) return this.cache;
    const primary = await this.readState(this.file);
    if (primary.ok) {
      this.cache = primary.state;
      this.lastMtime = current?.mtimeMs ?? null;
      return this.cache;
    }
    if (primary.missing) {
      // Sem arquivo principal: o backup ainda pode ter a ultima gravacao boa.
      const backup = await this.readState(this.backupFile);
      this.cache = backup.ok ? backup.state : structuredClone(INITIAL_STATE);
      if (backup.ok) await this.recover("arquivo principal ausente; estado restaurado do backup");
      this.lastMtime = null;
      return this.cache;
    }
    return this.recoverCorrupted(primary.error);
  }

  // Arquivo existe mas nao e JSON valido — desligamento no meio da gravacao deixa
  // exatamente isso (no Windows, um arquivo do tamanho certo cheio de NUL).
  async recoverCorrupted(error) {
    const backup = await this.readState(this.backupFile);
    const quarantine = `${this.file}.corrompido-${timestamp()}`;
    await this.fs.rename(this.file, quarantine).catch(() => {});
    this.cache = backup.ok ? backup.state : structuredClone(INITIAL_STATE);
    this.lastMtime = null;
    await this.recover(backup.ok
      ? `arquivo corrompido (${error.message}) movido para ${basename(quarantine)}; estado restaurado do backup`
      : `arquivo corrompido (${error.message}) movido para ${basename(quarantine)}; sem backup, comecando vazio`);
    return this.cache;
  }

  async readState(file) {
    try {
      const parsed = JSON.parse(await this.fs.readFile(file, "utf8"));
      const state = { ...structuredClone(INITIAL_STATE), ...parsed };
      if (!state.destinations.length && parsed.groups?.length) {
        state.destinations = parsed.groups.map((group) => ({ ...group, type: "group" }));
      }
      return { ok: true, state };
    } catch (error) {
      return { ok: false, missing: error.code === "ENOENT", error };
    }
  }

  async recover(message) {
    if (this.onRecovery) await this.onRecovery(message);
    else console.error(`[store] ${message}`);
  }

  async read() {
    return structuredClone(await this.load());
  }

  async update(mutator) {
    // A fila de escrita serializa os mutators, mas ela NAO pode carregar o erro
    // de um deles adiante: encadear direto deixa `writeQueue` numa promise
    // rejeitada, e a partir dai TODA escrita seguinte falha com o erro alheio —
    // o store inteiro para de gravar por causa de um unico mutator com defeito.
    // Foi o que aconteceu em 10/09/2026: um `selected.status` em item removido
    // derrubou publicacao, ingestao e resgate de link ao mesmo tempo, todos
    // reportando "Cannot set properties of undefined".
    const resultado = this.writeQueue.then(async () => {
      const draft = structuredClone(await this.load());
      const result = await mutator(draft);
      await this.persist(draft);
      this.cache = draft;
      return result;
    });
    // O elo da corrente sobrevive ao erro; quem chamou continua recebendo-o.
    this.writeQueue = resultado.then(() => undefined, () => undefined);
    return resultado;
  }

  async persist(state) {
    // Sem indentacao de proposito. Os dois espacos por nivel custavam 27% do
    // arquivo — com 1.200 posts por dia e ~15 mil gravacoes, sao cerca de 32 GB
    // escritos no disco todo dia so para enfeitar um arquivo que nenhum humano le
    // direto. Para inspecionar: `node -e "console.log(JSON.stringify(require('./data/store.json'),null,2))"`.
    const payload = JSON.stringify(state);
    await this.fs.mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await this.fs.writeFile(temp, payload, "utf8");
    await this.flush(temp);
    await this.backup();
    for (let attempt = 0; attempt < this.retries; attempt += 1) {
      try {
        await this.fs.rename(temp, this.file);
        await this.stamp();
        return;
      } catch (error) {
        if (!RETRYABLE.has(error.code) || attempt === this.retries - 1) {
          await this.fs.writeFile(this.file, payload, "utf8");
          await this.fs.rm(temp, { force: true }).catch(() => {});
          await this.stamp();
          return;
        }
        await delay(20 * (attempt + 1));
      }
    }
  }

  // Sem isto o rename publica um nome novo apontando para dados que ainda estao
  // no cache do sistema operacional: uma queda de energia perde o conteudo e deixa
  // o arquivo do tamanho certo, so que vazio.
  async flush(file) {
    if (!this.fs.open) return;
    const handle = await this.fs.open(file, "r+").catch(() => null);
    if (!handle) return;
    await handle.sync().catch(() => {});
    await handle.close().catch(() => {});
  }

  // So copia o que ja foi lido com sucesso — nunca promove um arquivo corrompido a backup.
  async backup() {
    if (!this.fs.copyFile || !this.cache) return;
    await this.fs.copyFile(this.file, this.backupFile).catch(() => {});
  }

  async stamp() {
    this.lastMtime = (await this.fs.stat(this.file).catch(() => null))?.mtimeMs ?? null;
  }

  async cleanupTemporaryFiles(now = Date.now()) {
    const directory = dirname(this.file);
    const prefix = `${basename(this.file)}.`;
    const entries = await this.fs.readdir(directory).catch(() => []);
    let removed = 0;
    for (const entry of entries) {
      if (!entry.startsWith(prefix) || !entry.endsWith(".tmp")) continue;
      const target = join(directory, entry);
      const info = await this.fs.stat(target).catch(() => null);
      if (info && now - info.mtimeMs < TEMP_MAX_AGE) continue;
      await this.fs.rm(target, { force: true }).catch(() => {});
      removed += 1;
    }
    return removed;
  }
}
