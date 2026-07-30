'use client';

import { useEffect, useState } from 'react';
import { clientApi } from '../lib/client';
import { Icon } from './Icon';

/**
 * The notification opt-in, shown on the order tracker rather than on arrival.
 *
 * Asking for notification permission the moment someone opens a menu is how permission
 * prompts get denied forever — the browser only lets you ask once, and a stranger has no
 * reason to say yes. Asked here, the customer has an order in the oven and a concrete
 * reason to want to know when it moves, which is the difference between a 5% and a 50%
 * acceptance rate.
 */
export function PushOptIn({ phone }: { phone: string }) {
  const [state, setState] = useState<'idle' | 'unsupported' | 'granted' | 'denied' | 'busy'>('idle');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      setState('unsupported');
      return;
    }
    if (Notification.permission === 'granted') setState('granted');
    if (Notification.permission === 'denied') setState('denied');
  }, []);

  const enable = async () => {
    setState('busy');
    try {
      const { publicKey, enabled } = await clientApi<{ publicKey: string; enabled: boolean }>('/storefront/push/key');
      if (!enabled || !publicKey) {
        setState('unsupported');
        return;
      }

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'denied' : 'idle');
        return;
      }

      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          // Chrome refuses a subscription that cannot show a notification, so this is not
          // optional even though we always do show one.
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        }));

      const json = subscription.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
      await clientApi('/storefront/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, phone }),
      });
      setState('granted');
    } catch {
      // A failed opt-in must never break the page the customer came here for.
      setState('idle');
    }
  };

  if (state === 'unsupported' || state === 'denied') return null;

  if (state === 'granted') {
    return (
      <p className="mt-3 flex items-center justify-center gap-1.5 text-[12.5px] text-ink-faint">
        <Icon name="check" size={13} strokeWidth={2.4} className="text-emerald-600" />
        We&rsquo;ll notify you as your order moves.
      </p>
    );
  }

  return (
    <button
      onClick={enable}
      disabled={state === 'busy'}
      className="btn-ghost mt-3 w-full gap-2 text-sm"
    >
      <Icon name="bell" size={16} />
      {state === 'busy' ? 'Turning on…' : 'Notify me when it moves'}
    </button>
  );
}

/**
 * The push API wants the VAPID key as raw bytes, not the base64url the server sends.
 *
 * Backed by an explicit ArrayBuffer because the DOM types require one — a plain
 * `Uint8Array` may be backed by a SharedArrayBuffer and is rejected by the signature.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
