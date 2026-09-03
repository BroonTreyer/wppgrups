import { discountPercentage } from "./offer.js";

export const DEFAULT_SWEET_SPOT = { min: 25, max: 200 };
export const SUSPICIOUS_DISCOUNT = 80;

const normalize = (text) => String(text ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

export const RISKY_KEYWORDS = [
  "testosterona", "testo ", "anabolizante", "sibutramina", "emagrecedor", "seca barriga",
  "afrodisiaco", "estimulante sexual", "viagra", "lubrificante intimo", "sex shop",
  "vape", "cigarro eletronico", "pod descartavel", "narguile",
  "replica", "primeira linha", "aaa premium",
  "arma", "municao", "soco ingles", "chave micha",
  "curso ", "ebook", "planilha digital", "acesso vitalicio"
];

const tokens = (text) => normalize(text).split(/[^a-z0-9]+/).filter(Boolean);
const singular = (token) => token.endsWith("s") ? token.slice(0, -1) : token;

export function matchesKeyword(text, words, keyword) {
  const target = normalize(keyword).trim();
  if (!target) return false;
  if (target.includes(" ")) return text.includes(target);
  return words.some((word) => word === target || singular(word) === target);
}

export function isRisky(offer, extra = []) {
  const haystack = normalize(offer.title);
  const words = tokens(haystack);
  return [...RISKY_KEYWORDS, ...extra].some((keyword) => matchesKeyword(haystack, words, keyword));
}

export function demandScore(soldCount) {
  if (!soldCount) return 0;
  return Math.min(35, Math.log10(soldCount) * 8.75);
}

export function reputationScore(rating) {
  if (!rating) return 0;
  if (rating < 4) return -10;
  return Math.min(20, (rating - 4) * 20);
}

export function discountScore(discount) {
  if (discount <= 0) return 0;
  if (discount > SUSPICIOUS_DISCOUNT) return Math.max(0, 25 - (discount - SUSPICIOUS_DISCOUNT));
  return Math.min(25, discount * 0.42);
}

export function priceScore(price, sweetSpot = DEFAULT_SWEET_SPOT) {
  const { min, max } = { ...DEFAULT_SWEET_SPOT, ...sweetSpot };
  if (price <= 0) return 0;
  if (price < min) return 10;
  if (price <= max) return 20;
  if (price <= max * 2) return 12;
  if (price <= max * 5) return 2;
  return -15;
}

export function scoreOffer(offer, options = {}) {
  const sweetSpot = options.sweetSpot ?? DEFAULT_SWEET_SPOT;
  const discount = discountPercentage(offer);
  const shipping = offer.shipping?.toLowerCase().includes("gr") ? 6 : 0;
  const pix = offer.paymentMethod ? 2 : 0;
  const total = demandScore(offer.soldCount)
    + reputationScore(offer.rating)
    + discountScore(discount)
    + priceScore(offer.currentPrice, sweetSpot)
    + shipping
    + pix
    - (isRisky(offer, options.riskyKeywords ?? []) ? 100 : 0);
  return Math.round(total);
}

export function scoreBreakdown(offer, options = {}) {
  const sweetSpot = options.sweetSpot ?? DEFAULT_SWEET_SPOT;
  return {
    demanda: Math.round(demandScore(offer.soldCount)),
    reputacao: Math.round(reputationScore(offer.rating)),
    desconto: Math.round(discountScore(discountPercentage(offer))),
    preco: priceScore(offer.currentPrice, sweetSpot),
    risco: isRisky(offer, options.riskyKeywords ?? []) ? -100 : 0,
    total: scoreOffer(offer, options)
  };
}
