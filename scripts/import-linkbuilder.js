import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildConfig, parseCurl } from "../src/infra/curl-import.js";

const OUTPUT = fileURLToPath(new URL("../data/linkbuilder.json", import.meta.url));
const [, , curlFile, productUrl] = process.argv;

if (!curlFile || !productUrl) {
  console.error("Uso: node scripts/import-linkbuilder.js <arquivo-com-curl.txt> <url-do-produto-usada-no-painel>");
  process.exit(1);
}

const config = buildConfig(parseCurl(await readFile(curlFile, "utf8")), productUrl);
await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, JSON.stringify(config, null, 2), "utf8");
console.log(`Gerador de links configurado em ${OUTPUT}`);
console.log(`Metodo: ${config.method}  URL: ${config.url}`);
console.log(`Cabecalhos: ${Object.keys(config.headers).join(", ")}`);
