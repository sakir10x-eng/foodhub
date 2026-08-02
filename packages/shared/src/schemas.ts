import { z } from 'zod';
import { MAX_QTY_PER_LINE } from './pricing';

/** BD mobile numbers, normalised to 01XXXXXXXXX (11 digits). */
export const bdPhone = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .transform((v) => (v.startsWith('+880') ? '0' + v.slice(4) : v.startsWith('880') ? '0' + v.slice(3) : v))
  .refine((v) => /^01[3-9]\d{8}$/.test(v), 'Enter a valid Bangladeshi mobile number');

export const password = z.string().min(8, 'At least 8 characters').max(200);

export const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Letters, numbers and hyphens only');

export const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/, 'Enter a valid domain');

/* ------------------------------------------------------------------ auth */

export const registerVendorSchema = z.object({
  businessName: z.string().trim().min(2).max(80),
  slug,
  ownerName: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email(),
  phone: bdPhone,
  password,
});
export type RegisterVendorInput = z.infer<typeof registerVendorSchema>;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({ refreshToken: z.string().min(10) });

/* --------------------------------------------------------------- catalog */

export const categorySchema = z.object({
  name: z.string().trim().min(1).max(60),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

const productBaseSchema = z.object({
  categoryId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional().default(''),
  /** Poisha. Integer only. */
  price: z.number().int().min(0).max(100_000_00),
  /**
   * Poisha. The "was" price shown struck through. Refused unless it is genuinely higher
   * than the price being charged — a storefront advertising a saving of ৳0, or a negative
   * one, is worse than no badge at all.
   */
  compareAtPrice: z.number().int().min(0).max(100_000_00).nullable().optional(),
  imageId: z.string().uuid().nullable().optional(),
  isAvailable: z.boolean().optional().default(true),
  listedOnMarketplace: z.boolean().optional().default(true),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  /**
   * Grams. 0 means "not weighed", which is the honest default for cooked food and the
   * reason a grocer's unweighed catalogue does not become undeliverable overnight.
   */
  weightGrams: z.number().int().min(0).max(200_000).optional(),
});

/**
 * A "was" price only means something if it is higher than the price being charged.
 *
 * Applied to the full create shape and to the partial patch shape separately, because a
 * refinement cannot be `.partial()`ed. On a patch either half may be absent, in which
 * case there is nothing to compare and nothing to complain about — the service reads the
 * stored price for the other half.
 */
const compareAtMustBeHigher = (
  v: { price?: number; compareAtPrice?: number | null },
  ctx: z.RefinementCtx,
) => {
  if (v.compareAtPrice != null && v.price != null && v.compareAtPrice <= v.price) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['compareAtPrice'],
      message: 'The old price has to be higher than the price you are charging',
    });
  }
};

export const productSchema = productBaseSchema.superRefine(compareAtMustBeHigher);
export const productPatchSchema = productBaseSchema.partial().superRefine(compareAtMustBeHigher);
export type ProductInput = z.infer<typeof productSchema>;

/* -------------------------------------------------------------- checkout */

export const cartItemSchema = z.object({
  productId: z.string().uuid(),
  qty: z.number().int().min(1).max(MAX_QTY_PER_LINE),
  /**
   * Chosen modifier option IDs. Only IDs cross the wire — never names or prices. The
   * server looks each one up, confirms it belongs to this product, and reads the price
   * from the database, so a crafted request cannot invent a ৳0 "large".
   */
  optionIds: z.array(z.string().uuid()).max(20).optional(),
  /** Set when the line is a bundle rather than a single product. */
  comboId: z.string().uuid().optional(),
});

/* ------------------------------------------------------------- modifiers */

export const modifierOptionSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(60),
  /** Poisha added to the line. Never negative — discounts belong in coupons. */
  priceDelta: z.number().int().min(0).max(100_000_00),
  isAvailable: z.boolean().optional().default(true),
  sortOrder: z.number().int().min(0).max(999).optional(),
});

export const modifierGroupSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(60),
    minSelect: z.number().int().min(0).max(20).default(0),
    maxSelect: z.number().int().min(1).max(20).default(1),
    sortOrder: z.number().int().min(0).max(999).optional(),
    options: z.array(modifierOptionSchema).min(1).max(30),
  })
  .refine((g) => g.maxSelect >= g.minSelect, {
    message: 'Maximum choices cannot be fewer than the minimum',
    path: ['maxSelect'],
  })
  .refine((g) => g.minSelect <= g.options.length, {
    // A group demanding three choices from two options can never be satisfied, and the
    // customer would simply be unable to add the item to their cart.
    message: 'Not enough options to satisfy the minimum',
    path: ['minSelect'],
  });

