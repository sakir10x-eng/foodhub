import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Channel,
  CheckoutInput,
  DeliveryZone,
  applyBps,
  matchZone,
  priceCart,
  splitPayment,
  type ChosenModifier,
} from '@foodhub/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant-context';
import { JOBS, QueueService } from '../infra/queue.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { PaymentsService } from '../payments/payments.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { RetentionService } from '../retention/retention.service';
import { toDto } from './orders.service';

export interface CheckoutContext {
  channel: Channel;
  tenantId: string;
  customerId: string | null;
}

@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly queue: QueueService,
    private readonly realtime: RealtimeGateway,
    private readonly payments: PaymentsService,
    private readonly loyalty: LoyaltyService,
    private readonly retention: RetentionService,
  ) {}

  /**
   * Places an order on either channel.
   *
   * The two channels share everything up to the money: same validation, same pricing
   * function, same order pipeline, same vendor panel. They diverge on exactly two
   * things — whose gateway takes the payment, and whether a commission is charged.
   */
  async placeOrder(input: CheckoutInput, ctx: CheckoutContext) {
    // Re-enter tenant scope: a marketplace checkout arrives in platform scope, and
    // everything below must be pinned to the one vendor fulfilling this order.
    return TenantContext.runAsTenant(ctx.tenantId, async () => {
      const tenant = await this.prisma.db.tenant.findUnique({ where: { id: ctx.tenantId } });
      if (!tenant) throw new NotFoundException('Store not found');
      if (tenant.planStatus === 'SUSPENDED') throw new ForbiddenException('This store is unavailable');
      if (!tenant.isOpen) throw new BadRequestException('This store is closed right now');
      if (ctx.channel === 'MARKETPLACE' && !tenant.listedOnMarketplace) {
        throw new NotFoundException('This store is not available on the marketplace');
      }

      /*
       * Store-level rules first, cart contents second.
       *
       * A customer asking for a delivery time from a store that does not do them should
       * be told exactly that — not "choose a sugar level", which is what they got when
       * this ran after modifier validation.
       */
      const scheduledFor = this.retention.validateScheduledFor(input.scheduledFor, tenant);

      // ── prices come from the database, never from the client
      const ids = [...new Set(input.items.map((i) => i.productId))];
      const products = await this.prisma.db.product.findMany({
        where: { id: { in: ids }, isArchived: false },
        select: {
          id: true, name: true, price: true, isAvailable: true, listedOnMarketplace: true,
          modifierGroups: {
            orderBy: { sortOrder: 'asc' },
            select: {
              id: true, name: true, minSelect: true, maxSelect: true,
              options: { select: { id: true, name: true, priceDelta: true, isAvailable: true } },
            },
          },
        },
      });
      const byId = new Map(products.map((p) => [p.id, p]));

      for (const item of input.items) {
        const product = byId.get(item.productId);
        // The tenant guard already scoped this query, so an item from another vendor is
        // simply missing here — a cross-vendor cart cannot be assembled by hand.
        if (!product) throw new BadRequestException('An item in your cart is no longer available');
        if (!product.isAvailable) throw new BadRequestException(`${product.name} just sold out`);
        if (ctx.channel === 'MARKETPLACE' && !product.listedOnMarketplace) {
          throw new BadRequestException(`${product.name} is not available on the marketplace`);
        }
      }

      // ── modifiers: resolved from the database, never trusted from the request
      //
      // The client sends option IDs only. Every one is looked up, checked to belong to
      // THIS product, and priced from the row — so a crafted request cannot attach a free
      // "large" or borrow an option from a cheaper dish.
      const chosenByItem = input.items.map((item) =>
        resolveModifiers(byId.get(item.productId)!, item.optionIds ?? []),
      );

      // ── fulfilment: delivery or collection from the counter
      //
      // PICKUP has no rider leg, so it resolves no zone, charges no fee and is bound by no
      // zone minimum. Deriving the fee from the fulfilment mode here is what keeps a
      // "pickup" order from silently carrying a delivery charge.
      const pickup = input.fulfillment === 'PICKUP';
      if (pickup && !tenant.pickupEnabled) {
        throw new BadRequestException('This store does not offer pickup');
      }

      const rawSubtotal = input.items.reduce((acc, item, idx) => {
        const base = byId.get(item.productId)?.price ?? 0;
        const extra = chosenByItem[idx].reduce((a, m) => a + m.priceDelta, 0);
        return acc + (base + extra) * item.qty;
      }, 0);

      const zones = (tenant.deliveryZones ?? []) as unknown as DeliveryZone[];
      let zone: DeliveryZone | null = null;
      if (!pickup) {
        /*
         * Where the food is going, decided here and nowhere else.
         *
         * A vendor who has drawn their delivery area on a map is making a promise about
         * distance, and the only honest way to keep it is to check the pin the customer
         * dropped. The client checks the same thing while they type — but the client can
         * be edited, and this is where the fee and the acceptance are actually decided.
         */
        const point =
          input.address.lat != null && input.address.lng != null
            ? { lat: input.address.lat, lng: input.address.lng }
            : null;
        const match = matchZone(zones, { area: input.address.area, point });

        if (match.outsideServiceArea) {
          throw new BadRequestException({
            code: 'OUTSIDE_SERVICE_AREA',
            message: point
              ? `${tenant.name} does not deliver to that location yet`
              : `${tenant.name} delivers to a set area — pin your location on the map so we can check`,
          });
        }
        zone = match.zone;
        if (!zone) throw new BadRequestException('This store has not set up delivery yet');
        if (zone.minOrder && rawSubtotal < zone.minOrder) {
          throw new BadRequestException(
            `Minimum order for ${zone.label} is ৳${(zone.minOrder / 100).toFixed(0)}`,
          );
        }
      }
      const deliveryFee = pickup ? 0 : zone!.fee;

      const coupon = await this.resolveCoupon(input.couponCode, rawSubtotal);

      // Loyalty stacks after the coupon, on whatever goods value is left. Quoted here
      // and re-checked inside the transaction, because a concurrent order from the same
      // phone could spend the same balance in between.
      const redemption = await this.loyalty.quoteRedemption(
        ctx.tenantId,
        input.address.phone,
        Math.max(0, rawSubtotal - coupon.amount),
        input.redeemPoints ?? 0,
        input.useWallet ?? false,
      );
      const discount = { ...coupon, amount: coupon.amount + redemption.discount };

      // Gateway fees only exist where a gateway is involved and we are the one absorbing it.
      const isOnline = input.paymentMethod !== 'COD';
      const gatewayFeeBps =
        ctx.channel === 'MARKETPLACE' && isOnline
          ? (this.config.get<number>('marketplace.gatewayFeeBps') ?? 0)
          : 0;

      const pricing = priceCart({
        items: input.items.map((i, idx) => {
          const p = byId.get(i.productId)!;
          return { productId: p.id, name: p.name, price: p.price, qty: i.qty, modifiers: chosenByItem[idx] };
        }),
        deliveryFee,
        discount: discount.amount,
        channel: ctx.channel,
        commissionRateBps: tenant.commissionRateBps,
        gatewayFeeBps,
      });

      // ── payment policy: how much has to be paid before the kitchen starts
      //
      // Computed from the SERVER's copy of the policy against the SERVER's total. The
      // client picks a method, never an amount — otherwise a hoax order is one edited
      // request away from paying ৳1 advance on a ৳3,000 biryani.
      const split = splitPayment(pricing.total, pricing.subtotal, {
        codEnabled: tenant.codEnabled,
        advancePercent: tenant.advancePercent,
        advanceThreshold: tenant.advanceThreshold,
      });

      if (input.paymentMethod === 'COD' && !split.codAllowed) {
        throw new BadRequestException(
          split.advanceRequired
            ? `This store needs ৳${(split.advanceAmount / 100).toFixed(0)} paid in advance — choose bKash, Nagad or card`
            : 'This store does not accept cash on delivery — choose bKash, Nagad or card',
        );
      }

      // An online payment for a 50%-advance order collects only the advance; the rest is
      // cash at the door. With no advance rule, paying online settles the whole thing.
      const advanceAmount = isOnline ? (split.advanceRequired ? split.advanceAmount : pricing.total) : 0;
      const dueOnDelivery = pricing.total - advanceAmount;

      // The gateway takes its cut of what it processes. priceCart quotes the fee on the
      // full total, which is right only when the full total is charged — on a 50% advance
      // we would be booking a fee on money the gateway never saw.
      const gatewayFee =
        advanceAmount === pricing.total
          ? pricing.total - pricing.commissionAmount - pricing.vendorPayable
          : applyBps(advanceAmount, gatewayFeeBps);

      const order = await this.prisma.db.$transaction(async (tx) => {
        const created = await tx.order.create({
          data: {
            tenantId: ctx.tenantId,
            code: 'PENDING', // replaced below, once the sequence has assigned `seq`
            channel: ctx.channel,
            fulfillment: pickup ? 'PICKUP' : 'DELIVERY',
            scheduledFor,
            customerId: ctx.customerId,
            customerPhone: input.address.phone,
            paymentMethod: input.paymentMethod,
            subtotal: pricing.subtotal,
            deliveryFee: pricing.deliveryFee,
            discount: pricing.discount,
            total: pricing.total,
            commissionAmount: pricing.commissionAmount,
            gatewayFee: ctx.channel === 'MARKETPLACE' ? gatewayFee : 0,
            advanceAmount,
            dueOnDelivery,
            couponCode: discount.code,
            pointsRedeemed: redemption.pointsUsed,
            walletUsed: redemption.walletUsed,
            // A collected order still records who is coming and on what number, but the
            // street fields are meaningless — storing them would put a fictional address
            // on the invoice of someone who walked in.
            deliveryAddress: (pickup
              ? { name: input.address.name, phone: input.address.phone, addressLine: '', area: '', city: '', note: input.address.note ?? '' }
              : input.address) as any,
            items: {
              create: pricing.lines.map((l) => ({
                productId: l.productId,
                nameSnapshot: l.nameSnapshot,
                priceSnapshot: l.priceSnapshot,
                qty: l.qty,
                modifiers: l.modifiers as any,
                comboName: l.comboName ?? null,
              })),
            },
            events: { create: [{ status: 'PENDING', actor: ctx.customerId ?? 'customer' }] },
          },
          include: { items: true, events: true },
        });

        const code = orderCode(created.seq);
        const withCode = await tx.order.update({
          where: { id: created.id },
          data: { code },
          include: { items: true, events: true },
        });

        if (discount.couponId) {
          await tx.coupon.update({
            where: { id: discount.couponId },
            data: { usedCount: { increment: 1 } },
          });
        }

        // Debited inside the same transaction as the order: if the order fails to
        // commit, the customer's points are not gone.
        await this.loyalty.spend(
          tx,
          ctx.tenantId,
          input.address.phone,
          created.id,
          redemption.pointsUsed,
          redemption.walletUsed,
        );

        return withCode;
      });

      const dto = toDto(order);

      // A basket that turned into an order must stop being chased.
      void this.retention.markRecovered(ctx.tenantId, input.address.phone);

      // Vendor's live queue lights up before the customer's page even finishes navigating.
      this.realtime.emitNewOrder(dto);
      await this.queue.enqueue(JOBS.ORDER_PLACED, {
        orderId: order.id,
        tenantId: ctx.tenantId,
        code: order.code,
        phone: order.customerPhone,
        total: order.total,
      });

      // ── payment: the ONE place the two channels genuinely differ
      let payment: { redirectUrl: string | null; provider: string } = {
        redirectUrl: null,
        provider: 'COD',
      };
      if (isOnline) {
        payment = await this.payments.createSession({
          order,
          channel: ctx.channel,
          tenantId: ctx.tenantId,
          method: input.paymentMethod,
          // Charge the advance, not the total — the rider collects the remainder.
          amount: advanceAmount,
        });
      }

      this.logger.log(`Order ${order.code} placed on ${ctx.channel} for tenant ${tenant.slug}`);
      return { order: dto, payment };
    });
  }

  /** Coupons are per-vendor. The tenant guard keeps one vendor's codes out of another's checkout. */
  private async resolveCoupon(code: string | undefined, subtotal: number) {
    if (!code) return { amount: 0, code: null as string | null, couponId: null as string | null };

    const coupon = await this.prisma.db.coupon.findFirst({
      where: { code: code.trim().toUpperCase(), isActive: true },
    });
    if (!coupon) throw new BadRequestException('That promo code is not valid');
    if (coupon.expiresAt && coupon.expiresAt < new Date()) {
      throw new BadRequestException('That promo code has expired');
    }
    if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) {
      throw new BadRequestException('That promo code has been fully claimed');
    }
    if (subtotal < coupon.minSubtotal) {
      throw new BadRequestException(
        `Spend at least ৳${(coupon.minSubtotal / 100).toFixed(0)} to use this code`,
      );
    }

    let amount = coupon.amountOff ?? 0;
    if (coupon.percentOffBps) {
      amount = Math.round((subtotal * coupon.percentOffBps) / 10_000);
    }
    if (coupon.maxDiscount !== null) amount = Math.min(amount, coupon.maxDiscount);

    return { amount: Math.min(amount, subtotal), code: coupon.code, couponId: coupon.id };
  }
}

