export function validateOffer(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Oferta invalida");
  const required = ["externalId", "marketplace", "title", "currentPrice", "affiliateUrl", "imageUrl"];
  const missing = required.filter((field) => input[field] === undefined || input[field] === "");
  if (missing.length) throw new Error(`Oferta invalida. Campos ausentes: ${missing.join(", ")}`);
  const currentPrice = Number(input.currentPrice);
  const originalPrice = input.originalPrice ? Number(input.originalPrice) : null;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) throw new Error("currentPrice deve ser maior que zero");
  if (originalPrice !== null && (!Number.isFinite(originalPrice) || originalPrice < currentPrice)) throw new Error("originalPrice deve ser igual ou maior que currentPrice");
  const rating = input.rating === undefined || input.rating === null || input.rating === "" ? null : Number(input.rating);
  const reviewCount = input.reviewCount === undefined || input.reviewCount === null || input.reviewCount === "" ? null : Number(input.reviewCount);
  if (rating !== null && (!Number.isFinite(rating) || rating < 0 || rating > 5)) throw new Error("rating deve estar entre 0 e 5");
  if (reviewCount !== null && (!Number.isInteger(reviewCount) || reviewCount < 0)) throw new Error("reviewCount deve ser um inteiro maior ou igual a zero");
  for (const field of ["affiliateUrl", "imageUrl"]) {
    let url;
    try { url = new URL(String(input[field])); } catch { throw new Error(`${field} deve ser uma URL valida`); }
    if (!["http:", "https:"].includes(url.protocol)) throw new Error(`${field} deve usar http ou https`);
  }
  return { ...input, externalId: String(input.externalId), marketplace: String(input.marketplace).trim(), title: String(input.title).trim(), currentPrice, originalPrice, rating, reviewCount, capturedAt: input.capturedAt ?? new Date().toISOString() };
}

export function discountPercentage(offer) {
  return !offer.originalPrice || offer.originalPrice <= offer.currentPrice ? 0 : Math.round((1 - offer.currentPrice / offer.originalPrice) * 100);
}

export const offerFingerprint = (offer) => `${offer.marketplace}:${offer.externalId}:${offer.currentPrice.toFixed(2)}`;
