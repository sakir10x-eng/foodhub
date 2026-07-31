import type { Channel, Fulfillment, InvoiceStatus, OrderStatus, PaymentStatus, Plan, PlanStatus, Role, SettlementStatus, SslStatus } from './enums';
import type { DeliveryZone } from './pricing';
import type { RiderPin } from './rider';

/** Wire shapes returned by the API. Money fields are always poisha integers. */

export interface ImageRef {
  id: string;
  /** Base path without extension; append -{w}.webp / -{w}.avif for responsive srcset. */
  url: string;
  blurhash: string | null;
  width: number;
  height: number;
  /**
   * AVIF derivatives are encoded off the request path. Only offer them once this is
   * true — a browser does NOT fall back if a listed <source> 404s.
   */
  hasAvif: boolean;
}

export interface PublicTenant {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  brandColor: string;
  logo: ImageRef | null;
  cover: ImageRef | null;
  isOpen: boolean;
  prepMinutes: number;
  address: string;
  phone: string;
  deliveryZones: DeliveryZone[];
  /** Collection from the counter. Hides the whole delivery leg when chosen. */
  pickupEnabled: boolean;
  pickupMinutes: number;
  /** Ordering for a later time — iftar, office lunch, parties. */
  schedulingEnabled: boolean;
  schedulingMaxDays: number;
  /** The vendor's OWN ad pixel IDs. Empty strings when unset. */
  marketing?: { metaPixelId: string; tiktokPixelId: string; ga4MeasurementId: string };
  /** Double-sided invite rewards, in poisha. Absent when the vendor runs none. */
  referral?: { enabled: boolean; referrerReward: number; refereeReward: number; minSpend: number };
  /** Present on the public tenant so the storefront can render a map link. */
  lat?: number | null;
  lng?: number | null;
  /**
   * Earned ratings. `null` until somebody has actually rated a delivered order — an
   * unrated store shows "New", never a made-up score.
   */
  rating: number | null;
  ratingCount: number;
  /** What delivery actually costs across the vendor's zones, cheapest and dearest. */
  deliveryFeeRange: { min: number; max: number };
  /** What has to be paid before the kitchen starts. Drives the checkout options. */
  payment: {
    codEnabled: boolean;
    advancePercent: number;
    /** Only demand an advance above this subtotal. 0 = always. */
    advanceThreshold: number;
  };
  /** Present on marketplace listings only. */
  distanceKm?: number;
  /** Paid placement. Always surfaced to the customer as "Sponsored". */
  promoted?: boolean;
  /** Cheapest zone fee. Kept for the marketplace cards; see deliveryFeeRange for both ends. */
  minDeliveryFee?: number;
  /**
   * What kind of food this is, for the marketplace filter chips. Free-form strings drawn
   * from a suggested list rather than an enum — a new cuisine must not need a migration,
   * and "Kacchi" is a category here in a way it is nowhere else.
   */
  cuisines: string[];
  /** The vendor's own estimate of the rider leg, in minutes. */
  deliveryMinutes: number;
  /**
   * The quoted arrival window, in minutes. Computed, never stored — it depends on the
   * distance to the customer, which is not a property of the vendor.
   */
  eta: { min: number; max: number };
}

/**
 * A single thing worth shouting about above the menu.
 *
 * Every offer is DERIVED from data the vendor already maintains — a live coupon, the
 * loyalty settings, a zone's free-delivery threshold. Nothing here is hand-written
 * marketing copy, so the strip can never advertise a discount that checkout will refuse.
 */
export interface OfferDto {
  id: string;
  kind: 'COUPON' | 'FREE_DELIVERY' | 'LOYALTY';
  title: string;
  subtitle: string;
  /** Copy-to-clipboard promo code, when the offer has one. */
  code?: string;
  /** ISO date — the strip counts down the last day. */
  expiresAt?: string | null;
}

export interface ModifierOptionDto {
  id: string;
  name: string;
  /** Poisha added to the unit price. Never negative. */
  priceDelta: number;
}

export interface ModifierGroupDto {
  id: string;
  name: string;
  /** 1 with maxSelect 1 is a required radio group; 0 is optional. */
  minSelect: number;
  maxSelect: number;
  options: ModifierOptionDto[];
}

export interface PublicProduct {
  id: string;
  categoryId: string | null;
  name: string;
  description: string;
  price: number;
  /**
   * What it used to cost, in poisha. Always greater than `price` when present — the API
   * refuses to store anything else, so a struck-through number is never theatre.
   */
  compareAtPrice?: number | null;
  image: ImageRef | null;
  isAvailable: boolean;
  sortOrder: number;
  /**
   * How the people who actually ate it voted. Absent until a handful have, because
   * "100% (1)" is a number that reads as a score and carries none.
   */
  approval?: { percent: number; count: number };
  /**
   * One of the store's genuine best-sellers over the last 30 days. Derived from order
   * lines, never hand-set: a "Popular" badge a vendor can switch on for anything is a
   * badge customers learn to ignore.
   */
  popular?: boolean;
  /** Empty for a flat-priced item. */
  modifierGroups?: ModifierGroupDto[];
}

