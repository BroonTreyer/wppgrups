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

/**
 * O link PAGA comissao? Nao confundir com "tem a marca do afiliado".
 *
 * O link de verdade do painel resolve para
 * `mercadolivre.com.br/social/<usuario>?matt_word=...&matt_tool=...&ref=<blob>`,
 * e o `ref` e assinado pelo servidor do Mercado Livre — ninguem o fabrica.
 * Colar `matt_word` e `matt_tool` numa URL de produto produz um link que PARECE
 * de afiliado e nao e: em 10 e 11/09/2026 esse formato saiu em 786 das 1.355
 * publicacoes, ate o dono do canal reparar que nao era o link dele.
 *
 * Por isso a checagem exige a marca do gerador (encurtador, /sec/ ou /social/
 * com ref) e NAO aceita os parametros soltos.
 */
export function isAttributedLink(url) {
  let target;
  try { target = new URL(String(url)); } catch { return false; }
  if (target.hostname === "meli.la" || target.hostname === "mercadolivre.com") return true;
  if (target.pathname.startsWith("/sec/")) return true;
  if (target.pathname.startsWith("/social/") && target.searchParams.has("ref")) return true;
  return false;
}

/**
 * Tem a marca do afiliado, mesmo sem a assinatura do servidor.
 *
 * Serve para diagnostico — dizer "este link ao menos carrega o meu codigo" —
 * nunca para liberar publicacao. Quem libera publicacao e `isAttributedLink`.
 */
export function hasAffiliateParams(url) {
  try {
    const target = new URL(String(url));
    return target.searchParams.has("matt_word") && target.searchParams.has("matt_tool");
  } catch { return false; }
}

export function decorateAffiliateUrl(url, params) {
  const target = new URL(String(url));
  if (!params) return target.toString();
  for (const [key, value] of new URLSearchParams(params)) target.searchParams.set(key, value);
  return target.toString();
}
