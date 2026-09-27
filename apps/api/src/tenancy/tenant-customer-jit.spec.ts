import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { ForbiddenException, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
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

// Milestone S0D-2B-1 — Customer JIT creation takes its tenant ONLY from the
// explicit, server-resolved TenantContext, and the transitional resolver
// fails closed on an identity whose Customer belongs to another tenant.
describe('S0D-2B-1 Customer JIT tenant ownership (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let customers: CustomersService;
  const originalEnv = { ...process.env };
  const customerSecret = 's0d2b1-customer-secret';
  const suffix = randomUUID().slice(0, 8);
  const createdSubjects: string[] = [];

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
      { sub: id.subject, email: id.email!, name: id.name },
      customerSecret,
      3600,
    );
  const byIdentity = (id: CustomerIdentity) =>
    prisma.customer.findUnique({
      where: {
        externalProvider_externalSubject: {
          externalProvider: id.provider,
          externalSubject: id.subject,
        },
      },
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

  it('A + C: an authenticated Tenant #1 request JIT-creates a Tenant #1 Customer, whatever tenant the client claims', async () => {
    const id = identity('http');

    await request(app.getHttpServer())
      .get('/api/v1/customers/me')
      .query({ tenantId: TEST_TENANT_B_ID })
      .set('Authorization', `Bearer ${tokenFor(id)}`)
      .set('x-tenant-id', TEST_TENANT_B_ID)
      .expect(200);

    // A profile edit carrying Tenant B cannot re-home the Customer either.
    const patched = await request(app.getHttpServer())
      .patch('/api/v1/customers/me')
      .set('Authorization', `Bearer ${tokenFor(id)}`)
      .set('x-tenant-id', TEST_TENANT_B_ID)
      .send({ displayName: 'Renamed', tenantId: TEST_TENANT_B_ID })
      .expect(200);

    const customer = await byIdentity(id);
    expect(customer?.tenantId).toBe(TENANT_1_MOCHA_HOUSE_ID);
    expect(customer?.displayName).toBe('Renamed');
    // Ownership is not exposed through the customer-facing contract.
    expect(patched.body).not.toHaveProperty('tenantId');
  });

  it('B: under an explicit Tenant B context the resolver creates a Tenant B Customer', async () => {
    const id = identity('tenant-b');
    const customer = await customers.resolveOrCreateFromIdentity(
      id,
      tenantContextFor(TEST_TENANT_B_ID),
    );
    expect(customer.tenantId).toBe(TEST_TENANT_B_ID);
  });

  it('D: an existing Tenant #1 Customer resolves to the same row and resyncs its email as before', async () => {
    const id = identity('existing');
    const created = await customers.resolveOrCreateFromIdentity(
      id,
      tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
    );

    const newEmail = `s0d2b1-existing-new-${suffix}@example.com`;
    const again = await customers.resolveOrCreateFromIdentity(
      { ...id, email: newEmail, name: 'Ignored on resync' },
      tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
    );

    expect(again.id).toBe(created.id);
    expect(again.tenantId).toBe(TENANT_1_MOCHA_HOUSE_ID);
    expect(again.email).toBe(newEmail);
    expect(again.displayName).toBe(created.displayName);
  });

  it('E: an identity owned by Tenant B is refused under Tenant #1 and is NOT updated', async () => {
    const id = identity('owned-by-b');
    const bCustomer = await customers.resolveOrCreateFromIdentity(
      id,
      tenantContextFor(TEST_TENANT_B_ID),
    );

    await expect(
      customers.resolveOrCreateFromIdentity(
        { ...id, email: `changed-${suffix}@example.com` },
        tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
      ),
    ).rejects.toThrow(ForbiddenException);

    // The same refusal over HTTP, with a message that reveals nothing.
    const response = await request(app.getHttpServer())
      .get('/api/v1/customers/me')
      .set('Authorization', `Bearer ${tokenFor(id)}`)
      .expect(403);
    const body = JSON.stringify(response.body);
    expect(body).not.toContain(TEST_TENANT_B_ID);
    expect(body).not.toContain(bCustomer.id);

    const unchanged = await byIdentity(id);
    expect(unchanged).toMatchObject({
      tenantId: TEST_TENANT_B_ID,
      email: bCustomer.email,
    });
    expect(unchanged?.updatedAt.getTime()).toBe(bCustomer.updatedAt.getTime());
  });

  describe('F: first-authentication race (unique-key conflict)', () => {
    it('concurrent first requests for one identity converge on ONE Tenant #1 Customer', async () => {
      const id = identity('race');
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          customers.resolveOrCreateFromIdentity(
            id,
            tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
          ),
        ),
      );
      expect(new Set(results.map((c) => c.id)).size).toBe(1);
      expect(results.every((c) => c.tenantId === TENANT_1_MOCHA_HOUSE_ID)).toBe(
        true,
      );
      expect(
        await prisma.customer.count({
          where: { externalProvider: id.provider, externalSubject: id.subject },
        }),
      ).toBe(1);
    });

    it('re-checks ownership after losing the race to another tenant, refusing without touching the winner', async () => {
      const id = identity('race-foreign');
      // The "winner": created by Tenant B after our lookup missed it.
      const winner = await customers.resolveOrCreateFromIdentity(
        id,
        tenantContextFor(TEST_TENANT_B_ID),
      );

      // A resolver whose initial lookup misses (as if it ran just before the
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

      await expect(
        racing.resolveOrCreateFromIdentity(
          { ...id, email: `race-changed-${suffix}@example.com` },
          tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(lookupMisses.customer.findUnique).toHaveBeenCalledTimes(1);
      expect(lookupMisses.customer.update).not.toHaveBeenCalled();

      const unchanged = await byIdentity(id);
      expect(unchanged).toMatchObject({
        tenantId: TEST_TENANT_B_ID,
        email: winner.email,
      });
    });
  });
});
