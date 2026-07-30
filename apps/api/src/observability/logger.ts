import { ConsoleLogger, LogLevel } from '@nestjs/common';
import { RequestContext } from './request-context';

/**
 * Structured JSON logs in production, human-readable in development.
 *
 * Grafana/Loki can't do anything with `[Nest] 4592 - LOG [OrdersService] Order FH...`;
 * it can filter, group and alert on `{"level":"info","tenantId":"…","requestId":"…"}`.
 * Every line automatically carries the request id and tenant from RequestContext.
 */
export class StructuredLogger extends ConsoleLogger {
  private readonly json = process.env.LOG_FORMAT === 'json' || process.env.NODE_ENV === 'production';

  log(message: any, ...rest: any[]) {
    this.emit('info', message, rest);
  }
  warn(message: any, ...rest: any[]) {
    this.emit('warn', message, rest);
  }
  error(message: any, ...rest: any[]) {
    this.emit('error', message, rest);
  }
  debug(message: any, ...rest: any[]) {
    if (!this.isLevelEnabled('debug' as LogLevel)) return;
    this.emit('debug', message, rest);
  }
  verbose(message: any, ...rest: any[]) {
    if (!this.isLevelEnabled('verbose' as LogLevel)) return;
    this.emit('debug', message, rest);
  }

  private emit(level: string, message: any, rest: any[]) {
    if (!this.json) {
      // Development: fall through to Nest's coloured console output.
      const ctx = RequestContext.current();
      const suffix = ctx?.requestId ? ` (req ${ctx.requestId.slice(0, 8)})` : '';
      const method = level === 'warn' ? super.warn : level === 'error' ? super.error : super.log;
      method.call(this, typeof message === 'string' ? message + suffix : message, ...rest);
      return;
    }

    const ctx = RequestContext.current();
    const context = rest.find((r) => typeof r === 'string');
    const stack = rest.find((r) => typeof r === 'string' && r.includes('\n    at '));

    process.stdout.write(
      JSON.stringify({
        level,
        time: new Date().toISOString(),
        msg: typeof message === 'string' ? message : safeStringify(message),
        context: context ?? undefined,
        requestId: ctx?.requestId,
        tenantId: ctx?.tenantId ?? undefined,
        userId: ctx?.userId ?? undefined,
        route: ctx?.route,
        stack: level === 'error' ? stack : undefined,
      }) + '\n',
    );
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
