import type { Config } from 'tailwindcss';

/**
 * Mobile-first by construction: the default (unprefixed) styles target a 360px phone,
 * which is the device most of our customers actually order on.
 *
 * The customer-facing pages are drawn inside a fixed-width column (see `AppShell`), so
 * `frame:` is the one breakpoint that matters here — it is the width at which that column
 * stops filling the window and becomes a card floating on the page.
 */
export default {
  // The map components live in a workspace package; Tailwind only emits classes it
  // can see, so a glob that stops at ./src silently ships an unstyled map.
  content: ['./src/**/*.{ts,tsx}', '../../packages/mapkit/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      screens: {
        frame: '520px',
      },
      colors: {
        // The vendor's brand colour is injected as a CSS variable per storefront,
        // so one component library serves every branded store.
        brand: {
          DEFAULT: 'rgb(var(--brand) / <alpha-value>)',
          soft: 'rgb(var(--brand-soft) / <alpha-value>)',
        },
        ink: {
          DEFAULT: '#17171C',
          muted: '#5E5E6C',
          faint: '#8E8E9E',
        },
        surface: {
          DEFAULT: '#FFFFFF',
          /** Inside the app column, behind the white cards. */
          page: '#F3F3F5',
          /** Outside the app column on a desktop window. */
          frame: '#E7E7EC',
          sunk: '#F1F1F5',
          line: '#ECECF0',
          /** The heavier rule, for boxes that need to read as one object. */
          edge: '#E2E2E8',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      borderRadius: { xl: '14px', '2xl': '20px', '3xl': '26px' },
      boxShadow: {
        card: '0 2px 8px rgba(20,20,30,.06)',
        frame: '0 10px 26px -12px rgba(20,20,40,.28)',
        // The floating basket and the add buttons sit ON the content rather than in it,
        // so they carry a deeper shadow than a card does.
        float: '0 4px 10px rgba(20,20,40,.14)',
        pill: '0 16px 30px -10px rgb(var(--brand) / .55)',
        sheet: '0 -8px 40px -12px rgba(15,15,25,.35)',
        bar: '0 -4px 24px -8px rgba(18,16,14,.18)',
      },
      keyframes: {
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        'slide-up': { from: { transform: 'translateY(100%)' }, to: { transform: 'translateY(0)' } },
        'pop-in': { from: { transform: 'scale(.92)', opacity: '0' }, to: { transform: 'scale(1)', opacity: '1' } },
        // The add button's confirmation: it overshoots and settles, which reads as
        // "received" without needing a word on screen.
        bump: { '0%,100%': { transform: 'scale(1)' }, '45%': { transform: 'scale(1.2)' } },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
      },
      animation: {
        shimmer: 'shimmer 1.4s infinite',
        'slide-up': 'slide-up .22s cubic-bezier(.22,1,.36,1)',
        'pop-in': 'pop-in .18s cubic-bezier(.22,1,.36,1)',
        bump: 'bump .32s ease',
        'fade-in': 'fade-in .2s ease',
      },
    },
  },
  plugins: [],
} satisfies Config;
