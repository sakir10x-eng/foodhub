# FoodHub — Rider Operations Plan (গ্রামীণ ডেলিভারি)

স্কোপ: খাবার **এবং** মুদি পণ্য, গ্রামে ডেলিভারি। একজন rider একাধিক দোকানের পার্সেল বহন করে,
নিজের এলাকার available কাজ দেখে, নিজে Accept করে, এক ট্রিপে একাধিক দোকান থেকে তুলে
একাধিক বাড়িতে দেয়, ক্যাশ তোলে এবং দিনশেষে জমা দেয়।

এই ডকুমেন্ট ৮টা ফেজে ভাগ করা। প্রতিটা ফেজ আলাদাভাবে deploy করা যায়।
**গ্রামের পাইলট চালু করা যাবে Phase 4 শেষ হলে।** ৫–৭ পরে যোগ করলেও চলবে।

---

## এখন কী আছে (ভিত্তি — পুনরায় বানানোর দরকার নেই)

| জিনিস | ফাইল |
|---|---|
| `Rider` model — name, phone, isActive, token, lat/lng/locationAt | `apps/api/prisma/schema.prisma:506` |
| Vendor হাতে rider assign করে | `apps/api/src/ops/ops.service.ts:150` |
| Run sheet `/rider?token=…` — ঠিকানা, ক্যাশ, Call, Navigate | `apps/web/src/app/rider/page.tsx` |
| Live location share (opt-in, ON_THE_WAY only), staleness + accuracy রুল | `packages/shared/src/rider.ts` |
| Zone geometry — polygon / circle / area-name, `zoneContains()`, `distanceKm()` | `packages/shared/src/pricing.ts:134` |
| COD split — `advanceAmount` + `dueOnDelivery` | `packages/shared/src/pricing.ts` |
| Vendor ledger — `seq`-ordered running balance | `apps/api/prisma/schema.prisma:929` |
| Socket rooms `tenant:<id>` ও `order:<code>:<phone>` | `apps/api/src/realtime/realtime.gateway.ts` |
| SMS / WhatsApp / Email transport + job queue | `apps/api/src/infra/notifications.service.ts` |

Zone geometry আর ledger — এই দুটো পুরোটাই পুনর্ব্যবহার হবে। নতুন করে লেখা হবে না।

---

## 🔴 Phase 0 — Security fix + rider identity rework

**এটা আগে। এটা ছাড়া বাকি কিছুই নিরাপদ নয়।**

### 0.1 Live cross-tenant leak (আগে patch করতে হবে)

`Rider` মডেলটা `tenant-guard.ts`-এর **কোনো তালিকাতেই নেই** — `TENANT_SCOPED_MODELS`-এও না,
`UNGUARDED_MODELS`-এও না। ফলে guard-টা query পাস করে দেয় কোনো ফিল্টার ছাড়াই
(`tenant-guard.ts:84`)। আর `listRiders(tenantId)` তার `tenantId` প্যারামিটারটা
**ব্যবহারই করে না** (`ops.service.ts:126`)।

ফলাফল, লাইভ সার্ভারে:

1. যেকোনো vendor `GET /vendor/ops/riders` কল করলে **সব দোকানের সব rider** ফেরত পায় —
   **`token` সহ**। ওই token দিয়ে `/rider?token=…` খুললে অন্য দোকানের সব গ্রাহকের
   পুরো ঠিকানা, ফোন নম্বর আর কত টাকা তুলতে হবে — সব দেখা যায়।
2. `removeRider(id)` — যেকোনো vendor অন্য দোকানের rider বন্ধ করে দিতে পারে।
3. `assignRider()` — `riderId` যাচাই হয় না, তাই অন্য দোকানের rider-কে assign করা যায়।

**Patch (Phase 1-এর জন্য অপেক্ষা করবে না):**
- `listRiders` → `where: { tenantId, isActive: true }`
- `removeRider(tenantId, id)` → `where: { id, tenantId }`
- `assignRider` → riderId ওই tenant-এর কিনা যাচাই, নাহলে 404
- `Rider` কে `TENANT_SCOPED_MODELS`-এ যোগ করা হবে **না** (0.2-এ এটা platform-scoped হচ্ছে) —
  বদলে `UNGUARDED_MODELS`-এ ব্যাখ্যাসহ যোগ করতে হবে, যাতে "ভুলে বাদ পড়েছে" আর
  "ইচ্ছে করে বাইরে রাখা" আলাদা করা যায়।
