import type { Config } from 'tailwindcss';

/** The vendor panel is used on a phone in a kitchen as often as on a laptop. */
export default {
  // The delivery-area editor lives in a workspace package; Tailwind only emits
  // classes it can see, so a glob that stops at ./src ships an unstyled map.
  content: ['./src/**/*.{ts,tsx}', '../../packages/mapkit/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: 'rgb(var(--brand) / <alpha-value>)', soft: 'rgb(var(--brand-soft) / <alpha-value>)' },
        ink: { DEFAULT: '#12100E', muted: '#6B6560', faint: '#9C948C' },
        // `edge` is the heavier rule the shared map components draw with.
        surface: { DEFAULT: '#FFFFFF', sunk: '#F6F4F1', line: '#E9E4DE', edge: '#E0DAD2' },
      },
      borderRadius: { xl: '14px', '2xl': '20px' },
      boxShadow: {
        card: '0 1px 2px rgba(18,16,14,.05), 0 4px 16px -8px rgba(18,16,14,.12)',
        bar: '0 -4px 24px -8px rgba(18,16,14,.18)',
        // Controls that float ON the map rather than in the page.
        float: '0 4px 10px rgba(20,20,40,.14)',
      },
      keyframes: {
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        'pop-in': { from: { transform: 'scale(.96)', opacity: '0' }, to: { transform: 'scale(1)', opacity: '1' } },
      },
      animation: { shimmer: 'shimmer 1.4s infinite', 'pop-in': 'pop-in .18s cubic-bezier(.22,1,.36,1)' },
    },
  },
  plugins: [],
} satisfies Config;
