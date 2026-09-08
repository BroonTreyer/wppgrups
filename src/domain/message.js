import { discountPercentage, minutesUntilExpiry } from "./offer.js";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const hour = (value) => new Date(value).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });

const HEADLINES = {
  kids: "👶 ACHADINHO PRA MAMÃE",
  // `home`, `beauty`, `health` e `fashion` saem de proposito: caem na manchete
  // geral. Rotular a oferta pelo nicho dizia menos que a chamada generica e
  // ainda arriscava anunciar o produto errado quando a classificacao escorrega.
  electronics: "📱 ACHADO TECH",
  "computing-gaming": "💻 ACHADO GAMER",
  "tools-auto": "🔧 ACHADO DE FERRAMENTA",
  sports: "🏋️ ACHADO FITNESS",
  market: "🛒 ACHADO DE MERCADO",
  general: "🔥 ACHADINHO DO DIA"
};

// O desconto NAO troca mais a manchete. Antes, qualquer 50% virava "PRECO
// ABSURDO" e apagava a identidade do post: um impermeabilizante de 18kg saiu
// com essa chamada num canal de achadinhos. O desconto ja tem lugar proprio na
// linha de "% OFF", e e la que a enfase entra.
const headline = (offer, nicheIds = []) => {
  const niche = nicheIds.find((id) => id !== "general" && HEADLINES[id]);
  return HEADLINES[niche] ?? HEADLINES.general;
};

const HYPE_DISCOUNT = 50;

export function formatOfferCaption(offer, now = new Date(), nicheIds = offer.nicheIds ?? []) {
  const discount = discountPercentage(offer);
  const lines = [headline(offer, nicheIds), "", `*${offer.title}*`, ""];

  if (offer.originalPrice) lines.push(`~${money.format(offer.originalPrice)}~`);
  lines.push(`💰 *${money.format(offer.currentPrice)}*${offer.paymentMethod ? ` ${offer.paymentMethod}` : ""}`);
  if (discount) {
    lines.push(discount >= HYPE_DISCOUNT ? `🚨 *${discount}% OFF* — PREÇO ABSURDO` : `🏷️ ${discount}% OFF`);
  }

  const provas = [];
  if (offer.rating) provas.push(`⭐ ${offer.rating.toFixed(1)}`);
  const social = offer.reviewCount ? `${offer.reviewCount} avaliações` : offer.soldLabel;
  if (social) provas.push(social);
  // So mostra frete quando ele e um ARGUMENTO de venda. "Enviado pelo FULL" e o
  // selo de logistica do Mercado Livre: nao diz nada a quem le no WhatsApp e
  // ainda ocupa a linha da prova social.
  if (offer.shipping?.toLowerCase().includes("gr")) provas.push("🚚 Frete grátis");
  if (provas.length) lines.push("", provas.join("  ·  "));

  const restam = minutesUntilExpiry(offer, now);
  if (restam !== null && restam > 0) {
    lines.push("", restam <= 120 ? `⏳ *CORRE, ACABA ÀS ${hour(offer.expiresAt)}*` : `⏳ Só até ${hour(offer.expiresAt)}`);
  }

  lines.push("", `👉 ${offer.affiliateUrl}`);
  return lines.join("\n");
}
