import {
  distanceKm,
  matchZone,
  pointInPolygon,
  productSchema,
  requiresLocation,
  reviewSchema,
  zoneContains,
  zoneHasShape,
  type DeliveryZone,
  type GeoPoint,
} from '@foodhub/shared';

const DHAKA: GeoPoint = { lat: 23.7806, lng: 90.4074 };
const MIRPUR_10: GeoPoint = { lat: 23.8069, lng: 90.3687 };
const CHATTOGRAM: GeoPoint = { lat: 22.3569, lng: 91.7832 };

const zone = (over: Partial<DeliveryZone> = {}): DeliveryZone => ({
  id: 'z',
  label: 'Zone',
  fee: 6000,
  minOrder: 0,
  areas: [],
  ...over,
});

/**
 * How far a vendor delivers is a promise about money and about time, and it is enforced
 * in exactly one function. These tests are the specification of that function: a change
 * that quietly widens a delivery area shows up here as a failure, not as a rider on a
 * forty-minute round trip for a ৳60 fee.
 */
describe('delivery area geometry', () => {
  it('measures real-world distances', () => {
    // Mirpur 10 to the city centre is a few kilometres; Chattogram is a different city.
    expect(distanceKm(DHAKA, MIRPUR_10)).toBeGreaterThan(3);
    expect(distanceKm(DHAKA, MIRPUR_10)).toBeLessThan(6);
    expect(distanceKm(DHAKA, CHATTOGRAM)).toBeGreaterThan(200);
    expect(distanceKm(DHAKA, DHAKA)).toBeCloseTo(0);
  });

  it('holds a point inside a circle and refuses one outside it', () => {
    const circle = zone({ center: DHAKA, radiusKm: 5 });
    expect(zoneContains(circle, MIRPUR_10)).toBe(true);
    expect(zoneContains(circle, CHATTOGRAM)).toBe(false);
  });

  it('holds a point inside a drawn boundary', () => {
    const box: GeoPoint[] = [
      { lat: 23.75, lng: 90.38 },
      { lat: 23.75, lng: 90.44 },
      { lat: 23.82, lng: 90.44 },
      { lat: 23.82, lng: 90.38 },
    ];
    expect(pointInPolygon(DHAKA, box)).toBe(true);
    expect(pointInPolygon(CHATTOGRAM, box)).toBe(false);
    // Just outside the western edge — the kind of near miss a vendor draws deliberately.
    expect(pointInPolygon({ lat: 23.78, lng: 90.37 }, box)).toBe(false);
  });

  it('treats fewer than three points as no boundary at all', () => {
    expect(zoneHasShape(zone({ polygon: [DHAKA, MIRPUR_10] }))).toBe(false);
    expect(zoneHasShape(zone({ polygon: [DHAKA, MIRPUR_10, CHATTOGRAM] }))).toBe(true);
    expect(zoneHasShape(zone({ center: DHAKA, radiusKm: 0 }))).toBe(false);
    expect(zoneHasShape(zone())).toBe(false);
  });
});

