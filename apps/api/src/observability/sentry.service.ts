import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RequestContext } from './request-context';

/**
 * Error reporting.
 *
 * @sentry/node is an OPTIONAL dependency: with SENTRY_DSN unset (or the package not
 * installed) every call here is a no-op, so local dev and CI need no Sentry account and
 * the import never fails the build. Install `@sentry/node` and set the DSN in production.
 */
@Injectable()
export class SentryService implements OnModuleInit {
  private readonly logger = new Logger(SentryService.name);
  private sentry: any = null;

  onModuleInit() {
    const dsn = process.env.SENTRY_DSN;
    if (!dsn) {
      this.logger.log('Error reporting: disabled (set SENTRY_DSN to enable)');
      return;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      this.sentry = require('@sentry/node');
      this.sentry.init({
        dsn,
        environment: process.env.NODE_ENV ?? 'development',
        release: process.env.GIT_SHA,
        tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
        // Vendor gateway keys and customer phone numbers must never leave the box.
        beforeSend: (event: any) => scrub(event),
      });
      this.logger.log('Error reporting: sentry');
    } catch {
      this.logger.warn('SENTRY_DSN is set but @sentry/node is not installed — reporting disabled');
    }
  }

  captureException(error: unknown): void {
    if (!this.sentry) return;
    const ctx = RequestContext.current();
    this.sentry.withScope((scope: any) => {
      if (ctx) {
        scope.setTag('request_id', ctx.requestId);
        scope.setTag('route', ctx.route);
        // Tenant is a tag so a vendor-specific outage is one filter away.
        if (ctx.tenantId) scope.setTag('tenant_id', ctx.tenantId);
        if (ctx.userId) scope.setUser({ id: ctx.userId });
      }
      this.sentry.captureException(error);
    });
  }

  captureMessage(message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    if (!this.sentry) return;
    this.sentry.captureMessage(message, level);
  }
}

const SECRET_KEYS = /pass|secret|token|key|authorization|cookie|storepassword|otp/i;
const PHONE = /\b(?:\+?880|0)1[3-9]\d{8}\b/g;

/** Strip credentials and mask BD phone numbers anywhere in the payload. */
function scrub(value: any, depth = 0): any {
  if (depth > 6 || value == null) return value;
  if (typeof value === 'string') return value.replace(PHONE, (m) => `01****${m.slice(-4)}`);
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}
