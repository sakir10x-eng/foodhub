'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * Bengali for the customer app.
 *
 * A dictionary and a hook rather than a routing library: the customer app is one phone
 * column of short strings, and `next-intl`'s locale segment would fork every URL in the
 * product — /m, /s, /order/[code] and every vendor's own domain — for copy that fits in
 * one file. The trade-off is deliberate and has one visible consequence, below.
 *
 * WHY THE FIRST PAINT IS ENGLISH. The storefront pages are statically rendered and
 * edge-cached; reading a locale cookie on the server would make every one of them
 * dynamic and throw away that cache. So the server always renders English (which is also
 * what Google indexes), and a reader who has chosen Bengali gets it at hydration. The
 * alternative — two cached copies of every page — is worth doing when there is traffic to
 * justify it, and this module is the only thing that would change.
 *
 * Keys are `surface.thing`. A missing Bengali key falls back to English rather than
 * showing the key, because a half-translated screen is still usable and a screen full of
 * `checkout.placeOrder` is not.
 */

export type Locale = 'en' | 'bn';

const STORAGE_KEY = 'fh_lang';

const en = {
  'nav.language': 'বাংলা',
  'nav.forRestaurants': 'For restaurants',

  'home.title': 'What are you eating today?',
  'home.subtitle': 'Restaurants delivering in Dhaka',
  'home.count_one': '{n} restaurant',
  'home.count_other': '{n} restaurants',
  'home.empty': 'No restaurants are listed yet. Check back shortly.',
  'home.noMatch': 'No restaurants match these filters.',
  'home.clearFilters': 'Clear filters',

  'filter.all': 'All',
  'filter.openNow': 'Open now',
  'filter.freeDelivery': 'Free delivery',
  'filter.sort': 'Sort',
  'filter.sort.relevance': 'Recommended',
  'filter.sort.rating': 'Top rated',
  'filter.sort.eta': 'Fastest',
  'filter.sort.fee': 'Lowest delivery fee',
  'filter.sort.distance': 'Nearest',

  'vendor.closed': 'Closed',
  'vendor.sponsored': 'Sponsored',
  'vendor.new': 'New',
  'vendor.deliveryFee': 'Delivery',
  'vendor.free': 'Free',

  'order.cancel': 'Cancel order',
  'order.cancel.title': 'Cancel this order?',
  'order.cancel.body': 'The restaurant will be told straight away. This cannot be undone.',
  'order.cancel.reason': 'Reason (optional)',
  'order.cancel.confirm': 'Yes, cancel it',
  'order.cancel.keep': 'Keep my order',
  'order.cancel.done': 'Your order has been cancelled.',
  'order.cancel.tooLate': 'The kitchen has already started, so this can no longer be cancelled here.',
  'order.refundDue': 'You paid {amount} online. The restaurant will refund it.',
  'order.eta': 'Arriving {window}',
  'order.etaPickup': 'Ready {window}',
  'order.delivered': 'Delivered',
  'order.cancelled': 'Cancelled',
} as const;

type Key = keyof typeof en;

/**
 * Bengali. Written the way a Dhaka customer reads a food app — English loanwords stay
 * where that is what people actually say ("অর্ডার", "ডেলিভারি"); nothing is translated
 * into Sanskritised Bengali that nobody uses out loud.
 */