export type ModifierGroupInput = z.infer<typeof modifierGroupSchema>;

export const comboSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().default(''),
  price: z.number().int().min(0).max(100_000_00),
  imageId: z.string().uuid().nullable().optional(),
  isAvailable: z.boolean().optional().default(true),
  listedOnMarketplace: z.boolean().optional().default(true),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  items: z
    .array(z.object({ productId: z.string().uuid(), qty: z.number().int().min(1).max(20) }))
    .min(2, 'A combo needs at least two items')
    .max(20),
});
export type ComboInput = z.infer<typeof comboSchema>;

export const deliveryAddressSchema = z.object({
  name: z.string().trim().min(2).max(80),
  phone: bdPhone,
  /**
   * Optional at this level and required by checkout only for DELIVERY orders — see the
   * superRefine below. Someone walking to the counter has no street to give, and making
   * them invent one puts a fictional address on a real invoice.
   */
  addressLine: z.string().trim().max(300).optional().default(''),
  area: z.string().trim().max(80).optional().default(''),
  /**
   * "Beside the Eidgah field, blue gate."
   *
   * In a village this is the address. Houses have no numbers and roads have no names, and
   * a rider finds a door by what is next to it. Kept separate from `addressLine` so the
   * run sheet can show it as prominently as the street, which is where it belongs.
   */
  landmark: z.string().trim().max(200).optional().default(''),
  /**
   * Ring before arriving. Common enough to be worth a checkbox: gates are locked, the
   * house is behind a field, or somebody has to come out to the road to meet the rider.
   */
  callBefore: z.boolean().optional().default(false),
  city: z.string().trim().max(80).optional().default('Dhaka'),
  note: z.string().trim().max(300).optional().default(''),
  /**
   * Where the pin was dropped. Optional because a vendor who has not drawn a delivery
   * area does not need one — but for a vendor who has, checkout refuses the order without
   * it, because there is no honest way to price a delivery to an unknown place.
   */
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
});
export type DeliveryAddress = z.infer<typeof deliveryAddressSchema>;

const checkoutBase = z.object({
  /** Which vendor is fulfilling. On a storefront this is implied by the Host header. */
  tenantId: z.string().uuid().optional(),
  items: z.array(cartItemSchema).min(1).max(50),
  /**
   * Delivery or collection. On PICKUP the server charges no delivery fee and ignores the
   * address entirely — which is why the address fields stay optional-ish below rather
   * than forcing a customer collecting an order to invent a street.
   */
  fulfillment: z.enum(['DELIVERY', 'PICKUP']).optional().default('DELIVERY'),
  /** ISO instant the customer wants it for. Omitted means as soon as possible. */
  scheduledFor: z.string().datetime().optional(),
  address: deliveryAddressSchema,
  paymentMethod: z.enum(['COD', 'SSLCOMMERZ', 'BKASH', 'NAGAD']),
  couponCode: z.string().trim().max(40).optional(),
  /** Loyalty points to spend on this order. The server re-checks the balance. */
  redeemPoints: z.number().int().min(0).max(1_000_000).optional(),
  /** Apply available store credit. */
  useWallet: z.boolean().optional(),
});

/**
 * A rider needs somewhere to go; a customer collecting does not. The requirement lives
 * here rather than on the address shape so both channels' schemas can apply it — a
 * `superRefine` result cannot be `.extend()`ed, which is why the base object is separate.
 */
export const requireAddressForDelivery = (
  v: { fulfillment?: string; address: { addressLine?: string } },
  ctx: z.RefinementCtx,
) => {
  if (v.fulfillment !== 'PICKUP' && (v.address.addressLine ?? '').trim().length < 5) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['address', 'addressLine'],
      message: 'Enter the delivery address',
    });
  }
};

export const checkoutSchema = checkoutBase.superRefine(requireAddressForDelivery);
export const marketplaceCheckoutSchema = checkoutBase
  .extend({ tenantId: z.string().uuid({ message: 'Pick a restaurant first' }) })
  .superRefine(requireAddressForDelivery);

export type CheckoutInput = z.infer<typeof checkoutSchema>;

