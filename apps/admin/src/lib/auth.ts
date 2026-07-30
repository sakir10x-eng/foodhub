'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AuthResponse, AuthUser } from '@foodhub/shared';

/** Empty means same origin — the edge routes /api on the admin host to the API too. */
export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: AuthUser | null;
  setSession: (session: AuthResponse) => void;
  signOut: () => void;
}

export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      setSession: (session) =>
        set({ accessToken: session.accessToken, refreshToken: session.refreshToken, user: session.user }),
      signOut: () => set({ accessToken: null, refreshToken: null, user: null }),
    }),
    { name: 'foodhub.admin.session' },
  ),
);

let refreshing: Promise<string | null> | null = null;

/**
 * Authenticated API client.
 *
 * Access tokens are short-lived (15m), so a 401 transparently redeems the refresh token
 * once and retries. Concurrent 401s share a single refresh — otherwise a dashboard that
 * fires six requests at load would burn six refresh tokens and rotate itself out.
 */
export async function adminApi<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const { accessToken } = useAuth.getState();

  const res = await fetch(`${API_BASE}/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(init.headers as Record<string, string>),
    },
  });

  if (res.status === 401 && retry) {
    const fresh = await refreshSession();
    if (fresh) return adminApi<T>(path, init, false);
    useAuth.getState().signOut();
    if (typeof window !== 'undefined') window.location.href = '/login';
    throw new ApiError('Session expired', 401);
  }

  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(body?.message ?? 'Request failed', res.status, body?.code);
  return body as T;
}

async function refreshSession(): Promise<string | null> {
  if (refreshing) return refreshing;
  const { refreshToken } = useAuth.getState();
  if (!refreshToken) return null;

  refreshing = (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) return null;
      const session: AuthResponse = await res.json();
      useAuth.getState().setSession(session);
      return session.accessToken;
    } catch {
      return null;
    } finally {
      refreshing = null;
    }
  })();

  return refreshing;
}

/** Upload goes through fetch directly — FormData must not carry a JSON content-type. */
export async function uploadImage(file: File): Promise<{ id: string; url: string }> {
  const { accessToken } = useAuth.getState();
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${API_BASE}/api/media/upload`, {
    method: 'POST',
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    body: form,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(body?.message ?? 'Upload failed', res.status);
  return body;
}
