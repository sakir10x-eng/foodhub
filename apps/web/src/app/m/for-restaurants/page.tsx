import type { Metadata } from 'next';
import Link from 'next/link';
import { formatBDT, PLAN_PRICING, type Plan } from '@foodhub/shared';
import { Icon, type IconName } from '../../../components/Icon';
import { ChannelDiagram } from '../../../components/landing/ChannelDiagram';
import { VendorSignup } from '../../../components/landing/VendorSignup';

export const metadata: Metadata = {
  title: 'রেস্টুরেন্টের জন্য FoodHub — নিজের ওয়েবসাইট, শূন্য কমিশন',
  description:
    'নিজের ডোমেইনে নিজের অনলাইন দোকান খুলুন — সেখানকার অর্ডারে কোনো কমিশন নেই। চাইলে এক ক্লিকে FoodHub মার্কেটপ্লেসেও যুক্ত হয়ে নতুন কাস্টমার পান।',
  openGraph: {
    title: 'নিজের রেস্টুরেন্টের অনলাইন দোকান — কমিশন ছাড়া',
    description: 'একটাই মেনু, একটাই অর্ডার প্যানেল, দুইটা বিক্রির চ্যানেল।',
  },
};

/** Marketing pages change rarely — cache them hard at the edge. */
export const revalidate = 3600;

const DOMAIN = process.env.NEXT_PUBLIC_PLATFORM_DOMAIN ?? 'lvh.me:3000';
const ADMIN_URL = `https://admin.${DOMAIN}`;

export default function ForRestaurantsPage() {
  return (
    <main className="mx-auto max-w-5xl px-4 pb-20">
      <Nav />
      <Hero />
      <Problem />
      <Features />
      <BusinessCase />
      <Pricing />
      <Roadmap />
      <Faq />
      <FinalCta />
      <Footer />
    </main>
  );
}

/* ────────────────────────────────────────────────────────────── nav ─── */

function Nav() {
  return (
    <nav className="flex items-center justify-between py-4">
      <Link href="/" className="flex items-center gap-2 font-extrabold tracking-tight">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand text-[11px] font-black text-white">FH</span>
        FoodHub
      </Link>
      <div className="flex items-center gap-2">
        <a href={`${ADMIN_URL}/login`} className="rounded-lg px-3 py-2 text-sm font-semibold text-ink-muted">
          লগইন
        </a>
        <a href="#signup" className="btn-brand h-10 min-h-0 px-4 text-sm">
          শুরু করুন
        </a>
      </div>
    </nav>
  );
}

/* ───────────────────────────────────────────────────────────── hero ─── */

function Hero() {
  return (
    <header className="grid items-center gap-10 py-10 md:grid-cols-2 md:py-16">
      <div className="rise-in">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-800">
          <Icon name="check" size={13} strokeWidth={2.4} />
          নিজের সাইটের অর্ডারে ০% কমিশন
        </span>

        <h1 className="mt-4 text-[34px] font-extrabold leading-[1.1] tracking-tight sm:text-5xl">
          নিজের রেস্টুরেন্টের
          <br />
          <span className="text-brand">নিজের অনলাইন দোকান</span>
        </h1>

        <p className="mt-4 max-w-md text-[15px] leading-relaxed text-ink-muted">
          আপনার নিজের ডোমেইনে, আপনার নিজের ব্র্যান্ডে, আপনার নিজের পেমেন্ট গেটওয়েতে।
          টাকা সরাসরি আপনার কাছে আসে — আমাদের হাত দিয়ে যায় না।
          তারপর চাইলে <strong className="text-ink">একটা সুইচ টিপে</strong> FoodHub
          মার্কেটপ্লেসেও যুক্ত হয়ে নতুন কাস্টমার পাবেন।
        </p>

        <div className="mt-6 flex flex-wrap gap-3">
          <a href="#signup" className="btn-brand px-6">১০ মিনিটে দোকান খুলুন</a>
          <a href="#how" className="btn-ghost px-6">কীভাবে কাজ করে</a>
        </div>

        <dl className="mt-8 grid grid-cols-3 gap-4 border-t border-surface-line pt-6">
          <Stat value="০%" label="নিজের সাইটে কমিশন" />
          <Stat value="১০ মিনিট" label="দোকান চালু হতে" />
          <Stat value="৳০" label="Free প্ল্যানে শুরু" />
        </dl>
      </div>

      <div id="how" className="rise-in" style={{ animationDelay: '.12s' }}>
        <ChannelDiagram />
        <p className="mt-4 text-center text-xs text-ink-faint">
          দুই জায়গার অর্ডার — একটাই প্যানেলে
        </p>
      </div>
    </header>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <dt className="sr-only">{label}</dt>
      <dd className="text-xl font-extrabold tracking-tight">{value}</dd>
      <dd className="mt-0.5 text-[11px] leading-tight text-ink-muted">{label}</dd>
    </div>
  );
}

