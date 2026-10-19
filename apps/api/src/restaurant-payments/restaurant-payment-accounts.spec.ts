import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  PAYMENT_ACCOUNT_OWNER_ONLY,
  type AdminPaymentAccountResponse,
  type AdminPaymentOnboardingResponse,
  type InternalPermissionKey,
} from '@mocha-house/contracts';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  createTestTenantB,
  removePaymentAccountsForTest,
  removeTestTenantB,
} from '@mocha-house/testing';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { CONNECT_ACCOUNT_PROVIDER } from './provider/connect-account-provider';
import type { FakeConnectAccountProvider } from './provider/fake-connect-account-provider';

// ESP-04 M1 — the restaurant's own Stripe account (Connect foundation),
// through the real HTTP stack (guards, tenant middleware, raw-body webhooks)
// against a disposable database, with the deterministic fake provider.
// Covers: owner only (a custom role holding the permission is refused);
// exactly one account per business under repeats and concurrency; the
// account's state always read back from the provider (returning from
// onboarding proves nothing) and only the approved configuration can be
// READY; customer payments stay disabled; verified webhooks — unsigned,
// forged, duplicate, live-mode, unknown-account and failing deliveries; and
// isolation between businesses.

jest.setTimeout(120_000);

const T1 = TENANT_1_MOCHA_HOUSE_ID;
const TB = TEST_TENANT_B_ID;
const INTERNAL_SECRET = 'm1-connect-internal-secret';

