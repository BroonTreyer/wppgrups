const PLACEHOLDER = "{{url}}";

export function tokenize(command) {
  const tokens = [];
  let current = "";
  let quote = null;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) { quote = null; continue; }
      current += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (char === "^" || char === "`") continue;
    if (char === "\\" && command[index + 1] === "\n") { index += 1; continue; }
    if (/\s/.test(char)) {
      if (current || started) { tokens.push(current); current = ""; started = false; }
      continue;
    }
    current += char;
  }
  if (current || started) tokens.push(current);
  return tokens;
}

export function parseCurl(command) {
  const tokens = tokenize(command.trim().replace(/^curl\s+/i, "curl "));
  const request = { url: null, method: null, headers: {}, body: null };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "curl") continue;
    if (token === "-X" || token === "--request") { request.method = tokens[++index]; continue; }
    if (token === "-H" || token === "--header") {
      const [name, ...rest] = tokens[++index].split(":");
      request.headers[name.trim().toLowerCase()] = rest.join(":").trim();
      continue;
    }
    if (token === "-b" || token === "--cookie") { request.headers.cookie = tokens[++index]; continue; }
    if (["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode"].includes(token)) { request.body = tokens[++index]; continue; }
    if (token.startsWith("-")) {
      if (["--compressed", "-s", "-i", "-k", "-L", "--location", "--insecure", "-v"].includes(token)) continue;
      index += 1;
      continue;
    }
    if (!request.url && /^https?:\/\//i.test(token)) request.url = token;
  }
  if (!request.url) throw new Error("Nao encontrei a URL da requisicao no comando colado");
  request.method = request.method ?? (request.body ? "POST" : "GET");
  return request;
}

export function buildConfig(request, productUrl) {
  const replaceAll = (text) => text
    .replaceAll(encodeURIComponent(productUrl), PLACEHOLDER)
    .replaceAll(productUrl, PLACEHOLDER);

  const config = {
    url: replaceAll(request.url),
    method: request.method,
    headers: Object.fromEntries(Object.entries(request.headers).filter(([name]) => !["content-length", "host", "connection", "accept-encoding"].includes(name)))
  };
  if (request.body) {
    const body = replaceAll(request.body);
    try { config.body = JSON.parse(body); } catch { config.body = body; }
  }
  const encoded = JSON.stringify(config);
  if (!encoded.includes(PLACEHOLDER)) {
    throw new Error("A URL do produto nao apareceu na requisicao. Gere o link para exatamente a URL informada e copie o request de novo.");
  }
  if (!config.headers.cookie) {
    throw new Error("O request copiado nao tem o cookie de sessao. Copie o request do painel ja autenticado (Copy as cURL).");
  }
  return config;
}

