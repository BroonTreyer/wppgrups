export function parseAffiliateParams(value) {
  const raw = String(value ?? "").trim().replace(/^[?&]+/, "");
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const entries = [...params];
  if (!entries.length || entries.some(([key, item]) => !key.trim() || !item.trim())) {
    throw new Error("Parametros de afiliado devem estar no formato chave=valor&chave=valor");
  }
  return params.toString();
}

export function isAttributedLink(url) {
  let target;
  try { target = new URL(String(url)); } catch { return false; }
  if (target.hostname === "meli.la" || target.hostname === "mercadolivre.com") return true;
  if (target.pathname.startsWith("/sec/")) return true;
  if (target.pathname.startsWith("/social/") && target.searchParams.has("ref")) return true;
  return target.searchParams.has("matt_word") && target.searchParams.has("matt_tool");
}

export function decorateAffiliateUrl(url, params) {
  const target = new URL(String(url));
  if (!params) return target.toString();
  for (const [key, value] of new URLSearchParams(params)) target.searchParams.set(key, value);
  return target.toString();
}
