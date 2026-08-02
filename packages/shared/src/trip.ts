import { distanceKm, type GeoPoint } from './pricing';

export type StopKind = 'PICKUP' | 'DROP';

/** One place the rider has to be, before it has been given a position in the run. */
export interface PlannedStop {
  orderId: string;
  kind: StopKind;
  /** Which shop, for a pickup. */
  tenantId?: string | null;
  /** The shop for a pickup, the customer's pin for a drop. Absent far more often than not. */
  point?: GeoPoint | null;
  /** Tiebreaker, and the only ordering available when there are no coordinates at all. */
  placedAt: number;
}

/**
 * Put a rider's stops in the order they should be visited.
 *
 * **Every pickup comes before every drop**, and that is a rule rather than a heuristic.
 * It is the one arrangement that cannot be wrong: you cannot deliver a parcel you have not
 * collected, and a rider reading a list on a motorcycle cannot hold an interleaved plan in
 * their head. It costs distance in the case where a second shop sits past several houses —
 * a real cost, accepted, because the alternative is a plan that is occasionally clever and
 * occasionally impossible.
 *
 * Within each half, coordinates are used when they exist and ignored honestly when they do
 * not. Straight-line distance only: **we do not compute a road route**, and presenting one
 * we never calculated as "the way" would be a guess wearing the clothes of a plan. The
 * rider knows the roads; they can drag the list around.
 *
 * Stops with no coordinates are not shuffled into a geometric order they cannot support.
 * They keep their arrival order and go last in their half, where the rider can plan them
 * with the local knowledge we do not have.
 */
export function planStops(stops: PlannedStop[], from?: GeoPoint | null): PlannedStop[] {
  const pickups = stops.filter((s) => s.kind === 'PICKUP');
  const drops = stops.filter((s) => s.kind === 'DROP');

  // Pickups are grouped by shop first: two parcels from one counter are one visit, and
  // splitting them would send the rider back to a door they were just standing at.
  const byShop = new Map<string, PlannedStop[]>();
  for (const stop of pickups) {
    const key = stop.tenantId ?? stop.orderId;
    if (!byShop.has(key)) byShop.set(key, []);
    byShop.get(key)!.push(stop);
  }
  const shopGroups = [...byShop.values()].map((group) =>
    [...group].sort((a, b) => a.placedAt - b.placedAt),
  );

  const orderedShops = nearestFirst(
    shopGroups,
    (group) => group[0].point ?? null,
    (group) => group[0].placedAt,
    from ?? null,
  );
  const orderedPickups = orderedShops.flat();

  // Drops start from wherever the last pickup left the rider, which is a better guess than
  // starting from where they were before the run began.
  const lastPickupPoint = [...orderedPickups].reverse().find((s) => s.point)?.point ?? from ?? null;
  const orderedDrops = nearestFirst(
    drops,
    (stop) => stop.point ?? null,
    (stop) => stop.placedAt,
    lastPickupPoint,
  );

  return [...orderedPickups, ...orderedDrops];
}

/**
 * Nearest-neighbour over the items that have a position; the rest keep their own order and
 * follow. Deliberately not a travelling-salesman solver — with five stops the difference
 * is a few hundred metres, and with a rider who can reorder the list it is nothing at all.
 */
function nearestFirst<T>(
  items: T[],
  pointOf: (item: T) => GeoPoint | null,
  timeOf: (item: T) => number,
  from: GeoPoint | null,
): T[] {
  const placed = items.filter((i) => pointOf(i));
  const unplaced = items.filter((i) => !pointOf(i)).sort((a, b) => timeOf(a) - timeOf(b));

  if (!from || placed.length === 0) {
    return [...placed.sort((a, b) => timeOf(a) - timeOf(b)), ...unplaced];
  }

  const remaining = [...placed];
  const route: T[] = [];
  let cursor = from;

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestDistance = Infinity;
    remaining.forEach((item, index) => {
      const d = distanceKm(cursor, pointOf(item)!);
      if (d < bestDistance) {
        bestDistance = d;
        bestIndex = index;
      }
    });
    const [next] = remaining.splice(bestIndex, 1);
    route.push(next);
    cursor = pointOf(next)!;
  }

  return [...route, ...unplaced];
}

/**
 * Where a customer's delivery sits in the rider's run.
 *
 * `stopsAhead` counts the stops the rider must finish first, so 0 means "coming to you
 * now". It is what the customer sees instead of a map while they wait their turn.
 */
export interface TripPosition {
  stopsAhead: number;
  isActiveStop: boolean;
}

/**
 * Whether this customer may see where the rider actually is.
 *
 * The old rule — visible once the order is ON_THE_WAY — was written when a rider carried
 * one order at a time, and it excluded READY for a specific reason: a rider marked ready is
 * usually standing at **somebody else's door**, and drawing them on a map broadcasts that
 * other customer's address.
 *
 * Batching brings that exact problem back inside ON_THE_WAY. A rider carrying three
 * parcels is at the first customer's gate while the second and third watch a dot sit
 * outside a stranger's house. So the window narrows again, to the same principle: the
 * position is shown only while the rider is actually coming **here**.
 *
 * An order with no trip is not part of a batch and cannot expose anyone, so it keeps the
 * old behaviour untouched.
 */
export function riderCoordsVisible(status: string, position: TripPosition | null): boolean {
  if (status !== 'ON_THE_WAY') return false;
  if (!position) return true;
  return position.isActiveStop;
}
