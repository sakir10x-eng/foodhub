/**
 * Proof that a parcel reached the person it was for.
 *
 * A four-digit code the customer holds and the rider asks for at the door. Cheap on
 * purpose: no photograph to upload on a village signal, no signature to capture on a
 * cracked screen, no data cost. The whole mechanism is a number said out loud.
 */

/**
 * Four digits, not six.
 *
 * The code guards a doorstep, not a bank account, and a rider standing in the sun reading
 * it back from a customer holding a phone at arm's length will get six wrong often enough
 * to make the feature hated. Brute force is handled by counting attempts, not by length —
 * see `DELIVERY_OTP_MAX_ATTEMPTS`, which is what actually makes guessing useless.
 */
export const DELIVERY_OTP_LENGTH = 4;

/**
 * How many wrong codes before the rider has to stop and call the shop.
 *
 * Three is enough for a misheard digit and far too few to guess one number in ten
 * thousand. Locking is not a punishment: the shop can still release the delivery, and the
 * rider is told to ring them rather than left standing at a door with no way forward.
 */
export const DELIVERY_OTP_MAX_ATTEMPTS = 3;

/** Generate a code. Zero-padded, so "0042" is a real code and not silently "42". */
export function makeDeliveryOtp(random: () => number = Math.random): string {
  const max = 10 ** DELIVERY_OTP_LENGTH;
  return String(Math.floor(random() * max)).padStart(DELIVERY_OTP_LENGTH, '0');
}

/** Compare what the rider typed with what we issued. Tolerant of spaces, nothing else. */
export function deliveryOtpMatches(expected: string | null | undefined, given: string): boolean {
  if (!expected) return false;
  return expected === given.replace(/\s/g, '');
}

/** Why a delivery did not happen. */
export const AttemptFailReason = {
  /** Knocked, rang, called. Nobody there. The commonest by a distance. */
  NO_ANSWER: 'NO_ANSWER',
  WRONG_ADDRESS: 'WRONG_ADDRESS',
  /** They were there and did not want it. */
  REFUSED: 'REFUSED',
  /** Cash on delivery, and the money is not in the house. */
  NO_CASH: 'NO_CASH',
  OTHER: 'OTHER',
} as const;
export type AttemptFailReason = (typeof AttemptFailReason)[keyof typeof AttemptFailReason];

export const ATTEMPT_FAIL_LABEL: Record<AttemptFailReason, string> = {
  NO_ANSWER: 'Nobody answered',
  WRONG_ADDRESS: 'Address is wrong',
  REFUSED: 'Customer refused it',
  NO_CASH: 'Customer had no cash',
  OTHER: 'Something else',
};
