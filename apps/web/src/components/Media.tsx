import clsx from 'clsx';
import type { ImageRef } from '@foodhub/shared';

/** Must mirror `media.widths` in the API config — see availableWidths() below. */
const WIDTHS = [160, 320, 640, 960, 1280];

/**
 * The widths that actually exist on disk.
 *
 * The upload pipeline never upscales: it writes a derivative for each configured width
 * that is no larger than the source, plus always the smallest. Listing a width that was
 * never generated puts a 404 in the srcset, and a browser that picks it — which a retina
 * phone will — renders a broken image. So the client mirrors the same rule.
 */
function availableWidths(sourceWidth: number): number[] {
  if (!sourceWidth) return WIDTHS;
  return WIDTHS.filter((w) => w <= sourceWidth || w === WIDTHS[0]);
}

/**
 * Responsive image off the derivative ladder the API produced on upload.
 *
 * Images are ~70% of page weight on a food site, so the browser is given a full
 * `<picture>`: AVIF first when it exists (typically 5-8x smaller than the WebP here),
 * WebP as the universal fallback. The LQIP is painted as the background so a card is
 * never a blank rectangle while the real file lands.
 */
export function Dish({
  image,
  alt,
  sizes = '(min-width: 768px) 200px, 33vw',
  className,
  priority = false,
}: {
  image: ImageRef | null;
  alt: string;
  sizes?: string;
  className?: string;
  priority?: boolean;
}) {
  if (!image) {
    return (
      <div
        className={clsx('grid place-items-center bg-surface-sunk text-ink-faint', className)}
        aria-hidden
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M3 17l5-5 3 3 4-4 6 6" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="8.5" cy="8" r="1.6" />
        </svg>
      </div>
    );
  }

  const widths = availableWidths(image.width);
  const srcSet = (ext: string) => widths.map((w) => `${image.url}-${w}.${ext} ${w}w`).join(', ');
  const fallbackWidth = widths.includes(640) ? 640 : widths[widths.length - 1];

  const loading = priority ? 'eager' : 'lazy';
  const style = image.blurhash
    ? { backgroundImage: `url(${image.blurhash})`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : undefined;

  return (
    <picture>
      {/*
        The hero image, started during HTML parse.

        Without this the browser cannot discover the cover photo until it has parsed the
        stylesheet and laid the page out — which on a phone is most of a second of doing
        nothing about the single largest thing on screen. React 19 hoists this into <head>.
        Only ever emitted for `priority` images: preloading everything is the same as
        preloading nothing, and worse, because it competes with what actually matters.
      */}
      {priority && (
        <link
          rel="preload"
          as="image"
          href={`${image.url}-${fallbackWidth}.webp`}
          imageSrcSet={srcSet(image.hasAvif ? 'avif' : 'webp')}
          imageSizes={sizes}
          type={image.hasAvif ? 'image/avif' : 'image/webp'}
          fetchPriority="high"
        />
      )}
      {/* Only offered once the queued AVIF encode has landed — a browser does NOT fall
          back to the next source if a listed one 404s. */}
      {image.hasAvif && <source type="image/avif" srcSet={srcSet('avif')} sizes={sizes} />}
      <source type="image/webp" srcSet={srcSet('webp')} sizes={sizes} />
      <img
        src={`${image.url}-${fallbackWidth}.webp`}
        alt={alt}
        width={image.width || undefined}
        height={image.height || undefined}
        loading={loading}
        decoding={priority ? 'sync' : 'async'}
        fetchPriority={priority ? 'high' : 'auto'}
        className={clsx('object-cover', className)}
        style={style}
      />
    </picture>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('skeleton', className)} aria-hidden />;
}

export function MenuSkeleton() {
  return (
    <div className="space-y-6 px-4 py-5">
      {[0, 1].map((section) => (
        <section key={section} className="space-y-3">
          <Skeleton className="h-5 w-32" />
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex gap-3">
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-4 w-16" />
              </div>
              <Skeleton className="h-[76px] w-[76px] shrink-0 rounded-xl" />
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

export function VendorListSkeleton() {
  return (
    <div className="grid gap-4 px-4 py-5 sm:grid-cols-2 lg:grid-cols-3">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="card overflow-hidden">
          <Skeleton className="h-32 w-full rounded-none" />
          <div className="space-y-2 p-3">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        </div>
      ))}
    </div>
  );
}
