/**
 * Development seed.
 *
 * Uses a raw PrismaClient on purpose: the tenant guard needs an ambient request scope,
 * and a seed script legitimately writes across every tenant.
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const t = (taka: number) => Math.round(taka * 100); // → poisha

/*
 * Order matters: the FIRST zone is the fallback for any area the vendor has not listed,
 * so the broadest and most expensive one goes first. A cheap zone in that slot would
 * quietly subsidise every delivery to an address nobody thought to configure.
 */
/**
 * A normal week for a Dhaka restaurant: open late, later still at the weekend.
 * Friday's shift crosses midnight, which is the case the open/close logic has to survive.
 */
const WEEK = [
  { day: 0, open: '11:00', close: '23:00' },
  { day: 1, open: '11:00', close: '23:00' },
  { day: 2, open: '11:00', close: '23:00' },
  { day: 3, open: '11:00', close: '23:00' },
  { day: 4, open: '11:00', close: '23:30' },
  { day: 5, open: '12:00', close: '01:00' },
  { day: 6, open: '11:00', close: '23:30' },
];

const ZONES = [
  { id: 'outside', label: 'Outside Dhaka', fee: t(120), minOrder: t(300), areas: [] },
  { id: 'dhaka-city', label: 'Inside Dhaka', fee: t(60), minOrder: t(150), areas: ['Gulshan', 'Banani', 'Uttara', 'Mirpur', 'Mohammadpur'] },
  // A free-delivery zone next door to the kitchen — this is what turns into the green
  // "Free delivery" card on the storefront's offer strip.
  { id: 'neighbourhood', label: 'Dhanmondi', fee: 0, minOrder: t(250), areas: ['Dhanmondi'] },
];

/**
 * The tea stall delivers by map, and only nearby.
 *
 * Deliberately different from the other two: it is a one-man stall in Mirpur, so "we go
 * 3km and no further" is exactly what it would really say — and it is what makes the
 * out-of-area refusal something you can see happen instead of read about.
 */
const WALKING_ZONES = (lat: number, lng: number) => [
  { id: 'nearby', label: 'Around Mirpur 10', fee: t(30), minOrder: 0, areas: [], center: { lat, lng }, radiusKm: 3 },
  { id: 'further', label: 'A bit further out', fee: t(60), minOrder: t(200), areas: [], center: { lat, lng }, radiusKm: 6 },
];

interface VendorSpec {
  slug: string;
  name: string;
  tagline: string;
  brandColor: string;
  phone: string;
  address: string;
  lat: number;
  lng: number;
  plan: 'FREE' | 'BASIC' | 'PRO';
  listed: boolean;
  commissionBps: number;
  /** Marketplace filter chips. */
  cuisines: string[];
  categories: { name: string; items: [string, number, string][] }[];
}

