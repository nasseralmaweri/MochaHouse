/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await -- test code: supertest and ioredis stubs are loosely typed, and stub providers are async by contract */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  type INestApplication,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { RedisModule } from '../redis/redis.module';
import { RedisService } from '../redis/redis.service';
import { RateLimitModule } from './rate-limit.module';
import { RateLimit } from './rate-limit.decorator';
import {
  RATE_LIMIT_MESSAGE,
  RateLimitEnforcer,
  RateLimitGuard,
  type RateLimitedRequest,
} from './rate-limit.guard';
import { RateLimitService } from './rate-limit.service';
import {
  CLIENT_IP_HEADER,
  CLIENT_IP_SIGNATURE_HEADER,
  CLIENT_IP_TIMESTAMP_HEADER,
  signClientIp,
} from './client-identity';

// HTTP-level tests of the rate limiter through a real Nest app, real Redis and
// a stub controller that applies the same decorators the production routes use.
// The tenant and the customer identity are set by test middleware from headers
// (production sets them from the server-resolved tenant and a verified token).

const SECRET = 'a-shared-secret-that-is-at-least-32-chars-long';

@Controller('t')
class StubController {
  constructor(private readonly enforcer: RateLimitEnforcer) {}

  @UseGuards(RateLimitGuard)
  @RateLimit('customer-sign-in')
  @Post('sign-in')
  signIn(@Body() body: { identifier?: string }) {
    // Mimics the real route: the answer never depends on whether the account exists.
    return {
      message: 'Invalid email or password.',
      echoed: body.identifier ? 1 : 0,
    };
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('account-recovery')
  @Post('forgot')
  forgot() {
    return { message: 'If an account exists, a code has been sent.' };
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('account-verification')
  @Post('reset')
  reset() {
    return { ok: true };
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('checkout')
  @Post('checkout')
  checkout() {
    return { ok: true };
  }

  @UseGuards(RateLimitGuard)
  @RateLimit('order-status')
  @Get('orders/:orderId')
  async status(
    @Param('orderId') orderId: string,
    @Query('accessToken') token: string,
    @Req() req: RateLimitedRequest,
  ) {
    if (token !== 'good-token') {
      throw new NotFoundException('Order not found.');
    }
    await this.enforcer.releaseOnSuccess(req);
    return { orderId, status: 'PREPARING' };
  }
}

const SMALL_LIMITS: Record<string, string> = {
  RATE_LIMIT_CUSTOMER_SIGN_IN_IDENTIFIER_IP_LIMIT: '3',
  RATE_LIMIT_CUSTOMER_SIGN_IN_IP_LIMIT: '8',
  RATE_LIMIT_CUSTOMER_SIGN_IN_IDENTIFIER_LIMIT: '6',
  RATE_LIMIT_CHECKOUT_IP_LIMIT: '4',
  RATE_LIMIT_CHECKOUT_SUBJECT_LIMIT: '4',
  RATE_LIMIT_CHECKOUT_TENANT_LIMIT: '12',
  RATE_LIMIT_ORDER_STATUS_FAILURES_LIMIT: '3',
  RATE_LIMIT_ACCOUNT_RECOVERY_IDENTIFIER_IP_LIMIT: '2',
  RATE_LIMIT_ACCOUNT_RECOVERY_IP_LIMIT: '5',
  RATE_LIMIT_ACCOUNT_RECOVERY_IDENTIFIER_LIMIT: '4',
  RATE_LIMIT_ACCOUNT_VERIFICATION_IDENTIFIER_IP_LIMIT: '3',
  RATE_LIMIT_ACCOUNT_VERIFICATION_IP_LIMIT: '10',
  RATE_LIMIT_ACCOUNT_VERIFICATION_IDENTIFIER_LIMIT: '8',
};

interface Harness {
  app: NestExpressApplication;
  service: RateLimitService;
  close: () => Promise<void>;
}

// Builds an app with the given environment applied for module construction
// (the config is read once, at module init) and restores it afterwards.
async function buildApp(
  env: Record<string, string>,
  options: { trustProxy?: number; redisDown?: boolean } = {},
): Promise<Harness> {
  const saved: Record<string, string | undefined> = {};
  const applied = { ...SMALL_LIMITS, ...env };
  for (const [name, value] of Object.entries(applied)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }

  @Module({})
  class TestMiddlewareModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
      consumer
        .apply((req: RateLimitedRequest, _res: unknown, next: () => void) => {
          const tenant = req.headers['x-test-tenant'];
          req.tenantContext = {
            tenantId: typeof tenant === 'string' ? tenant : 'tenant-default',
          } as RateLimitedRequest['tenantContext'];
          const subject = req.headers['x-test-subject'];
          if (typeof subject === 'string') {
            req.customerIdentity = {
              provider: 'test',
              subject,
              email: null,
              name: null,
              emailVerified: null,
            };
          }
          next();
        })
        .forRoutes('*');
    }
  }

  let builder = Test.createTestingModule({
    imports: [RedisModule, RateLimitModule, TestMiddlewareModule],
    controllers: [StubController],
  });
  if (options.redisDown) {
    builder = builder.overrideProvider(RedisService).useValue({
      getClient: () => ({ status: 'end' }),
      onModuleInit: async () => undefined,
      onModuleDestroy: async () => undefined,
    });
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  app.set('trust proxy', options.trustProxy ?? 0);
  await app.init();
  // One shared RUNNING server for every request of this app: supertest uses an
  // already-listening server as it is, instead of opening (and closing) a fresh
  // ephemeral server per request — which reset connections under the 40-request
  // concurrency burst on the Linux CI runner.
  await app.listen(0, '127.0.0.1');

  for (const [name, previous] of Object.entries(saved)) {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
  return {
    app,
    service: app.get(RateLimitService),
    close: () => app.close(),
  };
}

const unique = (label: string) => `${label}-${randomUUID()}`;
const post = (app: INestApplication, path: string) =>
  request(app.getHttpServer()).post(path);

describe('rate limiting over HTTP', () => {
  describe("peer IP mode, no proxy ('trust proxy' 0)", () => {
    let h: Harness;
    beforeAll(async () => {
      h = await buildApp({ RATE_LIMIT_CLIENT_IP_MODE: 'peer' });
    });
    afterAll(() => h.close());

    it('allows requests up to the limit, then answers 429 with a numeric Retry-After', async () => {
      const identifier = `${unique('ana')}@example.com`;
      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const res = await post(h.app, '/t/sign-in')
          .set('x-test-tenant', unique('t'))
          .send({ identifier, password: 'x' });
        statuses.push(res.status);
      }
      // A fresh tenant per request would mask the limit; the real check follows.
      expect(statuses.every((s) => s === 201)).toBe(true);

      const tenant = unique('t');
      const results: request.Response[] = [];
      for (let i = 0; i < 5; i += 1) {
        results.push(
          await post(h.app, '/t/sign-in')
            .set('x-test-tenant', tenant)
            .send({ identifier, password: 'x' }),
        );
      }
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 429, 429]);
      const limited = results[3];
      expect(limited.headers['retry-after']).toMatch(/^\d+$/);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(limited.body).toEqual({
        statusCode: 429,
        message: RATE_LIMIT_MESSAGE,
      });
    });

    it('counts refusals by policy and scope, without recording who was refused', async () => {
      const tenant = unique('t');
      const identifier = `${unique('count')}@example.com`;
      for (let i = 0; i < 5; i += 1) {
        await post(h.app, '/t/sign-in')
          .set('x-test-tenant', tenant)
          .send({ identifier, password: 'x' });
      }
      const denials = h.service.status().denials;
      expect(denials['customer-sign-in/identifier-ip']).toBeGreaterThanOrEqual(
        2,
      );
      expect(JSON.stringify(denials)).not.toContain(identifier);
      expect(JSON.stringify(denials)).not.toContain(tenant);
    });

    it('answers identically whether or not the account exists (no enumeration)', async () => {
      const tenant = unique('t');
      const known = `${unique('known')}@example.com`;
      const unknown = `${unique('unknown')}@example.com`;
      const limitedBodies: Array<{
        status: number;
        body: unknown;
        hasRetry: boolean;
      }> = [];
      for (const identifier of [known, unknown]) {
        let last;
        for (let i = 0; i < 4; i += 1) {
          last = await post(h.app, '/t/sign-in')
            .set('x-test-tenant', tenant)
            .send({ identifier, password: 'x' });
        }
        limitedBodies.push({
          status: last!.status,
          body: last!.body,
          hasRetry: Boolean(last!.headers['retry-after']),
        });
      }
      expect(limitedBodies[0]).toEqual(limitedBodies[1]);
      expect(limitedBodies[0].status).toBe(429);
    });

    it('treats case, spacing and Unicode variants of an identifier as the same bucket', async () => {
      const tenant = unique('t');
      const base = unique('variant');
      const variants = [
        `${base}@Example.com`,
        ` ${base}@example.com `,
        `${base.toUpperCase()}@EXAMPLE.COM`,
        `${base}@example.com`,
      ];
      const statuses: number[] = [];
      for (const identifier of variants) {
        statuses.push(
          (
            await post(h.app, '/t/sign-in')
              .set('x-test-tenant', tenant)
              .send({ identifier, password: 'x' })
          ).status,
        );
      }
      expect(statuses).toEqual([201, 201, 201, 429]);
    });

    it('does not let a spoofed X-Forwarded-For escape a limit', async () => {
      const tenant = unique('t');
      const identifier = `${unique('spoof')}@example.com`;
      for (let i = 0; i < 3; i += 1) {
        await post(h.app, '/t/sign-in')
          .set('x-test-tenant', tenant)
          .send({ identifier, password: 'x' });
      }
      for (const forged of ['203.0.113.1', '198.51.100.2', '192.0.2.3']) {
        const res = await post(h.app, '/t/sign-in')
          .set('x-test-tenant', tenant)
          .set('x-forwarded-for', forged)
          .send({ identifier, password: 'x' });
        expect(res.status).toBe(429);
      }
    });

    it('does not let client-supplied identity headers choose a bucket', async () => {
      const tenant = unique('t');
      const results: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        // The "signed" headers are ignored outside forwarded mode.
        results.push(
          (
            await post(h.app, '/t/checkout')
              .set('x-test-tenant', tenant)
              .set(CLIENT_IP_HEADER, `203.0.113.${i + 1}`)
              .set(
                CLIENT_IP_TIMESTAMP_HEADER,
                String(Math.floor(Date.now() / 1000)),
              )
              .set(
                CLIENT_IP_SIGNATURE_HEADER,
                signClientIp(
                  SECRET,
                  `203.0.113.${i + 1}`,
                  Math.floor(Date.now() / 1000),
                ),
              )
              .send({})
          ).status,
        );
      }
      expect(results).toEqual([201, 201, 201, 201, 429, 429]);
    });

    it('keeps tenants separate: one business exhausting its limits does not affect another', async () => {
      const identifier = `${unique('shared')}@example.com`;
      const tenantA = unique('tenant-a');
      const tenantB = unique('tenant-b');
      for (let i = 0; i < 4; i += 1) {
        await post(h.app, '/t/sign-in')
          .set('x-test-tenant', tenantA)
          .send({ identifier, password: 'x' });
      }
      expect(
        (
          await post(h.app, '/t/sign-in')
            .set('x-test-tenant', tenantA)
            .send({ identifier, password: 'x' })
        ).status,
      ).toBe(429);
      expect(
        (
          await post(h.app, '/t/sign-in')
            .set('x-test-tenant', tenantB)
            .send({ identifier, password: 'x' })
        ).status,
      ).toBe(201);
    });

    it('does not throttle signed-in customers sharing one network with each other', async () => {
      const tenant = unique('t');
      // Customer A uses up their own allowance...
      const a: number[] = [];
      for (let i = 0; i < 6; i += 1)
        a.push(
          (
            await post(h.app, '/t/checkout')
              .set('x-test-tenant', tenant)
              .set('x-test-subject', 'customer-a')
              .send({})
          ).status,
        );
      expect(a).toEqual([201, 201, 201, 201, 429, 429]);
      // ...a different customer on the same address is unaffected...
      expect(
        (
          await post(h.app, '/t/checkout')
            .set('x-test-tenant', tenant)
            .set('x-test-subject', 'customer-b')
            .send({})
        ).status,
      ).toBe(201);
    });

    it('limits anonymous checkout per address but leaves signed-in customers out of the address bucket', async () => {
      const tenant = unique('t');
      const anon: number[] = [];
      for (let i = 0; i < 6; i += 1)
        anon.push(
          (
            await post(h.app, '/t/checkout')
              .set('x-test-tenant', tenant)
              .send({})
          ).status,
        );
      expect(anon).toEqual([201, 201, 201, 201, 429, 429]);
      // The same address is now throttled for anonymous clients, not for a signed-in one.
      expect(
        (
          await post(h.app, '/t/checkout')
            .set('x-test-tenant', tenant)
            .set('x-test-subject', 'customer-z')
            .send({})
        ).status,
      ).toBe(201);
    });

    describe('guest order status', () => {
      const poll = (tenant: string, orderId: string, token = 'good-token') =>
        request(h.app.getHttpServer())
          .get(`/t/orders/${orderId}`)
          .query({ accessToken: token })
          .set('x-test-tenant', tenant);

      it('lets normal polling run: six tabs polling every 15 s for a minute stay allowed', async () => {
        const tenant = unique('t');
        const orderId = unique('order');
        const statuses: number[] = [];
        for (let i = 0; i < 24; i += 1)
          statuses.push((await poll(tenant, orderId)).status);
        expect(statuses.every((s) => s === 200)).toBe(true);
      });

      it('bounds one order independently of others', async () => {
        const tenant = unique('t');
        const busy = unique('busy');
        let last = 200;
        for (let i = 0; i < 35; i += 1)
          last = (await poll(tenant, busy)).status;
        expect(last).toBe(429);
        expect((await poll(tenant, unique('other'))).status).toBe(200);
      });

      it('counts only FAILED lookups against the address, then blocks guessing', async () => {
        const tenant = unique('t');
        const orderId = unique('o');
        // Successful polls never count toward the failure limit.
        for (let i = 0; i < 10; i += 1)
          expect((await poll(tenant, orderId)).status).toBe(200);
        // Wrong tokens: 404 three times (the limit), then 429 — for ANY order id.
        const bad: number[] = [];
        for (let i = 0; i < 5; i += 1)
          bad.push((await poll(tenant, unique('guess'), 'wrong')).status);
        expect(bad).toEqual([404, 404, 404, 429, 429]);
        const blocked = await poll(tenant, orderId);
        expect(blocked.status).toBe(429);
        expect(blocked.body).toEqual({
          statusCode: 429,
          message: RATE_LIMIT_MESSAGE,
        });
      });

      it('does not reveal whether an order exists in a limited response', async () => {
        const tenant = unique('t');
        for (let i = 0; i < 3; i += 1) await poll(tenant, unique('g'), 'wrong');
        const a = await poll(tenant, unique('existing'));
        const b = await poll(tenant, unique('missing'), 'wrong');
        expect([a.status, a.body]).toEqual([b.status, b.body]);
      });
    });

    it('caps account-recovery emails per address and per identifier', async () => {
      const tenant = unique('t');
      const identifier = `${unique('victim')}@example.com`;
      const results: number[] = [];
      for (let i = 0; i < 4; i += 1)
        results.push(
          (
            await post(h.app, '/t/forgot')
              .set('x-test-tenant', tenant)
              .send({ email: identifier })
          ).status,
        );
      expect(results).toEqual([201, 201, 429, 429]);
    });

    it('limits reset/verify code guessing per identifier', async () => {
      const tenant = unique('t');
      const email = `${unique('guess')}@example.com`;
      const results: number[] = [];
      for (let i = 0; i < 5; i += 1)
        results.push(
          (
            await post(h.app, '/t/reset')
              .set('x-test-tenant', tenant)
              .send({ email })
          ).status,
        );
      expect(results).toEqual([201, 201, 201, 429, 429]);
    });

    it('puts a missing, object or oversized identifier in ONE shared bucket instead of skipping the limits', async () => {
      const tenant = unique('t');
      const malformed: Array<Record<string, unknown>> = [
        {},
        { identifier: { $ne: 1 } },
        { identifier: ['a', 'b'] },
        { identifier: 'x'.repeat(400) },
        { identifier: '   ' },
        { identifier: 7 },
      ];
      const statuses: number[] = [];
      for (const body of malformed) {
        statuses.push(
          (
            await post(h.app, '/t/sign-in')
              .set('x-test-tenant', tenant)
              .send(body)
          ).status,
        );
      }
      // The shared bucket for unparseable identifiers fills after 3 (pair limit).
      expect(statuses).toEqual([201, 201, 201, 429, 429, 429]);
    });
  });

