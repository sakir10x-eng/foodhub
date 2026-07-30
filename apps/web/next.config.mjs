/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The shared package ships TypeScript sources; Next compiles it with the app.
  transpilePackages: ['@foodhub/shared', '@foodhub/mapkit'],
  poweredByHeader: false,
  compress: true,
  experimental: {
    // Ship only the icons/helpers actually imported.
    optimizePackageImports: ['@foodhub/shared'],
  },
  async headers() {
    // A year, in seconds. Anything whose URL changes when its bytes change gets it.
    const forever = 'public, max-age=31536000, immutable';
    return [
      {
        // Image derivatives are content-addressed by upload id — safe to cache forever.
        source: '/media/:path*',
        headers: [{ key: 'Cache-Control', value: forever }],
      },
      {
        // PWA icons. These were being re-fetched on every single visit at max-age=0,
        // which is three requests a customer pays for and never sees the benefit of.
        // The filenames are fixed, so a year is only safe because we would rename them
        // to change them — which is exactly what we would do.
        source: '/:icon(icon-192.png|icon-512.png|icon-maskable.png|favicon.ico)',
        headers: [{ key: 'Cache-Control', value: forever }],
      },
      {
        // The manifest DOES change (name, colours, shortcuts), so it is cached for a day
        // and revalidated rather than pinned for a year.
        source: '/manifest.webmanifest',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=86400, stale-while-revalidate=604800' }],
      },
      {
        /*
         * The service worker is the one file that must NEVER be cached hard.
         * A stale sw.js is how a PWA gets stuck on an old build with no way for the user
         * to fix it — the browser keeps serving the worker that keeps serving the old
         * assets. Explicit rather than inherited, because this is load-bearing.
         */
        source: '/sw.js',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }],
      },
    ];
  },
};
export default nextConfig;