- Regression test: tenant A লগইন করে tenant B-র rider দেখতে/মুছতে/assign করতে না পারে।

### 0.2 Rider = platform-level পরিচয়, দোকানের সম্পত্তি নয়

গ্রামে একজন rider ভাতের হোটেল **আর** মুদি দোকান — দুটোরই মাল নেবে। এখন
`Rider.tenantId` non-null, আর `riderQueue()` এক tenant-এর মধ্যে সীমাবদ্ধ, তাই সেটা অসম্ভব।

```prisma
model Rider {
  id        String  @id @default(uuid()) @db.Uuid
  name      String
  phone     String  @unique          // পরিচয়ের চাবি — একজন মানুষ, একটা row
  isActive  Boolean @default(true)
  token     String  @unique          // পুরোনো লিংক টিকে থাকবে (Phase 5-এ OTP আসবে)

  vehicle       Vehicle @default(MOTORCYCLE)
  capacityKg    Int     @default(15)   // Phase 6 এখান থেকে পড়বে
  photoUrl      String?
  nidNumber     String?               // encrypted-at-rest, gatewayConfig-এর মতো
  emergencyPhone String?

  onDuty     Boolean   @default(false)
  dutySince  DateTime?

  lat        Float?
  lng        Float?
  locationAt DateTime?

  shops   RiderShop[]
  areas   RiderArea[]
  orders  Order[]
  trips   Trip[]
  ledger  RiderLedgerEntry[]
  createdAt DateTime @default(now())

  @@index([isActive, onDuty])
  @@map("riders")
}

/// কোন rider কোন দোকানের মাল নিতে পারে। দোকানদার approve করে।
model RiderShop {
  riderId   String @db.Uuid
  tenantId  String @db.Uuid
  approved  Boolean @default(false)
  createdAt DateTime @default(now())
  @@id([riderId, tenantId])
  @@index([tenantId, approved])
  @@map("rider_shops")
}

enum Vehicle { BICYCLE MOTORCYCLE VAN FOOT }
```

**ট্রেড-অফ, লিখে রাখা:** `Rider` আর tenant-scoped নয়, তাই guard আর একে রক্ষা করে না —
প্রতিটা query হাতে scope করতে হবে। বিনিময়ে একজন rider বহু দোকান সার্ভ করতে পারে, যেটা
গ্রামের মডেলের পুরো ভিত্তি। এই সিদ্ধান্তটা `tenant-guard.ts`-এর `UNGUARDED_MODELS`
কমেন্টে লেখা থাকবে।

⚠️ `RiderShop.approved` ফিল্টার **প্রতিটা** rider query-তে থাকতে হবে। এটা বাদ পড়া মানে
0.1-এর leak আবার ফিরে আসা, শুধু নতুন চেহারায়।

### 0.3 Migration
বিদ্যমান প্রতিটা rider-এর জন্য: `Rider.tenantId` ড্রপ করার আগে সেই tenantId দিয়ে
একটা `RiderShop{approved: true}` row বানাতে হবে। একই ফোন নম্বর একাধিক tenant-এ থাকলে
সেগুলো **merge** হবে (একজন মানুষ = একটা row) — merge report লগে লিখতে হবে, চুপচাপ নয়।
পুরোনো `token` অপরিবর্তিত থাকবে যাতে rider-দের হাতের লিংক নষ্ট না হয়।

**Done when:** cross-tenant test লাল থেকে সবুজ; একজন rider দুই দোকানে approved হয়ে
দুই দোকানের কাজ এক কিউতে দেখে; পুরোনো লিংক এখনও কাজ করে।

---

## 🟠 Phase 1 — এলাকা + ডিউটি + কাজ নেওয়া

ইউজারের মূল চাওয়া: *"delivery man তার area-র ভিতর parcel pickup দেখবে।"*

### 1.1 Rider service area — zone geometry পুনর্ব্যবহার
`DeliveryZone` (`pricing.ts:134`) ইতিমধ্যেই polygon / center+radius / area-name তিনভাবেই
এলাকা বোঝে, আর `zoneContains(zone, point)` লেখা আছে। Rider-এর এলাকা **সেই একই shape**।

