import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleInit,
} from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import type { RateLimitConfig } from './rate-limit.config';
import { MemoryWindowCounter } from './memory-window-counter';

export const RATE_LIMIT_CONFIG = Symbol('RATE_LIMIT_CONFIG');

// One atomic step: count the request and read the time left in the window.
// INCR + EXPIRE happen inside a single script, so concurrent requests cannot
// interleave between them, and a key can never be left without an expiry.
// ARGV[2] = 0 reads the counter without counting (used for failure counters
// that are checked on the way in and only incremented when a request fails).
const WINDOW_SCRIPT = `
local increment = tonumber(ARGV[2])
local count
if increment == 1 then
  count = redis.call('INCR', KEYS[1])
  if count == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
  end
else
  count = tonumber(redis.call('GET', KEYS[1]) or '0')
end
local ttl = redis.call('TTL', KEYS[1])
if count > 0 and ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly count: number;
  readonly limit: number;
  readonly retryAfterSeconds: number;
  // Which counter answered. 'memory' means Redis was unreachable and the
  // per-instance fallback enforced the limit.
  readonly backend: 'redis' | 'memory';
}

export interface RateLimitStatus {
  readonly backend: 'redis' | 'memory';
  readonly degradedSince: Date | null;
  readonly fallbackDecisions: number;
  // Requests refused since the process started, by "policy/scope". Counts
  // only — no addresses, identifiers or order ids — so it is safe to log and
  // is what to look at when tuning a limit.
  readonly denials: Readonly<Record<string, number>>;
}

const DEGRADED_LOG_INTERVAL_MS = 60_000;

@Injectable()
export class RateLimitService implements OnModuleInit {
  private readonly logger = new Logger(RateLimitService.name);
  private readonly memory: MemoryWindowCounter;
  private degradedSince: Date | null = null;
  private fallbackDecisions = 0;
  private lastDegradedLogAt = 0;
  private readonly denials = new Map<string, number>();
  private pendingDenials = new Map<string, number>();
  private lastDenialLogAt = 0;

  constructor(
    private readonly redis: RedisService,
    @Inject(RATE_LIMIT_CONFIG) private readonly config: RateLimitConfig,
    @Optional() memory?: MemoryWindowCounter,
  ) {
    this.memory = memory ?? new MemoryWindowCounter();
  }

  // States, once, how this process will identify clients, so an operator can
  // see at a glance which protections are active.
  onModuleInit(): void {
    if (!this.config.enabled) {
      this.logger.warn('Rate limiting is DISABLED (RATE_LIMIT_ENABLED=0).');
      return;
    }
    if (this.config.clientIpMode === 'off') {
      this.logger.warn(
        'Rate limiting: no client-IP source is configured (RATE_LIMIT_CLIENT_IP_MODE / CLIENT_IP_FORWARD_SECRET). ' +
          'Per-IP limits are INACTIVE; tenant, customer, identifier and order limits still apply. ' +
          'See docs/security/public-api-rate-limiting.md.',
      );
    } else {
      this.logger.log(
        `Rate limiting active; client IP mode: ${this.config.clientIpMode}.`,
      );
    }
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  // Counts one request against `key` (or only reads it) and says whether the
  // limit is exceeded.
  //
  // REDIS FAILURE: if Redis is not ready, errors, or does not answer within
  // RATE_LIMIT_REDIS_TIMEOUT_MS, the SAME limit is enforced by a bounded
  // in-process counter. Protection therefore continues (per API instance, so
  // the effective limit is multiplied by the instance count) rather than
  // switching off, and the degraded state is logged and visible in status().
  // Redis calls never block a request for longer than the timeout.
  async hit(
    key: string,
    limit: number,
    windowSeconds: number,
    options: { increment?: boolean } = {},
  ): Promise<RateLimitDecision> {
    const increment = options.increment ?? true;

    const viaRedis = await this.tryRedis(key, windowSeconds, increment);
    if (viaRedis !== null) {
      if (this.degradedSince !== null) {
        this.logger.log('Rate limiting: Redis is available again.');
        this.degradedSince = null;
      }
      return {
        allowed: viaRedis.count <= limit,
        count: viaRedis.count,
        limit,
        retryAfterSeconds: Math.max(1, viaRedis.ttl),
        backend: 'redis',
      };
    }

    this.noteDegraded();
    const local = this.memory.hit(key, windowSeconds, increment);
    this.fallbackDecisions += 1;
    return {
      allowed: local.count <= limit,
      count: local.count,
      limit,
      retryAfterSeconds: local.retryAfterSeconds,
      backend: 'memory',
    };
  }

  // Records that a request was refused, and logs a one-line summary at most
  // once a minute so an abuse burst is visible without flooding the log.
  noteDenial(policy: string, scope: string): void {
    const label = `${policy}/${scope}`;
    this.denials.set(label, (this.denials.get(label) ?? 0) + 1);
    this.pendingDenials.set(label, (this.pendingDenials.get(label) ?? 0) + 1);
    const now = Date.now();
    if (now - this.lastDenialLogAt >= DEGRADED_LOG_INTERVAL_MS) {
      this.lastDenialLogAt = now;
      const summary = [...this.pendingDenials.entries()]
        .map(([name, count]) => `${name}=${count}`)
        .join(' ');
      this.pendingDenials = new Map();
      this.logger.warn(`Rate limit refusals (since last report): ${summary}`);
    }
  }

  status(): RateLimitStatus {
    return {
      denials: Object.fromEntries(this.denials),
      backend: this.degradedSince === null ? 'redis' : 'memory',
      degradedSince: this.degradedSince,
      fallbackDecisions: this.fallbackDecisions,
    };
  }

  private async tryRedis(
    key: string,
    windowSeconds: number,
    increment: boolean,
  ): Promise<{ count: number; ttl: number } | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const client = this.redis.getClient();
      // Not connected: do not queue a command that may sit for seconds.
      if (client.status !== 'ready') return null;

      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Redis timed out')),
          this.config.redisTimeoutMs,
        );
      });
      const reply = await Promise.race([
        client.eval(WINDOW_SCRIPT, 1, key, windowSeconds, increment ? 1 : 0),
        timeout,
      ]);

      if (
        !Array.isArray(reply) ||
        typeof reply[0] !== 'number' ||
        typeof reply[1] !== 'number'
      ) {
        return null;
      }
      return { count: reply[0], ttl: reply[1] };
    } catch {
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private noteDegraded(): void {
    const now = Date.now();
    if (this.degradedSince === null) this.degradedSince = new Date(now);
    // One warning a minute, so an outage does not flood the log.
    if (now - this.lastDegradedLogAt >= DEGRADED_LOG_INTERVAL_MS) {
      this.lastDegradedLogAt = now;
      this.logger.warn(
        'Rate limiting: Redis unavailable — enforcing limits per instance in memory until it recovers.',
      );
    }
  }
}
