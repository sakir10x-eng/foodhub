import type { DeliveryZone, OfferDto } from '@foodhub/shared';

/**
 * The offers shown under the storefront banner.
 *
 * Every one is DERIVED from something the vendor already maintains — a live coupon row,
 * the loyalty settings, a zone whose fee is zero. Nothing here is free-text marketing
 * copy, which is the point: the strip physically cannot advertise a deal that checkout
 * would then refuse. A coupon that expires stops being an offer on the next menu read.
 */
export function buildOffers(tenant: any, coupons: any[]): OfferDto[] {
  const offers: OfferDto[] = [];

  for (const c of coupons) {
    // A fully-claimed code is dead weight on the banner — it only produces a rejection
    // at checkout, which reads as a broken store rather than a finished promotion.
    if (c.usageLimit !== null && c.usedCount >= c.usageLimit) continue;

    const value = c.percentOffBps
      ? `${c.percentOffBps / 100}% off`
      : `${taka(c.amountOff ?? 0)} off`;
    const conditions: string[] = [];
    if (c.minSubtotal > 0) conditions.push(`on orders over ${taka(c.minSubtotal)}`);
    if (c.maxDiscount !== null && c.percentOffBps) conditions.push(`up to ${taka(c.maxDiscount)}`);

    offers.push({
      id: `coupon:${c.id}`,
      kind: 'COUPON',
      title: value,
      subtitle: conditions.length ? conditions.join(', ') : `Use code ${c.code}`,
      code: c.code,
      expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
    });
    if (offers.length >= 3) break; // a wall of codes reads as noise, not value
  }

  const zones = (tenant.deliveryZones ?? []) as DeliveryZone[];
  const free = zones.filter((z) => z.fee === 0);
  if (free.length > 0) {
    offers.push({
      id: 'free-delivery',
      kind: 'FREE_DELIVERY',
      title: 'Free delivery',
      subtitle:
        free.length === zones.length
          ? 'Everywhere we deliver'
          : `In ${free.map((z) => z.label).join(', ')}`,
    });
  }

  if (tenant.loyaltyEnabled && tenant.pointsPerHundred > 0) {
    // Quoted as cash back rather than points, because "1 point per ৳100" tells a
    // customer nothing until they know what a point is worth.
    const backPerHundred = tenant.pointsPerHundred * tenant.pointValue;
    offers.push({
      id: 'loyalty',
      kind: 'LOYALTY',
      title: `${taka(backPerHundred)} back per ${taka(100_00)}`,
      subtitle: `Redeem from ${tenant.minRedeemPoints} points`,
    });
  }

  return offers;
}

function taka(poisha: number): string {
  const whole = poisha / 100;
  return `৳${Number.isInteger(whole) ? whole : whole.toFixed(2)}`;
}