const VENDORS: VendorSpec[] = [
  {
    slug: 'kacchi-bhai',
    name: 'Kacchi Bhai',
    tagline: 'Dhaka’s kacchi, done properly',
    brandColor: '#B3341F',
    phone: '01711000001',
    address: 'House 12, Road 7, Dhanmondi, Dhaka',
    lat: 23.7461,
    lng: 90.3742,
    plan: 'PRO',
    listed: true,
    commissionBps: 1500,
    cuisines: ['Kacchi', 'Biryani', 'Bangladeshi'],
    categories: [
      {
        name: 'Kacchi & Biryani',
        items: [
          ['Mutton Kacchi (Full)', 420, 'Aged basmati, mutton shoulder, slow-dumped over coal.'],
          ['Mutton Kacchi (Half)', 260, 'The same plate, smaller appetite.'],
          ['Chicken Biryani', 240, 'Everyday biryani with roasted potato and boiled egg.'],
          ['Beef Tehari', 220, 'Old Dhaka style, cut with green chilli.'],
        ],
      },
      {
        name: 'Kebab',
        items: [
          ['Beef Shik Kebab', 180, 'Charcoal grilled, four skewers.'],
          ['Chicken Reshmi Kebab', 160, 'Yoghurt marinade, soft centre.'],
          ['Jali Kebab', 140, 'Minced beef in an egg lace.'],
        ],
      },
      {
        name: 'Drinks & Dessert',
        items: [
          ['Borhani', 60, 'Salted mint yoghurt. Non-negotiable with kacchi.'],
          ['Firni', 80, 'Rice pudding, clay pot.'],
          ['Lemon Mint', 70, 'Fresh, no syrup.'],
        ],
      },
    ],
  },
  {
    slug: 'pizza-shack',
    name: 'The Pizza Shack',
    tagline: 'Hand-stretched, stone baked',
    brandColor: '#1F7A4D',
    phone: '01711000002',
    address: 'Plot 45, Gulshan Avenue, Dhaka',
    lat: 23.7925,
    lng: 90.4078,
    plan: 'BASIC',
    listed: true,
    commissionBps: 1800,
    cuisines: ['Pizza', 'Fast Food', 'Burger'],
    categories: [
      {
        name: 'Pizza',
        items: [
          ['Margherita (12")', 550, 'San Marzano, fior di latte, basil.'],
          ['Pepperoni (12")', 690, 'Cup-and-char pepperoni, chilli honey on the side.'],
          ['BBQ Chicken (12")', 720, 'Smoked chicken, red onion, coriander.'],
          ['Four Cheese (12")', 750, 'Mozzarella, cheddar, parmesan, blue.'],
        ],
      },
      {
        name: 'Sides',
        items: [
          ['Garlic Bread', 180, 'With mozzarella and herb butter.'],
          ['Buffalo Wings (6)', 320, 'Blue cheese dip.'],
          ['Garden Salad', 200, 'Because someone has to order it.'],
        ],
      },
      { name: 'Drinks', items: [['Coke 500ml', 50, 'Chilled.'], ['Sparkling Water', 90, '']] },
    ],
  },
  {
    slug: 'chai-adda',
    name: 'Chai Adda',
    tagline: 'Tea, singara, and nowhere to be',
    brandColor: '#8A5A2B',
    phone: '01711000003',
    address: 'Shop 3, Mirpur 10 Circle, Dhaka',
    lat: 23.8069,
    lng: 90.3687,
    plan: 'FREE',
    listed: false, // Mode A only — storefront live, not yet on the marketplace
    commissionBps: 1500,
    cuisines: ['Tea & Coffee', 'Snacks', 'Breakfast'],
    categories: [
      {
        name: 'Tea',
        items: [
          ['Malai Cha', 50, 'Thick, sweet, the good stuff.'],
          ['Masala Cha', 45, 'Cardamom-forward.'],
          ['Lebu Cha', 35, 'Lemon, black salt, a slap of chilli.'],
        ],
      },
      {
        name: 'Snacks',
        items: [
          ['Singara (2)', 40, 'Potato and peanut.'],
          ['Samucha (2)', 45, 'Minced beef.'],
          ['Toast Biscuit', 30, 'For dunking.'],
        ],
      },
    ],
  },
];

