function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const configuration = () => ({
  env: process.env.NODE_ENV ?? 'development',
  port: int(process.env.PORT, 4000),

  /** Apex domain for vendor subdomains: <slug>.PLATFORM_DOMAIN */
  platformDomain: process.env.PLATFORM_DOMAIN ?? 'lvh.me:3000',
  /** Host that serves the mother marketplace. */
  marketplaceHost: process.env.MARKETPLACE_HOST ?? 'lvh.me:3000',
  /** What vendors CNAME to when connecting a custom domain. */
  cnameTarget: process.env.CNAME_TARGET ?? 'edge.foodhub.com.bd',

  corsOrigins: list(process.env.CORS_ORIGINS),

  jwt: {
    secret: process.env.JWT_SECRET ?? 'dev-only-jwt-secret-change-me',
    accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    refreshTtlDays: int(process.env.JWT_REFRESH_TTL_DAYS, 30),
  },

  redisUrl: process.env.REDIS_URL || null,

  media: {
    driver: (process.env.MEDIA_DRIVER ?? 'local') as 'local' | 's3',
    localDir: process.env.MEDIA_DIR ?? 'storage/media',
    publicBase: process.env.MEDIA_PUBLIC_BASE ?? '/media',
    cdnBase: process.env.CDN_BASE ?? '',
    /** Widths emitted for responsive srcset. */
    widths: [160, 320, 640, 960, 1280],
    maxUploadBytes: int(process.env.MAX_UPLOAD_BYTES, 8 * 1024 * 1024),
  },

  marketplace: {
    /** Platform commission applied to new vendors, in basis points. */
    defaultCommissionBps: int(process.env.DEFAULT_COMMISSION_BPS, 1500),
    /** Gateway fee we absorb on marketplace orders, in basis points of total. */
    gatewayFeeBps: int(process.env.GATEWAY_FEE_BPS, 250),
    /** Radius for "near me" in km. */
    nearMeRadiusKm: int(process.env.NEAR_ME_RADIUS_KM, 8),
    settlementCron: process.env.SETTLEMENT_CRON ?? '0 3 * * 1', // Mondays 03:00
  },

  /**
   * Turning a pin into an address and back.
   *
   * Two providers behind one interface. Google's Bangladeshi address data is markedly
   * better and it is what a vendor will ask for by name; OpenStreetMap needs no key, no
   * billing account and no approval, so it is what the product falls back to rather than
   * shipping a dead map. The server key is deliberately separate from the browser key:
   * this one is never sent to a client and should be IP-restricted, not referrer-restricted.
   */
  geo: {
    googleKey: process.env.GOOGLE_MAPS_SERVER_KEY || process.env.GOOGLE_MAPS_KEY || '',
    nominatimBase: process.env.NOMINATIM_BASE_URL ?? 'https://nominatim.openstreetmap.org',
    /** Nominatim's usage policy requires a real, identifying User-Agent. */
    userAgent: process.env.GEO_USER_AGENT ?? 'FoodHub/1.0 (+https://goodfood.72-61-244-150.sslip.io)',
    /** Bias results to Bangladesh — a search for "Mirpur" should not land in Pakistan. */
    countryCode: process.env.GEO_COUNTRY ?? 'bd',
  },

  billing: {
    cron: process.env.BILLING_CRON ?? '0 2 * * *',
    graceDays: int(process.env.BILLING_GRACE_DAYS, 7),
  },

  payments: {
    /** OUR marketplace gateway (Mode B). Vendors' own keys live encrypted per-tenant. */
    sslcommerz: {
      storeId: process.env.SSLCZ_STORE_ID ?? '',
      storePassword: process.env.SSLCZ_STORE_PASSWORD ?? '',
      sandbox: bool(process.env.SSLCZ_SANDBOX, true),
      /** Split-payout keeps customer funds out of our hands — see the regulatory note. */
      splitPayout: bool(process.env.SSLCZ_SPLIT_PAYOUT, true),
    },
    /**
     * Lets the mock gateway run outside development.
     *
     * Off by default and named to be impossible to set by accident: with it on, ANY
     * order can be marked paid from a URL. It exists so a demo deployment with no
     * merchant account can still walk the full money pipeline. Never set it on a
     * deployment that handles real orders.
     */
    allowMockInProduction: bool(process.env.DEMO_ALLOW_MOCK_PAYMENTS, false),
    /**
     * OUR bKash merchant account (Mode B). Preferred over SSLCommerz when set: it is the
     * wallet most customers here hold, and it skips an aggregator's cut.
     */
    bkash: {
      appKey: process.env.BKASH_APP_KEY ?? '',
      appSecret: process.env.BKASH_APP_SECRET ?? '',
      username: process.env.BKASH_USERNAME ?? '',
      password: process.env.BKASH_PASSWORD ?? '',
      sandbox: bool(process.env.BKASH_SANDBOX, true),
    },
    successUrl: process.env.PAYMENT_SUCCESS_URL ?? 'http://lvh.me:3000/order',
    failUrl: process.env.PAYMENT_FAIL_URL ?? 'http://lvh.me:3000/checkout?failed=1',
  },

  notifications: {
    /**
     * sms.net.bd. Order copy is kept ASCII on this channel on purpose — a single Bengali
     * character switches the message to UCS-2 and triples the per-message cost.
     */
    sms: {
      apiKey: process.env.SMS_API_KEY ?? '',
      senderId: process.env.SMS_SENDER_ID ?? '',
    },
    /** Meta Cloud API. Same number as the ordering bot's webhook. */
    whatsapp: {
      token: process.env.WHATSAPP_TOKEN ?? '',
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? '',
    },
    /** Mailgun HTTP API — vendor-facing mail only; customers here do not read email. */
    email: {
      apiKey: process.env.MAILGUN_API_KEY ?? '',
      domain: process.env.MAILGUN_DOMAIN ?? '',
      from: process.env.MAIL_FROM ?? '',
    },
  },

  push: {
    /**
     * VAPID keys identify this server to the browser's push service. Generate once with
     * `npx web-push generate-vapid-keys`; the public half is handed to the browser and
     * the private half never leaves here.
     */
    vapid: {
      publicKey: process.env.VAPID_PUBLIC_KEY ?? '',
      privateKey: process.env.VAPID_PRIVATE_KEY ?? '',
      subject: process.env.VAPID_SUBJECT ?? '',
    },
  },

  cache: {
    menuTtlSeconds: int(process.env.MENU_CACHE_TTL, 300),
  },
});

export type AppConfig = ReturnType<typeof configuration>;