const bn: Partial<Record<Key, string>> = {
  'nav.language': 'English',
  'nav.forRestaurants': 'রেস্টুরেন্টের জন্য',

  'home.title': 'আজ কী খাবেন?',
  'home.subtitle': 'ঢাকায় ডেলিভারি দিচ্ছে এমন রেস্টুরেন্ট',
  'home.count_one': '{n}টি রেস্টুরেন্ট',
  'home.count_other': '{n}টি রেস্টুরেন্ট',
  'home.empty': 'এখনো কোনো রেস্টুরেন্ট যুক্ত হয়নি। একটু পরে আবার দেখুন।',
  'home.noMatch': 'এই ফিল্টারে কোনো রেস্টুরেন্ট মেলেনি।',
  'home.clearFilters': 'ফিল্টার মুছুন',

  'filter.all': 'সব',
  'filter.openNow': 'এখন খোলা',
  'filter.freeDelivery': 'ফ্রি ডেলিভারি',
  'filter.sort': 'সাজান',
  'filter.sort.relevance': 'সুপারিশকৃত',
  'filter.sort.rating': 'সেরা রেটিং',
  'filter.sort.eta': 'দ্রুততম',
  'filter.sort.fee': 'কম ডেলিভারি ফি',
  'filter.sort.distance': 'সবচেয়ে কাছে',

  'vendor.closed': 'বন্ধ',
  'vendor.sponsored': 'স্পনসর্ড',
  'vendor.new': 'নতুন',
  'vendor.deliveryFee': 'ডেলিভারি',
  'vendor.free': 'ফ্রি',

  'order.cancel': 'অর্ডার বাতিল করুন',
  'order.cancel.title': 'অর্ডারটি বাতিল করবেন?',
  'order.cancel.body': 'রেস্টুরেন্টকে সঙ্গে সঙ্গে জানানো হবে। এটি আর ফেরানো যাবে না।',
  'order.cancel.reason': 'কারণ (ইচ্ছা হলে)',
  'order.cancel.confirm': 'হ্যাঁ, বাতিল করুন',
  'order.cancel.keep': 'অর্ডার রাখব',
  'order.cancel.done': 'আপনার অর্ডার বাতিল হয়েছে।',
  'order.cancel.tooLate': 'রান্না শুরু হয়ে গেছে, তাই এখান থেকে আর বাতিল করা যাবে না।',
  'order.refundDue': 'আপনি অনলাইনে {amount} দিয়েছেন। রেস্টুরেন্ট সেটি ফেরত দেবে।',
  'order.eta': '{window}-এ পৌঁছাবে',
  'order.etaPickup': '{window}-এ তৈরি হবে',
  'order.delivered': 'ডেলিভারি হয়েছে',
  'order.cancelled': 'বাতিল',
};

const dictionaries: Record<Locale, Partial<Record<Key, string>>> = { en, bn };

/** Bengali digits, because "৩০–৪০ মিনিট" beside "30" reads as two different apps. */
export function toBnDigits(value: string | number): string {
  return String(value).replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]);
}

export function localiseDigits(value: string | number, locale: Locale): string {
  return locale === 'bn' ? toBnDigits(value) : String(value);
}

interface LocaleContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: Key, vars?: Record<string, string | number>) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  /*
   * Always 'en' for the first render, on the server AND on the client. Reading storage
   * during the initial render would make the client's markup differ from the server's,
   * which React resolves by throwing the whole tree away and re-rendering it — a far
   * worse outcome than one frame of English.
   */
  const [locale, setLocaleState] = useState<Locale>('en');

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'bn' || stored === 'en') setLocaleState(stored);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    // Lets CSS pick the Bengali face for the whole document rather than per component.
    document.documentElement.dataset.locale = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private mode with storage disabled: the choice simply does not persist.
    }
  }, []);

  const value = useMemo<LocaleContextValue>(() => {
    const table = dictionaries[locale];
    return {
      locale,
      setLocale,
      t: (key, vars) => {
        const template = table[key] ?? en[key] ?? key;
        if (!vars) return template;
        return template.replace(/\{(\w+)\}/g, (_, name: string) => {
          const v = vars[name];
          if (v === undefined) return `{${name}}`;
          return typeof v === 'number' ? localiseDigits(v, locale) : String(v);
        });
      },
    };
  }, [locale, setLocale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/**
 * Usable outside the provider on purpose — server components render the English strings
 * and never see a provider, so a missing one is a normal state rather than a crash.
 */
export function useI18n(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (ctx) return ctx;
  return {
    locale: 'en',
    setLocale: () => {},
    t: (key, vars) => {
      const template = en[key] ?? key;
      return vars ? template.replace(/\{(\w+)\}/g, (_, n: string) => String(vars[n] ?? `{${n}}`)) : template;
    },
  };
}

/**
 * One translated string, for use inside a SERVER component.
 *
 * A server component cannot call a hook, and wrapping whole pages in `'use client'` just
 * to translate a heading would ship the page's data-fetching to the browser. This is the
 * smallest possible client island: it renders the English text on the server (so the HTML
 * is complete and indexable) and swaps to Bengali at hydration if that is what the reader
 * chose.
 */
export function T({ k, vars }: { k: Key; vars?: Record<string, string | number> }) {
  const { t } = useI18n();
  return <>{t(k, vars)}</>;
}

/** Plural without pulling in Intl.PluralRules for two cases. */
export function plural(t: LocaleContextValue['t'], base: 'home.count', n: number): string {
  return t((n === 1 ? `${base}_one` : `${base}_other`) as Key, { n });
}