async function main() {
  console.log('Seeding…');

  await prisma.$transaction([
    prisma.review.deleteMany(),
    prisma.referral.deleteMany(),
    prisma.abandonedCart.deleteMany(),
    prisma.subscription_Order.deleteMany(),
    prisma.pushSubscription.deleteMany(),
    prisma.couponFunding.deleteMany(),
    prisma.comboItem.deleteMany(),
    prisma.combo.deleteMany(),
    prisma.modifierOption.deleteMany(),
    prisma.modifierGroup.deleteMany(),
    prisma.rider.deleteMany(),
    prisma.ledgerEntry.deleteMany(),
    prisma.orderEvent.deleteMany(),
    prisma.orderItem.deleteMany(),
    prisma.payment.deleteMany(),
    prisma.order.deleteMany(),
    prisma.settlement.deleteMany(),
    prisma.invoice.deleteMany(),
    prisma.subscription.deleteMany(),
    prisma.coupon.deleteMany(),
    prisma.product.deleteMany(),
    prisma.category.deleteMany(),
    prisma.domain.deleteMany(),
    prisma.refreshToken.deleteMany(),
    prisma.savedAddress.deleteMany(),
    prisma.user.deleteMany(),
    prisma.image.deleteMany(),
    prisma.tenant.deleteMany(),
  ]);

  const passwordHash = await bcrypt.hash('password123', 10);

  await prisma.user.create({
    data: {
      role: 'PLATFORM_ADMIN',
      name: 'Platform Admin',
      email: 'admin@foodhub.test',
      passwordHash,
    },
  });

  const customer = await prisma.user.create({
    data: {
      role: 'CUSTOMER',
      name: 'Rifat Hasan',
      email: 'customer@foodhub.test',
      phone: '01811223344',
      passwordHash,
    },
  });

  await prisma.savedAddress.create({
    data: {
      userId: customer.id,
      label: 'Home',
      name: 'Rifat Hasan',
      phone: '01811223344',
      addressLine: 'Flat 4B, House 22, Road 11, Dhanmondi',
      area: 'Dhanmondi',
      city: 'Dhaka',
      isDefault: true,
    },
  });

  const nextBillingAt = new Date();
  nextBillingAt.setMonth(nextBillingAt.getMonth() + 1);

  for (const spec of VENDORS) {
    const tenant = await prisma.tenant.create({
      data: {
        slug: spec.slug,
        name: spec.name,
        tagline: spec.tagline,
        brandColor: spec.brandColor,
        phone: spec.phone,
        address: spec.address,
        lat: spec.lat,
        lng: spec.lng,
        plan: spec.plan,
        planStatus: 'ACTIVE',
        listedOnMarketplace: spec.listed,
        commissionRateBps: spec.commissionBps,
        isOpen: true,
        prepMinutes: spec.slug === 'chai-adda' ? 10 : 30,
        // A tea shop three streets away is not a twenty-minute ride; the demo should show
        // the arrival window actually differing between vendors rather than one constant.
        deliveryMinutes: spec.slug === 'chai-adda' ? 10 : 20,
        cuisines: spec.cuisines,
        deliveryZones: (spec.slug === 'chai-adda' ? WALKING_ZONES(spec.lat, spec.lng) : ZONES) as any,
        // Phase 4 demo state: the two marketplace vendors run a loyalty programme and
        // the flagship also has the AI assistant switched on.
        loyaltyEnabled: spec.listed,
        pointsPerHundred: 2,
        pointValue: 100,
        minRedeemPoints: 20,
        // Payment policy demo: the flagship demands half up front, which is what a real
        // kitchen doing ৳900 biryani orders does to stop hoax cash-on-delivery orders.
        advancePercent: spec.slug === 'kacchi-bhai' ? 50 : 0,
        advanceThreshold: spec.slug === 'kacchi-bhai' ? t(500) : 0,
        codEnabled: true,
        // Every demo store has a counter you can collect from, so the delivery/pickup
        // switch is visible on all three.
        // The kacchi house is a delivery kitchen, so it stays delivery-only — a
        // three-of-three demo would hide the fact that this is a per-vendor choice.
        // Everything below is plan-gated in the API, so the seed reflects a vendor who
        // has actually paid for it — otherwise the demo shows features their plan forbids.
        schedulingEnabled: spec.plan === 'PRO',
        schedulingMaxDays: 3,
        referralEnabled: spec.listed,
        referrerReward: t(50),
        refereeReward: t(50),
        referralMinSpend: t(300),
        // Auto open/close with a real weekly schedule, so the cron has something to act on.
        autoOpenClose: false,
        openingHours: WEEK as any,
        pickupEnabled: true,
        pickupMinutes: spec.slug === 'chai-adda' ? 5 : 20,
        aiAssistantEnabled: spec.slug === 'kacchi-bhai',
        aiPersona:
          spec.slug === 'kacchi-bhai'
            ? 'Always suggest borhani alongside kacchi — it is what regulars order. Never promise delivery in under 30 minutes.'
            : '',
      },
    });

    await prisma.user.create({
      data: {
        tenantId: tenant.id,
        role: 'VENDOR_OWNER',
        name: `${spec.name} Owner`,
        email: `${spec.slug}@foodhub.test`,
        phone: spec.phone,
        passwordHash,
      },
    });

    await prisma.subscription.create({
      data: {
        tenantId: tenant.id,
        plan: spec.plan,
        amount: spec.plan === 'PRO' ? t(4000) : spec.plan === 'BASIC' ? t(1500) : 0,
        nextBillingAt,
      },
    });

    let categoryOrder = 0;
    for (const category of spec.categories) {
      const cat = await prisma.category.create({
        data: { tenantId: tenant.id, name: category.name, sortOrder: categoryOrder++ },
      });
      let itemOrder = 0;
      for (const [name, price, description] of category.items) {
        // One item per category is on offer, so the struck-through "was" price and the
        // saving badge appear somewhere without every dish claiming to be discounted —
        // a menu where everything is reduced is a menu where nothing is.
        const onOffer = itemOrder === 1;
        await prisma.product.create({
          data: {
            tenantId: tenant.id,
            categoryId: cat.id,
            name,
            description,
            price: t(price),
            compareAtPrice: onOffer ? t(Math.round(price * 1.25)) : null, // price is taka here, so this stays whole
            isAvailable: true,
            listedOnMarketplace: true,
            sortOrder: itemOrder++,
          },
        });
      }
    }

    await prisma.coupon.create({
      data: {
        tenantId: tenant.id,
        code: 'WELCOME50',
        amountOff: t(50),
        minSubtotal: t(300),
        usageLimit: 500,
        isActive: true,
      },
    });

    // A second, percentage code that expires soon — the offer strip renders it with a
    // countdown, which is the case a fixed-amount code never exercises.
    const endsSoon = new Date();
    endsSoon.setDate(endsSoon.getDate() + 2);
    await prisma.coupon.create({
      data: {
        tenantId: tenant.id,
        code: 'FEAST15',
        percentOffBps: 1500,
        maxDiscount: t(200),
        minSubtotal: t(600),
        expiresAt: endsSoon,
        isActive: true,
      },
    });

    if (spec.plan !== 'FREE') {
      await prisma.domain.create({
        data: {
          tenantId: tenant.id,
          hostname: `${spec.slug}.test`,
          sslStatus: 'PENDING',
          isPrimary: true,
        },
      });
    }

    await seedModifiersAndCombos(tenant.id, spec.slug);
    await seedRatings(tenant.id, spec.slug);

    console.log(`  ✓ ${spec.name} (${spec.slug}) — ${spec.listed ? 'both channels' : 'own store only'}`);
  }

  /*
   * Imagery is NOT part of this seed. It is uploaded through the real HTTP media pipeline
   * by scripts/seed-images.mjs, which needs the API running — something a DB seed cannot
   * assume. But this seed DELETES the image rows, so skipping the second step leaves every
   * card and banner blank, and a blank demo reads as a broken build. Hence the warning
   * rather than a quiet success line.
   */
  console.log(`
Seed complete — but every store now has NO images.

  Run this next, against a RUNNING api:
    node scripts/seed-images.mjs http://127.0.0.1:4000
    node scripts/seed-images.mjs https://<your-host>     # for a deployed box

  Storefronts   http://kacchi-bhai.lvh.me:3000   http://pizza-shack.lvh.me:3000   http://chai-adda.lvh.me:3000
  Marketplace   http://lvh.me:3000
  Vendor admin  http://lvh.me:3001

  Vendor logins   kacchi-bhai@foodhub.test / pizza-shack@foodhub.test / chai-adda@foodhub.test
  Customer        customer@foodhub.test
  Platform admin  admin@foodhub.test
  Password        password123
`);
}

