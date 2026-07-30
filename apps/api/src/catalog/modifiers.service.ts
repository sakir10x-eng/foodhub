import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { ComboInput, ModifierGroupInput } from '@foodhub/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Modifier groups and combos — the two things that let a vendor sell more than one flat
 * price per dish.
 *
 * Groups are replaced wholesale rather than patched option by option. A vendor editing
 * "Size" thinks in terms of the finished list, not a sequence of adds and deletes, and a
 * half-applied edit is what produces a menu with two "Large" rows at different prices.
 */
@Injectable()
export class ModifiersService {
  constructor(private readonly prisma: PrismaService) {}

  listForProduct(productId: string) {
    return this.prisma.db.modifierGroup.findMany({
      where: { productId },
      orderBy: { sortOrder: 'asc' },
      include: { options: { orderBy: { sortOrder: 'asc' } } },
    });
  }

  /** Replaces every group on a product in one transaction. */
  async replaceGroups(tenantId: string, productId: string, groups: ModifierGroupInput[]) {
    const product = await this.prisma.db.product.findUnique({ where: { id: productId }, select: { id: true } });
    if (!product) throw new NotFoundException('Menu item not found');

    await this.prisma.db.$transaction(async (tx) => {
      // Cascade removes the options with their group.
      await tx.modifierGroup.deleteMany({ where: { productId } });
      for (const [i, group] of groups.entries()) {
        await tx.modifierGroup.create({
          data: {
            tenantId,
            productId,
            name: group.name,
            minSelect: group.minSelect,
            maxSelect: group.maxSelect,
            sortOrder: group.sortOrder ?? i,
            options: {
              create: group.options.map((o, oi) => ({
                tenantId,
                name: o.name,
                priceDelta: o.priceDelta,
                isAvailable: o.isAvailable ?? true,
                sortOrder: o.sortOrder ?? oi,
              })),
            },
          },
        });
      }
    });

    return this.listForProduct(productId);
  }

  /* ─────────────────────────────────────────────────────────── combos */

  listCombos() {
    return this.prisma.db.combo.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { items: { include: { product: { select: { id: true, name: true, price: true } } } } },
    });
  }

  async createCombo(tenantId: string, input: ComboInput) {
    await this.assertProductsOwned(input.items.map((i) => i.productId));
    await this.assertIsActuallyADeal(input.items, input.price);

    return this.prisma.db.combo.create({
      data: {
        tenantId,
        name: input.name,
        description: input.description ?? '',
        price: input.price,
        imageId: input.imageId ?? null,
        isAvailable: input.isAvailable ?? true,
        listedOnMarketplace: input.listedOnMarketplace ?? true,
        sortOrder: input.sortOrder ?? 0,
        items: { create: input.items.map((i) => ({ productId: i.productId, qty: i.qty })) },
      },
      include: { items: true },
    });
  }

  async updateCombo(tenantId: string, id: string, input: ComboInput) {
    await this.assertProductsOwned(input.items.map((i) => i.productId));
    await this.assertIsActuallyADeal(input.items, input.price);
    const existing = await this.prisma.db.combo.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundException('Combo not found');

    return this.prisma.db.$transaction(async (tx) => {
      await tx.comboItem.deleteMany({ where: { comboId: id } });
      return tx.combo.update({
        where: { id },
        data: {
          name: input.name,
          description: input.description ?? '',
          price: input.price,
          imageId: input.imageId ?? null,
          isAvailable: input.isAvailable ?? true,
          listedOnMarketplace: input.listedOnMarketplace ?? true,
          sortOrder: input.sortOrder ?? 0,
          items: { create: input.items.map((i) => ({ productId: i.productId, qty: i.qty })) },
        },
        include: { items: true },
      });
    });
  }

  async deleteCombo(id: string) {
    const combo = await this.prisma.db.combo.findUnique({ where: { id }, select: { id: true } });
    if (!combo) throw new NotFoundException('Combo not found');
    await this.prisma.db.combo.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * A combo may only bundle this vendor's own products.
   *
   * The tenant guard already scopes the query, so a foreign product simply does not come
   * back — the count check turns that silence into a clear rejection instead of a combo
   * that quietly contains fewer items than the vendor chose.
   */
  private async assertProductsOwned(productIds: string[]) {
    const unique = [...new Set(productIds)];
    const found = await this.prisma.db.product.count({
      where: { id: { in: unique }, isArchived: false },
    });
    if (found !== unique.length) {
      throw new BadRequestException('One of the items in this combo is no longer on your menu');
    }
  }

  /**
   * A meal deal must actually be a deal.
   *
   * Refused rather than warned about: the storefront shows the parts total struck through
   * next to the bundle price, so a combo priced above its parts advertises a saving that
   * is really a surcharge. Every real case of this is a typo — a vendor entering ৳980 for
   * two ৳420 dishes meant ৳780.
   */
  private async assertIsActuallyADeal(items: { productId: string; qty: number }[], price: number) {
    const products = await this.prisma.db.product.findMany({
      where: { id: { in: items.map((i) => i.productId) } },
      select: { id: true, price: true },
    });
    const byId = new Map(products.map((p) => [p.id, p.price]));
    const partsTotal = items.reduce((sum, i) => sum + (byId.get(i.productId) ?? 0) * i.qty, 0);

    if (price > partsTotal) {
      throw new BadRequestException(
        `This combo costs ৳${(price / 100).toFixed(0)} but the items separately are ` +
          `৳${(partsTotal / 100).toFixed(0)}. Price it below that or customers are better off not using it.`,
      );
    }
  }
}