  describe("peer IP mode behind one trusted proxy ('trust proxy' 1)", () => {
    let h: Harness;
    beforeAll(async () => {
      h = await buildApp(
        { RATE_LIMIT_CLIENT_IP_MODE: 'peer' },
        { trustProxy: 1 },
      );
    });
    afterAll(() => h.close());

    it('gives each real client behind the proxy its own address bucket', async () => {
      const tenant = unique('t');
      const identifier = `${unique('shared')}@example.com`;
      for (let i = 0; i < 4; i += 1) {
        await post(h.app, '/t/sign-in')
          .set('x-test-tenant', tenant)
          .set('x-forwarded-for', '203.0.113.10')
          .send({ identifier, password: 'x' });
      }
      expect(
        (
          await post(h.app, '/t/sign-in')
            .set('x-test-tenant', tenant)
            .set('x-forwarded-for', '203.0.113.10')
            .send({ identifier, password: 'x' })
        ).status,
      ).toBe(429);
      // A different client address, same identifier: not blocked by the pair limit.
      expect(
        (
          await post(h.app, '/t/sign-in')
            .set('x-test-tenant', tenant)
            .set('x-forwarded-for', '203.0.113.11')
            .send({ identifier, password: 'x' })
        ).status,
      ).toBe(201);
    });

    it('still caps an identifier across many addresses (email-bombing / stuffing ceiling)', async () => {
      const tenant = unique('t');
      const victim = `${unique('victim')}@example.com`;
      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        statuses.push(
          (
            await post(h.app, '/t/forgot')
              .set('x-test-tenant', tenant)
              .set('x-forwarded-for', `198.51.100.${i + 1}`)
              .send({ email: victim })
          ).status,
        );
      }
      // ceiling is 4 per identifier regardless of address
      expect(statuses).toEqual([201, 201, 201, 201, 429, 429]);
    });
  });

  describe('forwarded IP mode (signed client address from the web tier)', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await buildApp({ CLIENT_IP_FORWARD_SECRET: SECRET });
    });
    afterAll(() => h.close());

    const signedHeaders = (
      ip: string,
      secret = SECRET,
      seconds = Math.floor(Date.now() / 1000),
    ) => ({
      [CLIENT_IP_HEADER]: ip,
      [CLIENT_IP_TIMESTAMP_HEADER]: String(seconds),
      [CLIENT_IP_SIGNATURE_HEADER]: signClientIp(secret, ip, seconds),
    });

    const checkout = (tenant: string, headers: Record<string, string>) =>
      post(h.app, '/t/checkout')
        .set('x-test-tenant', tenant)
        .set(headers)
        .send({});

    it('buckets by the signed client address, not by the web server that sent it', async () => {
      const tenant = unique('t');
      for (let i = 0; i < 4; i += 1)
        await checkout(tenant, signedHeaders('203.0.113.50'));
      expect(
        (await checkout(tenant, signedHeaders('203.0.113.50'))).status,
      ).toBe(429);
      expect(
        (await checkout(tenant, signedHeaders('203.0.113.51'))).status,
      ).toBe(201);
    });

    it('treats a forged, stale or secret-mismatched signature as an ordinary (peer) request', async () => {
      const tenant = unique('t');
      // Forged requests all land in the one peer bucket: they cannot pick a fresh one.
      const forged: Array<Record<string, string>> = [
        signedHeaders(
          '203.0.113.60',
          'another-secret-that-is-also-32-characters-long',
        ),
        signedHeaders(
          '203.0.113.61',
          SECRET,
          Math.floor(Date.now() / 1000) - 3600,
        ),
        {
          ...signedHeaders('203.0.113.62'),
          [CLIENT_IP_SIGNATURE_HEADER]: '00'.repeat(32),
        },
        { [CLIENT_IP_HEADER]: '203.0.113.63' },
        {},
      ];
      const statuses: number[] = [];
      for (const headers of forged)
        statuses.push((await checkout(tenant, headers)).status);
      expect(statuses).toEqual([201, 201, 201, 201, 429]);
    });
  });

  describe("no client-IP source declared (mode 'off')", () => {
    let h: Harness;
    beforeAll(async () => {
      h = await buildApp({});
    });
    afterAll(() => h.close());

    it('leaves per-address limits inactive but still enforces the tenant ceiling', async () => {
      const tenant = unique('t');
      const statuses: number[] = [];
      for (let i = 0; i < 14; i += 1)
        statuses.push(
          (
            await post(h.app, '/t/checkout')
              .set('x-test-tenant', tenant)
              .send({})
          ).status,
        );
      // The anonymous per-address limit (4) is NOT applied; the tenant ceiling (12) is.
      expect(statuses.slice(0, 12).every((s) => s === 201)).toBe(true);
      expect(statuses.slice(12)).toEqual([429, 429]);
    });

    it('still protects credential routes per identifier', async () => {
      const tenant = unique('t');
      const identifier = `${unique('stuffed')}@example.com`;
      const statuses: number[] = [];
      for (let i = 0; i < 8; i += 1)
        statuses.push(
          (
            await post(h.app, '/t/sign-in')
              .set('x-test-tenant', tenant)
              .send({ identifier, password: 'x' })
          ).status,
        );
      // pair scope needs an address and is inactive; the identifier ceiling (6) holds
      expect(statuses).toEqual([201, 201, 201, 201, 201, 201, 429, 429]);
    });

    it('still bounds failed order lookups per order, and polling per order', async () => {
      const tenant = unique('t');
      const orderId = unique('o');
      let last = 200;
      for (let i = 0; i < 35; i += 1) {
        last = (
          await request(h.app.getHttpServer())
            .get(`/t/orders/${orderId}`)
            .query({ accessToken: 'good-token' })
            .set('x-test-tenant', tenant)
        ).status;
      }
      expect(last).toBe(429);
    });
  });

  describe('when Redis is unavailable', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await buildApp(
        { RATE_LIMIT_CLIENT_IP_MODE: 'peer' },
        { redisDown: true },
      );
    });
    afterAll(() => h.close());

    it('keeps enforcing limits in memory instead of switching protection off', async () => {
      const tenant = unique('t');
      const identifier = `${unique('down')}@example.com`;
      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1)
        statuses.push(
          (
            await post(h.app, '/t/sign-in')
              .set('x-test-tenant', tenant)
              .send({ identifier, password: 'x' })
          ).status,
        );
      expect(statuses).toEqual([201, 201, 201, 429, 429]);
      expect(h.service.status().backend).toBe('memory');
      expect(h.service.status().fallbackDecisions).toBeGreaterThan(0);
    });

    it('still serves normal polling', async () => {
      const tenant = unique('t');
      const orderId = unique('o');
      for (let i = 0; i < 12; i += 1) {
        const res = await request(h.app.getHttpServer())
          .get(`/t/orders/${orderId}`)
          .query({ accessToken: 'good-token' })
          .set('x-test-tenant', tenant);
        expect(res.status).toBe(200);
      }
    });
  });

  describe('when rate limiting is switched off', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await buildApp({ RATE_LIMIT_ENABLED: '0' });
    });
    afterAll(() => h.close());

    it('applies no limits (development only: production refuses to start this way)', async () => {
      const tenant = unique('t');
      for (let i = 0; i < 30; i += 1) {
        expect(
          (
            await post(h.app, '/t/checkout')
              .set('x-test-tenant', tenant)
              .send({})
          ).status,
        ).toBe(201);
      }
    });
  });
});