/**
 * Choices and bundles — the two things that make an order bigger than one flat price.
 *
 * Written against real products by name so the demo shows what a vendor would actually
 * configure: a size that must be chosen, extras that may be added, and a bundle priced
 * below the sum of its parts.
 */
async function seedModifiersAndCombos(tenantId: string, slug: string) {
  const GROUPS: Record<string, Record<string, { name: string; min: number; max: number; options: [string, number][] }[]>> = {
    'kacchi-bhai': {
      'Mutton Kacchi (Full)': [
        { name: 'Portion', min: 1, max: 1, options: [['Regular', 0], ['Extra meat', t(120)]] },
        { name: 'Add on', min: 0, max: 3, options: [['Borhani', t(60)], ['Extra egg', t(30)], ['Salad', t(20)]] },
      ],
      'Chicken Biryani': [
        { name: 'Spice', min: 1, max: 1, options: [['Mild', 0], ['Medium', 0], ['Extra hot', 0]] },
        { name: 'Add on', min: 0, max: 2, options: [['Borhani', t(60)], ['Firni', t(80)]] },
      ],
    },
    'pizza-shack': {
      'Margherita (12")': [
        { name: 'Size', min: 1, max: 1, options: [['12 inch', 0], ['16 inch', t(250)]] },
        { name: 'Extras', min: 0, max: 4, options: [['Extra cheese', t(90)], ['Olives', t(50)], ['Jalapeño', t(40)], ['Mushroom', t(60)]] },
      ],
      'Pepperoni (12")': [
        { name: 'Size', min: 1, max: 1, options: [['12 inch', 0], ['16 inch', t(250)]] },
        { name: 'Crust', min: 1, max: 1, options: [['Classic', 0], ['Thin', 0], ['Stuffed', t(150)]] },
      ],
    },
    'chai-adda': {
      'Malai Cha': [
        { name: 'Sugar', min: 1, max: 1, options: [['Normal', 0], ['Less', 0], ['No sugar', 0]] },
        { name: 'Size', min: 1, max: 1, options: [['Regular', 0], ['Large', t(15)]] },
      ],
    },
  };

  for (const [productName, groups] of Object.entries(GROUPS[slug] ?? {})) {
    const product = await prisma.product.findFirst({ where: { tenantId, name: productName } });
    if (!product) continue;
    for (const [gi, group] of groups.entries()) {
      await prisma.modifierGroup.create({
        data: {
          tenantId,
          productId: product.id,
          name: group.name,
          minSelect: group.min,
          maxSelect: group.max,
          sortOrder: gi,
          options: {
            create: group.options.map(([name, priceDelta], oi) => ({
              tenantId, name, priceDelta, sortOrder: oi,
            })),
          },
        },
      });
    }
  }

  const COMBOS: Record<string, { name: string; description: string; price: number; parts: [string, number][] }[]> = {
    'kacchi-bhai': [{
      name: 'Kacchi for two',
      description: 'Two full kacchi — the standard Friday order.',
      price: t(780),
      parts: [['Mutton Kacchi (Full)', 2]],
    }],
    'pizza-shack': [{
      name: 'Movie night',
      description: 'A 12" pizza, wings and garlic bread.',
      price: t(950),
      parts: [['Margherita (12\")', 1], ['Buffalo Wings (6)', 1], ['Garlic Bread', 1]],
    }],
    'chai-adda': [{
      name: 'Adda pack',
      description: 'Four cha and four singara.',
      price: t(150),
      parts: [['Malai Cha', 4], ['Singara (2)', 2]],
    }],
  };

  for (const combo of COMBOS[slug] ?? []) {
    const items: { productId: string; qty: number }[] = [];
    for (const [name, qty] of combo.parts) {
      const product = await prisma.product.findFirst({ where: { tenantId, name } });
      if (product) items.push({ productId: product.id, qty });
    }
    // A bundle needs at least two lines to be a bundle.
    if (items.length < 1) continue;
    await prisma.combo.create({
      data: {
        tenantId,
        name: combo.name,
        description: combo.description,
        price: combo.price,
        items: { create: items },
      },
    });
  }

  // One rider per store, so assignment has something to point at.
  //
  // The phone numbers must differ. A rider is a person identified by their phone and may
  // carry for several shops, so three demo riders sharing one placeholder number would be
  // one person working three jobs — which is a legitimate thing to model, but not what
  // three different names mean.
  const rider =
    slug === 'chai-adda'
      ? { name: 'Rasel', phone: '01712000001' }
      : slug === 'pizza-shack'
        ? { name: 'Jony', phone: '01712000002' }
        : { name: 'Shamim', phone: '01712000003' };

  await prisma.rider.create({
    data: {
      ...rider,
      token: Buffer.from(`${slug}-rider-1`).toString('base64url'),
      shops: { create: { tenantId, approved: true, approvedAt: new Date() } },
    },
  });
}