describe('ESP-04 M1 restaurant payment accounts (integration)', () => {
  const run = randomUUID().slice(0, 8);
  const originalEnv = { ...process.env };
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let fake: FakeConnectAccountProvider;
  const created = {
    users: [] as string[],
    roles: [] as string[],
    events: [] as string[],
  };

  const token = (key: string) =>
    signInternalDevJwt(
      {
        sub: `internal-dev:m1-${key}-${run}`,
        email: `m1-${key}-${run}@example.test`,
        name: null,
      },
      INTERNAL_SECRET,
      3600,
    );

  // A staff member of `tenantId` holding `roleId` at corporate scope.
  async function staff(tenantId: string, key: string, roleId: string) {
    const user = await prisma.internalUser.create({
      data: {
        tenantId,
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:m1-${key}-${run}`,
        email: `m1-${key}-${run}@example.test`,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    created.users.push(user.id);
    await prisma.internalUserRoleAssignment.create({
      data: {
        tenantId,
        internalUserId: user.id,
        roleId,
        scopeType: 'CORPORATE',
        scopeId: null,
      },
    });
    return user;
  }

  async function role(
    tenantId: string,
    key: string,
    permissions: InternalPermissionKey[],
    isSystem = false,
  ) {
    const row = await prisma.internalRole.create({
      data: {
        tenantId,
        key,
        displayName: `M1 ${key}`,
        isSystem,
        permissions: {
          create: permissions.map((permissionKey) => ({ permissionKey })),
        },
      },
    });
    created.roles.push(row.id);
    return row;
  }

  const as = (key: string, tenantId = T1) => ({
    get: (path: string) =>
      request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${token(key)}`)
        .set('X-Tenant-Id', tenantId),
    post: (path: string) =>
      request(app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${token(key)}`)
        .set('X-Tenant-Id', tenantId),
  });
  const ACCOUNT = '/api/v1/admin/payments/account';
  const ONBOARDING = '/api/v1/admin/payments/account/onboarding';
  const REFRESH = '/api/v1/admin/payments/account/refresh';

  const deliver = (body: Record<string, unknown>, signatureHeader?: string) => {
    const signed = fake.signedEvent(body);
    created.events.push(String(body.id));
    return request(app.getHttpServer())
      .post('/api/v1/restaurant-payments/webhooks/fake')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', signatureHeader ?? signed.signatureHeader)
      .send(signed.rawBody.toString('utf8'));
  };
  const classicEvent = (
    accountId: string,
    over: Record<string, unknown> = {},
  ) => ({
    id: `evt_m1_${randomUUID()}`,
    object: 'event',
    type: 'account.updated',
    livemode: false,
    account: accountId,
    data: { object: { id: accountId, object: 'account' } },
    ...over,
  });
  const thinEvent = (accountId: string, type: string) => ({
    id: `evt_m1v2_${randomUUID()}`,
    object: 'v2.core.event',
    type,
    livemode: false,
    related_object: {
      id: accountId,
      type: 'v2.core.account',
      url: `/v2/core/accounts/${accountId}`,
    },
  });
  const eventRow = (externalEventId: string) =>
    prisma.restaurantPaymentProviderEvent.findUniqueOrThrow({
      where: {
        provider_externalEventId: { provider: 'fake', externalEventId },
      },
    });
  const accountOf = (tenantId: string) =>
    prisma.tenantPaymentAccount.findUnique({ where: { tenantId } });

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = INTERNAL_SECRET;
    process.env.RATE_LIMIT_ENABLED = '0';
    process.env.RESTAURANT_PAYMENTS_PROVIDER = 'fake';
    process.env.PAYMENTS_CONNECT_RETURN_URL =
      'http://localhost:3000/admin/payments';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({
      rawBody: true,
    });
    await app.init();
    prisma = app.get(PrismaService);
    fake = app.get(CONNECT_ACCOUNT_PROVIDER);
    await removePaymentAccountsForTest({ tenantIds: [T1, TB] });

    // Mocha House: its built-in administrator role (the owner), a custom role
    // that ALSO holds payments.connect (not the owner), and staff without it.
    const adminRole = await prisma.internalRole.findFirstOrThrow({
      where: { tenantId: T1, key: 'platform-administrator', isSystem: true },
    });
    expect(
      await prisma.internalRolePermission.count({
        where: { roleId: adminRole.id, permissionKey: 'payments.connect' },
      }),
    ).toBe(1);
    await staff(T1, 'owner', adminRole.id);
    await staff(T1, 'owner2', adminRole.id);
    await staff(
      T1,
      'custom',
      (await role(T1, `m1-custom-${run}`, ['payments.connect'])).id,
    );
    await staff(
      T1,
      'plain',
      (await role(T1, `m1-plain-${run}`, ['reports.view'])).id,
    );

    // Business B with its own owner.
    await createTestTenantB(prisma);
    await staff(
      TB,
      'owner-b',
      (await role(TB, 'platform-administrator', ['payments.connect'], true)).id,
    );
  });

  afterAll(async () => {
    try {
      await removePaymentAccountsForTest({
        tenantIds: [T1, TB],
        externalEventIds: created.events,
      });
      // Business B's audit history of this suite (append-only: test-only
      // removal on the disposable database), so B can be removed.
      const client = new Client({
        connectionString: process.env.DATABASE_URL!.split('?')[0],
      });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL session_replication_role = replica');
        await client.query(
          'DELETE FROM "InternalAuditEvent" WHERE "tenantId" = $1',
          [TB],
        );
        await client.query('COMMIT');
      } finally {
        await client.end();
      }
      const b = await prisma.internalUser.findMany({
        where: { tenantId: TB, id: { in: created.users } },
        select: { id: true },
      });
      await prisma.internalUserRoleAssignment.deleteMany({
        where: { internalUserId: { in: b.map((u) => u.id) } },
      });
      await prisma.internalUser.deleteMany({
        where: { id: { in: b.map((u) => u.id) } },
      });
      await prisma.internalRolePermission.deleteMany({
        where: { role: { tenantId: TB } },
      });
      await prisma.internalRole.deleteMany({ where: { tenantId: TB } });
      await removeTestTenantB(prisma);
    } finally {
      await app?.close();
      process.env = { ...originalEnv };
    }
  });

  // --- who may connect ----------------------------------------------------------

  it("only the restaurant's owner may see or connect the account", async () => {
    const own = await as('owner').get(ACCOUNT).expect(200);
    expect(own.body as AdminPaymentAccountResponse).toEqual({
      providerAvailable: true,
      state: 'NOT_CONNECTED',
      accountId: null,
      testMode: true,
      requirementsDue: 0,
      lastCheckedAt: null,
      paymentsEnabled: false,
    });
    // A custom role holding the permission is still not the owner.
    for (const path of [ACCOUNT]) {
      const refused = await as('custom').get(path).expect(403);
      expect(refused.body).toMatchObject({ code: PAYMENT_ACCOUNT_OWNER_ONLY });
    }
    await as('custom').post(ONBOARDING).expect(403);
    await as('custom').post(REFRESH).expect(403);
    await as('plain').get(ACCOUNT).expect(403);
    await as('plain').post(ONBOARDING).expect(403);
    await request(app.getHttpServer()).get(ACCOUNT).expect(401);
    expect(await accountOf(T1)).toBeNull();
  });

  // --- connecting -------------------------------------------------------------------

  it('connects exactly one account per business, however often and concurrently onboarding is opened', async () => {
    const results = await Promise.all([
      as('owner').post(ONBOARDING),
      as('owner').post(ONBOARDING),
      as('owner2').post(ONBOARDING),
    ]);
    for (const r of results) expect(r.status).toBe(200);
    const urls = results.map(
      (r) => (r.body as AdminPaymentOnboardingResponse).url,
    );
    const row = (await accountOf(T1))!;
    expect(row.externalAccountId).toMatch(/^acct_fake/);
    for (const url of urls) {
      expect(url).toBe(
        `https://connect.fake.test/onboarding/${row.externalAccountId}`,
      );
    }
    // Again later: the same account, never a second one.
    const again = await as('owner').post(ONBOARDING).expect(200);
    expect((again.body as AdminPaymentOnboardingResponse).url).toBe(urls[0]);
    expect(
      await prisma.tenantPaymentAccount.count({ where: { tenantId: T1 } }),
    ).toBe(1);
    expect(
      await prisma.internalAuditEvent.count({
        where: {
          tenantId: T1,
          action: 'payments.account_created',
          // This run's account (audit history is append-only).
          afterData: {
            path: ['externalAccountId'],
            equals: row.externalAccountId!,
          },
        },
      }),
    ).toBe(1);
    expect(
      await prisma.internalAuditEvent.count({
        where: {
          tenantId: T1,
          action: 'payments.onboarding_opened',
          afterData: {
            path: ['externalAccountId'],
            equals: row.externalAccountId!,
          },
        },
      }),
    ).toBeGreaterThanOrEqual(4);
    expect(row).toMatchObject({
      provider: 'fake',
      livemode: false,
      lastSyncedAt: null,
    });
  });

  it("returning from onboarding proves nothing: the account's state is what Stripe reports", async () => {
    const row = (await accountOf(T1))!;
    const accountId = row.externalAccountId!;
    // Not read back yet.
    expect((await as('owner').get(ACCOUNT).expect(200)).body).toMatchObject({
      state: 'SETUP_IN_PROGRESS',
      accountId,
      lastCheckedAt: null,
    });
    // Back from Stripe with requirements still due.
    let status = (await as('owner').post(REFRESH).expect(200))
      .body as AdminPaymentAccountResponse;
    expect(status).toMatchObject({
      state: 'SETUP_IN_PROGRESS',
      requirementsDue: 3,
    });
    expect(status.lastCheckedAt).not.toBeNull();
    // Everything submitted, Stripe reviewing.
    fake.setAccount(accountId, {
      requirementsDue: 0,
      requirementsStatus: null,
    });
    status = (await as('owner').post(REFRESH).expect(200))
      .body as AdminPaymentAccountResponse;
    expect(status.state).toBe('UNDER_REVIEW');
    // Card payments active: ready — but customer payments stay disabled.
    fake.setAccount(accountId, { cardPaymentsStatus: 'active' });
    status = (await as('owner').post(REFRESH).expect(200))
      .body as AdminPaymentAccountResponse;
    expect(status).toMatchObject({ state: 'READY', paymentsEnabled: false });
    // Stripe asks for more and restricts.
    fake.setAccount(accountId, {
      cardPaymentsStatus: 'restricted',
      requirementsDue: 1,
      requirementsStatus: 'past_due',
    });
    status = (await as('owner').post(REFRESH).expect(200))
      .body as AdminPaymentAccountResponse;
    expect(status.state).toBe('ACTION_REQUIRED');
  });

  it('only the approved configuration can ever be ready', async () => {
    const accountId = (await accountOf(T1))!.externalAccountId!;
    for (const change of [
      { feesCollector: 'application' },
      { lossesCollector: 'application' },
      { dashboard: 'express' },
    ]) {
      fake.setAccount(accountId, {
        cardPaymentsStatus: 'active',
        requirementsDue: 0,
        requirementsStatus: null,
        dashboard: 'full',
        feesCollector: 'stripe',
        lossesCollector: 'stripe',
        ...change,
      });
      const status = (await as('owner').post(REFRESH).expect(200))
        .body as AdminPaymentAccountResponse;
      expect(status.state).toBe('CONFIGURATION_MISMATCH');
    }
    fake.setAccount(accountId, {
      dashboard: 'full',
      feesCollector: 'stripe',
      lossesCollector: 'stripe',
    });
    expect(
      (
        (await as('owner').post(REFRESH).expect(200))
          .body as AdminPaymentAccountResponse
      ).state,
    ).toBe('READY');
  });

  it('a provider failure changes nothing and says so', async () => {
    fake.failNext = 'retrieve';
    const refused = await as('owner').post(REFRESH).expect(503);
    expect(refused.body).toMatchObject({
      code: 'PAYMENTS_PROVIDER_UNAVAILABLE',
    });
    expect(
      (
        (await as('owner').get(ACCOUNT).expect(200))
          .body as AdminPaymentAccountResponse
      ).state,
    ).toBe('READY');
  });

  // --- webhooks ------------------------------------------------------------------------

  it('refuses unsigned and forged webhook deliveries before reading or recording anything', async () => {
    const accountId = (await accountOf(T1))!.externalAccountId!;
    const event = classicEvent(accountId);
    await request(app.getHttpServer())
      .post('/api/v1/restaurant-payments/webhooks/fake')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(event))
      .expect(400);
    await deliver(
      event,
      `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`,
    ).expect(400);
    // The SaaS billing webhook path is a different endpoint entirely.
    await request(app.getHttpServer())
      .post('/api/v1/restaurant-payments/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(event))
      .expect(404);
    expect(
      await prisma.restaurantPaymentProviderEvent.count({
        where: { externalEventId: String(event.id) },
      }),
    ).toBe(0);
  });

  it('a verified account event re-reads the account from Stripe, once per event', async () => {
    const accountId = (await accountOf(T1))!.externalAccountId!;
    fake.setAccount(accountId, {
      cardPaymentsStatus: 'pending',
      requirementsDue: 2,
      requirementsStatus: 'currently_due',
    });
    const before = (await accountOf(T1))!.lastSyncedAt!;
    const event = classicEvent(accountId);
    await deliver(event).expect(200);
    const after = (await accountOf(T1))!;
    expect(after.cardPaymentsStatus).toBe('pending');
    expect(after.requirementsDue).toBe(2);
    expect(after.lastSyncedAt!.getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );
    expect(await eventRow(String(event.id))).toMatchObject({
      status: 'PROCESSED',
      outcome: 'ACCOUNT_SYNCED',
      attempts: 1,
      externalAccountId: accountId,
    });
    // The same delivery again: handled once.
    fake.setAccount(accountId, {
      cardPaymentsStatus: 'active',
      requirementsDue: 0,
      requirementsStatus: null,
    });
    await deliver(event).expect(200);
    expect((await eventRow(String(event.id))).attempts).toBe(1);
    expect((await accountOf(T1))!.cardPaymentsStatus).toBe('pending');
    // A v2 (thin) account event works the same way.
    const thin = thinEvent(
      accountId,
      'v2.core.account[configuration.merchant].capability_status_updated',
    );
    await deliver(thin).expect(200);
    expect((await accountOf(T1))!.cardPaymentsStatus).toBe('active');
    expect((await eventRow(String(thin.id))).status).toBe('PROCESSED');
  });

  it('ignores live-mode, unrelated and unknown-account events, and retries a failed read', async () => {
    const accountId = (await accountOf(T1))!.externalAccountId!;
    const live = classicEvent(accountId, { livemode: true });
    await deliver(live).expect(200);
    expect(await eventRow(String(live.id))).toMatchObject({
      status: 'IGNORED',
      outcome: 'LIVE_MODE_REFUSED',
    });

    // Unrelated event types are acknowledged but not even recorded.
    const unrelated = classicEvent(accountId, { type: 'charge.succeeded' });
    await deliver(unrelated).expect(200);
    expect(
      await prisma.restaurantPaymentProviderEvent.count({
        where: { externalEventId: String(unrelated.id) },
      }),
    ).toBe(0);

    const unknown = classicEvent('acct_notours12345');
    await deliver(unknown).expect(200);
    expect((await eventRow(String(unknown.id))).outcome).toBe(
      'UNKNOWN_ACCOUNT',
    );

    fake.failNext = 'retrieve';
    const failing = classicEvent(accountId);
    await deliver(failing).expect(503);
    expect(await eventRow(String(failing.id))).toMatchObject({
      status: 'FAILED',
      attempts: 1,
    });
    await deliver(failing).expect(200);
    expect(await eventRow(String(failing.id))).toMatchObject({
      status: 'PROCESSED',
      attempts: 2,
    });
  });

  it("an account request never completed within the provider's idempotency window goes to support, never a second account", async () => {
    // Business B: the provider call fails after our record exists.
    fake.failNext = 'create';
    await as('owner-b', TB).post(ONBOARDING).expect(503);
    const pending = (await accountOf(TB))!;
    expect(pending.externalAccountId).toBeNull();
    expect(pending.creationRequestedAt).not.toBeNull();
    // Long after: refused, nothing created.
    await prisma.tenantPaymentAccount.update({
      where: { tenantId: TB },
      data: { creationRequestedAt: new Date(Date.now() - 25 * 3600 * 1000) },
    });
    const calls = fake.createCalls;
    const refused = await as('owner-b', TB).post(ONBOARDING).expect(409);
    expect(refused.body).toMatchObject({
      code: 'PAYMENT_ACCOUNT_NEEDS_SUPPORT',
    });
    expect(fake.createCalls).toBe(calls);
    expect((await accountOf(TB))!.externalAccountId).toBeNull();
    // Within the window a retry completes with the same idempotency key.
    await prisma.tenantPaymentAccount.update({
      where: { tenantId: TB },
      data: { creationRequestedAt: new Date() },
    });
    await as('owner-b', TB).post(ONBOARDING).expect(200);
    expect((await accountOf(TB))!.externalAccountId).toMatch(/^acct_fake/);
  });

  // --- isolation -----------------------------------------------------------------------

  it("keeps each business's account to itself", async () => {
    const t1Account = (await accountOf(T1))!.externalAccountId!;
    // Business B's own account (connected above).
    const b = await as('owner-b', TB).post(ONBOARDING).expect(200);
    const bRow = (await accountOf(TB))!;
    expect(bRow.externalAccountId).not.toBe(t1Account);
    expect((b.body as AdminPaymentOnboardingResponse).url).toContain(
      bRow.externalAccountId!,
    );
    // Each owner sees only their own.
    expect(
      (
        (await as('owner-b', TB).get(ACCOUNT).expect(200))
          .body as AdminPaymentAccountResponse
      ).accountId,
    ).toBe(bRow.externalAccountId);
    expect(
      (
        (await as('owner').get(ACCOUNT).expect(200))
          .body as AdminPaymentAccountResponse
      ).accountId,
    ).toBe(t1Account);
    // Mocha House's owner cannot act for business B.
    await as('owner', TB).get(ACCOUNT).expect(403);

    // An event about B's account updates B only.
    fake.setAccount(bRow.externalAccountId!, {
      cardPaymentsStatus: 'restricted',
      requirementsDue: 5,
    });
    const t1Before = await accountOf(T1);
    await deliver(classicEvent(bRow.externalAccountId!)).expect(200);
    expect((await accountOf(TB))!.requirementsDue).toBe(5);
    expect(await accountOf(T1)).toEqual(t1Before);

    // The database: one account per business, an account belongs to one
    // business, and a recorded account never changes or disappears.
    await expect(
      prisma.tenantPaymentAccount.update({
        where: { tenantId: TB },
        data: { externalAccountId: t1Account },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.tenantPaymentAccount.update({
        where: { tenantId: T1 },
        data: { externalAccountId: 'acct_somethingelse1' },
      }),
    ).rejects.toThrow(/never changes/);
    await expect(
      prisma.tenantPaymentAccount.delete({ where: { tenantId: T1 } }),
    ).rejects.toThrow(/never deleted/);
    await expect(
      prisma.tenantPaymentAccount.update({
        where: { tenantId: T1 },
        data: { livemode: true },
      }),
    ).rejects.toThrow();
  });
});