```prisma
model RiderArea {
  id       String @id @default(uuid()) @db.Uuid
  riderId  String @db.Uuid
  label    String              // "চর কাদিরপুর", "বাজার + উত্তর পাড়া"
  shape    Json                // GeoShape — DeliveryZone-এর জ্যামিতির অংশটুকু
  @@index([riderId])
  @@map("rider_areas")
}
```

⚠️ `packages/shared`-এ shape-matching কোডটা `pricing.ts` থেকে `geo-shape.ts`-এ তুলতে হবে,
আর `DeliveryZone` সেখান থেকে import করবে। **দুই ফাইলে দুটো export const পরস্পরকে
রেফার করলে bundler অর্ধেক-initialised পড়ে** (growth-phases-এ ধরা পড়া bug) — তাই
local `const` করে re-export করতে হবে।

**Fallback, গ্রামের জন্য জরুরি:** গ্রামে অর্ধেক গ্রাহকের pin থাকবে না। তাই ম্যাচিং হবে
এই ক্রমে — (১) গ্রাহকের pin থাকলে geometry, (২) না থাকলে `deliveryAddress.area` টেক্সট,
(৩) দুটোর কোনোটাই না মিললে **কোনো rider-কে দেখানো হবে না**, দোকানদারের কাছে
"এলাকা মেলেনি — হাতে assign করুন" হিসেবে যাবে। অনুমান করে ভুল rider-কে পাঠানো হবে না।

### 1.2 ডিউটি টগল
Run sheet-এ একটা সুইচ: **কাজে আছি / নেই**। Off থাকলে কোনো offer যাবে না এবং location
রিপোর্টও বন্ধ। `Rider.onDuty` + `dutySince` (Phase 5-এর হাজিরা এখান থেকেই আসবে)।

### 1.3 Available job feed
`GET /rider/available` — শর্ত সব একসাথে মিলতে হবে:
- rider `onDuty`
- order status `CONFIRMED` বা `READY`, `riderId` এখনও null
- order-এর tenant rider-এর approved shop তালিকায় আছে
- ডেলিভারি ঠিকানা rider-এর কোনো একটা area-র ভিতরে
- order `DELIVERY`, `PICKUP` নয়

ফেরত যাবে: দোকানের নাম ও দূরত্ব, এলাকা (**পুরো ঠিকানা নয়**), কত টাকা তুলতে হবে,
আনুমানিক আয়। ⚠️ **Accept করার আগে পুরো ঠিকানা দেখানো হবে না** — নাহলে যেকোনো
onDuty rider পুরো গ্রামের ঠিকানার তালিকা পেয়ে যায়।

### 1.4 Accept / Reject
`POST /rider/orders/:id/accept` — race condition আসল ঝুঁকি, তাই conditional update:

```ts
// riderId এখনও null থাকলে তবেই সেট হবে। দুজন একসাথে চাপলে একজন 0 row পাবে।
const claimed = await tx.order.updateMany({
  where: { id, riderId: null, status: { in: ['CONFIRMED', 'READY'] } },
  data: { riderId },
});
if (claimed.count === 0) throw new ConflictException('এই ডেলিভারিটি অন্য কেউ নিয়ে নিয়েছে');
```

Reject = ওই rider-এর ফিডে ওই order চাপা পড়বে (`RiderOfferSkip`), অন্যদের কাছে থাকবে।
Phase 5-এর acceptance-rate এই skip রেকর্ড থেকেই হিসাব হবে।

**দোকানদারের হাতে override থাকবে।** বিদ্যমান `Riders.tsx` panel-টা থাকবে — গ্রামে
দোকানদার প্রায়ই ফোনে বলে দেবে "করিমকে দাও"। Pool হলো ডিফল্ট, একমাত্র পথ নয়।

### 1.5 Rider-কে খবর দেওয়া
এখন run sheet ৬০ সেকেন্ডে একবার poll করে, কোনো শব্দ নেই। যোগ হবে:
- নতুন socket room `rider:<id>` (`realtime.gateway.ts`-এ, বিদ্যমান দুটোর পাশে)
- ফিডে নতুন কাজ ঢুকলে `rider:offer` ইভেন্ট + ব্রাউজারে শব্দ
- ৯০ সেকেন্ডেও কেউ না নিলে SMS (transport আছে), কারণ গ্রামে ফোন পকেটে থাকে