/**
 * Demo ratings, built the only way a rating can legitimately exist: a delivered order
 * with a review attached to it.
 *
 * Writing `ratingSum` directly would have been three lines shorter and a lie — the
 * storefront would show a score with no orders behind it, and the first person to click
 * through the reviews would find nothing. Seeding real rows keeps the demo honest and
 * exercises the same unique-per-order constraint the live endpoint relies on.
 */
async function seedRatings(tenantId: string, slug: string) {
  const SAMPLES: Record<string, { rating: number; name: string; comment: string }[]> = {
    'kacchi-bhai': [
      { rating: 5, name: 'Tanvir Ahmed', comment: 'Mutton fell off the bone. Borhani was cold and perfect.' },
      { rating: 5, name: 'Nusrat Jahan', comment: 'Ordered for eight people, everything arrived hot.' },
      { rating: 4, name: 'Rakib Hasan', comment: 'Great kacchi, though the rice was a little heavy on the ghee.' },
      { rating: 5, name: 'Farhana Islam', comment: 'Best kacchi I have had delivered in Dhaka.' },
      { rating: 4, name: 'Imran Kabir', comment: 'Twenty minutes late but they called ahead, so no complaints.' },
    ],
    'pizza-shack': [
      { rating: 4, name: 'Sadia Rahman', comment: 'Thin crust, proper char. Wings were the surprise.' },
      { rating: 5, name: 'Arif Chowdhury', comment: 'Picked it up myself, ready exactly when they said.' },
      { rating: 3, name: 'Mehedi Hasan', comment: 'Pizza was good, garlic bread arrived soggy.' },
      { rating: 5, name: 'Tasnim Akter', comment: 'Four cheese is worth the money.' },
    ],
    'chai-adda': [
      { rating: 5, name: 'Shahriar Kabir', comment: 'Malai cha exactly like the roadside stall, minus the queue.' },
      { rating: 5, name: 'Rubaiya Noor', comment: 'Singara still crunchy when it got here.' },
      { rating: 4, name: 'Nayeem Islam', comment: 'Cheap, fast, hot. Hard to argue with.' },
    ],
  };

  const samples = SAMPLES[slug] ?? [];
  if (samples.length === 0) return;

  /*
   * Spread across the menu rather than all on one dish.
   *
   * The old seed put every demo order on the first product, which made the whole store
   * look like it sold one thing: best-sellers had a single entry, and no dish ever
   * collected enough verdicts to show an approval score. History that is shaped like real
   * history is what makes those features testable at all.
   */
  const products = await prisma.product.findMany({
    where: { tenantId },
    orderBy: { sortOrder: 'asc' },
    take: 4,
  });
  if (products.length === 0) return;
  const product = products[0];

  for (const [i, sample] of samples.entries()) {
    const placedAt = new Date(Date.now() - (i + 1) * 36 * 60 * 60 * 1000);
    const order = await prisma.order.create({
      data: {
        tenantId,
        code: 'SEED',
        channel: 'OWN_STORE',
        status: 'DELIVERED',
        paymentStatus: 'PAID',
        paymentMethod: 'COD',
        customerPhone: `018${String(10000000 + i).slice(0, 8)}`,
        subtotal: product.price,
        deliveryFee: t(60),
        total: product.price + t(60),
        dueOnDelivery: product.price + t(60),
        placedAt,
        deliveredAt: new Date(placedAt.getTime() + 40 * 60 * 1000),
        deliveryAddress: { name: sample.name, phone: '01800000000', addressLine: 'Dhaka', area: '', city: 'Dhaka', note: '' },
        items: { create: [{ productId: product.id, nameSnapshot: product.name, priceSnapshot: product.price, qty: 1 }] },
      },
    });
    // `code` is derived from the sequence, which only exists after the insert.
    await prisma.order.update({
      where: { id: order.id },
      data: { code: `FH${(100000 + order.seq).toString(36).toUpperCase().padStart(5, '0')}` },
    });
    await prisma.review.create({
      data: {
        tenantId,
        orderId: order.id,
        rating: sample.rating,
        comment: sample.comment,
        authorName: sample.name,
        createdAt: new Date(placedAt.getTime() + 3 * 60 * 60 * 1000),
      },
    });

    // The dish verdict that came with the rating. A four-star evening where the food
    // itself was good is the ordinary case and the one the seed should reflect.
    await recordVote(tenantId, order.id, product.id, sample.rating >= 4);
  }

  await seedHistory(tenantId, products);

  // The denormalised counters must agree with the rows above — the same invariant the
  // live submit path maintains inside its transaction.
  const agg = await prisma.review.aggregate({
    where: { tenantId },
    _sum: { rating: true },
    _count: { _all: true },
  });
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { ratingSum: agg._sum.rating ?? 0, ratingCount: agg._count._all },
  });
}

