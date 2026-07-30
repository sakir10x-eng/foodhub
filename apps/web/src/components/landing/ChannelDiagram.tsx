import { Icon } from '../Icon';

/**
 * The whole product in one picture: two sales channels feeding one order queue.
 *
 * Animated with CSS `offset-path` rather than shipped as a GIF — it stays sharp at any
 * density, weighs nothing, and honours `prefers-reduced-motion`, which a GIF cannot.
 * The status strip below cycles a real order through the lifecycle.
 */
export function ChannelDiagram() {
  return (
    <div className="relative mx-auto w-full max-w-md" role="img"
         aria-label="আপনার নিজের ওয়েবসাইট আর FoodHub মার্কেটপ্লেস — দুই জায়গা থেকেই অর্ডার এসে একটাই কিচেন কিউতে জমা হয়">
      <div className="grid grid-cols-2 gap-3">
        <ChannelCard
          icon="store"
          title="আপনার নিজের সাইট"
          note="নিজের ডোমেইন"
          badge="কমিশন নেই"
          badgeTone="emerald"
        />
        <ChannelCard
          icon="globe"
          title="FoodHub মার্কেটপ্লেস"
          note="নতুন কাস্টমার"
          badge="কমিশন"
          badgeTone="violet"
        />
      </div>

      {/* The two feeds converging. Dots travel the paths on a loop. */}
      <svg viewBox="0 0 320 90" className="mt-1 h-24 w-full" aria-hidden>
        <path id="lane-a" d="M78 4 C78 46, 160 46, 160 86" fill="none"
              stroke="rgb(var(--brand))" strokeOpacity=".22" strokeWidth="2" strokeDasharray="4 4" />
        <path id="lane-b" d="M242 4 C242 46, 160 46, 160 86" fill="none"
              stroke="rgb(var(--brand))" strokeOpacity=".22" strokeWidth="2" strokeDasharray="4 4" />
        <circle r="4.5" fill="#10B981" className="flow-dot"
                style={{ offsetPath: 'path("M78 4 C78 46, 160 46, 160 86")' }} />
        <circle r="4.5" fill="#8B5CF6" className="flow-dot"
                style={{ offsetPath: 'path("M242 4 C242 46, 160 46, 160 86")', animationDelay: '1.6s' }} />
      </svg>

      {/* One queue. One panel. */}
      <div className="relative -mt-3 rounded-2xl border border-surface-line bg-white p-4 shadow-card">
        <span className="absolute -top-2 left-1/2 h-4 w-4 -translate-x-1/2 rotate-45 border-l border-t border-surface-line bg-white" />
        <p className="flex items-center gap-2 text-sm font-bold">
          <span className="relative grid h-8 w-8 place-items-center rounded-lg bg-brand/10 text-brand">
            <span className="pulse-ring absolute inset-0 rounded-lg bg-brand/25" />
            <Icon name="orders" size={16} className="relative" />
          </span>
          একটাই অর্ডার প্যানেল
        </p>

        <div className="mt-3 flex items-center justify-between rounded-xl bg-surface-sunk px-3 py-2.5">
          <span className="text-sm">
            <span className="block font-semibold">FH1A4K</span>
            <span className="block text-xs text-ink-muted">২× মাটন কাচ্চি · ৳৯০০</span>
          </span>
          {/* A reel of statuses; only one row is visible through the 2rem window. */}
          <span className="h-8 overflow-hidden text-right">
            <span className="status-reel block">
              {['নতুন অর্ডার', 'রান্না হচ্ছে', 'রওনা দিয়েছে', 'ডেলিভার হয়েছে'].map((label, i) => (
                <span key={label} className="flex h-8 items-center justify-end gap-1.5 text-xs font-bold whitespace-nowrap">
                  <span className={`h-1.5 w-1.5 rounded-full ${i === 3 ? 'bg-emerald-500' : 'bg-brand'}`} />
                  {label}
                </span>
              ))}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

function ChannelCard({
  icon, title, note, badge, badgeTone,
}: {
  icon: 'store' | 'globe';
  title: string;
  note: string;
  badge: string;
  badgeTone: 'emerald' | 'violet';
}) {
  const tone =
    badgeTone === 'emerald' ? 'bg-emerald-100 text-emerald-800' : 'bg-violet-100 text-violet-700';
  return (
    <div className="rounded-2xl border border-surface-line bg-white p-3 shadow-card">
      <span className="grid h-9 w-9 place-items-center rounded-lg bg-surface-sunk text-ink-muted">
        <Icon name={icon} size={18} />
      </span>
      <p className="mt-2 text-[13px] font-bold leading-tight">{title}</p>
      <p className="text-[11px] text-ink-muted">{note}</p>
      <span className={`mt-2 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold ${tone}`}>{badge}</span>
    </div>
  );
}