/** A customer rating one delivered order. Authorised by order code + the phone on it. */
export const reviewSchema = z.object({
  code: z.string().trim().min(3).max(20),
  phone: bdPhone,
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(500).optional().default(''),
  /**
   * A verdict per dish, alongside the verdict on the evening.
   *
   * Optional: someone who only wants to give the order four stars should not be blocked
   * on grading six items. Every id is checked against the order's own lines server-side,
   * so this cannot be used to vote on food the customer never bought.
   */
  dishes: z
    .array(z.object({ productId: z.string().uuid(), up: z.boolean() }))
    .max(50)
    .optional(),
});
export type ReviewInput = z.infer<typeof reviewSchema>;

/* ---------------------------------------------------------------- orders */

export const orderStatusUpdateSchema = z.object({
  status: z.enum([
    'PENDING',
    'CONFIRMED',
    'PREPARING',
    'READY',
    'ON_THE_WAY',
    'DELIVERED',
    'RETURNED',
    'CANCELLED',
    'REFUNDED',
  ]),
  note: z.string().trim().max(300).optional(),
});

/**
 * A customer calling off their own order.
 *
 * Authorised exactly like guest tracking — order code plus the phone it was placed with
 * — so it works for someone who never made an account, which is most of them. A reason
 * is asked for but not required: a cancel button that interrogates you gets abandoned,
 * and the vendor learns more from the ones people do answer.
 */
export const orderCancelSchema = z.object({
  code: z.string().trim().min(3).max(20),
  phone: bdPhone,
  reason: z.string().trim().max(300).optional(),
});
export type OrderCancelInput = z.infer<typeof orderCancelSchema>;

/**
 * A rider reporting where they are.
 *
 * The token is the rider's own run-sheet token — the same credential that lets them see
 * their deliveries — so a position can only ever be filed against the rider it belongs to.
 * `accuracy` is accepted and stored nowhere: it is used to throw away the wild fixes a
 * phone emits indoors before they ever reach a customer's screen.
 */
export const riderLocationSchema = z.object({
  token: z.string().trim().min(8).max(80),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  /** Metres of uncertainty, straight from the browser's Geolocation API. */
  accuracy: z.number().min(0).max(100_000).optional(),
});
export type RiderLocationInput = z.infer<typeof riderLocationSchema>;

/* --------------------------------------------------------------- tenants */

export const geoPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const deliveryZoneSchema = z.object({
  id: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(60),
  fee: z.number().int().min(0).max(500_00),
  minOrder: z.number().int().min(0).max(100_000_00).default(0),
  areas: z.array(z.string().trim().max(80)).max(200).default([]),
  /**
   * How far the rider goes, as the vendor drew it. A circle covers "3km around the shop";
   * a polygon covers the cases a circle gets wrong — a river, a flyover, one side of a
   * road. 50km is the cap because past that a vendor is describing a courier, not a
   * delivery, and an accidental extra digit should not silently promise the whole country.
   */
  center: geoPointSchema.nullable().optional(),
  radiusKm: z.number().min(0.2).max(50).nullable().optional(),
  polygon: z.array(geoPointSchema).max(200).nullable().optional(),
});