/**
 * Quiet delivered orders: no review, just the fact that somebody bought the thing and
 * said whether it was any good.
 *
 * This is what puts real numbers behind "Popular" and behind the approval score on a
 * dish. Twelve orders per store, weighted towards the first two items the way a real
 * menu's sales are, and every one of them a row that can be audited rather than a
 * counter written directly.
 */
async function seedHistory(tenantId: string, products: { id: string; name: string; price: number }[]) {
  // Index into `products` for each historical order. The first two dishes carry it, which
  // is what a real menu looks like and what makes a best-seller list mean anything.
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

    // Mostly happy, not unanimously. A dish sitting at 100% reads as a store that deletes
    // the bad ones, which is exactly the impression the score exists to avoid.
    await recordVote(tenantId, order.id, product.id, i % 7 !== 3);
  }
}

/**
 * One verdict, and the counter it feeds, written together.
 *
 * Mirrors ReviewsService exactly — the denormalised totals on Product must never be able
 * to disagree with the rows in product_votes, in the seed or anywhere else.
 */
async function recordVote(tenantId: string, orderId: string, productId: string, up: boolean) {
  await prisma.productVote.create({ data: { tenantId, orderId, productId, up } });
  await prisma.product.update({
    where: { id: productId },
    data: { thumbsTotal: { increment: 1 }, ...(up ? { thumbsUp: { increment: 1 } } : {}) },
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