describe('matchZone', () => {
  it('leaves a vendor with no drawn areas working exactly as before', () => {
    const zones = [zone({ id: 'all', fee: 12000 }), zone({ id: 'gulshan', fee: 6000, areas: ['Gulshan'] })];
    expect(matchZone(zones, { area: 'Gulshan' }).zone?.id).toBe('gulshan');
    // Unknown area falls back to the first zone, which is the documented catch-all.
    expect(matchZone(zones, { area: 'Nowhere' }).zone?.id).toBe('all');
    expect(matchZone(zones, { area: 'Nowhere' }).outsideServiceArea).toBe(false);
  });

  it('refuses a point outside every drawn area when there is no catch-all', () => {
    const zones = [zone({ id: 'near', center: DHAKA, radiusKm: 5 })];
    expect(matchZone(zones, { point: MIRPUR_10 }).zone?.id).toBe('near');

    const far = matchZone(zones, { point: CHATTOGRAM });
    expect(far.zone).toBeNull();
    expect(far.outsideServiceArea).toBe(true);
  });

  it('still takes the order when a shapeless zone exists to catch it', () => {
    const zones = [
      zone({ id: 'near', fee: 6000, center: DHAKA, radiusKm: 5 }),
      zone({ id: 'rest', fee: 12000 }),
    ];
    const far = matchZone(zones, { point: CHATTOGRAM, area: 'Anywhere' });
    expect(far.outsideServiceArea).toBe(false);
    expect(far.zone?.id).toBe('rest');
  });

  it('gives the customer the cheapest zone when drawn areas overlap', () => {
    // A vendor sets "2km ৳40" and "6km ৳90". Inside 2km both contain the point, and the
    // customer must not be charged for the vendor's own overlapping rings.
    const zones = [
      zone({ id: 'wide', fee: 9000, center: DHAKA, radiusKm: 6 }),
      zone({ id: 'close', fee: 4000, center: DHAKA, radiusKm: 2 }),
    ];
    expect(matchZone(zones, { point: { lat: 23.7825, lng: 90.409 } }).zone?.id).toBe('close');
  });

  it('prefers the drawn boundary over the area name', () => {
    // The dropdown says Gulshan; the pin says otherwise. The pin is the more specific
    // thing the customer told us, and it decides.
    const zones = [
      zone({ id: 'named', fee: 6000, areas: ['Gulshan'] }),
      zone({ id: 'drawn', fee: 3000, center: MIRPUR_10, radiusKm: 2 }),
    ];
    expect(matchZone(zones, { area: 'Gulshan', point: MIRPUR_10 }).zone?.id).toBe('drawn');
  });

  it('refuses a delivery with no pin when every zone is drawn', () => {
    const zones = [zone({ id: 'near', center: DHAKA, radiusKm: 5 })];
    // Nothing to test the address against, and no catch-all to fall into. Guessing here
    // would be the storefront quietly promising a delivery it cannot price.
    expect(matchZone(zones, { area: 'Gulshan' }).outsideServiceArea).toBe(true);
    expect(requiresLocation(zones)).toBe(true);
  });

  it('does not demand a pin from a vendor who kept a catch-all', () => {
    expect(requiresLocation([zone({ center: DHAKA, radiusKm: 5 }), zone({ id: 'rest' })])).toBe(false);
    expect(requiresLocation([zone()])).toBe(false);
  });

  it('has nothing to say about a vendor with no zones at all', () => {
    expect(matchZone([], { point: DHAKA })).toEqual({ zone: null, outsideServiceArea: false });
  });
});

/**
 * The two numbers a storefront is now allowed to print next to a dish. Both are refused
 * unless they are true — a struck-through price that was never charged and a rating with
 * nothing behind it are the same kind of lie.
 */
describe('menu claims', () => {
  it('refuses an old price that is not higher than the price being charged', () => {
    const base = { name: 'Kacchi', price: 45000 };
    expect(productSchema.safeParse({ ...base, compareAtPrice: 60000 }).success).toBe(true);
    expect(productSchema.safeParse({ ...base, compareAtPrice: 45000 }).success).toBe(false);
    expect(productSchema.safeParse({ ...base, compareAtPrice: 30000 }).success).toBe(false);
    // No claim at all is always fine.
    expect(productSchema.safeParse(base).success).toBe(true);
    expect(productSchema.safeParse({ ...base, compareAtPrice: null }).success).toBe(true);
  });

  it('accepts a rating with or without per-dish verdicts', () => {
    const base = { code: 'FH0001', phone: '01711000000', rating: 5 };
    expect(reviewSchema.safeParse(base).success).toBe(true);
    expect(
      reviewSchema.safeParse({
        ...base,
        dishes: [{ productId: '11111111-1111-4111-8111-111111111111', up: true }],
      }).success,
    ).toBe(true);
    // A vote has to name a real product id — the server checks it against the order too.
    expect(reviewSchema.safeParse({ ...base, dishes: [{ productId: 'nope', up: true }] }).success).toBe(false);
  });
});
