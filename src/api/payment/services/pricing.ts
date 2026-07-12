/**
 * pricing service
 *
 * Kademeli adet indirimi ve kargo ücreti mantığı. frontend/lib/pricing.ts ile
 * birebir aynı kademe tablosunu ve kargo eşiğini kullanır - herhangi bir
 * değişiklik iki tarafta da eşzamanlı yapılmalıdır.
 */

// Kargo: sepet toplamı (indirimli, KDV dahil) bu eşiğin üzerindeyse (dahil)
// ücretsiz, altındaysa sabit ücret uygulanır. frontend/lib/pricing.ts
// FREE_SHIPPING_THRESHOLD/SHIPPING_FEE (TRY) ile aynı değerler, kuruş cinsinden.
const FREE_SHIPPING_THRESHOLD_KURUS = 150_000; // 1500 TL
const SHIPPING_FEE_KURUS = 20_000; // 200 TL

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

function shippingFeeForKurus(subtotalKurus: number): number {
  return subtotalKurus >= FREE_SHIPPING_THRESHOLD_KURUS ? 0 : SHIPPING_FEE_KURUS;
}

export default {
  discountPerUnitTRY,
  effectiveUnitPriceTRY,
  shippingFeeForKurus,
};
