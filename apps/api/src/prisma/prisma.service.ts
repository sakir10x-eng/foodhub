import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { tenantGuardExtension } from './tenant-guard';

/** Queries slower than this are logged with their model and operation. */
const SLOW_QUERY_MS = Number(process.env.SLOW_QUERY_MS ?? 300);

function buildClient() {
  const client = new PrismaClient({
    log:
      process.env.PRISMA_LOG === 'query'
        ? ['query', 'warn', 'error']
        : [
            { emit: 'stdout', level: 'warn' },
            { emit: 'stdout', level: 'error' },
          ],
  });
  return client.$extends(tenantGuardExtension());
}

export type GuardedPrisma = ReturnType<typeof buildClient>;

/**
 * The client handed to a `$transaction(fn)` callback: the guarded client minus the
 * methods Prisma forbids inside a transaction. Services that take a `tx` parameter
 * should type it with this so the tenant guard still applies inside transactions.
 */
export type GuardedTx = Omit<
  GuardedPrisma,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private slowQueryHook: ((info: { model: string; operation: string; ms: number }) => void) | null = null;

  private readonly base = new PrismaClient({
    log: [
      { emit: 'stdout', level: 'warn' },
      { emit: 'stdout', level: 'error' },
    ],
  });

  /**
   * Optional read replica. When REPLICA_DATABASE_URL is set, analytics and marketplace
   * browsing read from it, keeping long report scans off the box that takes orders.
   * Unset, `readOnly` is the primary and everything still works.
   */
  private readonly replicaClient: PrismaClient | null = process.env.REPLICA_DATABASE_URL
    ? new PrismaClient({
        datasources: { db: { url: process.env.REPLICA_DATABASE_URL } },
        log: [{ emit: 'stdout', level: 'error' }],
      })
    : null;

  /**
   * The tenant-guarded client. Use this everywhere.
   * Queries against tenant-scoped models are pinned to TenantContext or rejected.
   */
  readonly db: GuardedPrisma = this.base
    .$extends(this.timingExtension())
    .$extends(tenantGuardExtension()) as unknown as GuardedPrisma;

  /**
   * Guarded client routed to the read replica when one is configured.
   *
   * Only for genuinely read-only work. Replicas lag, so anything that reads a value in
   * order to write it — balances, stock, settlement — must use `db`, not this.
   */
  readonly readOnly: GuardedPrisma = (this.replicaClient
    ? (this.replicaClient.$extends(this.timingExtension()).$extends(tenantGuardExtension()) as unknown)
    : (this.db as unknown)) as GuardedPrisma;

  /**
   * UNGUARDED client — raw SQL only (pg_trgm search, health checks, migrations).
   * Any query issued here MUST carry its own tenant predicate. Grep this symbol in review.
   */
  get unsafeRaw(): PrismaClient {
    return this.base;
  }

  /** Unguarded replica handle for raw analytics SQL. Falls back to the primary. */
  get unsafeRawReplica(): PrismaClient {
    return this.replicaClient ?? this.base;
  }

  /** Wired up by ObservabilityModule so slow queries become a metric, not just a log line. */
  onSlowQuery(hook: (info: { model: string; operation: string; ms: number }) => void) {
    this.slowQueryHook = hook;
  }

  private timingExtension() {
    return {
      name: 'query-timing',
      query: {
        $allModels: {
          $allOperations: async ({ model, operation, args, query }: any) => {
            const started = Date.now();
            try {
              return await query(args);
            } finally {
              const ms = Date.now() - started;
              if (ms >= SLOW_QUERY_MS) {
                this.logger.warn(`Slow query ${model}.${operation} took ${ms}ms`);
                this.slowQueryHook?.({ model, operation, ms });
              }
            }
          },
        },
      },
    } as any;
  }

  async onModuleInit() {
    await this.base.$connect();
    this.logger.log('Database connected');
    if (this.replicaClient) {
      await this.replicaClient.$connect();
      this.logger.log('Read replica connected — analytics and browsing routed to it');
    }
  }

  async onModuleDestroy() {
    await this.base.$disconnect();
    await this.replicaClient?.$disconnect();
  }

  /** Wipes every table. Test-only; refuses to run outside NODE_ENV=test. */
  async truncateAll() {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('truncateAll() is only available with NODE_ENV=test');
    }
    const tables = await this.base.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    `;
    if (tables.length === 0) return;
    const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
    await this.base.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  }
}
