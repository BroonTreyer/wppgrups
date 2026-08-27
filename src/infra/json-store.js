import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const INITIAL_STATE = { destinations: [], publications: [], deliveryEvents: [], offers: [], queue: [] };
const resolveFile = (value) => value instanceof URL ? fileURLToPath(value) : value;

export class JsonStore {
  constructor(file) {
    this.file = resolveFile(file);
    this.writeQueue = Promise.resolve();
  }

  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      const state = { ...INITIAL_STATE, ...parsed };
      if (!state.destinations.length && parsed.groups?.length) {
        state.destinations = parsed.groups.map((group) => ({ ...group, type: "group" }));
      }
      return state;
    } catch (error) {
      if (error.code === "ENOENT") return structuredClone(INITIAL_STATE);
      throw error;
    }
  }

  async update(mutator) {
    this.writeQueue = this.writeQueue.then(async () => {
      const state = await this.read();
      const result = await mutator(state);
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
      await rename(temporary, this.file);
      return result;
    });
    return this.writeQueue;
  }
}