/* ────────────────────────────────────────────────────────── problem ─── */

function Problem() {
  return (
    <section className="rounded-2xl bg-surface-sunk p-6 sm:p-8">
      <h2 className="text-xl font-extrabold tracking-tight sm:text-2xl">
        শুধু ফুড অ্যাপে থাকলে দোকান আপনার, কাস্টমার তাদের
      </h2>
      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        <Pain icon="tag" title="প্রতি অর্ডারে ২৫–৩০% চলে যায়"
              body="যে কাস্টমার প্রতি সপ্তাহে আসে, তার জন্যও প্রতিবার কমিশন দিতে হয়।" />
        <Pain icon="users" title="কাস্টমার নম্বরটাও আপনার না"
              body="কে কী অর্ডার করল, কতবার করল — কিছুই আপনার হাতে থাকে না।" />
        <Pain icon="store" title="নিজের ব্র্যান্ড হারিয়ে যায়"
              body="লিস্টের ভেতর আরেকটা নাম। পাশেই আপনার প্রতিযোগীর বিজ্ঞাপন।" />
      </div>
      <p className="mt-6 rounded-xl bg-white p-4 text-[15px] leading-relaxed">
        <strong>FoodHub উল্টো দিক থেকে শুরু করে।</strong> আগে আপনার নিজের দোকান দাঁড় করায় —
        যেখানে কাস্টমার, ডেটা আর পুরো টাকাটা আপনার। মার্কেটপ্লেস তার <em>উপরে</em> একটা
        বাড়তি সুযোগ, বাধ্যবাধকতা নয়।
      </p>
    </section>
  );
}