/** Human-readable, non-sequential-looking, and short enough to read over the phone. */
export function orderCode(seq: number): string {
  return `FH${(100000 + seq).toString(36).toUpperCase().padStart(5, '0')}`;
}

/**
 * Turn the option IDs a client sent into priced, named modifiers — or reject the cart.
 *
 * Every rule a vendor set on a group is enforced here rather than in the browser: a
 * required size that was not chosen, three sauces on a group that allows one, an option
 * that belongs to a different dish. The browser form prevents all of these; this is what
 * makes them true.
 */
function resolveModifiers(
  product: {
    name: string;
    modifierGroups: {
      id: string; name: string; minSelect: number; maxSelect: number;
      options: { id: string; name: string; priceDelta: number; isAvailable: boolean }[];
    }[];
  },
  optionIds: string[],
): ChosenModifier[] {
  const chosen: ChosenModifier[] = [];
  const seen = new Set(optionIds);

  for (const group of product.modifierGroups) {
    const picked = group.options.filter((o) => seen.has(o.id));
    for (const option of picked) seen.delete(option.id);

    if (picked.length < group.minSelect) {
      throw new BadRequestException(`Choose ${group.name.toLowerCase()} for ${product.name}`);
    }
    if (picked.length > group.maxSelect) {
      throw new BadRequestException(
        `Pick at most ${group.maxSelect} from ${group.name.toLowerCase()} for ${product.name}`,
      );
    }
    for (const option of picked) {
      if (!option.isAvailable) {
        throw new BadRequestException(`${option.name} just ran out`);
      }
      chosen.push({ groupName: group.name, optionName: option.name, priceDelta: option.priceDelta });
    }
  }

  // Anything left over came from another product — or from nowhere. Either way the cart
  // is not describing something this kitchen can cook.
  if (seen.size > 0) {
    throw new BadRequestException(`An option on ${product.name} is no longer available`);
  }
  return chosen;
}
