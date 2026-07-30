import 'server-only';
import { headers } from 'next/headers';
import { API_BASE, ApiError } from './client';

export { API_BASE, ApiError };

/**
 * Server-side calls go straight to the API over the internal network. Routing SSR
 * through the public hostname would mean a TLS handshake and a round trip out to the
 * edge and back for every render — and would break entirely if DNS resolved to a
 * load balancer the container cannot reach.
 */
const SERVER_BASE = process.env.API_INTERNAL_URL || API_BASE || 'http://127.0.0.1:4000';

interface Options extends RequestInit {
  /** Which vendor this call is about; forwarded as X-Tenant-Host. */
  tenantHost?: string;
  /** Seconds. Menus are cached hard; anything order-shaped omits this and goes no-store. */
  revalidate?: number;
  tags?: string[];
}

/**
 * Server-side fetch. Forwards the incoming Host so the API resolves the same tenant the
 * customer is actually looking at.
 */
export async function api<T>(path: string, opts: Options = {}): Promise<T> {
  const { tenantHost, revalidate, tags, ...init } = opts;

  const host = tenantHost ?? (await currentHost());
  const res = await fetch(`${SERVER_BASE}/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(host ? { 'X-Tenant-Host': host } : {}),
      ...(init.headers as Record<string, string>),
    },
    ...(revalidate === undefined
      ? { cache: 'no-store' as const }
      : { next: { revalidate, tags } }),
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(body?.message ?? 'Request failed', res.status, body?.code);
  return body as T;
}

export async function currentHost(): Promise<string> {
  const h = await headers();
  return h.get('x-forwarded-host') ?? h.get('host') ?? '';
}
