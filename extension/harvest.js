/**
 * Colhe produtos da pagina onde a extensao esta, dentro do navegador do dono.
 *
 * Existe porque as paginas de LOJA OFICIAL das marcas (`/loja/<marca>`) montam a
 * lista por JavaScript: buscadas pelo servidor, o HTML volta sem um unico id de
 * produto. E `lista.mercadolivre.com.br` responde com anti-bot para quem nao e
 * navegador. Dentro do Chrome logado do dono nao ha nenhum desses problemas — a
 * pagina ja renderizou e a sessao ja e legitima.
 *
 * O que sai daqui NAO e oferta pronta: e materia-prima. Quem decide preco,
 * desconto, nicho, publico e destino continua sendo o servidor, com as mesmas
 * regras da vitrine. Aqui so se le a tela.
 */

const textoDe = (raiz, seletores) => {
  for (const seletor of seletores) {
    const achado = raiz.querySelector(seletor);
    const texto = achado?.textContent?.trim();
    if (texto) return texto;
  }
  return null;
};

/**
 * Preco em numero, a partir do texto brasileiro da tela.
 *
 * "R$ 1.234,56" -> 1234.56. O ponto e separador de milhar e a virgula e decimal;
 * trocar a ordem dessas duas substituicoes transforma 1.234 em 1.234 dolares.
 */
const precoDe = (texto) => {
  if (!texto) return null;
  const limpo = String(texto).replace(/[^\d.,]/g, "").replace(/\./g, "").replace(",", ".");
  const valor = Number.parseFloat(limpo);
  return Number.isFinite(valor) && valor > 0 ? valor : null;
};

/** O id MLB de um link de produto, seja /p/MLB123, /up/MLBU123 ou MLB-123-nome. */
const idDeLink = (href) => {
  if (!href) return null;
  const direto = href.match(/\/(?:p|up)\/(ML[A-Z]?U?\d+)/);
  if (direto) return direto[1];
  const listagem = href.match(/(MLB)-?(\d{8,})/);
  return listagem ? `${listagem[1]}${listagem[2]}` : null;
};

/**
 * A imagem do card.
 *
 * Cuidado com lazy-load: o `src` costuma ser um placeholder cinza de 1px ate a
 * pessoa rolar a pagina. O endereco real fica em `data-src`, e e ele que serve.
 */
const imagemDe = (card) => {
  const img = card.querySelector("img");
  if (!img) return null;
  const bruto = img.getAttribute("data-src") || img.getAttribute("src") || "";
  if (!bruto || bruto.startsWith("data:")) return null;
  return bruto.startsWith("//") ? `https:${bruto}` : bruto;
};

const CARTOES = [
  ".poly-card",
  "[class*=poly-card]",
  ".ui-search-layout__item",
  ".andes-card",
  "li.ui-search-layout__item"
];

const TITULOS = [".poly-component__title", "h2", "h3", ".ui-search-item__title", "[class*=__title]"];
const PRECO_ATUAL = [".poly-price__current .andes-money-amount__fraction", ".andes-money-amount__fraction", "[class*=price] [class*=fraction]"];
const PRECO_ANTES = [
  "s .andes-money-amount__fraction",
  ".andes-money-amount--previous .andes-money-amount__fraction",
  ".poly-price__old-price .andes-money-amount__fraction",
  ".poly-component__price s .andes-money-amount__fraction",
  "s [class*=fraction]",
  "del [class*=fraction]"
];

/**
 * O preco "de", quando o riscado nao esta na tela.
 *
 * A listagem nem sempre mostra o preco anterior — as vezes so o selo "72% OFF".
 * Sem ele o produto chega com desconto zero e e recusado por "desconto abaixo do
 * minimo", mesmo tendo vindo de uma URL filtrada por desconto. Foi o que
 * aconteceu com 16 dos 48 produtos do vult em 11/09/2026.
 *
 * O selo diz a porcentagem; com o preco atual, o de antes sai por conta:
 * atual = antes x (1 - off/100)  =>  antes = atual / (1 - off/100)
 */
const precoAnteriorPeloSelo = (card, atual) => {
  const selo = (card.textContent ?? "").match(/(\d{1,2})\s*%\s*OFF/i);
  if (!selo || !atual) return null;
  const off = Number(selo[1]);
  if (!Number.isFinite(off) || off <= 0 || off >= 100) return null;
  const antes = atual / (1 - off / 100);
  // Duas casas: o valor reconstruido nao precisa bater ao centavo com o do site,
  // precisa sustentar a conta do desconto.
  return Math.round(antes * 100) / 100;
};

