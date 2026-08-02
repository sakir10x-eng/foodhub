/**
 * Live rider tracking — the rules, in one place, because every one of them is about
 * somebody's privacy or somebody's trust rather than about geometry.
 */

/**
 * How old a position may be before we stop showing it.
 *
 * A frozen pin is worse than no pin: the customer believes it, watches it not move, and
 * concludes the rider is sitting still. Three minutes is roughly two missed updates on a
 * phone that is reporting every thirty seconds — long enough to survive a tunnel, short
 * enough that nobody is watching a ghost.
 */
export const RIDER_FIX_MAX_AGE_MS = 3 * 60_000;

/**
 * A fix this vague is not a location, it is a district.
 *
 * Phones indoors routinely report accuracies of several kilometres from a wifi lookup.
 * Drawing that as a precise dot on a map is a lie with a decimal point on it.
 */
export const RIDER_FIX_MAX_ACCURACY_M = 500;

/**
 * How often the rider's phone reports in while the run sheet is open. Thirty seconds is
 * the point where the dot still feels live and the battery survives a shift.
 */
export const RIDER_REPORT_INTERVAL_MS = 30_000;

/**
 * Whether a customer may see the rider at all.
 *
 * ON_THE_WAY only — deliberately not READY. A rider marked READY is still at the counter
 * or, more often, finishing somebody else's delivery, and showing their position then
 * broadcasts a different customer's address to this one. The window opens when the food
 * is genuinely on its way here and shuts the moment it arrives.
 */
export function riderVisibleFor(status: string): boolean {
  return status === 'ON_THE_WAY';
}

/** A position is showable only if it is recent enough to still be true. */
export function isFixFresh(locationAt: Date | string | null | undefined, now = Date.now()): boolean {
  if (!locationAt) return false;
  const at = locationAt instanceof Date ? locationAt.getTime() : Date.parse(locationAt);
  return Number.isFinite(at) && now - at <= RIDER_FIX_MAX_AGE_MS;
}

/** What the customer's tracker is told about the rider. Never more than this. */
export interface RiderPin {
  name: string;
  /** So the customer can call about a locked gate rather than waiting and hoping. */
  phone: string;
  lat: number | null;
  lng: number | null;
  /** ISO. Absent when the last fix has gone stale. */
  locationAt: string | null;
  /**
   * How many stops the rider has before this one, on a batched run. 0 = coming here next,
   * null = not on a run at all.
   *
   * This is what a customer gets instead of a map while it is somebody else's turn — a
   * truthful, useful number in place of a dot parked outside a stranger's house. See
   * `riderCoordsVisible` in trip.ts.
   */
  stopsAhead?: number | null;
}
