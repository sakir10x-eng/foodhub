/**
 * Browser-side API client. Deliberately free of `next/headers` so client components can
 * import it — the server-side helper lives in ./api.ts and imports ApiError from here.
 */
/**
 * Empty means "same origin": in production the edge routes /api on every hostname —
 * marketplace, each vendor storefront, each custom domain — to the API, so the browser
 * never makes a cross-origin request and there is no CORS surface at all.
 * Set NEXT_PUBLIC_API_URL only when the API lives somewhere else (local dev).
 */
export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export async function clientApi<T>(
  path: string,
  init: RequestInit & { tenantHost?: string } = {},
): Promise<T> {
  const { tenantHost, ...rest } = init;
  // The Host header tells the API which vendor this call is about; on a vendor's own
  // domain that is simply the page's own host.
  const host = tenantHost ?? (typeof window !== 'undefined' ? window.location.host : '');

  const res = await fetch(`${API_BASE}/api${path}`, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...(host ? { 'X-Tenant-Host': host } : {}),
      ...(rest.headers as Record<string, string>),
    },
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(body?.message ?? 'Request failed', res.status, body?.code);
  return body as T;
}
