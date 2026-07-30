import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { AppModule } from './app.module';
import { ContextMiddleware } from './tenancy/context.middleware';
import { StructuredLogger } from './observability/logger';
import { RequestContext } from './observability/request-context';
import { MetricsService, METRICS } from './observability/metrics.service';
import { PrismaService } from './prisma/prisma.service';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: false,
    logger: new StructuredLogger(),
  });
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  // Behind Caddy, req.ip must come from X-Forwarded-For or every client looks like
  // the proxy — which would make per-IP rate limiting throttle everyone at once.
  app.set('trust proxy', 1);

  /**
   * Opens the correlation scope for every request and echoes the id back.
   *
   * An inbound X-Request-Id is honoured so a trace started at the edge (or by a mobile
   * client) stays one id end to end.
   */
  app.use((req: any, res: any, next: any) => {
    const incoming = req.headers['x-request-id'];
    const requestId = typeof incoming === 'string' && incoming.length <= 64 ? incoming : randomUUID();
    res.setHeader('X-Request-Id', requestId);
    RequestContext.run({ requestId, method: req.method, route: req.path }, () => next());
  });

  app.use(cookieParser());

  // Keep the raw body for signature verification — Meta signs the exact bytes, so a
  // re-serialised JSON object would never match the HMAC.
  app.use(
    json({
      limit: '2mb',
      verify: (req: any, _res, buf) => {
        if (req.originalUrl?.includes('/webhooks/')) req.rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use(urlencoded({ extended: true, limit: '2mb' }));

  app.use(
    helmet({
      // Storefront images are served cross-origin to the Next.js apps and the CDN.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: false,
    }),
  );

  // Opens the tenant scope for every request and resolves Host -> tenant. Mounted here,
  // ahead of the router, so there is no route pattern that can accidentally miss it.
  const context = app.get(ContextMiddleware);
  app.use((req: any, res: any, next: any) => context.use(req, res, next));

  const origins = config.get<string[]>('corsOrigins') ?? [];
  app.enableCors({
    // Vendors bring their own domains, so the allowed origin set is open-ended by design.
    // Auth rides on the Authorization header, not cookies, so this is not a CSRF surface.
    origin: origins.length ? origins : true,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Host', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  });

  // No global ValidationPipe: request bodies are validated with the zod schemas in
  // @foodhub/shared, so the browser and the server enforce byte-identical rules.
  app.setGlobalPrefix('api', { exclude: ['health', 'metrics'] });

  // Slow queries become a metric, not just a log line, so a creeping regression shows
  // up on a dashboard before a customer reports it.
  const metrics = app.get(MetricsService);
  app.get(PrismaService).onSlowQuery(({ model, operation, ms }) => {
    metrics.inc(METRICS.DB_SLOW_QUERIES, { model, operation }, 1, 'Queries slower than SLOW_QUERY_MS');
    void ms;
  });

  // Local media driver: serve the derivative ladder straight off disk in development.
  // In production this path is fronted by a CDN and never hits Node.
  if (config.get<string>('media.driver') === 'local') {
    const dir = resolve(process.cwd(), config.get<string>('media.localDir') ?? 'storage/media');
    app.useStaticAssets(dir, {
      prefix: config.get<string>('media.publicBase') ?? '/media',
      maxAge: '365d',
      immutable: true,
    });
    logger.log(`Serving media from ${dir}`);
  }

  app.enableShutdownHooks();

  const port = config.get<number>('port') ?? 4000;
  await app.listen(port, '0.0.0.0');
  logger.log(`API listening on http://127.0.0.1:${port}/api`);
  logger.log(`Realtime on ws://127.0.0.1:${port}/realtime`);
  logger.log(`Metrics on http://127.0.0.1:${port}/metrics`);
}

void bootstrap();
