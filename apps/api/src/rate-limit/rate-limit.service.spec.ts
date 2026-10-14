import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { RedisService } from '../redis/redis.service';
import { loadRateLimitConfig, type RateLimitConfig } from './rate-limit.config';
import { RateLimitService, type RateLimitDecision } from './rate-limit.service';

// Integration tests against a real (disposable) Redis, plus Redis-failure
// behaviour with stubbed clients.
describe('RateLimitService', () => {
  let redis: RedisService;
  let config: RateLimitConfig;
  let service: RateLimitService;
  const key = (label: string) => `rl:test:${randomUUID()}:${label}`;

  beforeAll(async () => {
    redis = new RedisService();
    await redis.onModuleInit();
    config = loadRateLimitConfig({ RATE_LIMIT_REDIS_TIMEOUT_MS: '200' });
    service = new RateLimitService(redis, config);
  });

  afterAll(async () => {
    await redis.onModuleDestroy();
  });

  describe('against Redis', () => {
    it('allows up to the limit and then denies, with a Retry-After inside the window', async () => {
      const k = key('basic');
      const decisions: RateLimitDecision[] = [];
      for (let i = 0; i < 5; i += 1)
        decisions.push(await service.hit(k, 3, 60));
      expect(decisions.map((d) => d.allowed)).toEqual([
        true,
        true,
        true,
        false,
        false,
      ]);
      expect(decisions.map((d) => d.count)).toEqual([1, 2, 3, 4, 5]);
      expect(decisions.every((d) => d.backend === 'redis')).toBe(true);
      const denied = decisions[3];
      expect(denied.retryAfterSeconds).toBeGreaterThan(0);
      expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);
    });

    it('is atomic: 200 concurrent requests against a limit of 50 allow exactly 50', async () => {
      const k = key('concurrent');
      const results = await Promise.all(
        Array.from({ length: 200 }, () => service.hit(k, 50, 60)),
      );
      expect(results.filter((r) => r.allowed)).toHaveLength(50);
      expect(new Set(results.map((r) => r.count)).size).toBe(200);
      expect(Math.max(...results.map((r) => r.count))).toBe(200);
    });

    it('never leaves a counter without an expiry, even if one was written without a TTL', async () => {
      const k = key('no-ttl');
      await redis.getClient().set(k, '2'); // a key with no TTL
      const decision = await service.hit(k, 10, 30);
      expect(decision.count).toBe(3);
      const ttl = await redis.getClient().ttl(k);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(30);
    });

    it('starts a new window after the old one expires', async () => {
      const k = key('expiry');
      await service.hit(k, 1, 1);
      expect((await service.hit(k, 1, 1)).allowed).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      const fresh = await service.hit(k, 1, 1);
      expect(fresh.allowed).toBe(true);
      expect(fresh.count).toBe(1);
    });

    it('reads a counter without counting (failure counters), and does not create the key', async () => {
      const k = key('check-only');
      expect((await service.hit(k, 5, 60, { increment: false })).count).toBe(0);
      expect(await redis.getClient().exists(k)).toBe(0);
      await service.hit(k, 5, 60);
      await service.hit(k, 5, 60);
      expect((await service.hit(k, 5, 60, { increment: false })).count).toBe(2);
      expect((await service.hit(k, 5, 60, { increment: false })).count).toBe(2);
    });

    it('gives a count back atomically, never below zero', async () => {
      const k = key('release');
      for (let i = 0; i < 10; i += 1) await service.hit(k, 100, 60);
      await Promise.all(Array.from({ length: 4 }, () => service.release(k)));
      expect((await service.hit(k, 100, 60, { increment: false })).count).toBe(
        6,
      );
      // releasing more than was counted stops at zero rather than going negative
      await Promise.all(Array.from({ length: 20 }, () => service.release(k)));
      expect((await service.hit(k, 100, 60, { increment: false })).count).toBe(
        0,
      );
      // releasing a key that does not exist is harmless and creates nothing
      await service.release(key('absent'));
    });

    it('keeps keys independent (different tenants / subjects never share a counter)', async () => {
      const a = key('tenant-a');
      const b = key('tenant-b');
      for (let i = 0; i < 4; i += 1) await service.hit(a, 2, 60);
      expect((await service.hit(b, 2, 60)).allowed).toBe(true);
    });
  });

  describe('when Redis fails', () => {
    function stubbed(client: Record<string, unknown>): RateLimitService {
      const fake = { getClient: () => client } as unknown as RedisService;
      return new RateLimitService(fake, config);
    }

    it('keeps enforcing the same limit in memory when Redis is not connected', async () => {
      const degraded = stubbed({ status: 'end' });
      const k = key('down');
      const decisions: RateLimitDecision[] = [];
      for (let i = 0; i < 5; i += 1)
        decisions.push(await degraded.hit(k, 3, 60));
      expect(decisions.map((d) => d.allowed)).toEqual([
        true,
        true,
        true,
        false,
        false,
      ]);
      expect(decisions.every((d) => d.backend === 'memory')).toBe(true);
      expect(degraded.status().backend).toBe('memory');
      expect(degraded.status().degradedSince).toBeInstanceOf(Date);
      expect(degraded.status().fallbackDecisions).toBe(5);
    });

    it('falls back when a command errors', async () => {
      const failing = stubbed({
        status: 'ready',
        eval: () => Promise.reject(new Error('READONLY')),
      });
      const k = key('error');
      await failing.hit(k, 1, 60);
      const second = await failing.hit(k, 1, 60);
      expect(second).toMatchObject({ allowed: false, backend: 'memory' });
    });

    it('falls back promptly when Redis accepts the command but never answers', async () => {
      const hung = stubbed({
        status: 'ready',
        eval: () => new Promise(() => undefined),
      });
      const started = Date.now();
      const decision = await hung.hit(key('hung'), 5, 60);
      expect(decision.backend).toBe('memory');
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('falls back on a malformed reply instead of trusting it', async () => {
      const odd = stubbed({
        status: 'ready',
        eval: () => Promise.resolve('nope'),
      });
      expect((await odd.hit(key('odd'), 5, 60)).backend).toBe('memory');
    });

    it('returns to Redis, and clears the degraded state, when it recovers', async () => {
      const client = redis.getClient() as unknown as { status: string };
      const flip = {
        get status() {
          return up ? client.status : 'end';
        },
        eval: (
          script: string,
          numKeys: number,
          ...rest: Array<string | number>
        ) => redis.getClient().eval(script, numKeys, ...rest),
      };
      let up = false;
      const flaky = stubbed(flip);
      expect((await flaky.hit(key('flip-a'), 5, 60)).backend).toBe('memory');
      expect(flaky.status().backend).toBe('memory');
      up = true;
      expect((await flaky.hit(key('flip-b'), 5, 60)).backend).toBe('redis');
      expect(flaky.status().backend).toBe('redis');
      expect(flaky.status().degradedSince).toBeNull();
    });
  });

  it('reports whether rate limiting is enabled', () => {
    expect(service.enabled).toBe(true);
    const off = new RateLimitService(
      redis,
      loadRateLimitConfig({ RATE_LIMIT_ENABLED: '0' }),
    );
    expect(off.enabled).toBe(false);
  });
});
