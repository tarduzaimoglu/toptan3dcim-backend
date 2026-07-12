/**
 * pricing service
 *
 * Kademeli adet indirimi mantığı. frontend/lib/pricing.ts ile birebir aynı
 * kademe tablosunu kullanır - herhangi bir değişiklik iki tarafta da
 * eşzamanlı yapılmalıdır.
 */

function discountPerUnitTRY(qty: number): number {
  if (!Number.isFinite(qty) || qty <= 0) return 0;

  if (qty >= 2000) return 3.0;
  if (qty >= 1500) return 1.5;
  if (qty >= 1000) return 0.75;
  if (qty >= 500) return 0.5;

  return 0;
}

function effectiveUnitPriceTRY(basePrice: number, qty: number): number {
  const d = discountPerUnitTRY(qty);
  const p = basePrice - d;
  return Math.max(p, 0);
}

export default {
  discountPerUnitTRY,
  effectiveUnitPriceTRY,
};
