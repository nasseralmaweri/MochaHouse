import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { CustomerProfile } from '@mocha-house/contracts';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { CustomerAuthModule } from '../../customer-auth/customer-auth.module';
import { signDevJwt } from '../../customer-auth/infrastructure/dev-jwt';
import { CustomersModule } from '../customers.module';

// Full HTTP integration test: PrismaModule + CustomerAuthModule +
// CustomersModule wired exactly as AppModule wires them, exercised over
// real HTTP with supertest — proves the guard, controller, and service are
// correctly connected, not just individually correct in isolation.
describe('GET /api/v1/customers/me (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const devSecret = 'customers-controller-spec-secret';

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = devSecret;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, CustomerAuthModule, CustomersModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.customer.deleteMany({
      where: {
        externalProvider: 'dev',
        externalSubject: { startsWith: 'dev:test-' },
      },
    });
    await app.close();
    process.env = { ...originalEnv };
  });

  function devToken(identifier: string): string {
    return signDevJwt(
      { sub: `dev:${identifier}`, email: identifier, name: null },
      devSecret,
      3600,
    );
  }

  it('rejects a request with no Authorization header', async () => {
    await request(app.getHttpServer()).get('/api/v1/customers/me').expect(401);
  });

  it('rejects a malformed/invalid token', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/customers/me')
      .set('Authorization', 'Bearer not-a-real-token')
      .expect(401);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const token = signDevJwt(
      { sub: 'dev:x', email: null, name: null },
      'wrong-secret',
      3600,
    );
    await request(app.getHttpServer())
      .get('/api/v1/customers/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('resolves a valid authenticated customer and returns their profile', async () => {
    const identifier = `test-${randomUUID()}@example.com`;
    const token = devToken(identifier);

    const response = await request(app.getHttpServer())
      .get('/api/v1/customers/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const body = response.body as CustomerProfile;
    expect(body.email).toBe(identifier);
    expect(body.status).toBe('ACTIVE');
    expect(typeof body.id).toBe('string');

    const stored = await prisma.customer.findUnique({
      where: {
        externalProvider_externalSubject: {
          externalProvider: 'dev',
          externalSubject: `dev:${identifier}`,
        },
      },
    });
    expect(stored).not.toBeNull();
  });

  it('resolves the same customer id across repeated sign-ins by the same identity', async () => {
    const identifier = `test-${randomUUID()}@example.com`;
    const token = devToken(identifier);

    const first = await request(app.getHttpServer())
      .get('/api/v1/customers/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const second = await request(app.getHttpServer())
      .get('/api/v1/customers/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect((second.body as CustomerProfile).id).toBe(
      (first.body as CustomerProfile).id,
    );
  });

  describe('PATCH /api/v1/customers/me (Milestone 4E)', () => {
    it('rejects an unauthenticated update with 401', async () => {
      await request(app.getHttpServer())
        .patch('/api/v1/customers/me')
        .send({ displayName: 'Nope' })
        .expect(401);
    });

    it('rejects a malformed/invalid bearer token with 401', async () => {
      await request(app.getHttpServer())
        .patch('/api/v1/customers/me')
        .set('Authorization', 'Bearer not-a-real-token')
        .send({ displayName: 'Nope' })
        .expect(401);
    });

    it('rejects an expired bearer token with 401', async () => {
      const expired = signDevJwt(
        { sub: 'dev:x', email: 'x@example.com', name: null },
        devSecret,
        -10,
      );
      await request(app.getHttpServer())
        .patch('/api/v1/customers/me')
        .set('Authorization', `Bearer ${expired}`)
        .send({ displayName: 'Nope' })
        .expect(401);
    });

    it('updates the display name and returns it, and GET /me then reflects it', async () => {
      const identifier = `test-${randomUUID()}@example.com`;
      const token = devToken(identifier);

      const patched = await request(app.getHttpServer())
        .patch('/api/v1/customers/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ displayName: '  Grace   Hopper ' })
        .expect(200);
      expect((patched.body as CustomerProfile).displayName).toBe(
        'Grace Hopper',
      );

      const me = await request(app.getHttpServer())
        .get('/api/v1/customers/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect((me.body as CustomerProfile).displayName).toBe('Grace Hopper');
    });

    it('stores a blank display name as null', async () => {
      const token = devToken(`test-${randomUUID()}@example.com`);
      const patched = await request(app.getHttpServer())
        .patch('/api/v1/customers/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ displayName: '   ' })
        .expect(200);
      expect((patched.body as CustomerProfile).displayName).toBeNull();
    });

    it('rejects an over-long display name with 400', async () => {
      const token = devToken(`test-${randomUUID()}@example.com`);
      await request(app.getHttpServer())
        .patch('/api/v1/customers/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ displayName: 'x'.repeat(81) })
        .expect(400);
    });

    it('ignores unknown fields and cannot change identity/status/verification', async () => {
      const identifier = `test-${randomUUID()}@example.com`;
      const token = devToken(identifier);

      // Establish the row first.
      const before = await request(app.getHttpServer())
        .get('/api/v1/customers/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const beforeBody = before.body as CustomerProfile;

      await request(app.getHttpServer())
        .patch('/api/v1/customers/me')
        .set('Authorization', `Bearer ${token}`)
        .send({
          displayName: 'Legit Name',
          id: 'hacked-id',
          status: 'DEACTIVATED',
          emailVerified: true,
          email: 'attacker@example.com',
          externalSubject: 'dev:someone-else',
        })
        .expect(200);

      const stored = await prisma.customer.findUnique({
        where: {
          externalProvider_externalSubject: {
            externalProvider: 'dev',
            externalSubject: `dev:${identifier}`,
          },
        },
      });
      expect(stored?.id).toBe(beforeBody.id);
      expect(stored?.status).toBe('ACTIVE');
      expect(stored?.emailVerifiedAt).toBeNull();
      expect(stored?.email).toBe(identifier);
      expect(stored?.displayName).toBe('Legit Name');
    });

    it('one customer updating their profile never affects another', async () => {
      const tokenA = devToken(`test-${randomUUID()}@example.com`);
      const idB = `test-${randomUUID()}@example.com`;
      const tokenB = devToken(idB);

      await request(app.getHttpServer())
        .patch('/api/v1/customers/me')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ displayName: 'Belongs To B' })
        .expect(200);

      await request(app.getHttpServer())
        .patch('/api/v1/customers/me')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ displayName: 'Belongs To A' })
        .expect(200);

      const meB = await request(app.getHttpServer())
        .get('/api/v1/customers/me')
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);
      expect((meB.body as CustomerProfile).displayName).toBe('Belongs To B');
    });

    it('a customer-set display name survives a subsequent sign-in that carries a provider name claim', async () => {
      const identifier = `test-${randomUUID()}@example.com`;
      const seededToken = signDevJwt(
        { sub: `dev:${identifier}`, email: identifier, name: 'Provider Name' },
        devSecret,
        3600,
      );

      // First sign-in seeds displayName from the provider claim.
      const seeded = await request(app.getHttpServer())
        .get('/api/v1/customers/me')
        .set('Authorization', `Bearer ${seededToken}`)
        .expect(200);
      expect((seeded.body as CustomerProfile).displayName).toBe(
        'Provider Name',
      );

      // Customer edits it.
      await request(app.getHttpServer())
        .patch('/api/v1/customers/me')
        .set('Authorization', `Bearer ${seededToken}`)
        .send({ displayName: 'My Own Name' })
        .expect(200);

      // A later sign-in still carrying the old provider name must not undo it.
      const later = await request(app.getHttpServer())
        .get('/api/v1/customers/me')
        .set('Authorization', `Bearer ${seededToken}`)
        .expect(200);
      expect((later.body as CustomerProfile).displayName).toBe('My Own Name');
    });
  });
});