**Done when:** দুই দোকানে approved একজন rider ডিউটিতে গিয়ে নিজের এলাকার দুই দোকানের কাজ
এক ফিডে দেখে, Accept করে, আর দ্বিতীয় জন Accept চাপলে পরিষ্কার বাংলা বার্তা পায়।

---

## 🟠 Phase 2 — ট্রিপ: একাধিক দোকান, একাধিক বাড়ি

গ্রামে অর্ডারের ঘনত্ব কম। এক অর্ডারে এক ট্রিপ চালালে খরচ কখনো উঠবে না। তাছাড়া একটা
`Order` এক tenant-এর — তাই "চাল + রান্না করা খাবার" মানেই দুইটা order, যেগুলো rider-কে
**একটা ট্রিপ** হিসেবে দেখতে হবে।

```prisma
model Trip {
  id        String     @id @default(uuid()) @db.Uuid
  riderId   String     @db.Uuid
  status    TripStatus @default(PLANNED)
  stops     TripStop[]
  startedAt   DateTime?
  completedAt DateTime?
  @@index([riderId, status])
  @@map("trips")
}

model TripStop {
  id       String   @id @default(uuid()) @db.Uuid
  tripId   String   @db.Uuid
  seq      Int                    // rider যে ক্রমে যাবে
  kind     StopKind               // PICKUP | DROP
  orderId  String   @db.Uuid
  tenantId String?  @db.Uuid      // PICKUP হলে কোন দোকান
  arrivedAt   DateTime?
  completedAt DateTime?
  @@unique([tripId, seq])
  @@map("trip_stops")
}

enum TripStatus { PLANNED ACTIVE COMPLETED CANCELLED }
enum StopKind   { PICKUP DROP }
```

- Rider একাধিক কাজ Accept করলে সেগুলো একটা PLANNED ট্রিপে জমা হয়।
- "ট্রিপ শুরু" চাপলে stop-গুলো সাজানো হয়: আগে সব PICKUP (দোকানভিত্তিক grouped),
  তারপর DROP-গুলো nearest-neighbour ক্রমে। **কোনো road routing নয়** — সরলরেখার দূরত্ব।
  যে রাস্তা আমরা হিসাব করিনি সেটা "রুট" বলে দেখানো মিথ্যা; rider-tracking-এর যে কারণে
  ম্যাপে route line আঁকা হয়নি, ঠিক সেই কারণ।
- Rider ক্রম হাতে বদলাতে পারবে। সে রাস্তাটা আমাদের চেয়ে ভালো চেনে।

### 2.1 Pickup আলাদা ঘটনা
`OrderStatus` enum-এ নতুন status **যোগ করা হবে না** — একটা নতুন status মানে state machine,
label, `HAPPY_PATH`, i18n, admin badge, kitchen ticket, customer tracker — সব জায়গায় তার
আলাদা তার (IndoBangla-তে গোনা হয়েছিল ৯টা জায়গা)। বদলে:
- `Order.pickedUpAt DateTime?`
- `TripStop.completedAt` (PICKUP stop)
- একটা `OrderEvent` row (মডেলটা আছে, `schema.prisma:877`)

Rider দোকানে "মাল নিয়েছি" চাপলে order `READY → ON_THE_WAY` যায় — যেটা সত্যি, মাল রওনা
হয়েছে — এবং `pickedUpAt` বসে।

### 2.2 🔴 Batching একটা নতুন privacy সমস্যা তৈরি করে

বর্তমান রুল: গ্রাহক rider-কে দেখে শুধু `ON_THE_WAY`-তে
(`packages/shared/src/rider.ts` → `riderVisibleFor`)। কমেন্টে লেখা আছে `READY` বাদ দেওয়ার
কারণ — তখন rider সাধারণত **অন্য গ্রাহকের দরজায়** থাকে, আর তার অবস্থান দেখানো মানে
সেই অন্য গ্রাহকের ঠিকানা ফাঁস।

