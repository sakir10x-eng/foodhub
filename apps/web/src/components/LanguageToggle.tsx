'use client';

import { useI18n } from '../lib/i18n';
import { Icon } from './Icon';

/**
 * One tap between Bengali and English.
 *
 * The button shows the language you would switch TO, not the one you are in — a control
 * labelled with the current state reads as "you are here" and nobody presses it.
 */
export function LanguageToggle({ className = '' }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();

  return (
    <button
      type="button"
      onClick={() => setLocale(locale === 'bn' ? 'en' : 'bn')}
      aria-label={locale === 'bn' ? 'Switch to English' : 'বাংলায় দেখুন'}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border border-surface-line px-3 py-2 text-xs font-semibold text-ink-muted transition hover:border-brand hover:text-brand ${className}`}
    >
      <Icon name="globe" size={14} />
      {t('nav.language')}
    </button>
  );
}
