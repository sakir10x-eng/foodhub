export const metadata = { title: 'Offline — FoodHub' };

/** Served by the service worker when a navigation fails with no cached copy. */
export default function OfflinePage() {
  return (
    <main className="mx-auto grid min-h-dvh max-w-sm place-items-center px-6 text-center">
      <div>
        <p className="text-4xl" aria-hidden>
          🍽️
        </p>
        <h1 className="mt-3 text-xl font-bold">You’re offline</h1>
        <p className="mt-2 text-sm text-ink-muted">
          Menus you’ve already opened still work. Everything else is waiting for a connection.
        </p>
      </div>
    </main>
  );
}