Batching করলে **ঠিক সেই সমস্যাটাই `ON_THE_WAY`-তে ফিরে আসে**: rider গ্রাহক ক-এর দরজায়
দাঁড়িয়ে আছে, আর গ্রাহক খ ম্যাপে দেখছে তার খাবার একটা অচেনা বাড়িতে থেমে আছে।

তাই রুলটা বদলাতে হবে:

> **Rider-এর অবস্থান দেখা যাবে শুধু তখনই, যখন ওই গ্রাহকের DROP-ই ট্রিপের চলতি stop।**
> তার আগে গ্রাহক দেখবে "আপনি লাইনে ৩ নম্বর — আনুমানিক ২৫ মিনিট", কোনো ম্যাপ নয়।

`riderVisibleFor(status)` হবে `riderVisibleFor(order, trip)`. এটা `packages/shared`-এই
থাকবে, যাতে API আর UI আলাদা উত্তর দিতে না পারে — যে কারণে রুলগুলো প্রথমেই ওখানে রাখা
হয়েছিল। ⚠️ এটা **API-তে enforce করতে হবে**, শুধু UI-তে লুকিয়ে নয়।

**Done when:** এক ট্রিপে দুই দোকান + তিন বাড়ি; ২ নম্বর গ্রাহক ম্যাপ দেখে না, লাইনের
অবস্থান দেখে; rider তার দিকে রওনা দিলে ম্যাপ খোলে।

---

## 🟠 Phase 3 — ডেলিভারির প্রমাণ ও ব্যর্থ ডেলিভারি

### 3.1 দরজায় OTP
COD-তে সবচেয়ে সস্তা ও কার্যকর প্রমাণ। ছবি নয় — গ্রামে ডেটা খরচ ও নেটওয়ার্ক দুটোই সমস্যা।
- Order `ON_THE_WAY` হলে গ্রাহকের ফোনে ৪ ডিজিটের কোড (SMS transport আছে)
- Rider দরজায় কোড বসিয়ে DELIVERED চাপে
- কোড ছাড়া DELIVERED করা যাবে **শুধু** `deliveryOtpRequired` off থাকলে (per-tenant সেটিং,
  ছোট দোকানের জন্য) অথবা দোকানদার নিজে override করলে — override একটা `OrderEvent`,
  যাতে পরে দেখা যায় কে ছাড় দিয়েছিল
- ৩ বার ভুল হলে rider-কে দোকানে ফোন করতে বলা হবে

### 3.2 ব্যর্থ চেষ্টা ও ফেরত
এখন `ON_THE_WAY` থেকে যাওয়ার পথ শুধু `DELIVERED` বা `CANCELLED` — "গ্রাহক বাসায় নেই"
বলে কিছু নেই। মুদি পণ্যে এটা প্রতিদিন ঘটবে।

```prisma
model DeliveryAttempt {
  id       String @id @default(uuid()) @db.Uuid
  orderId  String @db.Uuid
  riderId  String @db.Uuid
  reason   AttemptFailReason
  note     String?
  lat Float?  lng Float?          // চেষ্টাটা আদৌ ওখানে হয়েছিল কিনা
  createdAt DateTime @default(now())
  @@index([orderId])
  @@map("delivery_attempts")
}

enum AttemptFailReason { NO_ANSWER WRONG_ADDRESS REFUSED NO_CASH SHOP_CLOSED OTHER }
```

`OrderStatus`-এ একটাই নতুন value যোগ হবে: **`RETURNED`** (`ON_THE_WAY` থেকে পৌঁছানো যায়,
সেখান থেকে `REFUNDED`)। এটাই একমাত্র status যেটা যোগ না করে উপায় নেই — মাল দোকানে ফেরত
এসেছে এটা `CANCELLED` থেকে আলাদা, কারণ পণ্য খরচ হয়েছে আর ক্যাশ ওঠেনি।

⚠️ একটা status যোগ করা মানে **সব জায়গায় তার হিসাব** — `ORDER_TRANSITIONS`,
`ORDER_STATUS_LABEL`, `HAPPY_PATH` (এতে ঢুকবে না), `TERMINAL_STATUSES`, `ACTIVE_STATUSES`,
i18n (`apps/web/src/lib/i18n.tsx`), admin badge, kitchen ticket, customer tracker,
ledger-এর settlement branch। চেকলিস্ট ধরে করতে হবে, একটা বাদ পড়লে চুপচাপ ভুল দেখাবে।

