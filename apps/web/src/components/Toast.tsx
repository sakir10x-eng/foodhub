'use client';

import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * One transient message at a time.
 *
 * It exists for the two moments in the ordering flow where something happens that the
 * customer did not directly ask for and would otherwise only discover later: a promo code
 * landing on the clipboard, and a cart being emptied because the next dish came from a
 * different restaurant. Both used to be silent. Everything else on this page confirms
 * itself visually — the basket count, the stepper, the sheet — and does not need a toast.
 */
interface ToastState {
  message: string | null;
  /** Bumped on every show so a repeat of the same words restarts the timer. */
  token: number;
  show: (message: string) => void;
  dismiss: () => void;
}

export const useToast = create<ToastState>((set, get) => ({
  message: null,
  token: 0,
  show: (message) => set({ message, token: get().token + 1 }),
  dismiss: () => set({ message: null }),
}));

/** Fire-and-forget helper for callers that are not React components. */
export const toast = (message: string) => useToast.getState().show(message);

export function Toaster() {
  const message = useToast((s) => s.message);
  const token = useToast((s) => s.token);
  const dismiss = useToast((s) => s.dismiss);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(dismiss, 3000);
    return () => clearTimeout(timer);
  }, [message, token, dismiss]);

  if (!message) return null;

  return (
    <div
      // `polite`, not `alert`: none of these interrupt anything, and an assertive live
      // region would cut across a screen reader mid-word to say "Copied".
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[5.5rem] z-[70] flex justify-center px-4"
    >
      <p className="animate-slide-up rounded-xl bg-ink px-4 py-3 text-center text-[13.5px] font-semibold text-white shadow-sheet">
        {message}
      </p>
    </div>
  );
}
