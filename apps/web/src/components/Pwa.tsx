'use client';

import { useEffect, useState } from 'react';

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Registers the service worker and offers installation at a moment the customer has
 * shown intent — not on first paint, which is when install prompts get dismissed
 * reflexively and never shown again.
 */
export function Pwa() {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(true);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }

    const onPrompt = (e: Event) => {
      // Chrome would otherwise show its own mini-infobar; we want to choose the moment.
      e.preventDefault();
      setPrompt(e as InstallPromptEvent);
      setDismissed(localStorage.getItem('foodhub.install.dismissed') === '1');
    };
    window.addEventListener('beforeinstallprompt', onPrompt);

    const sync = () => setOffline(!navigator.onLine);
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);

    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);

  const install = async () => {
    if (!prompt) return;
    await prompt.prompt();
    await prompt.userChoice;
    setPrompt(null);
  };

  const dismiss = () => {
    localStorage.setItem('foodhub.install.dismissed', '1');
    setDismissed(true);
  };

  return (
    <>
      {offline && (
        <div
          role="status"
          className="fixed inset-x-0 top-0 z-50 bg-ink px-4 py-2 text-center text-xs font-medium text-white"
        >
          You’re offline — the menu below is the last version we saved.
        </div>
      )}

      {prompt && !dismissed && (
        // Held inside the app column, so on a desktop it sits on the phone-width card
        // rather than stretching across the grey page behind it. 436 = the column's 460
        // less the same 12px gutter the cards inside it use.
        <div className="fixed inset-x-0 bottom-24 z-40 mx-auto flex w-[calc(100%-1.5rem)] max-w-[436px] animate-slide-up items-center gap-3 rounded-2xl border border-surface-line bg-white p-3 shadow-card">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand text-sm font-extrabold text-white">
            FH
          </span>
          <p className="min-w-0 flex-1 text-[13px] leading-snug">
            <span className="font-semibold">Add to your home screen</span>
            <span className="block text-ink-muted">Opens instantly, works on a weak connection.</span>
          </p>
          <button onClick={install} className="shrink-0 rounded-lg bg-brand px-3 py-2 text-xs font-bold text-white">
            Add
          </button>
          <button onClick={dismiss} aria-label="Not now" className="shrink-0 px-1 text-ink-faint">
            ×
          </button>
        </div>
      )}
    </>
  );
}
