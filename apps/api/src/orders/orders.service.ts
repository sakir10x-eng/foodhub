import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { canTransition, OrderDto, OrderStatus, isTerminal } from '@foodhub/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant-context';
import { LedgerService } from '../ledger/ledger.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { ReferralsService } from '../marketing/referrals.service';
import { JOBS, QueueService } from '../infra/queue.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

const ORDER_INCLUDE = {
  items: true,
  events: { orderBy: { createdAt: 'asc' } },
  // Carried so the tracker knows whether to still offer the rating prompt.
  review: { select: { rating: true } },
} satisfies Prisma.OrderInclude;

export interface OrderListQuery {
  status?: OrderStatus[];
  channel?: 'OWN_STORE' | 'MARKETPLACE';
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly loyalty: LoyaltyService,
    private readonly queue: QueueService,
    private readonly realtime: RealtimeGateway,
    private readonly referrals: ReferralsService,
  ) {}

  async list(query: OrderListQuery) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 25));
    const where: Prisma.OrderWhereInput = {
      ...(query.status?.length ? { status: { in: query.status } } : {}),
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.from || query.to
        ? { placedAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.db.order.findMany({
        where,
        include: ORDER_INCLUDE,
        orderBy: { placedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.db.order.count({ where }),
    ]);

    return { data: rows.map(toDto), total, page, pageSize };
  }

  async getOne(id: string): Promise<OrderDto> {
    const order = await this.prisma.db.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
    if (!order) throw new NotFoundException('Order not found');
    return toDto(order);
  }

  /** Guest order tracking: the code plus the phone that placed it. */
  async trackGuest(code: string, phone: string): Promise<OrderDto> {
    const order = await TenantContext.runAsPlatform('guest order tracking by code + phone', () =>
      this.prisma.db.order.findUnique({
        where: { code: code.trim().toUpperCase() },
        include: { ...ORDER_INCLUDE, tenant: { select: { name: true } } },
      }),
    );
    // Requiring the phone as well stops order codes from being a public enumeration.
    const last10 = (v: string) => v.replace(/\D/g, '').slice(-10);
    if (!order || last10(order.customerPhone) !== last10(phone)) {
      throw new NotFoundException('No order found with that number and phone');
    }
    return { ...toDto(order), tenantName: (order as any).tenant?.name };
  }

  async listForCustomer(customerId: string) {
    const orders = await TenantContext.runAsPlatform('a customer sees their orders across vendors', () =>
      this.prisma.db.order.findMany({
        where: { customerId },
        include: { ...ORDER_INCLUDE, tenant: { select: { name: true, slug: true } } },
        orderBy: { placedAt: 'desc' },
        take: 50,
      }),
    );
    return orders.map((o) => ({ ...toDto(o), tenantName: (o as any).tenant?.name }));
  }

  /**
   * The one place an order's status ever changes.
   *
   * Transitions are validated against the shared state machine, and DELIVERED on a paid
   * marketplace order is what triggers settlement — inside the same transaction, guarded
   * by `settledAt`, so a double-fire cannot pay a vendor twice.
   */
  async updateStatus(
    orderId: string,
    next: OrderStatus,
    actor: string,
    note?: string,
  ): Promise<OrderDto> {
    const updated = await this.prisma.db.$transaction(
      async (tx) => {
        const order = await tx.order.findUnique({ where: { id: orderId } });
        if (!order) throw new NotFoundException('Order not found');

        if (order.status === next) return order; // idempotent no-op
        if (!canTransition(order.status, next)) {
          throw new BadRequestException(`Cannot move an order from ${order.status} to ${next}`);
        }

        const data: Prisma.OrderUpdateInput = { status: next };
        if (next === 'CONFIRMED') data.confirmedAt = new Date();
        if (next === 'DELIVERED') data.deliveredAt = new Date();
        if (next === 'CANCELLED') {
          data.cancelledAt = new Date();
          data.cancelReason = note ?? null;
        }

        // ── settlement: marketplace money only, and only once
        if (next === 'DELIVERED' && order.channel === 'MARKETPLACE' && !order.settledAt) {
          await this.ledger.postOrderSettlement(tx, order, collectedOnline(order));
          // Whatever the rider was owed has now been handed over, so the order is
          // fully paid regardless of how the money arrived.
          data.paymentStatus = 'PAID';
          data.settledAt = new Date();
        }

        if (next === 'REFUNDED' && order.channel === 'MARKETPLACE' && order.settledAt) {
          // We can only give back what we are actually holding. On a half-paid order the
          // rest of the money went to the vendor as cash and is theirs to return.
          const held = collectedOnline(order) - order.commissionAmount - order.gatewayFee;
          await this.ledger.postRefund(tx, order, Math.max(0, held));
          data.paymentStatus = 'REFUNDED';
        }

        // Loyalty points are awarded on delivery, never at checkout — otherwise a
        // cancelled order mints points the customer never earned. Guarded by the
        // order's own pointsEarned, so a replayed DELIVERED awards nothing twice.
        if (next === 'DELIVERED') {
          const points = await this.loyalty.awardForDelivery(tx, order.tenantId, order);
          if (points > 0) data.pointsEarned = points;
        }

        await tx.orderEvent.create({
          data: { orderId, status: next, note: note ?? null, actor },
        });

        return tx.order.update({ where: { id: orderId }, data, include: ORDER_INCLUDE });
      },
      // Serializable: two workers marking the same order delivered must not both settle.
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    // Referral rewards pay on delivery, outside the status transaction: the payout is a
    // separate concern from the order's own state, and a wallet credit failing must not
    // roll back a delivery that physically happened.
    if (next === 'DELIVERED') {
      void this.referrals
        .settleOnDelivery(updated.tenantId, {
          id: updated.id,
          customerPhone: updated.customerPhone,
          total: updated.total,
        })
        .catch((err) => this.logger.error(`Referral payout failed for ${orderId}: ${err.message}`));
    }

    const dto = await this.getOne(orderId);

    // Push to the customer's tracker and the vendor's live queue, then queue the SMS/push.
    this.realtime.emitOrderUpdate(dto);
    await this.queue.enqueue(JOBS.ORDER_STATUS_CHANGED, {
      orderId,
      tenantId: dto.tenantId,
      status: next,
      code: dto.code,
      phone: dto.deliveryAddress.phone,
    });

    if (isTerminal(next)) {
      this.logger.log(`Order ${dto.code} reached terminal state ${next}`);
    }
    return dto;
  }

  /** Marks payment received. Called by the gateway webhook, never by a client. */
  async markPaid(orderId: string, paymentRef: string, actor = 'webhook') {
    const order = await TenantContext.runAsPlatform('payment webhook has no tenant session', () =>
      this.prisma.db.order.findUnique({
        where: { id: orderId },
        select: { tenantId: true, status: true, dueOnDelivery: true },
      }),
    );
    if (!order) throw new NotFoundException('Order not found');

    return TenantContext.runAsTenant(order.tenantId, async () => {
      await this.prisma.db.order.update({
        where: { id: orderId },
        data: {
          // A successful gateway callback on a half-paid order settles the ADVANCE only;
          // calling it PAID here would tell the rider to hand over the food for free.
          paymentStatus: order.dueOnDelivery > 0 ? 'PARTIALLY_PAID' : 'PAID',
          paymentRef,
        },
      });
      // Paying is what confirms an online order; COD orders are confirmed by the vendor.
      if (order.status === 'PENDING') {
        return this.updateStatus(orderId, 'CONFIRMED', actor, 'Payment received');
      }
      return this.getOne(orderId);
    });
  }

  /** Vendor dashboard: the live queue, newest first, only what still needs action. */
  activeQueue() {
    return this.prisma.db.order
      .findMany({
        where: { status: { in: ['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'ON_THE_WAY'] } },
        include: ORDER_INCLUDE,
        orderBy: { placedAt: 'asc' },
        take: 100,
      })
      .then((rows) => rows.map(toDto));
  }

  async stats(days = 7) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    const rows = await this.prisma.db.order.groupBy({
      by: ['channel'],
      where: { placedAt: { gte: since }, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
      _count: { _all: true },
      _sum: { total: true, commissionAmount: true },
    });
    return rows.map((r) => ({
      channel: r.channel,
      orders: r._count._all,
      revenue: r._sum.total ?? 0,
      commission: r._sum.commissionAmount ?? 0,
    }));
  }
}

/**
 * How much of an order's money passed through OUR gateway.
 *
 * This is the one input that separates the payment shapes: a fully prepaid order
 * contributes its total, a 50%-advance order only its advance (the rider took the rest
 * in cash), and a plain cash order nothing at all.
 */
function collectedOnline(order: {
  paymentStatus: string;
  total: number;
  advanceAmount: number;
}): number {
  if (order.paymentStatus === 'PAID') return order.total;
  if (order.paymentStatus === 'PARTIALLY_PAID') return order.advanceAmount;
  return 0;
}

export function toDto(order: any): OrderDto {
  return {
    id: order.id,
    code: order.code,
    tenantId: order.tenantId,
    channel: order.channel,
    status: order.status,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    fulfillment: order.fulfillment ?? 'DELIVERY',
    scheduledFor: order.scheduledFor ? order.scheduledFor.toISOString() : null,
    reviewRating: order.review?.rating ?? null,
    subtotal: order.subtotal,
    deliveryFee: order.deliveryFee,
    discount: order.discount,
    total: order.total,
    commissionAmount: order.commissionAmount,
    // The split matters to the customer (what the rider will ask for) and to the
    // kitchen (whether the money is already in), so it travels with every order.
    advanceAmount: order.advanceAmount ?? 0,
    dueOnDelivery: order.dueOnDelivery ?? 0,
    items: (order.items ?? []).map((i: any) => ({
      id: i.id,
      productId: i.productId,
      nameSnapshot: i.nameSnapshot,
      priceSnapshot: i.priceSnapshot,
      qty: i.qty,
      modifiers: i.modifiers ?? [],
      comboName: i.comboName ?? null,
    })),
    deliveryAddress: order.deliveryAddress,
    placedAt: order.placedAt.toISOString(),
    events: (order.events ?? []).map((e: any) => ({
      status: e.status,
      note: e.note,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}
