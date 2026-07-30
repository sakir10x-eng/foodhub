import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestInfo {
  requestId: string;
  method: string;
  route: string;
  tenantId: string | null;
  userId: string | null;
  startedAt: number;
}

const storage = new AsyncLocalStorage<RequestInfo>();

/**
 * Per-request correlation data, carried through async boundaries.
 *
 * Every log line, metric and error report picks the request id up from here, so a
 * customer complaint with one id in the response header is traceable across the API
 * log, the queue worker it spawned, and Sentry — without threading a context object
 * through fifteen function signatures.
 */
export const RequestContext = {
  run<T>(partial: Partial<RequestInfo>, fn: () => T): T {
    return storage.run(
      {
        requestId: partial.requestId ?? randomUUID(),
        method: partial.method ?? '-',
        route: partial.route ?? '-',
        tenantId: partial.tenantId ?? null,
        userId: partial.userId ?? null,
        startedAt: Date.now(),
      },
      fn,
    );
  },

  current(): RequestInfo | null {
    return storage.getStore() ?? null;
  },

  /** Filled in later by the guard, once the tenant and user are known. */
  attach(fields: Partial<Pick<RequestInfo, 'tenantId' | 'userId' | 'route'>>): void {
    const store = storage.getStore();
    if (!store) return;
    Object.assign(store, fields);
  },

  id(): string | null {
    return storage.getStore()?.requestId ?? null;
  },
};
