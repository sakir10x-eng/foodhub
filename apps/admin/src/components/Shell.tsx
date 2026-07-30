'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { useAuth } from '../lib/auth';
import { Icon, type IconName } from './Icon';

interface NavItem { href: string; label: string; icon: IconName }

/** Vendor navigation — five thumb targets, which is all a phone bar should carry. */
const VENDOR_NAV: NavItem[] = [
  { href: '/', label: 'Today', icon: 'home' },
  { href: '/menu', label: 'Menu', icon: 'menu' },
  { href: '/orders', label: 'Orders', icon: 'orders' },
  { href: '/analytics', label: 'Insights', icon: 'chart' },
  { href: '/billing', label: 'Money', icon: 'money' },
];

/** Secondary destinations — sidebar only, to keep the phone bar uncrowded. */
const VENDOR_SECONDARY: NavItem[] = [
  { href: '/settings', label: 'Store', icon: 'store' },
  { href: '/domains', label: 'Domain', icon: 'globe' },
];

const PLATFORM_NAV: NavItem[] = [{ href: '/platform', label: 'Platform', icon: 'shield' }];

/**
 * Panel chrome. A bottom bar on phones (vendors run their kitchen from one) and a
 * sidebar from `md` up.
 *
 * The guard also enforces the role boundary in the UI: a platform admin has no tenant,
 * so every vendor screen would 403 against them. Rather than showing a wall of errors,
 * they are redirected to the console that is actually theirs.
 */
export function Shell({ children }: { children: React.ReactNode }) {
  return <Chrome nav={VENDOR_NAV} secondary={VENDOR_SECONDARY} requireRole="vendor">{children}</Chrome>;
}

export function PlatformShell({ children }: { children: React.ReactNode }) {
  return <Chrome nav={PLATFORM_NAV} secondary={[]} requireRole="platform">{children}</Chrome>;
}

function Chrome({
  children, nav, secondary, requireRole,
}: {
  children: React.ReactNode;
  nav: NavItem[];
  secondary: NavItem[];
  requireRole: 'vendor' | 'platform';
}) {
  const pathname = usePathname();
  const router = useRouter();
  const user = useAuth((s) => s.user);
  const signOut = useAuth((s) => s.signOut);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // The session lives in localStorage, so the guard can only run after hydration.
    const state = useAuth.getState();
    if (!state.accessToken) {
      router.replace('/login');
      return;
    }
    const isPlatform = state.user?.role === 'PLATFORM_ADMIN';
    // Send each role to the console it can actually use, instead of 403-ing every call.
    if (requireRole === 'vendor' && isPlatform) {
      router.replace('/platform');
      return;
    }
    if (requireRole === 'platform' && !isPlatform) {
      router.replace('/');
      return;
    }
    setReady(true);
  }, [router, requireRole]);

  if (!ready) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <div className="skeleton h-10 w-40 rounded-full" />
      </div>
    );
  }

  const isPlatform = user?.role === 'PLATFORM_ADMIN';

  return (
    <div className="min-h-dvh md:flex">
      <aside className="hidden w-56 shrink-0 border-r border-surface-line px-3 py-5 md:block">
        <p className="flex items-center gap-2 px-3 text-sm font-extrabold tracking-tight">
          <span className="grid h-6 w-6 place-items-center rounded-md bg-brand text-[10px] font-black text-white">FH</span>
          FoodHub
        </p>
        <p className="mb-5 px-3 pt-1 text-xs text-ink-muted">
          {isPlatform ? 'Platform console' : (user?.tenantSlug ?? 'vendor')}
        </p>

        <nav className="space-y-1">
          {[...nav, ...secondary].map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition',
                pathname === item.href ? 'bg-brand/10 text-brand' : 'text-ink-muted hover:bg-surface-sunk',
              )}
            >
              <Icon name={item.icon} size={17} />
              {item.label}
            </Link>
          ))}
        </nav>

        <button
          onClick={() => { signOut(); router.replace('/login'); }}
          className="mt-6 w-full rounded-lg px-3 py-2 text-left text-sm text-ink-faint hover:bg-surface-sunk"
        >
          Sign out
        </button>
      </aside>

      <div className="min-w-0 flex-1 pb-20 md:pb-0">{children}</div>

      {nav.length > 1 && (
        <nav
          className="fixed inset-x-0 bottom-0 z-30 grid border-t border-surface-line bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
          style={{ gridTemplateColumns: `repeat(${nav.length}, minmax(0, 1fr))` }}
        >
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                'flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium',
                pathname === item.href ? 'text-brand' : 'text-ink-faint',
              )}
            >
              <Icon name={item.icon} size={20} />
              {item.label}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}

export function PageHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <header className="flex items-center justify-between gap-3 border-b border-surface-line px-4 py-4">
      <h1 className="text-xl font-extrabold tracking-tight">{title}</h1>
      {action}
    </header>
  );
}

export function Banner({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error'; children: React.ReactNode }) {
  const tones = {
    info: 'bg-surface-sunk text-ink-muted',
    warn: 'bg-amber-50 text-amber-900',
    error: 'bg-red-50 text-red-700',
  };
  const icons = { info: 'sparkles', warn: 'alert', error: 'alert' } as const;
  return (
    <p
      role={tone === 'error' ? 'alert' : undefined}
      className={clsx('flex items-center gap-2 rounded-xl px-4 py-3 text-sm', tones[tone])}
    >
      <Icon name={icons[tone]} size={16} className="shrink-0" />
      <span>{children}</span>
    </p>
  );
}
