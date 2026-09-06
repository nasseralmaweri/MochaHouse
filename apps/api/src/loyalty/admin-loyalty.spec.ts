import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  AdminLoyaltyCustomerDetail,
  AdminLoyaltyCustomerSearchResponse,
} from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { LoyaltyModule } from './loyalty.module';

type Scope = { scopeType: 'CORPORATE' | 'LOCATION'; scopeId: string | null };

// Milestone 7A — the HQ Mocha Beans surface, over real HTTP against local
// Postgres. Covers the CORPORATE-only permission gates, the manual
// adjustment rules (reason, operationKey idempotency, no negative balance),
// and that exactly one ledger entry + exactly one InternalAuditEvent is
// written per successful adjustment.
describe('Admin Mocha Beans surface (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'admin-loyalty-spec-internal-secret';
  const suffix = randomUUID();

  const userIds: string[] = [];
  const roleIds: string[] = [];
  const customerIds: string[] = [];
  let locId: string;

  const token = (key: string) =>
    signInternalDevJwt(
      { sub: `internal-dev:${key}`, email: `${key}@example.com`, name: null },
      internalSecret,
      3600,
    );

  async function makeUser(key: string): Promise<string> {
    const user = await prisma.internalUser.create({
      data: {
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:${key}`,
        email: `${key}@example.com`,
        displayName: key,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    userIds.push(user.id);
    return user.id;
  }

  async function makeRole(permissionKeys: string[]): Promise<string> {
    const role = await prisma.internalRole.create({
      data: {
        key: `loyalty-spec-${suffix}-${randomUUID()}`,
        displayName: 'Loyalty Spec Role',
        permissions: { create: permissionKeys.map((permissionKey) => ({ permissionKey })) },
      },
    });
    roleIds.push(role.id);
    return role.id;
  }

  async function assign(userId: string, roleId: string, scope: Scope) {
    await prisma.internalUserRoleAssignment.create({
      data: { internalUserId: userId, roleId, ...scope },
    });
  }

  async function makeUserWithRole(
    key: string,
    permissionKeys: string[],
    scope: Scope,
  ): Promise<void> {
    const roleId = await makeRole(permissionKeys);
    const userId = await makeUser(`${key}-${suffix}`);
    await assign(userId, roleId, scope);
  }

  async function makeCustomer(balance?: number): Promise<string> {
    const customer = await prisma.customer.create({
      data: {
        externalProvider: 'test',
        externalSubject: `test-adminloyalty-${randomUUID()}`,
        email: `adminloyalty-${randomUUID()}@example.com`,
        displayName: 'Loyalty Test Customer',
      },
    });
    customerIds.push(customer.id);
    if (balance !== undefined) {
      await prisma.customerLoyaltyAccount.create({
        data: { customerId: customer.id, balance },
      });
    }
    return customer.id;
  }

  const search = (key: string, query: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/admin/loyalty/customers?query=${encodeURIComponent(query)}`)
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`);

  const getDetail = (key: string, customerId: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/admin/loyalty/customers/${customerId}`)
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`);

  const adjust = (key: string, customerId: string, body: unknown) =>
    request(app.getHttpServer())
      .post(`/api/v1/admin/loyalty/customers/${customerId}/adjustments`)
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`)
      .send(body as object);

  async function auditEventsFor(customerId: string) {
    return prisma.internalAuditEvent.findMany({
      where: { targetType: 'customer', targetId: customerId },
    });
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = 'admin-loyalty-spec-customer-secret';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        PrismaModule,
        CustomerAuthModule,
        InternalAuthModule,
        LoyaltyModule,
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    locId = (
      await prisma.location.create({
        data: {
          name: `Loyalty Spec Loc ${suffix}`,
          slug: `loyalty-spec-${suffix}`,
          isActive: true,
          isDigitalOrderingEnabled: true,
        },
      })
    ).id;

    // Full HQ loyalty user (corporate view + adjust).
    await makeUserWithRole(
      'hq',
      ['loyalty.view', 'loyalty.adjust'],
      { scopeType: 'CORPORATE', scopeId: null },
    );
    // View only, corporate.
    await makeUserWithRole('viewer', ['loyalty.view'], {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    // Holds both keys but only at LOCATION scope — must be rejected
    // (loyalty.* is CORPORATE-only).
    await makeUserWithRole(
      'locationScoped',
      ['loyalty.view', 'loyalty.adjust'],
      { scopeType: 'LOCATION', scopeId: locId },
    );
    // A seeded Store Manager — must have neither key.
    const storeManager = await prisma.internalRole.findUniqueOrThrow({
      where: { key: 'store-manager' },
    });
    const storeMgr = await makeUser(`storeMgr-${suffix}`);
    await assign(storeMgr, storeManager.id, {
      scopeType: 'LOCATION',
      scopeId: locId,
    });
  }, 45_000);

  afterAll(async () => {
    await prisma.internalAuditEvent.deleteMany({
      where: { actorInternalUserId: { in: userIds } },
    });
    await prisma.mochaBeanLedgerEntry.deleteMany({
      where: { loyaltyAccount: { customerId: { in: customerIds } } },
    });
    await prisma.customerLoyaltyAccount.deleteMany({
      where: { customerId: { in: customerIds } },
    });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: { in: userIds } },
    });
    for (const id of roleIds) {
      await prisma.internalRolePermission.deleteMany({ where: { roleId: id } });
      await prisma.internalRole.deleteMany({ where: { id } });
    }
    await prisma.internalUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.location.deleteMany({ where: { id: locId } });
    await app.close();
    process.env = { ...originalEnv };
  });

  // ---- Permission / scope -----------------------------------------

  it('read requires loyalty.view', async () => {
    const customerId = await makeCustomer(10);
    await getDetail('storeMgr', customerId).expect(403);
    await search('storeMgr', 'anything').expect(403);
    await getDetail('hq', customerId).expect(200);
  });

  it('adjustment requires loyalty.adjust (view alone is not enough)', async () => {
    const customerId = await makeCustomer(10);
    await adjust('viewer', customerId, {
      deltaBeans: 5,
      reason: 'test',
      operationKey: randomUUID(),
    }).expect(403);
  });

  it('loyalty.* held only at LOCATION scope is rejected (corporate-only)', async () => {
    const customerId = await makeCustomer(10);
    await getDetail('locationScoped', customerId).expect(403);
    await adjust('locationScoped', customerId, {
      deltaBeans: 5,
      reason: 'test',
      operationKey: randomUUID(),
    }).expect(403);
  });

  it('a seeded Store Manager holds neither loyalty key', async () => {
    const role = await prisma.internalRole.findUniqueOrThrow({
      where: { key: 'store-manager' },
      include: { permissions: true },
    });
    const keys = role.permissions.map((p) => p.permissionKey);
    expect(keys).not.toContain('loyalty.view');
    expect(keys).not.toContain('loyalty.adjust');
  });

  // ---- Lookup ---------------------------------------------------

  it('finds a customer by exact email and by exact id, with balance', async () => {
    const customerId = await makeCustomer(42);
    const customer = await prisma.customer.findUniqueOrThrow({
      where: { id: customerId },
    });

    const byEmail = (
      await search('hq', customer.email!.toUpperCase()).expect(200)
    ).body as AdminLoyaltyCustomerSearchResponse;
    expect(byEmail.customers).toHaveLength(1);
    expect(byEmail.customers[0].id).toBe(customerId);
    expect(byEmail.customers[0].balance).toBe(42);

    const byId = (await search('hq', customerId).expect(200))
      .body as AdminLoyaltyCustomerSearchResponse;
    expect(byId.customers[0].id).toBe(customerId);
  });

  it('reports a zero balance for a customer with no ledger account', async () => {
    const customerId = await makeCustomer();
    const detail = (await getDetail('hq', customerId).expect(200))
      .body as AdminLoyaltyCustomerDetail;
    expect(detail.customer.balance).toBe(0);
    expect(detail.entries).toEqual([]);
  });

  it('rejects an empty lookup query', async () => {
    await search('hq', '   ').expect(400);
  });

  // ---- Manual adjustment --------------------------------------

  it('applies a positive adjustment: one ledger entry, one audit event, balance moves', async () => {
    const customerId = await makeCustomer(10);
    const detail = (
      await adjust('hq', customerId, {
        deltaBeans: 15,
        reason: '  Service recovery  ',
        operationKey: randomUUID(),
      }).expect(201)
    ).body as AdminLoyaltyCustomerDetail;

    expect(detail.customer.balance).toBe(25);
    expect(detail.entries).toHaveLength(1);
    expect(detail.entries[0]).toMatchObject({
      type: 'MANUAL_ADJUSTMENT',
      amount: 15,
      reason: 'Service recovery', // trimmed
    });
    expect(detail.entries[0].actorLabel).toBe(`hq-${suffix}`);

    const events = await auditEventsFor(customerId);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('loyalty.beans_adjusted');
    expect(events[0].reason).toBe('Service recovery');
    expect(events[0].beforeData).toEqual({ balance: 10 });
    expect(events[0].afterData).toEqual({ balance: 25, delta: 15 });
  });

  it('applies a negative adjustment down to exactly zero', async () => {
    const customerId = await makeCustomer(30);
    const detail = (
      await adjust('hq', customerId, {
        deltaBeans: -30,
        reason: 'Correcting an error',
        operationKey: randomUUID(),
      }).expect(201)
    ).body as AdminLoyaltyCustomerDetail;
    expect(detail.customer.balance).toBe(0);
  });

  it('rejects a deduction that would take the balance below zero', async () => {
    const customerId = await makeCustomer(10);
    await adjust('hq', customerId, {
      deltaBeans: -11,
      reason: 'Too much',
      operationKey: randomUUID(),
    }).expect(409);

    const detail = (await getDetail('hq', customerId).expect(200))
      .body as AdminLoyaltyCustomerDetail;
    expect(detail.customer.balance).toBe(10);
    expect(detail.entries).toHaveLength(0);
    expect(await auditEventsFor(customerId)).toHaveLength(0);
  });

  it('rejects a blank or missing reason', async () => {
    const customerId = await makeCustomer(10);
    await adjust('hq', customerId, {
      deltaBeans: 5,
      reason: '   ',
      operationKey: randomUUID(),
    }).expect(400);
    await adjust('hq', customerId, {
      deltaBeans: 5,
      operationKey: randomUUID(),
    }).expect(400);
  });

  it('rejects a zero or non-integer delta', async () => {
    const customerId = await makeCustomer(10);
    await adjust('hq', customerId, {
      deltaBeans: 0,
      reason: 'x',
      operationKey: randomUUID(),
    }).expect(400);
    await adjust('hq', customerId, {
      deltaBeans: 2.5,
      reason: 'x',
      operationKey: randomUUID(),
    }).expect(400);
  });

  it('rejects a missing or too-short operationKey', async () => {
    const customerId = await makeCustomer(10);
    await adjust('hq', customerId, {
      deltaBeans: 5,
      reason: 'x',
    }).expect(400);
    await adjust('hq', customerId, {
      deltaBeans: 5,
      reason: 'x',
      operationKey: 'short',
    }).expect(400);
  });

  it('is idempotent on operationKey: a repeat does not adjust again', async () => {
    const customerId = await makeCustomer(10);
    const operationKey = randomUUID();
    const body = { deltaBeans: 7, reason: 'Bonus', operationKey };

    const first = (await adjust('hq', customerId, body).expect(201))
      .body as AdminLoyaltyCustomerDetail;
    const second = (await adjust('hq', customerId, body).expect(201))
      .body as AdminLoyaltyCustomerDetail;

    expect(first.customer.balance).toBe(17);
    expect(second.customer.balance).toBe(17);
    expect(second.entries).toHaveLength(1);
    expect(await auditEventsFor(customerId)).toHaveLength(1);
  });

  it('rejects reusing an operationKey for a different customer', async () => {
    const customerA = await makeCustomer(10);
    const customerB = await makeCustomer(10);
    const operationKey = randomUUID();
    await adjust('hq', customerA, {
      deltaBeans: 3,
      reason: 'A',
      operationKey,
    }).expect(201);
    await adjust('hq', customerB, {
      deltaBeans: 3,
      reason: 'B',
      operationKey,
    }).expect(409);
  });

  it('concurrent identical adjustments apply exactly once', async () => {
    const customerId = await makeCustomer(0);
    const body = { deltaBeans: 9, reason: 'Race', operationKey: randomUUID() };

    const results = await Promise.allSettled([
      adjust('hq', customerId, body),
      adjust('hq', customerId, body),
      adjust('hq', customerId, body),
    ]);
    // Every call resolves (idempotent replay), none rejects.
    for (const r of results) {
      expect(r.status).toBe('fulfilled');
    }

    const detail = (await getDetail('hq', customerId).expect(200))
      .body as AdminLoyaltyCustomerDetail;
    expect(detail.customer.balance).toBe(9);
    expect(detail.entries).toHaveLength(1);
    expect(await auditEventsFor(customerId)).toHaveLength(1);
  });

  it('concurrent identical deductions to zero apply once, without a false below-zero rejection', async () => {
    // Balance 10, deduct 10: succeeds exactly once; applying it twice would
    // go below zero. Two concurrent requests with the SAME operationKey
    // must both resolve as the same successful operation — the loser is
    // recognised as an idempotent replay under the account lock, never
    // rejected by the below-zero check (the MINOR review finding).
    const customerId = await makeCustomer(10);
    const body = {
      deltaBeans: -10,
      reason: 'Full deduction',
      operationKey: randomUUID(),
    };

    const responses = await Promise.all([
      adjust('hq', customerId, body),
      adjust('hq', customerId, body),
    ]);

    for (const res of responses) {
      // Neither request may 409 — that would be a false below-zero
      // rejection of the idempotent replay.
      expect([200, 201]).toContain(res.status);
      expect(
        (res.body as AdminLoyaltyCustomerDetail).customer.balance,
      ).toBe(0);
    }

    const detail = (await getDetail('hq', customerId).expect(200))
      .body as AdminLoyaltyCustomerDetail;
    expect(detail.customer.balance).toBe(0);
    const manualEntries = detail.entries.filter(
      (e) => e.type === 'MANUAL_ADJUSTMENT',
    );
    expect(manualEntries).toHaveLength(1);
    expect(manualEntries[0].amount).toBe(-10);
    expect(await auditEventsFor(customerId)).toHaveLength(1);
  });

  it('returns 404 for an unknown customer', async () => {
    await getDetail('hq', randomUUID()).expect(404);
    await adjust('hq', randomUUID(), {
      deltaBeans: 5,
      reason: 'x',
      operationKey: randomUUID(),
    }).expect(404);
  });
});
