import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { InternalUserProfile } from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { CustomersModule } from '../customers/customers.module';
import { OrdersModule } from '../orders/orders.module';
import { CatalogModule } from '../catalog/catalog.module';
import { LocationsModule } from '../locations/locations.module';
import { InternalAuthModule } from './internal-auth.module';
import { signInternalDevJwt } from './infrastructure/internal-dev-jwt';
import { signDevJwt } from '../customer-auth/infrastructure/dev-jwt';

// Full HTTP integration: every /api/v1/admin/* controller plus the internal
// sign-in / me namespace, wired exactly as AppModule wires them, exercised
// over real HTTP. Proves the InternalAuthGuard boundary end to end and that
// a customer token can never cross it.
describe('Internal admin authentication boundary (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'admin-protection-spec-internal-secret';
  const customerSecret = 'admin-protection-spec-customer-secret';

  const activeEmail = `admin-protection-active-${randomUUID()}@example.com`;
  const invitedEmail = `admin-protection-invited-${randomUUID()}@example.com`;
  const createdEmails = [activeEmail, invitedEmail];

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = customerSecret;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        PrismaModule,
        CustomerAuthModule,
        CustomersModule,
        InternalAuthModule,
        OrdersModule,
        CatalogModule,
        LocationsModule,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    await prisma.internalUser.create({
      data: {
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:${activeEmail}`,
        email: activeEmail,
        displayName: 'Active Admin',
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    await prisma.internalUser.create({
      data: {
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:${invitedEmail}`,
        email: invitedEmail,
        displayName: 'Invited Admin',
        status: 'INVITED',
      },
    });
  });

  afterAll(async () => {
    await prisma.internalUser.deleteMany({
      where: { email: { in: createdEmails } },
    });
    await app.close();
    process.env = { ...originalEnv };
  });

  const internalToken = (email: string) =>
    signInternalDevJwt(
      { sub: `internal-dev:${email}`, email, name: null },
      internalSecret,
      3600,
    );

  const customerToken = () =>
    signDevJwt(
      {
        sub: 'dev:shopper@example.com',
        email: 'shopper@example.com',
        name: null,
      },
      customerSecret,
      3600,
    );

  describe('POST /api/v1/internal/auth/sign-in', () => {
    it('400 when identifier/password missing', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/internal/auth/sign-in')
        .send({ identifier: 'admin@example.com' })
        .expect(400);
    });

    it('mints an internal token for valid dev credentials', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/internal/auth/sign-in')
        .send({ identifier: activeEmail, password: 'anything-in-dev' })
        .expect(201);
      expect(typeof (res.body as { idToken: string }).idToken).toBe('string');
      expect(
        (res.body as { expiresInSeconds: number }).expiresInSeconds,
      ).toBeGreaterThan(0);
    });
  });

  describe('GET /api/v1/internal/me', () => {
    it('401 with no token', async () => {
      await request(app.getHttpServer()).get('/api/v1/internal/me').expect(401);
    });

    it('401 with a garbage token', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/internal/me')
        .set('Authorization', 'Bearer not-a-real-token')
        .expect(401);
    });

    it('401 with a valid CUSTOMER token (isolation)', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/internal/me')
        .set('Authorization', `Bearer ${customerToken()}`)
        .expect(401);
    });

    it('403 for a valid internal token with no matching InternalUser', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/internal/me')
        .set(
          'Authorization',
          `Bearer ${internalToken(`unknown-${randomUUID()}@example.com`)}`,
        )
        .expect(403);
    });

    it('403 for a valid internal token mapped to an INVITED user', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/internal/me')
        .set('Authorization', `Bearer ${internalToken(invitedEmail)}`)
        .expect(403);
    });

    it('200 with the profile for an ACTIVE internal user', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/internal/me')
        .set('Authorization', `Bearer ${internalToken(activeEmail)}`)
        .expect(200);
      const body = res.body as InternalUserProfile;
      expect(body.email).toBe(activeEmail);
      expect(body.status).toBe('ACTIVE');
      expect(typeof body.id).toBe('string');
    });

    it('suspending an ACTIVE user immediately blocks a still-valid token', async () => {
      const email = `admin-protection-suspend-${randomUUID()}@example.com`;
      createdEmails.push(email);
      await prisma.internalUser.create({
        data: {
          externalProvider: 'internal-dev',
          externalSubject: `internal-dev:${email}`,
          email,
          status: 'ACTIVE',
          activatedAt: new Date(),
        },
      });
      const token = internalToken(email);

      await request(app.getHttpServer())
        .get('/api/v1/internal/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      await prisma.internalUser.update({
        where: { email },
        data: { status: 'SUSPENDED' },
      });

      await request(app.getHttpServer())
        .get('/api/v1/internal/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });
  });

  const BOGUS_LOCATION = '00000000-0000-0000-0000-000000000000';

  // Every entry is a REAL route on one of the three admin controllers, so
  // route matching always succeeds and the guard always runs.
  describe.each([
    ['GET', `/api/v1/admin/orders?locationId=${BOGUS_LOCATION}`, undefined],
    [
      'GET',
      `/api/v1/admin/orders/${BOGUS_LOCATION}?locationId=${BOGUS_LOCATION}`,
      undefined,
    ],
    [
      'POST',
      `/api/v1/admin/orders/${BOGUS_LOCATION}/advance`,
      { locationId: BOGUS_LOCATION, expectedStatus: 'RECEIVED' },
    ],
    ['PATCH', '/api/v1/admin/catalog/products/nonexistent', { isActive: true }],
    [
      'PATCH',
      '/api/v1/admin/locations/nonexistent/digital-ordering',
      { isDigitalOrderingEnabled: true },
    ],
  ] as const)('%s %s', (method, path, body) => {
    const send = (t?: string) => {
      const lower = method.toLowerCase() as 'get' | 'post' | 'patch';
      const req = request(app.getHttpServer())[lower](path);
      if (body) req.send(body);
      return t ? req.set('Authorization', `Bearer ${t}`) : req;
    };

    it('401 without a token', async () => {
      await send().expect(401);
    });

    it('401 with a valid customer token (isolation)', async () => {
      await send(customerToken()).expect(401);
    });

    it('403 with an internal token for an INVITED user', async () => {
      await send(internalToken(invitedEmail)).expect(403);
    });

    it('passes the guard (not 401/403) with an ACTIVE internal token', async () => {
      const res = await send(internalToken(activeEmail));
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  it('GET /api/v1/admin/orders returns 200 for an ACTIVE internal user', async () => {
    const res = await request(app.getHttpServer())
      .get(
        '/api/v1/admin/orders?locationId=00000000-0000-0000-0000-000000000000',
      )
      .set('Authorization', `Bearer ${internalToken(activeEmail)}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