export const tenantSettingsSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  tagline: z.string().trim().max(160).optional(),
  logoId: z.string().uuid().nullable().optional(),
  coverId: z.string().uuid().nullable().optional(),
  brandColor: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  phone: bdPhone.optional(),
  address: z.string().trim().max(300).optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  isOpen: z.boolean().optional(),
  listedOnMarketplace: z.boolean().optional(),
  prepMinutes: z.number().int().min(1).max(240).optional(),
  /** The rider leg, used for the quoted arrival window when no pin has been dropped. */
  deliveryMinutes: z.number().int().min(1).max(240).optional(),
  /**
   * Marketplace filter chips. Capped at six because a restaurant that claims eight
   * cuisines matches every filter and therefore describes nothing.
   */
  cuisines: z.array(z.string().trim().min(2).max(30)).max(6).optional(),
  deliveryZones: z.array(deliveryZoneSchema).max(50).optional(),

  /** Orders placed for a later time. */
  schedulingEnabled: z.boolean().optional(),
  schedulingMaxDays: z.number().int().min(1).max(30).optional(),

  /** The vendor's own ad pixels. Format-checked so a pasted URL cannot silently do nothing. */
  metaPixelId: z.string().trim().regex(/^\d{0,20}$/, 'A Meta pixel ID is digits only').optional(),
  tiktokPixelId: z.string().trim().max(40).optional(),
  ga4MeasurementId: z.string().trim().regex(/^(G-[A-Z0-9]{4,}|)$/, 'A GA4 ID looks like G-XXXXXXX').optional(),

  /** Double-sided invite rewards. */
  referralEnabled: z.boolean().optional(),
  referrerReward: z.number().int().min(0).max(10_000_00).optional(),
  refereeReward: z.number().int().min(0).max(10_000_00).optional(),
  referralMinSpend: z.number().int().min(0).max(100_000_00).optional(),

  /** Collection from the counter. */
  pickupEnabled: z.boolean().optional(),
  pickupMinutes: z.number().int().min(1).max(240).optional(),

  /** Loyalty programme (Phase 4). Funded by the vendor, so only they can change it. */
  loyaltyEnabled: z.boolean().optional(),
  pointsPerHundred: z.number().int().min(0).max(100).optional(),
  /** Poisha per point. Capped so a typo can't make points worth ৳1,000 each. */
  pointValue: z.number().int().min(1).max(10_000).optional(),
  minRedeemPoints: z.number().int().min(1).max(100_000).optional(),

  /**
   * Payment policy. Guards against hoax cash-on-delivery orders: the vendor can demand
   * money before the kitchen starts. `advancePercent` is deliberately a fixed set — a
   * free-form percentage invites 7% and 33% orders that are impossible to explain to a
   * customer, and 50/100 is what the vendors actually asked for.
   */
  codEnabled: z.boolean().optional(),
  /**
   * Ask for the customer's code at the door before a delivery may be marked done.
   *
   * Off by default. Switching it on for every shop at once would stop deliveries wherever
   * customers have not seen the code, so this is opt-in per vendor — and the code appears
   * on the customer's own tracker as well as by SMS, so it works where SMS does not.
   */
  deliveryOtpRequired: z.boolean().optional(),
  advancePercent: z
    .union([z.literal(0), z.literal(50), z.literal(100)])
    .optional(),
  advanceThreshold: z.number().int().min(0).max(1_000_000_00).optional(),

  /** AI ordering assistant (Phase 4). */
  aiAssistantEnabled: z.boolean().optional(),
  aiPersona: z.string().trim().max(2000).optional(),
})
  .refine(
    // A vendor who turns COD off but demands no advance has closed every door: no online
    // prepayment is required and no cash is accepted, so nothing can be ordered. Reject it
    // here rather than let them discover it from an empty order list.
    (v) => !(v.codEnabled === false && v.advancePercent === 0),
    {
      message: 'Turn on an advance payment before switching cash on delivery off',
      path: ['codEnabled'],
    },
  );
export type TenantSettingsInput = z.infer<typeof tenantSettingsSchema>;

/** Vendor's OWN gateway credentials (Mode A). Stored AES-256-GCM encrypted, never read back. */
export const gatewayConfigSchema = z.object({
  provider: z.enum(['SSLCOMMERZ', 'BKASH', 'NAGAD', 'NONE']),
  storeId: z.string().trim().max(200).optional(),
  storePassword: z.string().trim().max(400).optional(),
  appKey: z.string().trim().max(400).optional(),
  appSecret: z.string().trim().max(400).optional(),
  username: z.string().trim().max(200).optional(),
  passwordSecret: z.string().trim().max(400).optional(),
  sandbox: z.boolean().default(true),
});
export type GatewayConfigInput = z.infer<typeof gatewayConfigSchema>;

/**
 * A vendor's own SMS account.
 *
 * Worth having per-vendor rather than only platform-wide: Mode A is the vendor's brand on
 * the vendor's domain, and a confirmation signed "FoodHub" reads like a scam to a customer
 * who ordered from Kacchi Bhai. The sender ID is also the thing the vendor has already
 * paid to have masked.
 */
export const smsConfigSchema = z.object({
  provider: z.enum(['SMSNETBD', 'NONE']).default('SMSNETBD'),
  apiKey: z.string().trim().max(200).optional(),
  /** The masked sender name. Operators cap this at 11 characters. */
  senderId: z.string().trim().max(11).optional(),
});
export type SmsConfigInput = z.infer<typeof smsConfigSchema>;

export const addDomainSchema = z.object({ hostname });
