import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { ReviewDto, ReviewInput } from '@foodhub/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant-context';
import { CacheService } from '../infra/cache.service';

/**
 * Ratings, earned one order at a time.
 *
 * The anti-fraud design is the schema, not a filter: a review is keyed to an order
 * (`orderId` is unique) and can only be posted with the order code AND the phone that
 * placed it. There is no endpoint that rates a store directly, so a competitor cannot
 * bury a vendor and a vendor cannot inflate themselves without cooking real food first.
 *
 * The tenant's running `ratingSum`/`ratingCount` are updated in the same transaction as
 * the review row, so the average shown on the storefront can never drift from the rows
 * behind it.
 */
@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async submit(input: ReviewInput) {
    const order = await TenantContext.runAsPlatform('guest review by order code + phone', () =>
      this.prisma.db.order.findUnique({
        where: { code: input.code.trim().toUpperCase() },
        select: {
          id: true,
          tenantId: true,
          status: true,
          customerPhone: true,
          deliveryAddress: true,
          review: { select: { id: true } },
          // The dishes this order actually contained. Any vote for something not in here
          // is dropped — the count under a dish has to mean "people who ate it".
          items: { select: { productId: true } },
        },
      }),
    );

    // Same check as order tracking: the code alone must not be a valid credential.
    const last10 = (v: string) => v.replace(/\D/g, '').slice(-10);
    if (!order || last10(order.customerPhone) !== last10(input.phone)) {
      throw new NotFoundException('No order found with that number and phone');
    }
    if (order.status !== 'DELIVERED') {
      throw new BadRequestException('You can rate an order once it has been delivered');
    }
    if (order.review) {
      throw new ConflictException('You have already rated this order');
    }

    const authorName = String((order.deliveryAddress as any)?.name ?? '').trim();

    /*
     * Per-dish verdicts, filtered to what this order contained.
     *
     * The order line is the ticket: you may vote on the biryani because you bought the
     * biryani, once. Deduplicated here as well as by the unique index, so a request with
     * the same dish twice is a no-op rather than a 500 the customer has to interpret.
     */
    const orderedIds = new Set(order.items.map((i) => i.productId).filter((id): id is string => !!id));
    const votes = new Map<string, boolean>();
    for (const vote of input.dishes ?? []) {
      if (orderedIds.has(vote.productId)) votes.set(vote.productId, vote.up);
    }

    await TenantContext.runAsTenant(order.tenantId, () =>
      this.prisma.db.$transaction(async (tx) => {
        await tx.review.create({
          data: {
            tenantId: order.tenantId,
            orderId: order.id,
            rating: input.rating,
            comment: input.comment ?? '',
            authorName,
          },
        });

        for (const [productId, up] of votes) {
          await tx.productVote.create({
            data: { tenantId: order.tenantId, orderId: order.id, productId, up },
          });
          // Same transaction as the row it summarises, for the same reason the tenant's
          // rating counters are: a crash between the two leaves a number on the menu
          // that nothing can be reconciled against.
          await tx.product.update({
            where: { id: productId },
            data: { thumbsTotal: { increment: 1 }, ...(up ? { thumbsUp: { increment: 1 } } : {}) },
          });
        }
        // Incremented in the same transaction as the row it summarises — a crash between
        // the two would leave a store's average permanently wrong with nothing to detect it.
        await tx.tenant.update({
          where: { id: order.tenantId },
          data: {
            ratingSum: { increment: input.rating },
            ratingCount: { increment: 1 },
            // The header shows the score, so the cached menu payload is now stale.
            menuVersion: { increment: 1 },
          },
        });
      }),
    );

    await this.cache.delByPrefix(`menu:${order.tenantId}`);
    await this.cache.del(`menuver:${order.tenantId}`);
    await this.cache.delByPrefix('marketplace:');

    return { ok: true, rating: input.rating };
  }

  /**
   * The vendor's public answer to a review.
   *
   * Editable, because the first reply to a one-star review is often written angry — and a
   * vendor who cannot fix it will simply stop replying at all.
   */
  async reply(reviewId: string, reply: string) {
    const review = await this.prisma.db.review.findUnique({
      where: { id: reviewId },
      select: { id: true, tenantId: true },
    });
    if (!review) throw new NotFoundException('Review not found');

    await this.prisma.db.review.update({
      where: { id: reviewId },
      data: { reply, repliedAt: new Date() },
    });
    // The reply shows under the menu, so the cached payload is now stale.
    await this.cache.delByPrefix(`menu:${review.tenantId}`);
    await this.cache.del(`menuver:${review.tenantId}`);
    return { ok: true };
  }

  /**
   * The reviews shown under a store's menu.
   *
   * Only ones that came with words: a wall of bare 5-star rows tells a customer nothing
   * the average already did, and pushes the menu down for no information.
   */
  recent(tenantId: string, take = 8) {
    return TenantContext.runAsPlatform('public reviews for one explicit tenant', () =>
      this.prisma.db.review.findMany({
        where: { tenantId, NOT: { comment: '' } },
        orderBy: { createdAt: 'desc' },
        take,
        select: {
          id: true, rating: true, comment: true, authorName: true, createdAt: true,
          reply: true, repliedAt: true,
        },
      }),
    );
  }
}

/** Dates cross the wire as ISO strings, never Date objects. */
export function toReviewDto(r: {
  id: string; rating: number; comment: string; authorName: string; createdAt: Date;
  reply?: string | null;
}): ReviewDto {
  return {
    id: r.id,
    rating: r.rating,
    comment: r.comment,
    // A first name is enough attribution for a food review and leaks less than a full one.
    authorName: r.authorName.split(' ')[0] || 'Customer',
    createdAt: r.createdAt.toISOString(),
    reply: r.reply ?? null,
  };
}
