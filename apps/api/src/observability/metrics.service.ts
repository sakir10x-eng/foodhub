import { Injectable } from '@nestjs/common';

type Labels = Record<string, string>;

interface Histogram {
  buckets: Map<number, number>;
  sum: number;
  count: number;
}

/** Latency buckets in ms, chosen around what a food storefront actually needs to hit. */
const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

/**
 * Prometheus-format metrics, scraped by Grafana at /metrics.
 *
 * Hand-rolled rather than pulling in prom-client: the surface we need is four metric
 * types, and this keeps the dependency list short. Series are labelled by tenant where
 * that's useful for spotting a single noisy vendor, and deliberately not where it would
 * explode cardinality (never by order id, product id or customer).
 */
@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly help = new Map<string, string>();

  private key(name: string, labels: Labels = {}): string {
    const parts = Object.entries(labels)
      .filter(([, v]) => v !== undefined && v !== '')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${escapeLabel(String(v))}"`);
    return parts.length ? `${name}{${parts.join(',')}}` : name;
  }

  inc(name: string, labels: Labels = {}, by = 1, help?: string): void {
    if (help) this.help.set(name, help);
    const k = this.key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }

  gauge(name: string, value: number, labels: Labels = {}, help?: string): void {
    if (help) this.help.set(name, help);
    this.gauges.set(this.key(name, labels), value);
  }

  observe(name: string, valueMs: number, labels: Labels = {}, help?: string): void {
    if (help) this.help.set(name, help);
    const k = this.key(name, labels);
    let h = this.histograms.get(k);
    if (!h) {
      h = { buckets: new Map(BUCKETS.map((b) => [b, 0])), sum: 0, count: 0 };
      this.histograms.set(k, h);
    }
    h.sum += valueMs;
    h.count += 1;
    for (const bucket of BUCKETS) {
      if (valueMs <= bucket) h.buckets.set(bucket, (h.buckets.get(bucket) ?? 0) + 1);
    }
  }

  /** Time a block and record it, whether it throws or not. */
  async time<T>(name: string, labels: Labels, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      this.observe(name, Date.now() - started, labels);
    }
  }

  /** Prometheus text exposition format. */
  render(): string {
    const lines: string[] = [];
    const emitted = new Set<string>();

    const header = (series: string, type: string) => {
      const name = series.split('{')[0];
      if (emitted.has(name)) return;
      emitted.add(name);
      const help = this.help.get(name);
      if (help) lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
    };

    for (const [series, value] of [...this.counters].sort()) {
      header(series, 'counter');
      lines.push(`${series} ${value}`);
    }
    for (const [series, value] of [...this.gauges].sort()) {
      header(series, 'gauge');
      lines.push(`${series} ${value}`);
    }
    for (const [series, h] of [...this.histograms].sort()) {
      header(series, 'histogram');
      const name = series.split('{')[0];
      const inner = series.includes('{') ? series.slice(series.indexOf('{') + 1, -1) : '';
      const withLe = (le: string) => `${name}_bucket{${inner ? inner + ',' : ''}le="${le}"}`;
      let cumulative = 0;
      for (const bucket of BUCKETS) {
        cumulative = h.buckets.get(bucket) ?? 0;
        lines.push(`${withLe(String(bucket))} ${cumulative}`);
      }
      lines.push(`${withLe('+Inf')} ${h.count}`);
      lines.push(`${name}_sum${inner ? `{${inner}}` : ''} ${h.sum}`);
      lines.push(`${name}_count${inner ? `{${inner}}` : ''} ${h.count}`);
    }

    // Process health, so one scrape covers "is the API healthy" too.
    const mem = process.memoryUsage();
    lines.push('# TYPE foodhub_process_heap_bytes gauge');
    lines.push(`foodhub_process_heap_bytes ${mem.heapUsed}`);
    lines.push('# TYPE foodhub_process_uptime_seconds gauge');
    lines.push(`foodhub_process_uptime_seconds ${Math.round(process.uptime())}`);

    return lines.join('\n') + '\n';
  }
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export const METRICS = {
  HTTP_REQUESTS: 'foodhub_http_requests_total',
  HTTP_DURATION: 'foodhub_http_request_duration_ms',
  ORDERS_PLACED: 'foodhub_orders_placed_total',
  ORDER_VALUE: 'foodhub_order_value_poisha_total',
  MENU_CACHE: 'foodhub_menu_cache_total',
  DB_SLOW_QUERIES: 'foodhub_db_slow_queries_total',
  RATE_LIMITED: 'foodhub_rate_limited_total',
  AI_TOKENS: 'foodhub_ai_tokens_total',
  QUEUE_JOBS: 'foodhub_queue_jobs_total',
  WS_CONNECTIONS: 'foodhub_ws_connections',
} as const;