/**
 * Nota e quantidade de vendas, lidas do texto do card.
 *
 * Isto NAO e detalhe: o filtro da ingestao exige `minSold` e `minRating`, e um
 * produto que chega sem esses campos e descartado como "pouca gente comprou".
 * Na primeira colheita real, 51 lojas renderam ~900 produtos e TODOS foram
 * filtrados por isso — a lista era boa, faltava a prova social.
 *
 * O layout varia entre a vitrine e a listagem, entao le-se por padrao de texto
 * em vez de seletor: "4.8" perto da estrela, "+5mil vendidos", "(1.234)".
 */
const provaSocial = (card) => {
  const texto = (card.textContent ?? "").replace(/\s+/g, " ");

  // Nota: "4,8" ou "4.8", sempre entre 0 e 5, e nunca colada num numero maior.
  const nota = texto.match(/(?:^|\s)([0-5][.,]\d)(?=\s|\()/);
  const rating = nota ? Number.parseFloat(nota[1].replace(",", ".")) : null;

  // Vendas: "+5mil vendidos", "+1000 vendidos", "50 vendidos".
  const vendas = texto.match(/\+?\s*([\d.]+)\s*(mil|mi)?\s*vendid/i);
  let soldCount = null;
  if (vendas) {
    const base = Number.parseFloat(vendas[1].replace(/\./g, ""));
    const escala = /mil/i.test(vendas[2] ?? "") ? 1000 : /mi/i.test(vendas[2] ?? "") ? 1_000_000 : 1;
    if (Number.isFinite(base)) soldCount = Math.round(base * escala);
  }

  // Sem "vendidos" a listagem as vezes mostra so o numero de avaliacoes: "(1.234)".
  // Avaliacao nao e venda, mas quem avalia comprou — serve de piso, nao de teto.
  if (soldCount === null) {
    const avaliacoes = texto.match(/\((\d[\d.]*)\)/);
    if (avaliacoes) {
      const total = Number.parseFloat(avaliacoes[1].replace(/\./g, ""));
      if (Number.isFinite(total)) soldCount = total;
    }
  }
  return { rating: rating && rating > 0 && rating <= 5 ? rating : null, soldCount, soldLabel: vendas ? vendas[0].trim() : null };
};

/** Um card virou produto, ou null quando falta o essencial. */
const doCartao = (card) => {
  const link = card.querySelector('a[href*="mercadolivre.com"], a[href^="/"]');
  const href = link?.href ?? null;
  const externalId = idDeLink(href);
  const title = textoDe(card, TITULOS);
  const currentPrice = precoDe(textoDe(card, PRECO_ATUAL));
  const imageUrl = imagemDe(card);
  if (!externalId || !title || !currentPrice || !href) return null;

  // Loja oficial: o card da marca traz o selo em texto ou em atributo de imagem.
  const texto = card.textContent ?? "";
  const officialStore = /loja oficial/i.test(texto) || Boolean(card.querySelector('[alt*="Loja oficial" i]'));
  const marca = textoDe(card, [".poly-component__seller", "[class*=seller]"]);

  const { rating, soldCount, soldLabel } = provaSocial(card);

  return {
    externalId,
    title: title.slice(0, 240),
    currentPrice,
    originalPrice: precoDe(textoDe(card, PRECO_ANTES)) ?? precoAnteriorPeloSelo(card, currentPrice),
    imageUrl,
    productUrl: href.split("#")[0],
    rating,
    soldCount,
    soldLabel,
    officialStore,
    sellerName: marca ? marca.replace(/^por\s+/i, "").replace(/loja oficial/i, "").trim().slice(0, 60) || null : null
  };
};

/**
 * Rola a pagina ate o fim para acordar o lazy-load.
 *
 * Sem isto, so os cards da primeira dobra tem imagem e metade da lista sequer
 * existe no DOM. Para quando a altura para de crescer — nao ha "ultima pagina"
 * confiavel numa lista que carrega sozinha.
 */
async function rolarAteOFim(limite = 12) {
  let alturaAnterior = 0;
  for (let volta = 0; volta < limite; volta += 1) {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const altura = document.body.scrollHeight;
    if (altura === alturaAnterior) break;
    alturaAnterior = altura;
  }
  window.scrollTo(0, 0);
}

/**
 * O endereco da proxima pagina, lido da propria paginacao do Mercado Livre.
 *
 * Montar o sufixo `_Desde_51` na mao NAO funciona: em 11/09/2026 as tres
 * "paginas" de `/loja/vult/_Discount_20-100` voltaram os mesmos 48 produtos,
 * com estatisticas identicas ate no numero de filtrados. O ML ignora o sufixo
 * quando ele nao vem na forma que ele mesmo gera.
 *
 * Ler o `href` do botao "Seguinte" resolve de vez: seja qual for o formato do
 * dia, e o formato certo, porque veio do proprio site.
 */
const offsetAtual = () => Number(location.pathname.match(/_Desde_(\d+)/)?.[1]) || 1;

/** O ML mostra a paginacao? E o botao de avancar esta vivo? */
const paginacaoNaTela = () => {
  const proximo = document.querySelector(".andes-pagination__button--next");
  if (proximo) return !proximo.className.includes("--disabled");
  return Boolean(document.querySelector(".andes-pagination, [class*=pagination]"));
};

/**
 * O endereco da proxima pagina.
 *
 * Ordem de preferencia, da mais confiavel para a menos: o link que o proprio ML
 * renderizou; qualquer `_Desde_` maior que o atual que esteja na tela; e, so em
 * ultimo caso, montado.
 *
 * Montar era dado como impossivel: em 11/09/2026 `_Desde_51` devolveu a MESMA
 * pagina. O erro estava no numero, nao na ideia — 51 pressupoe 50 itens por
 * pagina e o ML entrega 48. Por isso aqui o offset vem do que ESTA pagina de
 * fato leu, nunca de uma constante: se leu 48, a proxima comeca em 49.
 *
 * Sem isso a colheita nunca saiu da pagina 1. Medido em 990 colheitas: nenhuma
 * leu mais de 48 produtos e nenhuma das 54 URLs tinha paginacao. O catalogo
 * inteiro que o sistema enxergava eram 1.250 produtos em 51 lojas.
 */
const proximaPagina = (lidos) => {
  const candidatos = [
    ".andes-pagination__button--next:not(.andes-pagination__button--disabled) a",
    "a[title='Seguinte']",
    "a[aria-label='Seguinte']",
    "a[title='Próxima']",
    ".ui-search-link[rel='next']",
    "link[rel='next']"
  ];
  for (const seletor of candidatos) {
    const link = document.querySelector(seletor);
    // Um "Seguinte" que aponta para a propria pagina faz a colheita repetir a
    // mesma lista — ja aconteceu com avon e eudora.
    if (link?.href && link.href !== location.href) return link.href;
  }

  const atual = offsetAtual();
  const naTela = [...document.querySelectorAll('a[href*="_Desde_"]')]
    .map((a) => ({ href: a.href, n: Number(a.href.match(/_Desde_(\d+)/)?.[1]) }))
    .filter((item) => Number.isFinite(item.n) && item.n > atual)
    .sort((a, b) => a.n - b.n);
  if (naTela.length) return naTela[0].href;

  if (!lidos || !paginacaoNaTela()) return null;
  const url = new URL(location.href);
  // O ML cola o `_Desde_` no segmento de FILTRO (`_Discount_10-100_Desde_49`),
  // mas numa loja sem filtro ele e um segmento proprio (`/loja/vult/_Desde_49`).
  // Concatenar direto nos dois casos produzia `/loja/vult_Desde_49`, que e outra
  // loja — inexistente.
  const base = url.pathname.replace(/_Desde_\d+/, "").replace(/\/+$/, "");
  const ultimo = base.split("/").pop() ?? "";
  url.pathname = ultimo.startsWith("_") ? `${base}_Desde_${atual + lidos}` : `${base}/_Desde_${atual + lidos}`;
  return url.href === location.href ? null : url.href;
};

async function colher({ rolar = true } = {}) {
  if (rolar) await rolarAteOFim();
  const vistos = new Set();
  const produtos = [];
  for (const seletor of CARTOES) {
    for (const card of document.querySelectorAll(seletor)) {
      const produto = doCartao(card);
      if (!produto || vistos.has(produto.externalId)) continue;
      vistos.add(produto.externalId);
      produtos.push(produto);
    }
    // O primeiro seletor que rende resultado e o certo para esta pagina; seguir
    // para os outros so acrescentaria os mesmos cards sob outra classe.
    if (produtos.length) break;
  }
  // O diagnostico viaja junto porque daqui nao da para inspecionar nada: o
  // servidor leva anti-bot nestas paginas, entao a unica testemunha do que
  // estava na tela e a propria colheita.
  const diagnostico = {
    lidos: produtos.length,
    offset: offsetAtual(),
    paginacaoNaTela: paginacaoNaTela(),
    linksDesde: document.querySelectorAll('a[href*="_Desde_"]').length,
    botaoSeguinte: Boolean(document.querySelector(".andes-pagination__button--next"))
  };
  return { produtos, url: location.href, titulo: document.title, proxima: proximaPagina(produtos.length), diagnostico };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "harvest") return false;
  colher({ rolar: message.rolar !== false })
    .then((resultado) => sendResponse(resultado))
    .catch((error) => sendResponse({ produtos: [], erro: error.message }));
  return true;
});