function Pain({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  return (
    <div className="rounded-xl bg-white p-4">
      <span className="grid h-9 w-9 place-items-center rounded-lg bg-red-50 text-red-600">
        <Icon name={icon} size={18} />
      </span>
      <h3 className="mt-2.5 text-sm font-bold leading-snug">{title}</h3>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">{body}</p>
    </div>
  );
}

/* ───────────────────────────────────────────────────────── features ─── */

const FEATURES: { icon: IconName; title: string; body: string; live: boolean }[] = [
  { icon: 'globe', title: 'নিজের ডোমেইন + ফ্রি SSL', live: true,
    body: 'order.apnarrestaurant.com — DNS-এ একটা CNAME বসালেই HTTPS সার্টিফিকেট নিজে থেকে চালু হয়ে যায়।' },
  { icon: 'menu', title: 'মেনু ম্যানেজমেন্ট', live: true,
    body: 'ছবি আপলোড করলে নিজে থেকেই WebP/AVIF-এ কনভার্ট হয়। "শেষ হয়ে গেছে" এক ট্যাপে — সাথে সাথে সব খোলা পেজে আপডেট।' },
  { icon: 'orders', title: 'লাইভ অর্ডার স্ক্রিন', live: true,
    body: 'নতুন অর্ডার রিফ্রেশ ছাড়াই স্ক্রিনে চলে আসে। রান্নাঘরের জন্য বড় বাটন, এক ট্যাপে পরের ধাপ।' },
  { icon: 'bike', title: 'ডেলিভারি জোন', live: true,
    body: 'এলাকা অনুযায়ী চার্জ আর সর্বনিম্ন অর্ডার। কাস্টমার চেকআউটেই সঠিক চার্জ দেখে।' },
  { icon: 'chart', title: 'অ্যানালিটিক্স', live: true,
    body: 'কোন আইটেম চলছে, কোন সময়ে ভিড় বেশি (ঢাকার সময়ে), আর "বিক্রি হচ্ছে কিন্তু সোল্ড-আউট দেওয়া" আইটেমের অ্যালার্ট।' },
  { icon: 'star', title: 'লয়্যালটি পয়েন্ট', live: true,
    body: 'ফোন নম্বর দিয়েই পয়েন্ট জমে — গেস্ট কাস্টমারও পায়। ডেলিভারি হলে তবেই পয়েন্ট, ক্যান্সেল হলে নয়।' },
  { icon: 'sparkles', title: 'AI দিয়ে চ্যাটে অর্ডার', live: true,
    body: 'কাস্টমার বাংলা/ইংরেজি/বাংলিশে লিখে অর্ডার দিতে পারে। আপনার আসল মেনুর বাইরে কিছু বলার সুযোগ ওর নেই।' },
  { icon: 'wallet', title: 'নিজের পেমেন্ট গেটওয়ে', live: true,
    body: 'নিজের bKash/Nagad/SSLCommerz অ্যাকাউন্ট যুক্ত করুন। টাকা সরাসরি আপনার কাছে, আমাদের কাছে জমা থাকে না।' },
  { icon: 'home', title: 'মোবাইল অ্যাপের মতো', live: true,
    body: 'কাস্টমার হোম স্ক্রিনে অ্যাড করতে পারে। দুর্বল নেটওয়ার্কেও মেনু সাথে সাথে খোলে।' },
];

function Features() {
  return (
    <section className="py-14">
      <SectionHead
        eyebrow="যা যা পাচ্ছেন"
        title="প্রথম দিন থেকেই সবকিছু চালু"
        sub="আলাদা করে কিছু কিনতে হবে না, কোনো ফিচার পরের প্ল্যানে লুকানো নেই।" />
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => (
          <div key={f.title} className="card p-5">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand/10 text-brand">
              <Icon name={f.icon} size={20} />
            </span>
            <h3 className="mt-3 flex items-center gap-2 text-[15px] font-bold">
              {f.title}
              {f.live && (
                <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-800">
                  চালু
                </span>
              )}
            </h3>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">{f.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ──────────────────────────────────────────────────── business case ─── */

function BusinessCase() {
  return (
    <section className="rounded-2xl border border-surface-line bg-white p-6 shadow-card sm:p-8">
      <SectionHead
        eyebrow="হিসাবটা কেমন দাঁড়ায়"
        title="আপনার ব্যবসার কী লাভ"
        sub="সংখ্যাগুলো উদাহরণ — আপনার নিজের হিসাব বসিয়ে দেখুন।" />

      <div className="mt-7 overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="border-b border-surface-line text-left text-xs uppercase tracking-wide text-ink-faint">
              <th className="py-2 pr-4 font-semibold">মাসে ৩০০ অর্ডার, গড়ে ৳৫০০</th>
              <th className="py-2 pr-4 font-semibold">শুধু ফুড অ্যাপে</th>
              <th className="py-2 font-semibold">FoodHub-এ নিজের সাইট</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-line">
            <Row label="মোট বিক্রি" a="৳১,৫০,০০০" b="৳১,৫০,০০০" />
            <Row label="কমিশন (২৫%)" a="− ৳৩৭,৫০০" b="৳০" highlight />
            <Row label="সফটওয়্যারের খরচ" a="৳০" b={`− ${formatBDT(PLAN_PRICING.BASIC.monthly)}`} />
            <Row label="হাতে থাকল" a="৳১,১২,৫০০" b="৳১,৪৮,৫০০" strong />
          </tbody>
        </table>
      </div>

      <p className="mt-4 rounded-xl bg-emerald-50 p-4 text-sm text-emerald-900">
        <strong>মাসে প্রায় ৳৩৬,০০০ পার্থক্য</strong> — শুধু যে কাস্টমাররা এমনিতেই আপনার
        কাছে ফিরে আসত, তাদের অর্ডার নিজের সাইটে নিয়ে এলেই।
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Insight icon="users" title="কাস্টমার আপনার থাকে"
                 body="নাম, নম্বর, কে কী অর্ডার করে — সব আপনার ডেটাবেজে। রিপিট কাস্টমার এক ট্যাপে আগের অর্ডার আবার দিতে পারে।" />
        <Insight icon="globe" title="মার্কেটপ্লেস নতুন কাস্টমার আনে"
                 body="যারা আপনাকে চেনে না তারা মার্কেটপ্লেসে খুঁজে পায়। শুধু সেই অর্ডারগুলোতেই কমিশন — নিজের সাইটে কখনো নয়।" />
      </div>
    </section>
  );
}

function Row({ label, a, b, highlight, strong }: {
  label: string; a: string; b: string; highlight?: boolean; strong?: boolean;
}) {
  return (
    <tr className={strong ? 'font-extrabold' : ''}>
      <td className="py-2.5 pr-4">{label}</td>
      <td className={`py-2.5 pr-4 tabular-nums ${highlight ? 'text-red-700' : 'text-ink-muted'}`}>{a}</td>
      <td className={`py-2.5 tabular-nums ${highlight || strong ? 'text-emerald-700' : ''}`}>{b}</td>
    </tr>
  );
}

function Insight({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  return (
    <div className="rounded-xl bg-surface-sunk p-4">
      <h3 className="flex items-center gap-2 text-sm font-bold">
        <Icon name={icon} size={16} /> {title}
      </h3>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">{body}</p>
    </div>
  );
}

/* ────────────────────────────────────────────────────────── pricing ─── */

const PLAN_LABEL: Record<Plan, { name: string; for: string; features: string[] }> = {
  FREE: {
    name: 'ফ্রি', for: 'শুরু করার জন্য',
    features: ['FoodHub সাবডোমেইনে দোকান', '২০টি পর্যন্ত আইটেম', 'মার্কেটপ্লেসে থাকার সুযোগ', 'ক্যাশ অন ডেলিভারি'],
  },
  BASIC: {
    name: 'বেসিক', for: 'চালু রেস্টুরেন্টের জন্য',
    features: ['নিজের ডোমেইন + ফ্রি SSL', 'যত খুশি মেনু আইটেম', 'নিজের পেমেন্ট গেটওয়ে', 'লয়্যালটি পয়েন্ট', 'অ্যানালিটিক্স'],
  },
  PRO: {
    name: 'প্রো', for: 'একাধিক শাখা / বেশি অর্ডার',
    features: ['বেসিকের সবকিছু', 'স্টাফ অ্যাকাউন্ট', 'AI চ্যাট অর্ডার', 'মার্কেটপ্লেসে অগ্রাধিকার', 'অগ্রাধিকার সাপোর্ট'],
  },
};

function Pricing() {
  return (
    <section className="py-14">
      <SectionHead
        eyebrow="দাম"
        title="মাসিক ফি, অর্ডারে ভাগ নয়"
        sub="নিজের সাইটের অর্ডারে আমরা কখনো কমিশন নিই না — বেশি বিক্রি হলে আমাদের বিল বাড়ে না।" />

      <div className="mt-8 grid gap-4 md:grid-cols-3">
        {(Object.keys(PLAN_LABEL) as Plan[]).map((plan) => {
          const info = PLAN_LABEL[plan];
          const price = PLAN_PRICING[plan].monthly;
          const featured = plan === 'BASIC';
          return (
            <div key={plan}
                 className={`rounded-2xl border p-6 ${featured ? 'border-brand bg-brand/5 shadow-card' : 'border-surface-line bg-white'}`}>
              {featured && (
                <span className="mb-2 inline-block rounded-full bg-brand px-2.5 py-0.5 text-[11px] font-bold text-white">
                  সবচেয়ে জনপ্রিয়
                </span>
              )}
              <h3 className="text-lg font-extrabold">{info.name}</h3>
              <p className="text-xs text-ink-muted">{info.for}</p>
              <p className="mt-3 text-3xl font-extrabold tracking-tight">
                {price === 0 ? 'ফ্রি' : formatBDT(price)}
                {price > 0 && <span className="text-sm font-medium text-ink-muted">/মাস</span>}
              </p>
              <ul className="mt-4 space-y-2 text-[13px]">
                {info.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <Icon name="check" size={15} className="mt-0.5 shrink-0 text-emerald-600" strokeWidth={2.4} />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <a href="#signup" className={`mt-5 w-full ${featured ? 'btn-brand' : 'btn-ghost'}`}>
                {price === 0 ? 'ফ্রি শুরু করুন' : 'বেছে নিন'}
              </a>
            </div>
          );
        })}
      </div>

      <p className="mt-5 rounded-xl bg-surface-sunk p-4 text-center text-[13px] text-ink-muted">
        মার্কেটপ্লেস থেকে আসা অর্ডারে আলাদা কমিশন — সেটা <strong className="text-ink">শুধু তখনই</strong>,
        যখন আমরা আপনাকে একজন <strong className="text-ink">নতুন</strong> কাস্টমার এনে দিই।
      </p>
    </section>
  );
}

/* ────────────────────────────────────────────────────────── roadmap ─── */

const ROADMAP: { status: 'live' | 'next' | 'later'; title: string; body: string }[] = [
  { status: 'live', title: 'নিজের দোকান + মার্কেটপ্লেস',
    body: 'নিজের ডোমেইন, মেনু, লাইভ অর্ডার প্যানেল, ডেলিভারি জোন, কুপন, নিজের পেমেন্ট গেটওয়ে। মার্কেটপ্লেসে যুক্ত হওয়া এক সুইচে।' },
  { status: 'live', title: 'অ্যানালিটিক্স, লয়্যালটি ও AI',
    body: 'বেস্ট সেলার, ব্যস্ত সময়, স্টক অ্যালার্ট, পয়েন্ট ও স্টোর ক্রেডিট, "আবার অর্ডার করুন", আর চ্যাটে অর্ডার নেওয়া।' },
  { status: 'next', title: 'WhatsApp-এ অর্ডার',
    body: 'কাস্টমার WhatsApp-এ মেসেজ দিলেই অর্ডার নেওয়া — কোড লেখা হয়ে গেছে, এখন Meta-র বিজনেস অ্যাকাউন্ট যাচাই বাকি।' },
  { status: 'next', title: 'অনলাইন পেমেন্ট চালু',
    body: 'SSLCommerz split-payout — টাকা গেটওয়ে থেকে সরাসরি আপনার অ্যাকাউন্টে যাবে, আমাদের হাত ঘুরে নয়।' },
  { status: 'later', title: 'রাইডার ও ডেলিভারি ট্র্যাকিং',
    body: 'এখন ডেলিভারি আপনার নিজের লোক দিয়ে। পরে চাইলে রাইডার নেটওয়ার্ক আর লাইভ ট্র্যাকিং যুক্ত হবে।' },
  { status: 'later', title: 'একাধিক শাখা ও ইনভেন্টরি',
    body: 'এক অ্যাকাউন্টে কয়েকটা আউটলেট, কাঁচামালের হিসাব আর স্টক শেষ হওয়ার আগেই সতর্কতা।' },
];

function Roadmap() {
  const badge = {
    live: { text: 'এখনই আছে', cls: 'bg-emerald-100 text-emerald-800' },
    next: { text: 'পরের ধাপে', cls: 'bg-amber-100 text-amber-800' },
    later: { text: 'পরিকল্পনায়', cls: 'bg-surface-sunk text-ink-muted' },
  };
  return (
    <section className="py-14">
      <SectionHead
        eyebrow="রোডম্যাপ"
        title="কী আছে, কী আসছে"
        sub="যা এখনো বানানো হয়নি সেটা আমরা 'আছে' বলে চালাই না।" />

      <ol className="mt-8 space-y-3">
        {ROADMAP.map((item) => (
          <li key={item.title} className="flex gap-4 rounded-2xl border border-surface-line bg-white p-4 shadow-card">
            <span className={`grid h-8 shrink-0 place-items-center self-start rounded-full px-2.5 text-[11px] font-bold ${badge[item.status].cls}`}>
              {badge[item.status].text}
            </span>
            <span>
              <h3 className="text-[15px] font-bold">{item.title}</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">{item.body}</p>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ────────────────────────────────────────────────────────────── faq ─── */

const FAQ = [
  { q: 'সত্যিই নিজের সাইটের অর্ডারে কোনো কমিশন নেই?',
    a: 'নেই। ওই টাকা আপনার নিজের গেটওয়ে দিয়ে সরাসরি আপনার কাছে যায় — আমাদের হাত দিয়েই যায় না। আমরা শুধু মাসিক ফি নিই।' },
  { q: 'মার্কেটপ্লেসে যোগ দেওয়া কি বাধ্যতামূলক?',
    a: 'না। এটা একটা সুইচ, যখন খুশি বন্ধ বা চালু করতে পারবেন। শুধু নিজের সাইট চালালেও পুরো সিস্টেম সমানভাবে কাজ করে।' },
  { q: 'আমার নিজের ডোমেইন না থাকলে?',
    a: 'সমস্যা নেই — সাথে সাথেই একটা FoodHub ঠিকানা পাবেন। পরে নিজের ডোমেইন কিনে যেকোনো সময় যুক্ত করতে পারবেন, SSL নিজে থেকেই হয়ে যাবে।' },
  { q: 'মেনু তুলতে কতক্ষণ লাগে?',
    a: 'অ্যাকাউন্ট খুলতে ২ মিনিট। এরপর প্রতিটা আইটেম যোগ করতে ৩০ সেকেন্ডের মতো — ছবি দিলে বাকিটা নিজে থেকেই ঠিক হয়ে যায়।' },
  { q: 'পুরনো অর্ডার আর কাস্টমারের তথ্য কি আমার থাকবে?',
    a: 'হ্যাঁ। প্রতিটা অর্ডার, প্রতিটা কাস্টমারের নম্বর আপনার নিজের ডেটা। আপনি যেকোনো সময় দেখতে ও নামাতে পারবেন।' },
];

function Faq() {
  return (
    <section className="py-14">
      <SectionHead eyebrow="সাধারণ প্রশ্ন" title="যা সবাই জানতে চান" />
      <div className="mx-auto mt-8 max-w-2xl divide-y divide-surface-line rounded-2xl border border-surface-line bg-white px-5">
        {FAQ.map((item) => (
          <details key={item.q} className="group py-4">
            <summary className="flex cursor-pointer items-center justify-between gap-3 text-[15px] font-semibold marker:content-['']">
              {item.q}
              <Icon name="chevron" size={16}
                    className="shrink-0 rotate-90 text-ink-faint transition group-open:-rotate-90" />
            </summary>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">{item.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────── signup ─── */

function FinalCta() {
  return (
    <section id="signup" className="scroll-mt-6 rounded-2xl bg-ink p-6 text-white sm:p-10">
      <div className="grid gap-8 md:grid-cols-2">
        <div>
          <h2 className="text-2xl font-extrabold leading-tight tracking-tight sm:text-3xl">
            আজই নিজের দোকান খুলুন
          </h2>
          <p className="mt-3 text-[15px] leading-relaxed text-white/70">
            কার্ড লাগবে না, চুক্তি নেই। ফর্মটা পূরণ করলেই আপনার সাইট লাইভ হয়ে যাবে —
            এরপর শুধু মেনু তুলবেন।
          </p>
          <ul className="mt-6 space-y-2.5 text-sm">
            {['সাথে সাথে আপনার দোকানের ঠিকানা', 'নিজের সাইটের অর্ডারে ০% কমিশন', 'যখন খুশি মার্কেটপ্লেসে যুক্ত হওয়া']
              .map((t) => (
                <li key={t} className="flex items-center gap-2.5">
                  <Icon name="check" size={16} className="text-emerald-400" strokeWidth={2.4} />
                  {t}
                </li>
              ))}
          </ul>
        </div>

        <div className="rounded-2xl bg-white p-5 text-ink">
          <VendorSignup adminUrl={ADMIN_URL} storefrontSuffix={`.${DOMAIN}`} />
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="mt-12 flex flex-wrap items-center justify-between gap-3 border-t border-surface-line pt-6 text-xs text-ink-muted">
      <p>© {new Date().getFullYear()} FoodHub — বাংলাদেশের রেস্টুরেন্টের জন্য।</p>
      <div className="flex gap-4">
        <Link href="/" className="hover:text-ink">মার্কেটপ্লেস</Link>
        <a href={`${ADMIN_URL}/login`} className="hover:text-ink">ভেন্ডর লগইন</a>
      </div>
    </footer>
  );
}

function SectionHead({ eyebrow, title, sub }: { eyebrow: string; title: string; sub?: string }) {
  return (
    <div className="max-w-2xl">
      <p className="text-xs font-bold uppercase tracking-widest text-brand">{eyebrow}</p>
      <h2 className="mt-2 text-2xl font-extrabold leading-tight tracking-tight sm:text-3xl">{title}</h2>
      {sub && <p className="mt-2 text-[15px] leading-relaxed text-ink-muted">{sub}</p>}
    </div>
  );
}
