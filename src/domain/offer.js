export function validateOffer(input) {
  const required = ["externalId", "marketplace", "title", "currentPrice", "affiliateUrl", "imageUrl"];
  const missing = required.filter((field) => input[field] === undefined || input[field] === "");
  if (missing.length) throw new Error(`Oferta invalida. Campos ausentes: ${missing.join(", ")}`);
  const currentPrice = Number(input.currentPrice);
  const originalPrice = input.originalPrice ? Number(input.originalPrice) : null;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) throw new Error("currentPrice deve ser maior que zero");
  if (originalPrice !== null && (!Number.isFinite(originalPrice) || originalPrice < currentPrice)) throw new Error("originalPrice deve ser igual ou maior que currentPrice");
  return { ...input, currentPrice, originalPrice, rating: input.rating ? Number(input.rating) : null, reviewCount: input.reviewCount ? Number(input.reviewCount) : null, capturedAt: input.capturedAt ?? new Date().toISOString() };
}

export function discountPercentage(offer) {
  return !offer.originalPrice || offer.originalPrice <= offer.currentPrice ? 0 : Math.round((1 - offer.currentPrice / offer.originalPrice) * 100);
}

export const offerFingerprint = (offer) => `${offer.marketplace}:${offer.externalId}:${offer.currentPrice.toFixed(2)}`;
