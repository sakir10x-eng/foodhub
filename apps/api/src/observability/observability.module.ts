import {
  CallHandler,
  Controller,
  ExecutionContext,
  Get,
  Global,
  Header,
  Injectable,
  Module,
  NestInterceptor,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { MetricsService, METRICS } from './metrics.service';
import { SentryService } from './sentry.service';
import { RequestContext } from './request-context';
import { PlatformScope, Public } from '../common/decorators';
import type { FoodhubRequest } from '../common/request-types';

/**
 * Records one histogram observation and one counter increment per request.
 *
 * Labelled by method, route template and status — never by full URL, which would
 * create a new time series per order id and blow up Prometheus' memory.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(
    private readonly metrics: MetricsService,
    private readonly sentry: SentryService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();

    const req = ctx.switchToHttp().getRequest<FoodhubRequest>();
    const res = ctx.switchToHttp().getResponse();
    const started = Date.now();

    // The route template ("/api/vendor/orders/:id"), not the concrete path.
    const route = (req.route?.path as string) ?? req.path ?? '-';
    RequestContext.attach({ route, tenantId: req.tenant?.id ?? null, userId: req.user?.id ?? null });

    const record = (status: number, error?: unknown) => {
      const labels = { method: req.method, route, status: String(status) };
      this.metrics.inc(METRICS.HTTP_REQUESTS, labels, 1, 'Total HTTP requests handled');
      this.metrics.observe(
        METRICS.HTTP_DURATION,
        Date.now() - started,
        { method: req.method, route },
        'HTTP request duration in milliseconds',
      );
      if (error) this.sentry.captureException(error);
    };

    return next.handle().pipe(
      tap({
        complete: () => record(res.statusCode),
        error: (err) => record(err?.status ?? 500, err),
      }),
    );
  }
}

@Controller()
class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  /**
   * Prometheus scrape target. Public because it is expected to be reachable only from
   * inside the private network — the Caddyfile does not route /metrics from the edge.
   */
  @Public()
  @PlatformScope('metrics endpoint reads no tenant data')
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): string {
    return this.metrics.render();
  }
}

@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    MetricsService,
    SentryService,
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
  ],
  exports: [MetricsService, SentryService],
})
export class ObservabilityModule {}