describe('rate limiting: abuse resistance', () => {
  describe('the limiter reads the field the handler acts on', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await buildApp({ RATE_LIMIT_CLIENT_IP_MODE: 'peer' });
    });
    afterAll(() => h.close());

    it('cannot be sidestepped by a throwaway "identifier" next to the real "email" (recovery, reset)', async () => {
      const tenant = unique('t');
      const victim = `${unique('victim')}@example.com`;
      const forgot: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        forgot.push(
          (
            await post(h.app, '/t/forgot')
              .set('x-test-tenant', tenant)
              .send({ email: victim, identifier: `throwaway-${i}` })
          ).status,
        );
      }
      // the bucket is the victim's EMAIL, whatever "identifier" says
      expect(forgot).toEqual([201, 201, 429, 429]);

      const reset: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        reset.push(
          (
            await post(h.app, '/t/reset')
              .set('x-test-tenant', tenant)
              .send({
                email: victim,
                identifier: `throwaway-${i}`,
                code: String(i),
              })
          ).status,
        );
      }
      expect(reset).toEqual([201, 201, 201, 429, 429]);
    });

    it('cannot be sidestepped by a throwaway "email" next to the real "identifier" (sign-in)', async () => {
      const tenant = unique('t');
      const identifier = `${unique('real')}@example.com`;
      const statuses: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        statuses.push(
          (
            await post(h.app, '/t/sign-in')
              .set('x-test-tenant', tenant)
              .send({
                identifier,
                email: `throwaway-${i}@example.com`,
                password: 'x',
              })
          ).status,
        );
      }
      expect(statuses).toEqual([201, 201, 201, 429]);
    });
  });

  describe('refused requests do not consume wider shared allowances', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await buildApp(
        { RATE_LIMIT_CLIENT_IP_MODE: 'peer' },
        { trustProxy: 1 },
      );
    });
    afterAll(() => h.close());

    it('one source hammering an identifier cannot exhaust its ceiling and lock the customer out', async () => {
      const tenant = unique('t');
      const victim = `${unique('victim')}@example.com`;
      // The attacker (one address) sends many requests; only its first 2 are counted
      // anywhere (pair limit 2) — the rest are refused before the ceiling (4) is touched.
      for (let i = 0; i < 25; i += 1) {
        await post(h.app, '/t/forgot')
          .set('x-test-tenant', tenant)
          .set('x-forwarded-for', '203.0.113.99')
          .send({ email: victim });
      }
      // The real customer, from another address, can still use the remaining allowance.
      const statuses: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        statuses.push(
          (
            await post(h.app, '/t/forgot')
              .set('x-test-tenant', tenant)
              .set('x-forwarded-for', '198.51.100.7')
              .send({ email: victim })
          ).status,
        );
      }
      expect(statuses).toEqual([201, 201, 429]); // ceiling 4 = 2 (attacker) + 2 (customer)
    });

    it('one flooding address cannot exhaust the tenant ceiling for everyone else', async () => {
      const tenant = unique('t');
      for (let i = 0; i < 60; i += 1) {
        await post(h.app, '/t/checkout')
          .set('x-test-tenant', tenant)
          .set('x-forwarded-for', '203.0.113.77')
          .send({});
      }
      // The flood was refused at the per-address scope (4), so only 4 counted against the
      // tenant ceiling (12): several signed-in customers can still check out.
      for (const subject of ['c1', 'c2']) {
        for (let i = 0; i < 4; i += 1) {
          expect(
            (
              await post(h.app, '/t/checkout')
                .set('x-test-tenant', tenant)
                .set('x-test-subject', subject)
                .set('x-forwarded-for', '198.51.100.8')
                .send({})
            ).status,
          ).toBe(201);
        }
      }
    });
  });

  describe('guest order status failure counter', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await buildApp({ RATE_LIMIT_CLIENT_IP_MODE: 'peer' });
    });
    afterAll(() => h.close());

    const poll = (tenant: string, orderId: string, token: string) =>
      request(h.app.getHttpServer())
        .get(`/t/orders/${orderId}`)
        .query({ accessToken: token })
        .set('x-test-tenant', tenant);

    it('limits a concurrent burst of guesses straight away (no check-then-record race)', async () => {
      const tenant = unique('t');
      // All 40 requests are in flight at once against the app's one shared server.
      const results = await Promise.all(
        Array.from({ length: 40 }, () =>
          poll(tenant, unique('guess'), 'wrong'),
        ),
      );
      const notFound = results.filter((r) => r.status === 404).length;
      const limited = results.filter((r) => r.status === 429).length;
      expect(notFound).toBe(3); // the failure limit
      expect(limited).toBe(37);
    });

    it('gives a successful lookup back, so a customer polling for an hour never fills it', async () => {
      const tenant = unique('t');
      const orderId = unique('o');
      for (let i = 0; i < 12; i += 1)
        expect((await poll(tenant, orderId, 'good-token')).status).toBe(200);
      // all 12 reservations were returned: three wrong guesses still get their 404s
      const bad: number[] = [];
      for (let i = 0; i < 4; i += 1)
        bad.push((await poll(tenant, unique('g'), 'wrong')).status);
      expect(bad).toEqual([404, 404, 404, 429]);
    });
  });

  describe('memory fallback under a key flood', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await buildApp(
        { RATE_LIMIT_CLIENT_IP_MODE: 'peer' },
        { redisDown: true },
      );
    });
    afterAll(() => h.close());

    it('still limits normally while Redis is down, including the failure counter and its release', async () => {
      const tenant = unique('t');
      const orderId = unique('o');
      for (let i = 0; i < 6; i += 1) {
        expect(
          (
            await request(h.app.getHttpServer())
              .get(`/t/orders/${orderId}`)
              .query({ accessToken: 'good-token' })
              .set('x-test-tenant', tenant)
          ).status,
        ).toBe(200);
      }
      const bad: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        bad.push(
          (
            await request(h.app.getHttpServer())
              .get(`/t/orders/${unique('g')}`)
              .query({ accessToken: 'wrong' })
              .set('x-test-tenant', tenant)
          ).status,
        );
      }
      expect(bad).toEqual([404, 404, 404, 429]);
    });
  });
});
