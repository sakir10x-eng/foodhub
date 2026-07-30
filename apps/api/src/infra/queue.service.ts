import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type JobHandler = (payload: any) => Promise<void> | void;

/**
 * Background jobs with two drivers, chosen by whether REDIS_URL is set:
 *   - BullMQ  (production: retries, backoff, survives restarts, multi-worker)
 *   - in-process setImmediate queue (dev/test: no Redis, same API, no durability)
 *
 * Everything that must not block an HTTP response goes through here — order
 * notifications, settlement rollups, image derivatives, webhook fan-out.
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly handlers = new Map<string, JobHandler>();
  private readonly queues = new Map<string, any>();
  private readonly workers: any[] = [];
  private connection: any = null;
  private readonly useRedis: boolean;
  /** Pending in-process jobs — awaited by drain() so tests are deterministic. */
  private inflight: Promise<void>[] = [];

  constructor(private readonly config: ConfigService) {
    const url = this.config.get<string | null>('redisUrl');
    this.useRedis = Boolean(url);
    if (this.useRedis) {
      const RedisCtor = require('ioredis') as typeof import('ioredis').default;
      this.connection = new RedisCtor(url as string, { maxRetriesPerRequest: null });
      this.logger.log('Queue driver: bullmq');
    } else {
      this.logger.log('Queue driver: in-process (set REDIS_URL for durable jobs)');
    }
  }

  /** Register the worker for a job name. Call once, at module init. */
  register(name: string, handler: JobHandler): void {
    this.handlers.set(name, handler);
    if (!this.useRedis) return;

    const { Worker } = require('bullmq') as typeof import('bullmq');
    const worker = new Worker(
      name,
      async (job: any) => {
        await handler(job.data);
      },
      { connection: this.connection, concurrency: 5 },
    );
    worker.on('failed', (job: any, err: Error) => {
      this.logger.error(`Job ${name}#${job?.id} failed: ${err.message}`);
    });
    this.workers.push(worker);
  }

  /** Fire and forget. Never await this on a request path. */
  async enqueue(name: string, payload: unknown, opts: { delayMs?: number } = {}): Promise<void> {
    if (this.useRedis) {
      const { Queue } = require('bullmq') as typeof import('bullmq');
      let queue = this.queues.get(name);
      if (!queue) {
        queue = new Queue(name, { connection: this.connection });
        this.queues.set(name, queue);
      }
      await queue.add(name, payload, {
        delay: opts.delayMs ?? 0,
        attempts: 5,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      });
      return;
    }

    const handler = this.handlers.get(name);
    if (!handler) {
      this.logger.warn(`No handler registered for job "${name}" — dropped`);
      return;
    }
    const run = (async () => {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      try {
        await handler(payload);
      } catch (err) {
        this.logger.error(`Job ${name} failed: ${(err as Error).message}`);
      }
    })();
    this.inflight.push(run);
    void run.finally(() => {
      this.inflight = this.inflight.filter((p) => p !== run);
    });
  }

  /** Test helper: wait until the in-process queue is empty. No-op on BullMQ. */
  async drain(): Promise<void> {
    while (this.inflight.length) {
      await Promise.all([...this.inflight]);
    }
  }

  async onModuleDestroy() {
    await Promise.all(this.workers.map((w) => w.close().catch(() => undefined)));
    await Promise.all([...this.queues.values()].map((q) => q.close().catch(() => undefined)));
    await this.connection?.quit?.().catch(() => undefined);
  }
}

export const JOBS = {
  ORDER_PLACED: 'order.placed',
  ORDER_STATUS_CHANGED: 'order.status-changed',
  ORDER_SETTLE: 'order.settle',
  IMAGE_DERIVATIVES: 'image.derivatives',
  NOTIFY: 'notify.send',
} as const;