**Done when:** rider "গ্রাহক নেই" দেয় → দোকানদার স্ক্রিনে কারণসহ দেখে → হয় আবার পাঠায়
(order আবার pool-এ) নয়তো RETURNED করে; ক্যাশ খাতায় কোনো টাকা ওঠে না।

---

## 🔴 Phase 4 — ক্যাশ ও আয়ের খাতা (COD-তে সবচেয়ে বড় ঝুঁকি)

Vendor-এর জন্য ledger আছে, **rider-এর জন্য কিছুই নেই**। এখন rider কত টাকা তুলেছে আর কত
জমা দিয়েছে তার কোনো রেকর্ড কোথাও নেই।

### 4.1 দুটো আলাদা হিসাব — মেশানো যাবে না

সবচেয়ে সাধারণ ভুল হলো "হাতে থাকা ক্যাশ" আর "প্রাপ্য পারিশ্রমিক" এক খাতায় রাখা। প্রথমটা
দোকানের টাকা যেটা rider বহন করছে; দ্বিতীয়টা rider-এর নিজের টাকা যেটা আমরা দেব। এক
করলে ৫০০ টাকা জমা না দেওয়া আর ৫০০ টাকা মজুরি বকেয়া — দুটো দেখতে একরকম লাগবে।

```prisma
model RiderLedgerEntry {
  id       String @id @default(uuid()) @db.Uuid
  seq      Int    @unique @default(autoincrement())   // ⚠️ createdAt নয় — নিচে দেখুন
  riderId  String @db.Uuid
  account  RiderAccount        // CASH | EARNINGS
  type     RiderLedgerType
  amount   Int                 // signed poisha
  balanceAfter Int             // ওই account-এর চলতি ব্যালেন্স
  orderId  String? @db.Uuid
  memo     String  @default("")
  createdAt DateTime @default(now())
  @@index([riderId, account, seq])
  @@map("rider_ledger_entries")
}

enum RiderAccount { CASH EARNINGS }
enum RiderLedgerType {
  CASH_COLLECTED    // + CASH   — দরজায় টাকা নিল
  CASH_DEPOSITED    // − CASH   — দোকানে/হাবে জমা দিল
  DELIVERY_FEE      // + EARNINGS
  DISTANCE_BONUS    // + EARNINGS
  PENALTY           // − EARNINGS
  PAYOUT            // − EARNINGS
}
```

⚠️ **`balanceAfter` বের করতে হবে `seq` ধরে, কখনো `createdAt` ধরে নয়।** Postgres-এর
`now()` transaction-scoped, তাই এক transaction-এ লেখা সব row-র timestamp এক — vendor
ledger-এ ঠিক এই ভুলে একবার payable দ্বিগুণ গোনা হয়েছিল। একই ফাঁদ, একই সমাধান।

⚠️ সব টাকা **integer poisha**। Float কখনো নয়।

### 4.2 কখন কোন এন্ট্রি
- `DELIVERED` + `dueOnDelivery > 0` → `CASH_COLLECTED` (+)
- `DELIVERED` → `DELIVERY_FEE` (+), হার per-tenant সেটিং
- দোকানদার/হাব "জমা নিয়েছি" চাপলে → `CASH_DEPOSITED` (−)
- ⚠️ Vendor ledger-এর মতোই **idempotent** হতে হবে — DELIVERED দুবার fire করলে দুবার
  ক্যাশ উঠবে না। `settledAt`-এর মতো একটা গার্ড লাগবে।

### 4.3 ক্যাশ লিমিট
`Tenant.riderCashLimit` (ডিফল্ট ৫,০০০ টাকা)। rider-এর হাতে এর বেশি জমলে নতুন COD কাজ
ফিডে দেখাবে না, আর "জমা দিয়ে আসুন" বার্তা দেখাবে। প্রিপেইড অর্ডার তবু দেখাবে।

### 4.4 স্ক্রিন
- Rider run sheet-এ: **আজ তুলেছি / জমা দিয়েছি / হাতে আছে** + আজকের আয়
- দোকানদারের প্যানেলে দৈনিক মিলকরণ: rider ধরে ধরে হাতে কত, "জমা নিলাম" বোতাম,
  ঘাটতি হলে সেটা `PENALTY` না, একটা খোলা পার্থক্য হিসেবেই থাকবে (মানুষ ঠিক করবে)

