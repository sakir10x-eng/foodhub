/**
 * Money is ALWAYS an integer number of poisha (1 BDT = 100 poisha).
 * Never use floats for money anywhere in this codebase.
 */

export type Poisha = number;

const POISHA_PER_TAKA = 100;

export function taka(amount: number): Poisha {
  return Math.round(amount * POISHA_PER_TAKA);
}

export function toTaka(p: Poisha): number {
  return p / POISHA_PER_TAKA;
}

/** Assert a value is a safe integer amount of poisha. Throws otherwise. */
export function assertPoisha(p: unknown, label = 'amount'): asserts p is Poisha {
  if (typeof p !== 'number' || !Number.isSafeInteger(p)) {
    throw new Error(`${label} must be an integer number of poisha, got ${String(p)}`);
  }
}

/** Sum with overflow-ish safety; all inputs must be integers. */
export function sum(...amounts: Poisha[]): Poisha {
  let total = 0;
  for (const a of amounts) {
    assertPoisha(a);
    total += a;
  }
  return total;
}

/**
 * Apply a basis-point rate to an amount, rounding half-up to the nearest poisha.
 * 500 bps = 5%.
 */
export function applyBps(amount: Poisha, bps: number): Poisha {
  assertPoisha(amount);
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new Error(`basis points must be an integer in [0, 10000], got ${bps}`);
  }
  return Math.round((amount * bps) / 10_000);
}

const BDT_FORMAT = new Intl.NumberFormat('en-BD', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/** "৳1,250" / "৳1,250.50" — display only, never round-trip this back into logic. */
export function formatBDT(p: Poisha, opts: { symbol?: boolean } = {}): string {
  const { symbol = true } = opts;
  const value = toTaka(p);
  const body = BDT_FORMAT.format(value);
  return symbol ? `৳${body}` : body;
}

/** Split an amount into n parts whose sum is exactly the original (largest-remainder). */
export function splitEvenly(amount: Poisha, parts: number): Poisha[] {
  assertPoisha(amount);
  if (!Number.isInteger(parts) || parts <= 0) throw new Error('parts must be a positive integer');
  const base = Math.floor(amount / parts);
  const remainder = amount - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < remainder ? 1 : 0));
}
