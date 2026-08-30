import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  INTERNAL_PERMISSION_KEYS,
  type InternalUserProfile,
} from '@mocha-house/contracts';
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

// Full HTTP integration for the authentication + lifecycle boundary
// (InternalAuthGuard) and customer isolation, plus the 5B fact that an
// ACTIVE internal user with no role assignments is denied by PermissionGuard
// on every admin route. The exhaustive permission/scope matrix lives in
// internal-authorization.spec.ts.
describe('Internal admin authentication + baseline authorization (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'admin-protection-spec-internal-secret';
  const customerSecret = 'admin-protection-spec-customer-secret';

  const activeNoRolesEmail = `admin-protection-noroles-${randomUUID()}@example.com`;
  const grantedEmail = `admin-protection-granted-${randomUUID()}@example.com`;
  const invitedEmail = `admin-protection-invited-${randomUUID()}@example.com`;
  const createdEmails = [activeNoRolesEmail, grantedEmail, invitedEmail];
  const roleKey = `admin-protection-all-${randomUUID()}`;
  let roleId: string;

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

    const activeNoRoles = await prisma.internalUser.create({
      data: {
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:${activeNoRolesEmail}`,
        email: activeNoRolesEmail,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    void activeNoRoles;

    const granted = await prisma.internalUser.create({
      data: {
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:${grantedEmail}`,
        email: grantedEmail,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    await prisma.internalUser.create({
      data: {
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:${invitedEmail}`,
        email: invitedEmail,
        status: 'INVITED',
      },
    });

    const role = await prisma.internalRole.create({
      data: {
        key: roleKey,
        displayName: 'Admin Protection Spec — all permissions',
        permissions: {
          create: INTERNAL_PERMISSION_KEYS.map((permissionKey) => ({
            permissionKey,
          })),
        },
      },
    });
    roleId = role.id;
    await prisma.internalUserRoleAssignment.create({
      data: {
        internalUserId: granted.id,
        roleId: role.id,
        scopeType: 'CORPORATE',
        scopeId: null,
      },
    });
  });

  afterAll(async () => {
    await prisma.internalUserRoleAssignment.deleteMany({ where: { roleId } });
    await prisma.internalRolePermission.deleteMany({ where: { roleId } });
    await prisma.internalRole.deleteMany({ where: { id: roleId } });
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
        .send({ identifier: grantedEmail, password: 'anything-in-dev' })
        .expect(201);
      expect(typeof (res.body as { idToken: string }).idToken).toBe('string');
      expect(
        (res.body as { expiresInSeconds: number }).expiresInSeconds,
      ).toBeGreaterThan(0);
    });
  });

  describe('GET /api/v1/internal/me (authentication + lifecycle only — no permission required)', () => {
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

    it('200 for an ACTIVE internal user even with no role assignments (me needs no permission)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/internal/me')
        .set('Authorization', `Bearer ${internalToken(activeNoRolesEmail)}`)
        .expect(200);
      const body = res.body as InternalUserProfile;
      expect(body.email).toBe(activeNoRolesEmail);
      expect(body.status).toBe('ACTIVE');
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

  // Every entry is a REAL route on one of the three admin controllers.
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

    it('403 with an internal token for an INVITED user (lifecycle)', async () => {
      await send(internalToken(invitedEmail)).expect(403);
    });

    it('403 with an ACTIVE internal token that has NO role assignments (authorization)', async () => {
      await send(internalToken(activeNoRolesEmail)).expect(403);
    });

    it('passes both guards (not 401/403) with an ACTIVE corporate-granted internal token', async () => {
      const res = await send(internalToken(grantedEmail));
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  it('GET /api/v1/admin/orders returns 200 for a corporate-granted internal user', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/admin/orders?locationId=${BOGUS_LOCATION}`)
      .set('Authorization', `Bearer ${internalToken(grantedEmail)}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