**Done when:** পাঁচটা COD ডেলিভারি → হাতের ক্যাশ ঠিক মেলে → জমা দেওয়ার পর শূন্য;
DELIVERED পুনরায় fire করলে অঙ্ক বদলায় না।

> ⬆️ **গ্রামের পাইলট এখান থেকে চালু করা যায়।**

---

## 🟡 Phase 5 — পরিচয়, শিফট, পারফরম্যান্স

- **OTP লগইন** — এখন লিংকটাই পাসওয়ার্ড; একবার ফরোয়ার্ড হলেই সব ঠিকানা উন্মুক্ত।
  ফোনে OTP → session। ⚠️ পুরোনো token লিংক অন্তত এক রিলিজ চালু থাকবে, নাহলে একদিনে
  সব rider বাইরে আটকে যাবে।
- **শিফট / হাজিরা** — `onDuty` বদলের log থেকে `RiderShift` (from/to), দৈনিক রিপোর্ট
- **পারফরম্যান্স** — offer পেয়েছে কতটা, নিয়েছে কতটা (acceptance rate),
  সময়মতো পৌঁছানোর হার (`pickedUpAt`/`deliveredAt` বনাম ETA), ব্যর্থ চেষ্টা, গ্রাহকের rating
- **প্রোফাইল** — NID, ছবি, গাড়ি, জরুরি যোগাযোগ। NID `gatewayConfig`-এর মতো
  AES-256-GCM envelope-এ, কোনো ক্লায়েন্টে ফেরত যাবে না
- **SOS** — দুর্ঘটনা/গাড়ি নষ্ট বোতাম → দোকানদার + হাব ম্যানেজারকে তাৎক্ষণিক

---

## 🟡 Phase 6 — গ্রামের বাস্তবতা (foodpanda-র যেটা লাগে না)

1. **ঠিকানা** — গ্রামে বাড়ির নম্বর নেই। `deliveryAddress`-এ `landmark` ফিল্ড
   ("ঈদগাহ মাঠের পাশে, নীল গেট") + ঐচ্ছিক ভয়েস নোট + "আসার আগে ফোন দিন" ফ্ল্যাগ।
   Run sheet-এ landmark ঠিকানার সমান বড় করে।
2. **ধারণক্ষমতা** — ২০ কেজি চাল মোটরসাইকেলে যাবে না। `Product.weightGrams` →
   order-এর মোট ওজন → `Rider.capacityKg`-এর চেয়ে বেশি হলে ফিডে দেখাবে না। ভ্যানওয়ালা
   দেখবে, মোটরসাইকেলওয়ালা দেখবে না।
3. **স্লট-ভিত্তিক ট্রিপ** — সবচেয়ে বড় অর্থনৈতিক পার্থক্য। খাবার = তাৎক্ষণিক;
   মুদি = "দুপুর ১২টা পর্যন্ত অর্ডার → এক ট্রিপ"। `Tenant.deliveryMode` = INSTANT | SLOTTED,
   স্লট শেষ হলে ট্রিপ নিজে থেকে PLANNED হয়ে ফিডে ওঠে। বিদ্যমান scheduling
   (`schedulingEnabled`) আর নৈশ cron-এর ওপরেই বসবে।
4. **নেটওয়ার্ক** — run sheet-এর প্রতিটা অ্যাকশন এখন live fetch, নেটওয়ার্ক গেলে কিছুই হয় না।
   অ্যাকশনগুলো IndexedDB-তে queue হবে আর নেটওয়ার্ক ফিরলে sync হবে। PWA service worker
   আছে, কিন্তু ⚠️ **টাকার endpoint কখনো cache হয় না** — সেই নিয়ম ভাঙা যাবে না;
   queue করা মানে cache করা নয়, তাই আলাদা করে লিখতে হবে।
5. **মুদি পণ্যের বদল (substitution)** — দোকানে জিনিস নেই → দোকানদার বাদ দেয়/বদলায় →
   দাম বদলায় → rider ভিন্ন টাকা তুলবে। এখন confirm-এর পর `dueOnDelivery` আর বদলানো যায় না।
   দরকার: গ্রাহকের সম্মতিসহ পুনঃমূল্যায়ন (`priceCart()`-এই, অন্য কোথাও নয়), তারপর
   `advanceAmount + dueOnDelivery = total` অপরিবর্তিত রেখে নতুন split।
   ⚠️ প্রিপেইড অর্ডারে দাম কমলে সেটা রিফান্ড — নীরবে গিলে ফেলা যাবে না।
