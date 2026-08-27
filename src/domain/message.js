import { discountPercentage } from "./offer.js";
const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export function formatOfferCaption(offer, now = new Date()) {
  const discount = discountPercentage(offer);
  const lines = ["🔥 *OFERTA ENCONTRADA*", "", `*${offer.title}*`, ""];
  if (offer.originalPrice) lines.push(`De ~${money.format(offer.originalPrice)}~`);
  lines.push(`Por *${money.format(offer.currentPrice)}*${offer.paymentMethod ? ` ${offer.paymentMethod}` : ""}`);
  if (discount) lines.push(`📉 ${discount}% de desconto`);
  if (offer.rating) lines.push(`⭐ ${offer.rating.toFixed(1)}/5${offer.reviewCount ? ` — ${offer.reviewCount} avaliacoes` : ""}`);
  if (offer.shipping) lines.push(`🚚 ${offer.shipping}`);
  lines.push("", `🛒 *Comprar:* ${offer.affiliateUrl}`, "", `🏪 ${offer.marketplace}`);
  lines.push(`⏰ Preco verificado as ${now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" })} e sujeito a alteracao.`);
  lines.push("_Podemos receber comissao por compras realizadas pelo link._");
  return lines.join("\n");
}
