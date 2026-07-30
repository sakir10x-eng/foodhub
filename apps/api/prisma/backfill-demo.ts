import { PrismaClient } from '@prisma/client';

/**
 * Brings an already-seeded demo database up to the state `seed.ts` now produces, WITHOUT
 * deleting anything.
 *
 * The full seed truncates: it would take out the demo imagery, every order placed while
 * testing, and the ratings behind the storefront scores. On a deployment somebody is
 * actively poking at, that is a worse trade than a one-off script that only adds.
 *
 * Safe to run twice — every step checks before it writes.
 *
 *   docker exec foodhub-api-1 npx ts-node -T prisma/backfill-demo.ts
 */
const prisma = new PrismaClient();

const t = (taka: number) => Math.round(taka * 100);

/** Same shape the seed writes: a stall that delivers a fixed distance and no further. */
const walkingZones = (lat: number, lng: number) => [
  { id: 'nearby', label: 'Around Mirpur 10', fee: t(30), minOrder: 0, areas: [], center: { lat, lng }, radiusKm: 3 },
  { id: 'further', label: 'A bit further out', fee: t(60), minOrder: t(200), areas: [], center: { lat, lng }, radiusKm: 6 },
];

/** What the seed now gives each demo vendor. Keyed by slug so a renamed store is skipped. */
const DEMO_CUISINES: Record<string, string[]> = {
  'kacchi-bhai': ['Kacchi', 'Biryani', 'Bangladeshi'],
  'pizza-shack': ['Pizza', 'Fast Food', 'Burger'],
  'chai-adda': ['Tea & Coffee', 'Snacks', 'Breakfast'],
};

async function main() {
  const tenants = await prisma.tenant.findMany({
    select: {
      id: true, slug: true, name: true, lat: true, lng: true,
      pickupEnabled: true, deliveryZones: true, cuisines: true,
    },
  });

  for (const tenant of tenants) {
    // 1. Every demo store offers pickup, so the delivery/pickup switch is visible on all
    //    of them rather than only the two that happened to have it on.
    if (!tenant.pickupEnabled) {
      await prisma.tenant.update({ where: { id: tenant.id }, data: { pickupEnabled: true, pickupMinutes: 20 } });
      console.log(`${tenant.slug}: pickup enabled`);
    }

    // 2. The tea stall delivers by map. Left alone if somebody has already drawn an area,
    //    because that would be a vendor's own setting and not ours to overwrite.
    if (tenant.slug === 'chai-adda' && tenant.lat != null && tenant.lng != null) {
      const zones = (tenant.deliveryZones ?? []) as any[];
      const alreadyDrawn = zones.some((z) => z?.center || z?.polygon);
      if (!alreadyDrawn) {
        await prisma.tenant.update({
          where: { id: tenant.id },
          data: { deliveryZones: walkingZones(tenant.lat, tenant.lng) as any },
        });
        console.log(`${tenant.slug}: delivery area set to 3km / 6km rings`);
      }
    }

    // 3. One item per category on offer, so the struck-through price has somewhere to show.
    const categories = await prisma.category.findMany({ where: { tenantId: tenant.id }, select: { id: true } });
    for (const category of categories) {
      const items = await prisma.product.findMany({
        where: { tenantId: tenant.id, categoryId: category.id, isArchived: false },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, price: true, compareAtPrice: true },
      });
      const target = items[1];
      if (target && target.compareAtPrice == null) {
        // Rounded to whole taka. `price` is POISHA, so a bare *1.25 produces things like
        // ৳56.25 — a "was" price with paisa in it that no menu in Dhaka has ever shown.
        await prisma.product.update({
          where: { id: target.id },
          data: { compareAtPrice: Math.round((target.price * 1.25) / 100) * 100 },
        });
      }
    }

    // 4. Cuisine tags and a delivery-leg estimate, so the marketplace filter chips have
    //    something to match and the arrival window is not the same number for a tea stall
    //    three streets away and a kitchen across the city. Only set when still empty:
    //    these are a vendor's own description of themselves once they have touched them.
    const tags = DEMO_CUISINES[tenant.slug];
    if (tags && (tenant.cuisines?.length ?? 0) === 0) {
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { cuisines: tags, deliveryMinutes: tenant.slug === 'chai-adda' ? 10 : 20 },
      });
      console.log(`${tenant.slug}: cuisines ${tags.join(', ')}`);
    }

    await backfillHistory(tenant.id);
    // The storefront payload is cached against this; without the bump the menu keeps
    // serving prices and badges from before this script ran.
    await prisma.tenant.update({ where: { id: tenant.id }, data: { menuVersion: { increment: 1 } } });
  }

  console.log('done');
}

/**
 * Delivered orders with a verdict on the dish, enough of them that the approval score
 * clears the five-vote floor on the store's top items.
 *
 * Skipped entirely once a store has any votes — running this twice should not double a
 * dish's history.
 */
async function backfillHistory(tenantId: string) {
  const existing = await prisma.productVote.count({ where: { tenantId } });
  if (existing > 0) return;

  const products = await prisma.product.findMany({
    where: { tenantId, isArchived: false },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    take: 4,
    select: { id: true, name: true, price: true },
  });
  if (products.length === 0) return;

  const PATTERN = [0, 0, 0, 1, 0, 1, 1, 0, 2, 1, 0, 1];
  for (const [i, index] of PATTERN.entries()) {
    const product = products[Math.min(index, products.length - 1)];
    const placedAt = new Date(Date.now() - (i + 1) * 19 * 60 * 60 * 1000);
    const qty = i % 4 === 0 ? 2 : 1;
    const subtotal = product.price * qty;

    const order = await prisma.order.create({
      data: {
        tenantId,
        code: 'SEED',
        channel: 'OWN_STORE',
        status: 'DELIVERED',
        paymentStatus: 'PAID',
        paymentMethod: 'COD',
        customerPhone: `019${String(20000000 + i).slice(0, 8)}`,
        subtotal,
        deliveryFee: t(60),
        total: subtotal + t(60),
        dueOnDelivery: subtotal + t(60),
        placedAt,
        deliveredAt: new Date(placedAt.getTime() + 38 * 60 * 1000),
        deliveryAddress: { name: 'Demo customer', phone: '01800000000', addressLine: 'Dhaka', area: '', city: 'Dhaka', note: '' },
        items: { create: [{ productId: product.id, nameSnapshot: product.name, priceSnapshot: product.price, qty }] },
      },
    });
    await prisma.order.update({
      where: { id: order.id },
      data: { code: `FH${(100000 + order.seq).toString(36).toUpperCase().padStart(5, '0')}` },
    });

    // Mostly happy, not unanimously — a dish at a flat 100% reads as a store that deletes
    // the bad ones, which is the impression the score exists to avoid.
    const up = i % 7 !== 3;
    await prisma.productVote.create({ data: { tenantId, orderId: order.id, productId: product.id, up } });
    await prisma.product.update({
      where: { id: product.id },
      data: { thumbsTotal: { increment: 1 }, ...(up ? { thumbsUp: { increment: 1 } } : {}) },
    });
  }
  console.log(`${tenantId}: ${PATTERN.length} history orders with dish verdicts`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