6. **কম-প্রযুক্তির fallback** — যে rider স্মার্টফোন চালায় না, তার হয়ে দোকানদার status
   বদলাতে পারবে (`OrderEvent.actor`-এ কে করল লেখা থাকবে), আর কাজের বিবরণ SMS-এ যাবে।

---

## 🟡 Phase 7 — হাব / ম্যানেজার কনসোল

একটা গ্রামে ৩–৪ জনের বেশি rider হলে দোকানদারের প্যানেল আর যথেষ্ট নয়।
`/platform` কনসোলে (আছে, superadmin-এর জন্য) যোগ হবে:
- সব rider এক ম্যাপে, ডিউটির অবস্থা সহ
- অপেক্ষমাণ কাজ যেগুলো কেউ নেয়নি (সবচেয়ে গুরুত্বপূর্ণ সংখ্যা)
- এলাকাভিত্তিক লোড — কোন এলাকায় rider কম
- সব rider-এর ক্যাশ, এক পাতায়
- Rider approve করা / এলাকা বদলানো / নিষ্ক্রিয় করা

⚠️ এই কনসোলের প্রতিটা read `TenantContext.runAsPlatform(reason, …)`-এ মুড়তে হবে —
`grep -r runAsPlatform` দিয়েই cross-tenant read গুলো অডিট করা হয়, তাই এটাই একমাত্র পথ।

---

## গোটা কাজে যে ফাঁদগুলো মনে রাখতে হবে

| ফাঁদ | কেন |
|---|---|
| নতুন top-level web route (`/rider/...`) `middleware.ts`-এর `shared` অ্যারেতে যোগ করতে **হবে** | নাহলে marketplace host-এ `/m/<path>`-এ rewrite হয়ে 404 — `/rider`-এ ঠিক এটাই হয়েছিল |
| নতুন Prisma model = guard তালিকায় **সচেতন** সিদ্ধান্ত | Phase 0-এর leak-টা ঠিক এভাবেই হয়েছিল — কোনো তালিকাতেই ছিল না |
| ledger ব্যালেন্স `seq` ধরে, `createdAt` ধরে নয় | Postgres `now()` transaction-scoped |
| সব টাকা integer poisha | Float কখনো নয় |
| `priceCart()` ছাড়া কোথাও total হিসাব নয় | commission OWN_STORE-এ hard-zero, শাখা দুটো "এক" করা যাবে না |
| `packages/shared`-এ দুই export const পরস্পরকে রেফার করলে bundler ভাঙে | local `const` + re-export |
| নতুন `OrderStatus` = ৯ জায়গায় তার | Phase 3-এর চেকলিস্ট দেখুন |
| টেস্টে `Host` হেডার — Node fetch পারে না | `curl -H "Host: ..."` |
| লোকালে Docker/Redis নেই | in-process fallback, বানানোর চেষ্টা করবেন না |

## টেস্ট
প্রতিটা ফেজে unit + API smoke। যেগুলো অবশ্যই লাগবে:
- Phase 0 — cross-tenant rider access (৩টা ভেক্টর: list, remove, assign)
- Phase 1 — একই order-এ দুজন rider একসাথে Accept → ঠিক একজন পায়
- Phase 2 — batched ট্রিপে ২ নম্বর গ্রাহক rider-এর অবস্থান **পায় না** (API স্তরে)
- Phase 3 — ভুল OTP-তে DELIVERED হয় না
- Phase 4 — DELIVERED দুবার = ক্যাশ একবার

## আনুমানিক আকার
| Phase | কাজ |
|---|---|
| 0 | ছোট (patch) + মাঝারি (migration) |
| 1 | বড় |
| 2 | বড় |
| 3 | মাঝারি |
| 4 | মাঝারি–বড় |
| 5 | মাঝারি |
| 6 | বড় (৬টা স্বাধীন টুকরো, আলাদা করে করা যায়) |
| 7 | মাঝারি |
