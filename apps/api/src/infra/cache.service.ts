import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';

interface Entry {
  value: string;
  expiresAt: number;
}

/**
 * Cache with two drivers, chosen by whether REDIS_URL is set:
 *   - Redis   (production, shared across API instances)
 *   - in-process LRU-ish Map (dev/test, zero infrastructure)
 *
 * Callers never care which. Menus are the hot path: they change rarely and are read on
 * every storefront render, so they are cached hard and invalidated by version bump.
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly memory = new Map<string, Entry>();
  private readonly maxMemoryEntries = 5_000;
  private redis: Redis | null = null;

  constructor(private readonly config: ConfigService) {
    const url = this.config.get<string | null>('redisUrl');
    if (url) {
      try {
        // Required lazily so dev installs without a running Redis never touch it.
        const RedisCtor = require('ioredis') as typeof import('ioredis').default;
        this.redis = new RedisCtor(url, { maxRetriesPerRequest: 2, lazyConnect: false });
        this.redis.on('error', (e: Error) => this.logger.warn(`Redis: ${e.message}`));
        this.logger.log('Cache driver: redis');
      } catch (e) {
        this.logger.warn(`Redis unavailable (${(e as Error).message}) — falling back to in-process cache`);
      }
    } else {
      this.logger.log('Cache driver: in-process (set REDIS_URL for a shared cache)');
    }
  }

  async get<T>(key: string): Promise<T | null> {
    if (this.redis) {
      const raw = await this.redis.get(key).catch(() => null);
      return raw ? (JSON.parse(raw) as T) : null;
    }
    const hit = this.memory.get(key);
    if (!hit) return null;
    if (hit.expiresAt < Date.now()) {
      this.memory.delete(key);
      return null;
    }
    return JSON.parse(hit.value) as T;
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const raw = JSON.stringify(value);
    if (this.redis) {
      await this.redis.set(key, raw, 'EX', Math.max(1, ttlSeconds)).catch(() => undefined);
      return;
    }
    if (this.memory.size >= this.maxMemoryEntries) {
      // Cheap eviction: drop the oldest inserted key.
      const oldest = this.memory.keys().next().value;
      if (oldest) this.memory.delete(oldest);
    }
    this.memory.set(key, { value: raw, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    if (this.redis) {
      await this.redis.del(...keys).catch(() => undefined);
      return;
    }
    for (const k of keys) this.memory.delete(k);
  }

  async delByPrefix(prefix: string): Promise<void> {
    if (this.redis) {
      // SCAN rather than KEYS so a big keyspace never blocks the server.
      let cursor = '0';
      do {
        const [next, found] = await this.redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
        cursor = next;
        if (found.length) await this.redis.del(...found);
      } while (cursor !== '0');
      return;
    }
    for (const k of [...this.memory.keys()]) {
      if (k.startsWith(prefix)) this.memory.delete(k);
    }
  }

  /**
   * Atomic increment with a TTL applied on first write. Used by rate limiting, where a
   * read-then-write would let concurrent requests each see the pre-increment count and
   * both conclude they are under the limit.
   */
  async increment(key: string, ttlSeconds: number): Promise<number> {
    if (this.redis) {
      const value = await this.redis.incr(key).catch(() => 1);
      if (value === 1) await this.redis.expire(key, ttlSeconds).catch(() => undefined);
      return value;
    }
    // Single-process fallback: Node is single-threaded, so this read-modify-write
    // cannot interleave.
    const hit = this.memory.get(key);
    const current = hit && hit.expiresAt > Date.now() ? Number(JSON.parse(hit.value)) : 0;
    const next = current + 1;
    this.memory.set(key, {
      value: JSON.stringify(next),
      expiresAt: (hit && hit.expiresAt > Date.now() ? hit.expiresAt : Date.now() + ttlSeconds * 1000),
    });
    return next;
  }

  /** Read-through: return the cached value or compute, store and return it. */
  async wrap<T>(key: string, ttlSeconds: number, produce: () => Promise<T>): Promise<T> {
    const hit = await this.get<T>(key);
    if (hit !== null) return hit;
    const value = await produce();
    await this.set(key, value, ttlSeconds);
    return value;
  }

  async onModuleDestroy() {
    await this.redis?.quit().catch(() => undefined);
  }
}
