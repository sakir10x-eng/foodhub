import clsx from 'clsx';

/**
 * The column every customer-facing page is drawn inside.
 *
 * Ordering food is a one-handed, one-column task, so the layout is a phone at every size
 * rather than a phone layout that stretches into a desktop one. Past `frame:` the column
 * stops growing and becomes a card on a grey page — the same pixels a customer sees on
 * their phone, which is where essentially all of these orders are placed. A vendor
 * checking their own storefront on a laptop then sees exactly what their customers do.
 *
 * Deliberately NOT `overflow-hidden`: that would make this a scroll container and kill
 * `position: sticky` on the category rail inside. The rounded corners are applied to the
 * banner itself instead.
 */
export function AppShell({
  children,
  className,
  style,
}: {
  children: React.ReactNode;
  className?: string;
  /** Carries the vendor's `--brand` variable, so everything inside — including the
   *  fixed basket pill and the sheet — is painted in their colour. */
  style?: React.CSSProperties;
}) {
  return (
    <div className="min-h-dvh bg-surface-frame frame:py-5">
      <main
        style={style}
        className={clsx(
          'relative mx-auto min-h-dvh w-full max-w-[460px] bg-surface-page',
          'frame:min-h-[calc(100dvh-2.5rem)] frame:rounded-3xl frame:shadow-frame',
          className,
        )}
      >
        {children}
      </main>
    </div>
  );
}
