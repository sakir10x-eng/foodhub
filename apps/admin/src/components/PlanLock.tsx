'use client';

import Link from 'next/link';
import { PLANS, planRequiredFor, type Entitlements, type PlanFeature } from '@foodhub/shared';
import { Icon } from './Icon';

/**
 * The upgrade prompt that replaces a feature the current plan does not include.
 *
 * It names the plan and the price rather than saying "upgrade to unlock" — a vendor
 * deciding whether ৳1,500 a month is worth it needs the number in front of them, not one
 * more click away. The server enforces the same rule in PlanService; this is the part
 * that has to be persuasive, not the part that has to be secure.
 */
export function PlanLock({
  feature,
  entitlements,
  children,
}: {
  feature: PlanFeature;
  entitlements: Entitlements | undefined;
  children: React.ReactNode;
}) {
  // Until entitlements load, show the feature rather than a flash of "locked" —
  // wrongly telling a paying vendor they cannot do something is the worse error.
  if (!entitlements || entitlements.features.includes(feature)) return <>{children}</>;

  const needed = planRequiredFor(feature);
  const spec = PLANS[needed];

  return (
    <div className="relative overflow-hidden rounded-2xl border border-surface-line bg-white shadow-card">
      {/* The real UI stays visible underneath — a vendor should see what they are buying. */}
      <div aria-hidden className="pointer-events-none select-none opacity-35 blur-[1.5px]">
        {children}
      </div>

      <div className="absolute inset-0 grid place-items-center bg-white/55 p-4 backdrop-blur-[2px]">
        <div className="max-w-sm text-center">
          <span className="mx-auto grid h-10 w-10 place-items-center rounded-full bg-ink text-white">
            <Icon name="lock" size={18} strokeWidth={2.2} />
          </span>
          <p className="mt-2.5 text-[15px] font-bold">
            {spec.label} plan · ৳{(spec.price / 100).toLocaleString('en-BD')}/month
          </p>
          <p className="mt-1 text-[13px] leading-snug text-ink-muted">{spec.pitch}</p>
          <Link href="/billing" className="btn-brand mt-3 h-10 min-h-0 w-full text-sm">
            See plans
          </Link>
        </div>
      </div>
    </div>
  );
}

/** Compact inline variant for a single control rather than a whole section. */
export function PlanBadge({ feature, entitlements }: { feature: PlanFeature; entitlements: Entitlements | undefined }) {
  if (!entitlements || entitlements.features.includes(feature)) return null;
  const needed = planRequiredFor(feature);
  return (
    <Link
      href="/billing"
      className="inline-flex items-center gap-1 rounded-full bg-ink/8 px-2 py-0.5 text-[11px] font-bold text-ink-muted transition hover:bg-ink/12"
    >
      <Icon name="lock" size={11} strokeWidth={2.4} />
      {PLANS[needed].label}
    </Link>
  );
}
