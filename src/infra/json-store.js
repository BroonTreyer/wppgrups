import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const INITIAL_STATE = { destinations: [], publications: [], deliveryEvents: [], offers: [], queue: [], sources: [], seenProducts: [], affiliateLinks: [], affiliateRequests: [], affiliateStatus: null, alerts: [], operation: { running: false } };
const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY", "ENOENT"]);
const TEMP_MAX_AGE = 10 * 60 * 1000;
const resolveFile = (value) => value instanceof URL ? fileURLToPath(value) : value;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class JsonStore {
  constructor(file, { fs = { mkdir, readFile, readdir, rename, rm, stat, writeFile }, retries = 6 } = {}) {
    this.file = resolveFile(file);
    this.fs = fs;
    this.retries = retries;
    this.writeQueue = Promise.resolve();
    this.cache = null;
    this.lastMtime = null;
  }

  async load() {
    const current = await this.fs.stat(this.file).catch(() => null);
    if (this.cache && current && current.mtimeMs === this.lastMtime) return this.cache;
    try {
      const parsed = JSON.parse(await this.fs.readFile(this.file, "utf8"));
      const state = { ...structuredClone(INITIAL_STATE), ...parsed };
      if (!state.destinations.length && parsed.groups?.length) {
        state.destinations = parsed.groups.map((group) => ({ ...group, type: "group" }));
      }
      this.cache = state;
      this.lastMtime = current?.mtimeMs ?? null;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.cache = structuredClone(INITIAL_STATE);
      this.lastMtime = null;
    }
    return this.cache;
  }

  async read() {
    return structuredClone(await this.load());
  }

  async update(mutator) {
    this.writeQueue = this.writeQueue.then(async () => {
      const draft = structuredClone(await this.load());
      const result = await mutator(draft);
      await this.persist(draft);
      this.cache = draft;
      return result;
    });
    return this.writeQueue;
  }

  async persist(state) {
    const payload = JSON.stringify(state, null, 2);
    await this.fs.mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await this.fs.writeFile(temp, payload, "utf8");
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
