'use client';

import { useEffect, useRef, useState } from 'react';
import { formatBDT } from '@foodhub/shared';
import { clientApi } from '../lib/client';

interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

interface Reply {
  text: string;
  cart: { productId: string; name: string; qty: number; price: number }[];
  cartTotal: number;
  orderCode: string | null;
}

/**
 * Chat-to-order widget.
 *
 * The assistant owns its own cart server-side (on the conversation row) rather than
 * sharing the storefront's local cart — a customer who ordered by chat and a customer
 * who tapped through the menu are two different sessions, and merging them silently
 * would produce orders nobody intended.
 */
export function Assistant({ brandName }: { brandName: string }) {
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [cart, setCart] = useState<Reply['cart']>([]);
  const [cartTotal, setCartTotal] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const sessionId = useRef<string>('');

  useEffect(() => {
    // Stable per-browser conversation key, so closing the tab doesn't lose the order.
    let id = localStorage.getItem('foodhub.assistant.session');
    if (!id) {
      id = `web-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      localStorage.setItem('foodhub.assistant.session', id);
    }
    sessionId.current = id;

    clientApi<{ available: boolean }>('/storefront/assistant/status')
      .then((s) => setAvailable(s.available))
      .catch(() => setAvailable(false));
  }, []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [turns, busy]);

  if (!available) return null;

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const message = draft.trim();
    if (!message || busy) return;

    setTurns((t) => [...t, { role: 'user', text: message }]);
    setDraft('');
    setBusy(true);
    try {
      const reply = await clientApi<Reply>('/storefront/assistant/chat', {
        method: 'POST',
        body: JSON.stringify({ message, sessionId: sessionId.current }),
      });
      setTurns((t) => [...t, { role: 'assistant', text: reply.text }]);
      setCart(reply.cart);
      setCartTotal(reply.cartTotal);
    } catch (err) {
      setTurns((t) => [
        ...t,
        { role: 'assistant', text: (err as Error).message || 'Sorry — something went wrong. Try again?' },
      ]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {!open && (
        /*
         * Pinned to the right edge of the app column, not the window. On a desktop the
         * page is a phone-width card, and a launcher glued to the browser's right edge
         * floats in the grey beside it. The rail itself ignores pointer events so it
         * cannot swallow taps meant for the menu underneath.
         */
        <div className="pointer-events-none fixed inset-x-0 bottom-24 z-40 mx-auto flex w-full max-w-[460px] justify-end px-4">
          <button
            onClick={() => {
              setOpen(true);
              if (turns.length === 0) {
                setTurns([
                  {
                    role: 'assistant',
                    text: `Hi! I can help you order from ${brandName}. What are you in the mood for?`,
                  },
                ]);
              }
            }}
            aria-label="Order by chat"
            className="pointer-events-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand text-white shadow-float transition active:scale-90"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12Z" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex flex-col bg-white sm:inset-auto sm:bottom-6 sm:right-6 sm:h-[560px] sm:w-[380px] sm:rounded-2xl sm:border sm:border-surface-line sm:shadow-card">
          <header className="flex items-center justify-between border-b border-surface-line px-4 py-3">
            <div>
              <p className="text-sm font-bold">Order by chat</p>
              <p className="text-xs text-ink-muted">{brandName}</p>
            </div>
            <button onClick={() => setOpen(false)} aria-label="Close chat" className="grid h-9 w-9 place-items-center rounded-full bg-surface-sunk">
              ×
            </button>
          </header>

          <div ref={scroller} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {turns.map((turn, i) => (
              <div
                key={i}
                className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-[14px] leading-relaxed ${
                  turn.role === 'user'
                    ? 'ml-auto bg-brand text-white'
                    : 'mr-auto bg-surface-sunk text-ink'
                }`}
              >
                {turn.text}
              </div>
            ))}
            {busy && (
              <div className="mr-auto flex gap-1 rounded-2xl bg-surface-sunk px-3 py-3">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-faint"
                    style={{ animationDelay: `${i * 150}ms` }}
                  />
                ))}
              </div>
            )}
          </div>

          {cart.length > 0 && (
            <div className="border-t border-surface-line bg-surface-sunk px-4 py-2 text-xs">
              <p className="font-semibold">
                In your chat order · {formatBDT(cartTotal)}
              </p>
              <p className="truncate text-ink-muted">
                {cart.map((c) => `${c.qty}× ${c.name}`).join(', ')}
              </p>
            </div>
          )}

          <form onSubmit={send} className="flex gap-2 border-t border-surface-line p-3">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="e.g. two kacchi and a borhani"
              aria-label="Message"
              className="field flex-1"
              enterKeyHint="send"
            />
            <button disabled={busy || !draft.trim()} className="btn-brand shrink-0 px-4" aria-label="Send">
              →
            </button>
          </form>
        </div>
      )}
    </>
  );
}
