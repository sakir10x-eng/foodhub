import type { Metadata, Viewport } from 'next';
import { Hind_Siliguri, Plus_Jakarta_Sans } from 'next/font/google';
import { LocaleProvider } from '../lib/i18n';
import './globals.css';

/**
 * Two families, both self-hosted at build time by next/font.
 *
 * Jakarta carries the interface — it has the tight, slightly geometric numerals a page
 * full of prices needs. Hind Siliguri sits behind it for Bengali, because a vendor writes
 * their menu in the language they cook in and a missing glyph is a broken storefront.
 * Neither costs a request to Google at runtime, and both are declared with `swap` so a
 * slow font never holds the food back.
 */
/*
 * No `weight` on Jakarta: that makes next/font serve the VARIABLE font, which is one file
 * covering 200–800 instead of one file per weight. The page was pulling sixteen font
 * files; on a phone, where the browser will only open a handful of connections at once,
 * that is the difference between text at 900ms and text at 2.5s.
 */
const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-jakarta',
  display: 'swap',
});

/*
 * Hind Siliguri has no variable cut on Google Fonts, so it is two static weights and no
 * more — regular for body text and semibold for the few headings that are Bengali. The
 * Latin subset is deliberately NOT requested: Jakarta already covers Latin, and asking
 * for it here would download a second copy of the alphabet nobody renders.
 */
const bengali = Hind_Siliguri({
  subsets: ['bengali'],
  weight: ['400', '600'],
  variable: '--font-bengali',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'FoodHub',
  description: 'Order food from restaurants near you.',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'FoodHub' },
  icons: { icon: '/icon-192.png', apple: '/icon-192.png' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Never block zoom — pinch-to-zoom is an accessibility requirement, not a nuisance.
  maximumScale: 5,
  themeColor: '#ffffff',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${jakarta.variable} ${bengali.variable}`}>
      <head>
        {/*
          Warm up the API connection during HTML parse so the first data fetch doesn't pay
          for DNS + TCP + TLS.

          Only when the API is genuinely somewhere else. In production it is same-origin,
          and this was emitting a preconnect to http://127.0.0.1:4000 on every page — a
          guaranteed-failing connection attempt on every visitor's first paint.
        */}
        {process.env.NEXT_PUBLIC_API_URL ? (
          <link rel="preconnect" href={process.env.NEXT_PUBLIC_API_URL} crossOrigin="" />
        ) : null}
      </head>
      <body>
        <LocaleProvider>{children}</LocaleProvider>
      </body>
    </html>
  );
}