export interface ComboDto {
  id: string;
  name: string;
  description: string;
  /** Poisha for the whole bundle. */
  price: number;
  image: ImageRef | null;
  /** What the same items cost separately — shown struck through when it is higher. */
  partsTotal: number;
  saving: number;
  items: { productId: string; name: string; qty: number }[];
}

export interface PublicCategory {
  id: string;
  name: string;
  sortOrder: number;
  products: PublicProduct[];
}

export interface ReviewDto {
  id: string;
  rating: number;
  comment: string;
  authorName: string;
  createdAt: string;
  /** The vendor's public answer. Null when they have not replied. */
  reply?: string | null;
}

export interface PublicMenu {
  tenant: PublicTenant;
  categories: PublicCategory[];
  /** Live offers, best-value first. Empty when the vendor is running none. */
  offers: OfferDto[];
  /** Fixed bundles sold at one price. Empty when the vendor runs none. */
  combos: ComboDto[];
  /** The most recent ratings that came with words. Empty for a new store. */
  reviews: ReviewDto[];
  /** Monotonic version — bump invalidates the edge cache for this menu. */
  version: string;
}

export interface OrderItemDto {
  id: string;
  productId: string | null;
  nameSnapshot: string;
  priceSnapshot: number;
  qty: number;
  /** Chosen options, snapshotted at order time. */
  modifiers?: { groupName: string; optionName: string; priceDelta: number }[];
  /** Set when the line came from a bundle. */
  comboName?: string | null;
}

export interface OrderDto {
  id: string;
  code: string;
  tenantId: string;
  tenantName?: string;
  channel: Channel;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentMethod: string;
  fulfillment: Fulfillment;
  /** ISO instant the customer asked for. Null means as soon as possible. */
  scheduledFor?: string | null;
  /** Set once the customer has rated this order — a second rating is refused. */
  reviewRating?: number | null;
  subtotal: number;
  deliveryFee: number;
  discount: number;
  total: number;
  commissionAmount: number;
  /** Taken online before cooking started. 0 on a plain cash order. */
  advanceAmount: number;
  /** What the rider collects at the door. Always `total - advanceAmount`. */
  dueOnDelivery: number;
  items: OrderItemDto[];
  deliveryAddress: {
    name: string;
    phone: string;
    addressLine: string;
    area: string;
    city: string;
    note: string;
  };
  placedAt: string;
  /**
   * When this order should arrive, as real clock times rather than a duration — the
   * tracker is read minutes after ordering and "35 min" from when is the first question
   * it raises. Absent once the order is terminal, and on payloads that did not join the
   * vendor (a vendor's own queue already knows its kitchen times).
   */
  etaAt?: { earliest: string; latest: string } | null;
  /**
   * Whether the CUSTOMER may still call this off. Decided on the server so the button
   * appears exactly when the cancel endpoint would say yes — a button that fails on tap
   * is worse than no button.
   */
  canCancel?: boolean;
  /**
   * The rider, and where they are — present ONLY while the order is on its way and the
   * last fix is recent. See `riderVisibleFor` and `isFixFresh` in ./rider.ts; both rules
   * are about a person's privacy, so they are enforced server-side and this field simply
   * is not populated when they say no.
   */
  rider?: RiderPin | null;
  /**
   * Who is assigned, as an opaque id. Separate from `rider` on purpose: the vendor's
   * panel needs to know an order already has someone on it from the moment it is
   * assigned, while the customer-facing `rider` block stays shut until the food is
   * genuinely on its way. A uuid tells a customer nothing, so this one is not gated.
   */
  riderId?: string | null;
  /** Where the food is going, when the customer dropped a pin. Anchors the tracking map. */
  destination?: { lat: number; lng: number } | null;
  events?: { status: OrderStatus; note: string | null; createdAt: string }[];
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  tenantId: string | null;
  tenantSlug?: string | null;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

export interface VendorSummary {
  tenant: {
    id: string;
    slug: string;
    name: string;
    plan: Plan;
    planStatus: PlanStatus;
    isOpen: boolean;
    listedOnMarketplace: boolean;
    commissionRateBps: number;
    /** null until a customer has rated a delivered order. */
    rating: number | null;
    ratingCount: number;
  };
  today: { orders: number; revenue: number; activeOrders: number };
  pendingPayout: number;
}

/** What a vendor's current plan unlocks. Mirrors PLANS — the server is the authority. */
export interface Entitlements {
  plan: Plan;
  features: string[];
  staffSeats: number;
  menuItems: number;
  analyticsDays: number;
}

export interface SettlementDto {
  id: string;
  periodStart: string;
  periodEnd: string;
  gross: number;
  commission: number;
  netPayable: number;
  status: SettlementStatus;
  paidAt: string | null;
}

export interface InvoiceDto {
  id: string;
  number: string;
  amount: number;
  status: InvoiceStatus;
  dueAt: string;
  paidAt: string | null;
  periodLabel: string;
}

export interface DomainDto {
  id: string;
  hostname: string;
  sslStatus: SslStatus;
  isPrimary: boolean;
  verifiedAt: string | null;
  /** What the vendor must put in their DNS. */
  cnameTarget: string;
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}
