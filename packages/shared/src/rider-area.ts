import { distanceKm, pointInPolygon, type GeoPoint } from './pricing';

/**
 * Where a rider will go.
 *
 * Deliberately the same three ways of describing a place that a `DeliveryZone` already
 * uses — a drawn polygon, a circle, or plain area names — because a village rider's patch
 * and a shop's delivery area are the same kind of statement about the same map, and the
 * geometry underneath is shared rather than reimplemented.
 */
export interface GeoShape {
  /**
   * Free-text area names, matched case-insensitively.
   *
   * This is not a lesser option here, it is the one that will carry most of the weight.
   * Half of a village's customers will never drop a pin, and "চর কাদিরপুর" typed into an
   * address field is the only thing we will know about where they live.
   */
  areas?: string[];
  center?: GeoPoint | null;
  radiusKm?: number | null;
  polygon?: GeoPoint[] | null;
}

/** Whether this shape can answer a question about coordinates at all. */
export function shapeHasGeometry(shape: GeoShape): boolean {
  return (shape.polygon?.length ?? 0) >= 3 || (!!shape.center && (shape.radiusKm ?? 0) > 0);
}

/** Whether a point falls inside the drawn part of the shape. */
export function shapeContainsPoint(shape: GeoShape, point: GeoPoint): boolean {
  if (shape.polygon && shape.polygon.length >= 3) return pointInPolygon(point, shape.polygon);
  if (shape.center && (shape.radiusKm ?? 0) > 0) return distanceKm(shape.center, point) <= shape.radiusKm!;
  return false;
}

/** Whether a written area name is one this shape claims. Case- and space-insensitive. */
export function shapeCoversArea(shape: GeoShape, area: string): boolean {
  const wanted = area.trim().toLowerCase();
  if (!wanted) return false;
  return (shape.areas ?? []).some((name) => name.trim().toLowerCase() === wanted);
}

/** What we know about where a delivery is going. Both parts are frequently missing. */
export interface DeliveryTarget {
  point?: GeoPoint | null;
  area?: string | null;
}

/**
 * Whether a delivery belongs to this rider's patch.
 *
 * The order of the rules is the whole design, and it is built around one refusal: **we
 * never guess**. A delivery shown to the wrong rider is a wasted trip in a place where the
 * next village is eight kilometres away, and an offer that turns out not to be theirs
 * teaches a rider to stop trusting the list.
 *
 *   1. A pin inside a drawn boundary is the strongest evidence there is, so it decides.
 *   2. With no pin — the common case — the written area name is matched instead.
 *   3. A pin that falls outside every drawn boundary still gets the name check, because a
 *      rider who wrote down "বাজার" and never drew anything means it.
 *   4. If nothing above can answer, this is **false**, and the order stays with the shop
 *      to hand out by hand. Silence is the correct output for "we do not know".
 */
export function riderCoversDelivery(areas: GeoShape[], target: DeliveryTarget): boolean {
  if (areas.length === 0) return false;

  if (target.point) {
    const drawn = areas.filter(shapeHasGeometry);
    if (drawn.some((shape) => shapeContainsPoint(shape, target.point!))) return true;
  }

  if (target.area) {
    return areas.some((shape) => shapeCoversArea(shape, target.area!));
  }

  return false;
}

/**
 * Why an order is not on anybody's list.
 *
 * A shop watching an order sit unclaimed needs to know which of two things is happening,
 * because the fix is different: nobody is on duty near it, or nothing about the address
 * can be matched to a patch at all. The second is a data problem the shop can fix by
 * typing an area name; the first is a staffing problem.
 */
export function isAddressMatchable(target: DeliveryTarget): boolean {
  return Boolean(target.point || (target.area && target.area.trim()));
}
