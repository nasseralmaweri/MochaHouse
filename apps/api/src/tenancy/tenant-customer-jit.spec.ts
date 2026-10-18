import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  TEST_TENANT_B_NAME,
  createTestTenantB,
  removeTestTenantB,
  tenantContextFor,
} from '@mocha-house/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { CustomersModule } from '../customers/customers.module';
import { CustomersService } from '../customers/application/customers.service';
import type { CustomerIdentity } from '../customer-auth/infrastructure/customer-identity';
import { signDevJwt } from '../customer-auth/infrastructure/dev-jwt';

// Milestone S0D-2B-1, revised by SC4f-2 — a customer profile's business
// comes ONLY from the explicit, server-resolved TenantContext; one login may
// hold one profile per business, each created only by an explicit action
// there, and never borrowed, adopted or matched across businesses.
describe('SC4f-2 customer profile ownership per business (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let customers: CustomersService;
  const originalEnv = { ...process.env };
  const customerSecret = 's0d2b1-customer-secret';
  const suffix = randomUUID().slice(0, 8);
  const createdSubjects: string[] = [];
  const T1 = tenantContextFor(TENANT_1_MOCHA_HOUSE_ID);
  const TB = tenantContextFor(TEST_TENANT_B_ID);

  const identity = (label: string, email?: string): CustomerIdentity => {
    const subject = `dev:s0d2b1-${label}-${suffix}`;
    createdSubjects.push(subject);
    return {
      provider: 'dev',
      subject,
      email: email ?? `s0d2b1-${label}-${suffix}@example.com`,
      name: `S0D2B1 ${label}`,
      emailVerified: true,
    };
  };
  const tokenFor = (id: CustomerIdentity) =>
    signDevJwt(
      {
        sub: id.subject,
        email: id.email!,
        name: id.name,
        emailVerified: id.emailVerified,
      },
      customerSecret,
      3600,
    );
  const profileOf = (res: { body: unknown }) =>
    (res.body as { profile: { id: string } }).profile;
  const profilesOf = (id: CustomerIdentity) =>
    prisma.customer.findMany({
      where: { externalProvider: id.provider, externalSubject: id.subject },
      orderBy: { createdAt: 'asc' },
    });

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = customerSecret;

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, CustomerAuthModule, CustomersModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    customers = moduleRef.get(CustomersService);
    await createTestTenantB(prisma);
  });

  afterAll(async () => {
    await prisma.customer.deleteMany({
      where: { externalSubject: { in: createdSubjects } },
    });
    await removeTestTenantB(prisma);
    await app.close();
    process.env = { ...originalEnv };
  });

  it('A + C: joining over HTTP creates the profile at the resolved business, whatever business the client claims', async () => {
    const id = identity('http');

    const joined = await request(app.getHttpServer())
      .post('/api/v1/customers/me/enrollment')
      .query({ tenantId: TEST_TENANT_B_ID })
      .set('Authorization', `Bearer ${tokenFor(id)}`)
      .set('x-tenant-id', TEST_TENANT_B_ID)
      .send({ tenantId: TEST_TENANT_B_ID })
      .expect(201);
    expect(joined.body).toMatchObject({ created: true });

    // A profile edit carrying Tenant B cannot re-home the Customer either.
    const patched = await request(app.getHttpServer())
      .patch('/api/v1/customers/me')
      .set('Authorization', `Bearer ${tokenFor(id)}`)
      .set('x-tenant-id', TEST_TENANT_B_ID)
      .send({ displayName: 'Renamed', tenantId: TEST_TENANT_B_ID })
      .expect(200);

    const [customer, ...others] = await profilesOf(id);
    expect(others).toEqual([]);
    expect(customer.tenantId).toBe(TENANT_1_MOCHA_HOUSE_ID);
    expect(customer.displayName).toBe('Renamed');
    // Ownership is not exposed through the customer-facing contract.
    expect(patched.body).not.toHaveProperty('tenantId');
    expect(profileOf(joined)).not.toHaveProperty('tenantId');
  });

  it('B: joining under an explicit Tenant B context creates a Tenant B profile', async () => {
    const { customer } = await customers.enroll(identity('tenant-b'), TB, {});
    expect(customer.tenantId).toBe(TEST_TENANT_B_ID);
  });

  it('D: an existing Tenant #1 profile resolves to the same row and resyncs its email as before', async () => {
    const id = identity('existing');
    const created = await customers.createAtRegistration(id, T1);

    const newEmail = `s0d2b1-existing-new-${suffix}@example.com`;
    const again = await customers.requireCustomer(
      { ...id, email: newEmail, name: 'Ignored on resync' },
      T1,
      'profile',
    );

    expect(again.id).toBe(created.id);
    expect(again.tenantId).toBe(TENANT_1_MOCHA_HOUSE_ID);
    expect(again.email).toBe(newEmail);
    expect(again.displayName).toBe(created.displayName);
  });

  it("E: a login with only Tenant B's profile is NOT_ENROLLED at Tenant #1; nothing of B is revealed or touched", async () => {
    const id = identity('owned-by-b');
    const { customer: bCustomer } = await customers.enroll(id, TB, {});

    for (const path of [
      '/api/v1/customers/me',
      '/api/v1/customers/me/preferences',
    ]) {
      const response = await request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${tokenFor(id)}`)
        .expect(403);
      expect(response.body).toMatchObject({
        code: 'CUSTOMER_NOT_ENROLLED',
        businessName: 'Mocha House',
      });
      const body = JSON.stringify(response.body);
      expect(body).not.toContain(TEST_TENANT_B_ID);
      expect(body).not.toContain(TEST_TENANT_B_NAME);
      expect(body).not.toContain(bCustomer.id);
    }

    const [unchanged, ...others] = await profilesOf(id);
    expect(others).toEqual([]);
    expect(unchanged).toMatchObject({
      tenantId: TEST_TENANT_B_ID,
      email: bCustomer.email,
    });
    expect(unchanged.updatedAt.getTime()).toBe(bCustomer.updatedAt.getTime());
  });

  it('E2: joining Tenant #1 too gives the login a SEPARATE profile there; the Tenant B profile is untouched', async () => {
    const id = identity('both');
    const { customer: b } = await customers.enroll(id, TB, {
      displayName: 'Name at B',
    });
    await prisma.customer.update({
      where: { id: b.id },
      data: { marketingEmailOptIn: true },
    });

    const joined = await request(app.getHttpServer())
      .post('/api/v1/customers/me/enrollment')
      .set('Authorization', `Bearer ${tokenFor(id)}`)
      .send({})
      .expect(201);

    const profiles = await profilesOf(id);
    expect(profiles.map((p) => p.tenantId)).toEqual([
      TEST_TENANT_B_ID,
      TENANT_1_MOCHA_HOUSE_ID,
    ]);
    const [atB, atT1] = profiles;
    expect(atT1.id).not.toBe(atB.id);
    expect(profileOf(joined).id).toBe(atT1.id);
    // Nothing is copied from the other business: name from the login's own
    // claim, consent off.
    expect(atT1.displayName).toBe(id.name);
    expect(atT1.marketingEmailOptIn).toBe(false);
    expect(atB).toMatchObject({
      displayName: 'Name at B',
      marketingEmailOptIn: true,
    });
  });

  it('E3: joining needs a verified login', async () => {
    const id = { ...identity('unverified'), emailVerified: false };
    const res = await request(app.getHttpServer())
      .post('/api/v1/customers/me/enrollment')
      .set('Authorization', `Bearer ${tokenFor(id)}`)
      .send({})
      .expect(403);
    expect(res.body).toMatchObject({ code: 'CUSTOMER_EMAIL_NOT_VERIFIED' });
    expect(await profilesOf(id)).toEqual([]);
  });

  it('E4: joining again is idempotent and never changes the existing profile', async () => {
    const id = identity('again');
    const first = await request(app.getHttpServer())
      .post('/api/v1/customers/me/enrollment')
      .set('Authorization', `Bearer ${tokenFor(id)}`)
      .send({ displayName: 'First' })
      .expect(201);
    const second = await request(app.getHttpServer())
      .post('/api/v1/customers/me/enrollment')
      .set('Authorization', `Bearer ${tokenFor(id)}`)
      .send({ displayName: 'Second' })
      .expect(200);
    expect(second.body).toMatchObject({
      created: false,
      profile: { id: profileOf(first).id, displayName: 'First' },
    });
    expect(second.headers['cache-control']).toBe('no-store');
  });

  describe('F: concurrent joins (unique-key conflict)', () => {
    it('concurrent joins for one login converge on ONE Tenant #1 profile', async () => {
      const id = identity('race');
      const results = await Promise.all(
        Array.from({ length: 8 }, () => customers.enroll(id, T1, {})),
      );
      expect(new Set(results.map((r) => r.customer.id)).size).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(
        results.every((r) => r.customer.tenantId === TENANT_1_MOCHA_HOUSE_ID),
      ).toBe(true);
      expect(await profilesOf(id)).toHaveLength(1);
    });

    it('after losing the race, returns the winner at the SAME business — never another business’s profile', async () => {
      const id = identity('race-foreign');
      // The login also has a profile at Tenant B, which must never be
      // returned for Tenant #1.
      const { customer: atB } = await customers.enroll(id, TB, {});
      // The "winner" at Tenant #1, created after our lookup missed it.
      const { customer: winner } = await customers.enroll(id, T1, {});

      // A service whose initial lookup misses (as if it ran just before the
      // winner committed); every other call hits the real database, so the
      // create collides on the real unique key and takes the P2002 path.
      const lookupMisses = {
        customer: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: (args: unknown) => prisma.customer.create(args as never),
          findUniqueOrThrow: (args: unknown) =>
            prisma.customer.findUniqueOrThrow(args as never),
          update: jest.fn(),
        },
      };
      const racing = new CustomersService(lookupMisses as never);

      const result = await racing.enroll(id, T1, {});
      expect(result).toMatchObject({ created: false });
      expect(result.customer.id).toBe(winner.id);
      expect(result.customer.id).not.toBe(atB.id);
      expect(lookupMisses.customer.update).not.toHaveBeenCalled();
      expect(await profilesOf(id)).toHaveLength(2);
    });
  });
});
