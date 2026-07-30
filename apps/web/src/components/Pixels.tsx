'use client';

import Script from 'next/script';
import { useEffect } from 'react';
import type { PublicTenant } from '@foodhub/shared';

/**
 * The vendor's own ad pixels.
 *
 * These are THEIR ad accounts, not ours — a vendor running Facebook ads at their kitchen
 * cannot optimise for purchases unless a `Purchase` event fires from the page the order
 * completed on. Without it their campaign optimises for clicks, spends their money badly,
 * and the platform gets the blame.
 *
 * Loaded `afterInteractive` so a third-party tag can never delay the menu appearing, and
 * rendered only when the vendor has actually pasted an ID.
 */
export function Pixels({ tenant }: { tenant: PublicTenant }) {
  const meta = tenant.marketing?.metaPixelId;
  const tiktok = tenant.marketing?.tiktokPixelId;
  const ga4 = tenant.marketing?.ga4MeasurementId;

  if (!meta && !tiktok && !ga4) return null;

  return (
    <>
      {meta && (
        <Script id="meta-pixel" strategy="afterInteractive">
          {`!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init','${meta}');fbq('track','PageView');`}
        </Script>
      )}

      {tiktok && (
        <Script id="tiktok-pixel" strategy="afterInteractive">
          {`!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];
ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie"];
ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};
for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);
ttq.load=function(e,n){var r="https://analytics.tiktok.com/i18n/pixel/events.js";
ttq._i=ttq._i||{};ttq._i[e]=[];ttq._i[e]._u=r;ttq._t=ttq._t||{};ttq._t[e]=+new Date;
ttq._o=ttq._o||{};ttq._o[e]=n||{};var o=d.createElement("script");o.type="text/javascript";
o.async=!0;o.src=r+"?sdkid="+e+"&lib="+t;var a=d.getElementsByTagName("script")[0];
a.parentNode.insertBefore(o,a)};ttq.load('${tiktok}');ttq.page();}(window,document,'ttq');`}
        </Script>
      )}

      {ga4 && (
        <>
          <Script src={`https://www.googletagmanager.com/gtag/js?id=${ga4}`} strategy="afterInteractive" />
          <Script id="ga4" strategy="afterInteractive">
            {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}
gtag('js',new Date());gtag('config','${ga4}');`}
          </Script>
        </>
      )}
    </>
  );
}

/**
 * Fire the conversion.
 *
 * Mounted on the order confirmation page, where the sale is real. Guarded by the order
 * code in sessionStorage so a refresh — or the customer coming back to check on their
 * food — does not report the same purchase twice and inflate the vendor's ROAS.
 */
export function PurchaseEvent({
  code,
  value,
  currency = 'BDT',
}: {
  code: string;
  value: number;
  currency?: string;
}) {
  useEffect(() => {
    const key = `fh:purchase:${code}`;
    if (typeof window === 'undefined' || sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');

    const amount = value / 100;
    const w = window as any;
    try {
      w.fbq?.('track', 'Purchase', { value: amount, currency, content_type: 'product' });
      w.ttq?.track('CompletePayment', { value: amount, currency });
      w.gtag?.('event', 'purchase', { transaction_id: code, value: amount, currency });
    } catch {
      // An ad blocker removing one of these must never break the confirmation page.
    }
  }, [code, value, currency]);

  return null;
}
