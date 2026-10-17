import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  AdminBillingResponse,
  InternalPermissionKey,
  PlatformPaymentSetupListResponse,
  PlatformPermission,
  PlatformTenantBillingResponse,
} from '@mocha-house/contracts';
import {
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  type ScratchDatabase,
} from '@mocha-house/testing';
import { AppModule } from '../app.module';
import { grantPlatformPermissions } from '../../test/platform-permissions';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializable } from '../prisma/serializable-transaction';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { signPlatformDevJwt } from '../platform-auth/infrastructure/platform-dev-jwt';
import { BillingLifecycleService } from './application/billing-lifecycle.service';
import { BillingEnforcementService } from './application/billing-enforcement.service';
import type {
  FakeEventBody,
  FakeSaasBillingProvider,
} from './provider/fake-saas-billing-provider';
import { SAAS_BILLING_PROVIDER } from './provider/saas-billing-provider';

// SC3e-4 — payment setup deadlines and billing recovery access, end to end on
// the real AppModule (fake provider) in a SCRATCH database. Time moves only
// forward through the suite (sweeps take an explicit `now`):
//   A. enforcement OFF: payment setup is recorded (since when), no deadline,
//      no suspension, no extension;
//   B. activation: every eligible business (all three entry paths, also
//      ones that predate SC3e-4) gets a 14-day window; excluded categories
//      never do; reminders 7/3/1 days before; expiry suspends for billing
//      (BILLING_WIND_DOWN) — never a SECURITY suspension, never new sales;
//   C. a later (re)activation gives a fresh window, never a stale deadline;
//   D. extensions (max 30 days), repeated Checkout never resets the deadline,
//      recovery only after verified setup and payment; duplicate events.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const DAY = 24 * 60 * 60 * 1000;

jest.setTimeout(300_000);

describe('SC3e-4 payment setup deadlines (integration, scratch database)', () => {
  let scratch: ScratchDatabase;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let lifecycle: BillingLifecycleService;
  let enforcement: BillingEnforcementService;
  let fake: FakeSaasBillingProvider;
  const originalEnv = { ...process.env };
  const PLATFORM_SECRET = `sc3e4-platform-${randomUUID()}`;
  const INTERNAL_SECRET = `sc3e4-internal-${randomUUID()}`;
  const run = randomUUID().replace(/-/g, '').slice(0, 8);
  const versions: Record<string, string> = {};
  const prices: Record<string, string> = {};
  // The suite's clock: starts 60 days ago, only moves forward.
  const T0 = Date.now() - 60 * DAY;
  const at = (days: number) => new Date(T0 + days * DAY);
  const enforce = (on: boolean) => {
    if (on) process.env.BILLING_ENFORCEMENT_ENABLED = '1';
    else delete process.env.BILLING_ENFORCEMENT_ENABLED;
  };
  const notify = (on: boolean) => {
    if (on) process.env.BILLING_NOTIFICATIONS_ENABLED = '1';
    else delete process.env.BILLING_NOTIFICATIONS_ENABLED;
  };
  const sweep = (now: Date) => lifecycle.paymentSetupSweep(now, 200);

  // --- people ------------------------------------------------------------------------
  async function operator(key: string, permissions: PlatformPermission[]) {
    const row = await prisma.platformOperator.create({
      data: {
        externalProvider: 'platform-dev',
        externalSubject: `platform-dev:sc3e4-${key}-${run}`,
        email: `sc3e4-${key}-${run}@example.test`,
        status: 'ACTIVE',
      },
    });
    await grantPlatformPermissions(prisma, row.id, permissions);
    return row.id;
  }
  const asOperator = (
    key: string,
    method: 'get' | 'post',
    path: string,
    body?: object,
    signedInSecondsAgo = 0,
  ) => {
    const req = request(app.getHttpServer())
      [method](`/api/v1/platform${path}`)
      .set(
        'Authorization',
        `Bearer ${signPlatformDevJwt(
          {
            sub: `platform-dev:sc3e4-${key}-${run}`,
            mfa: true,
            iat: Math.floor(Date.now() / 1000) - signedInSecondsAgo,
          },
          PLATFORM_SECRET,
          3600,
        )}`,
      );
    return body ? req.send(body) : req;
  };
  const staffToken = (key: string) =>
    signInternalDevJwt(
      {
        sub: `internal-dev:sc3e4-${key}-${run}`,
        email: `sc3e4-${key}-${run}@example.com`,
        name: null,
        email_verified: true,
      },
      INTERNAL_SECRET,
      3600,
    );
  const asStaff = (b: Business, method: 'get' | 'post', path: string) =>
    request(app.getHttpServer())
      [method](`/api/v1/admin${path}`)
      .set('Authorization', `Bearer ${staffToken(b.key)}`)
      .set('X-Tenant-Id', b.tenantId);
  async function owner(tenantId: string, key: string) {
    const permissions: InternalPermissionKey[] = [
      'billing.view',
      'billing.manage',
      'locations.view',
    ];
    const role = await prisma.internalRole.create({
      data: {
        tenantId,
        key: 'platform-administrator',
        displayName: 'Owner',
        isSystem: true,
        permissions: {
          create: permissions.map((permissionKey) => ({ permissionKey })),
        },
      },
    });
    const user = await prisma.internalUser.create({
      data: {
        tenantId,
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:sc3e4-${key}-${run}`,
        email: `sc3e4-${key}-${run}@example.com`,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    await prisma.internalUserRoleAssignment.create({
      data: {
        tenantId,
        internalUserId: user.id,
        roleId: role.id,
        scopeType: 'CORPORATE',
        scopeId: null,
      },
    });
  }

  // --- businesses ----------------------------------------------------------------------
  interface Business {
    key: string;
    tenantId: string;
    subscriptionId: string;
    customer: string;
  }
  type Kind =
    | 'awaiting' // billed, no provider subscription (started, abandoned Checkout)
    | 'paying'
    | 'trialing'
    | 'past_due'
    | 'unpaid'
    | 'canceled'
    | 'complimentary'
    | 'founding';
  async function business(key: string, kind: Kind): Promise<Business> {
    const tenantId = randomUUID();
    await prisma.tenant.create({
      data: {
        id: tenantId,
        slug: `sc3e4-${key}-${run}`,
        name: `SC3e4 ${key}`,
        status: 'ACTIVE',
      },
    });
    await owner(tenantId, key);
    const customer = `fake_cus_${key}_${run}`;
    const billed = kind !== 'complimentary' && kind !== 'founding';
    const sub = `fake_sub_${key}_${run}`;
    const linked = billed && kind !== 'awaiting';
    const row = await prisma.tenantSubscription.create({
      data: {
        subscriberTenantId: tenantId,
        planVersionId: kind === 'founding' ? versions.founding : versions.pro,
        billingMode: billed ? 'BILLED' : 'COMPLIMENTARY',
        ...(billed
          ? {
              billingProvider: 'fake',
              planPriceId: prices.pro,
              externalCustomerId: customer,
              externalSubscriptionId: linked ? sub : null,
              recurringPaymentAuthorizedAt: linked ? at(-30) : null,
              currentPeriodStart:
                kind === 'paying' || kind === 'past_due' ? at(-10) : null,
              currentPeriodEnd:
                kind === 'paying' || kind === 'past_due' ? at(20) : null,
            }
          : {}),
        status:
          kind === 'trialing'
            ? 'TRIALING'
            : kind === 'past_due'
              ? 'PAST_DUE'
              : kind === 'unpaid'
                ? 'UNPAID'
                : kind === 'canceled'
                  ? 'CANCELED'
                  : 'ACTIVE',
        ...(kind === 'trialing'
          ? {
              trialStartedAt: at(-5),
              trialEndsAt: at(9),
              trialRequiresPaymentMethod: false,
            }
          : {}),
        ...(kind === 'past_due' || kind === 'unpaid'
          ? { pastDueAt: at(-2), graceEndsAt: at(5) }
          : {}),
        ...(kind === 'canceled' ? { canceledAt: at(-1) } : {}),
      },
    });
    return { key, tenantId, subscriptionId: row.id, customer };
  }
  const subOf = (b: Business) =>
    prisma.tenantSubscription.findUniqueOrThrow({
      where: { id: b.subscriptionId },
    });
  const tenantOf = (b: Business) =>
    prisma.tenant.findUniqueOrThrow({
      where: { id: b.tenantId },
      select: { status: true, suspensionReason: true },
    });
  const historyOf = async (b: Business) =>
    (
      await prisma.tenantSubscriptionEvent.findMany({
        where: {
          subscriptionId: b.subscriptionId,
          type: {
            in: [
              'PAYMENT_SETUP_REQUIRED',
              'PAYMENT_SETUP_WINDOW_STARTED',
              'PAYMENT_SETUP_EXTENDED',
              'PAYMENT_SETUP_EXPIRED',
              'PAYMENT_SETUP_COMPLETED',
              'BILLING_SUSPENDED',
              'BILLING_SUSPENSION_LIFTED',
            ],
          },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { type: true },
      })
    ).map((e) => e.type);
  const summaryOf = async (b: Business) =>
    (
      (await asStaff(b, 'get', '/billing').expect(200))
        .body as AdminBillingResponse
    ).billing.paymentSetup;

  let seq = 0;
  async function deliver(
    b: { sub: string; customer: string },
    type: string,
    data: Partial<FakeEventBody['data']> = {},
  ) {
    const occurred = Math.floor(Date.now() / 1000) + seq++;
    const body: FakeEventBody = {
      id: `evt_${run}_${seq++}`,
      type,
      created: occurred,
      livemode: false,
      data: {
        subscription: b.sub,
        customer: b.customer,
        ...(type === 'invoice.paid'
          ? {
              amount: 9900,
              currency: 'usd',
              periodStart: Math.floor(Date.now() / 1000),
              periodEnd: Math.floor(Date.now() / 1000) + 30 * 86_400,
            }
          : {}),
        ...data,
      },
    };
    const signed = fake.signEvent(body, new Date(occurred * 1000));
    const verified = fake.verifyEvent({
      ...signed,
      now: new Date(occurred * 1000),
    });
    return { verified, result: await lifecycle.recordAndApply(verified) };
  }

  // Fixtures shared across phases.
  let started: Business; // billing started by an operator while enforcement is off
  let legacy: Business; // billed and awaiting setup before SC3e-4 (no record)
  let fromComplimentary: Business; // complimentary ended with no subscription
  let excluded: Record<string, Business>;
  let security: Business;

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3e4_setup',
    );
    await applyMigrations(scratch.url, listMigrations(MIGRATIONS));
    process.env.DATABASE_URL = scratch.url;
    process.env.PLATFORM_AUTH_PROVIDER = 'dev';
    process.env.PLATFORM_AUTH_DEV_JWT_SECRET = PLATFORM_SECRET;
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = INTERNAL_SECRET;
    process.env.RATE_LIMIT_ENABLED = '0';
    process.env.SAAS_BILLING_PROVIDER = 'fake';
    process.env.SAAS_BILLING_TRIAL_CLAIM_SECRET = `sc3e4-claims-${randomUUID()}`;
    process.env.PLAN_CHANGE_SWEEP_DISABLED = '1';
    process.env.BILLING_CHECKOUT_RETURN_URL =
      'http://localhost:3000/admin/billing';
    enforce(false);
    notify(false);
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({
      rawBody: true,
    });
    await app.init();
    prisma = app.get(PrismaService);
    lifecycle = app.get(BillingLifecycleService);
    enforcement = app.get(BillingEnforcementService);
    fake = app.get(SAAS_BILLING_PROVIDER);
    await operator('accounts', ['billing.accounts.manage']);
    await operator('none', []);

    const plan = await prisma.subscriptionPlan.create({
      data: { key: `pro-${run}`, name: 'Pro' },
    });
    const version = await prisma.subscriptionPlanVersion.create({
      data: { planId: plan.id, version: 1, moduleKeys: ['crm'] },
    });
    await prisma.subscriptionPlanVersion.update({
      where: { id: version.id },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });
    versions.pro = version.id;
    const price = await prisma.subscriptionPlanPrice.create({
      data: {
        planId: plan.id,
        interval: 'MONTH',
        currency: 'USD',
        amountMinorUnits: 9900,
      },
    });
    await prisma.subscriptionPlanPrice.update({
      where: { id: price.id },
      data: { externalPriceId: `fake_price_pro_${run}` },
    });
    fake.priceCatalog.set(`fake_price_pro_${run}`, {
      amountMinorUnits: 9900,
      currency: 'usd',
      interval: 'MONTH',
    });
    prices.pro = price.id;
    versions.founding = (
      await prisma.subscriptionPlanVersion.findFirstOrThrow({
        where: { plan: { key: 'founding' } },
      })
    ).id;
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      process.env = { ...originalEnv };
      await scratch?.drop();
    }
  });

  // --- A. enforcement OFF ------------------------------------------------------------------

  it('A. with enforcement off: payment setup is recorded, but no deadline, no suspension, no extension', async () => {
    // Entry path 1 — an operator starts billing.
    started = await business('started', 'complimentary');
    await asOperator(
      'accounts',
      'post',
      `/tenants/${started.tenantId}/billing/start`,
      { planPriceId: prices.pro },
    ).expect(200);
    expect((await subOf(started)).paymentSetupRequiredSince).not.toBeNull();
    expect(await historyOf(started)).toEqual(['PAYMENT_SETUP_REQUIRED']);
    const shown = await summaryOf(started);
    expect({ ...shown, since: typeof shown.since }).toEqual({
      required: true,
      since: 'string',
      deadline: null,
      expired: false,
    });
    // Entry path 2 — a complimentary arrangement ends with no subscription.
    fromComplimentary = await business('fromcomp', 'complimentary');
    await runSerializable(prisma, (tx) =>
      lifecycle.endComplimentary(
        tx,
        {
          subscriptionId: fromComplimentary.subscriptionId,
          previousPlanVersionId: versions.pro,
          previousPlanPriceId: prices.pro,
          previousBillingProvider: 'fake',
          previousExternalCustomerId: fromComplimentary.customer,
          previousExternalSubscriptionId: null,
          previousTrialStartedAt: null,
          previousTrialEndsAt: null,
          previousTrialRequiresPaymentMethod: null,
        },
        at(0),
        {
          source: 'SYSTEM',
          billingProviderEventId: null,
          actorPlatformOperatorId: null,
        },
      ),
    );
    expect(await historyOf(fromComplimentary)).toEqual([
      'PAYMENT_SETUP_REQUIRED',
    ]);
    // Billed and awaiting setup before SC3e-4: no record yet.
    legacy = await business('legacy', 'awaiting');
    expect((await subOf(legacy)).paymentSetupRequiredSince).toBeNull();

    // Nothing is enforced: the sweeps do nothing; nothing can be extended.
    expect(await enforcement.sweep(at(1))).toMatchObject({ enabled: false });
    expect(await sweep(at(30))).toEqual({
      windows: 0,
      expired: 0,
      reminders: 0,
    });
    expect(await prisma.billingEnforcementActivation.count()).toBe(0);
    for (const b of [started, fromComplimentary, legacy]) {
      const row = await subOf(b);
      expect([
        row.paymentSetupWindowStartedAt,
        row.paymentSetupDueAt,
        row.paymentSetupExpiredAt,
      ]).toEqual([null, null, null]);
      expect(await tenantOf(b)).toEqual({
        status: 'ACTIVE',
        suspensionReason: null,
      });
    }
    const refused = await asOperator(
      'accounts',
      'post',
      `/tenants/${started.tenantId}/billing/payment-setup/extension`,
      {
        days: 3,
        reason: 'Owner is travelling this week.',
      },
    ).expect(409);
    expect((refused.body as { code: string }).code).toBe(
      'BILLING_NOT_EXTENDABLE',
    );
  });

  // --- B. activation -------------------------------------------------------------------------

  it('B1. on activation every eligible business gets a fresh 14-day window — excluded categories never do', async () => {
    excluded = {
      paying: await business('paying', 'paying'),
      trialing: await business('trialing', 'trialing'),
      past_due: await business('pastdue', 'past_due'),
      unpaid: await business('unpaid', 'unpaid'),
      canceled: await business('canceled', 'canceled'),
      complimentary: await business('comp', 'complimentary'),
      founding: await business('founding', 'founding'),
    };
    security = await business('security', 'awaiting');
    enforce(true);
    const first = await sweep(at(2));
    expect(first.windows).toBe(4);
    expect(await prisma.billingEnforcementActivation.count()).toBe(1);
    for (const b of [started, fromComplimentary, legacy, security]) {
      const row = await subOf(b);
      expect(row.paymentSetupRequiredSince).not.toBeNull();
      expect(row.paymentSetupWindowStartedAt).toEqual(at(2));
      expect(row.paymentSetupDueAt).toEqual(at(16));
      expect(await historyOf(b)).toEqual(
        expect.arrayContaining(['PAYMENT_SETUP_WINDOW_STARTED']),
      );
    }
    for (const b of Object.values(excluded)) {
      const row = await subOf(b);
      expect([row.paymentSetupRequiredSince, row.paymentSetupDueAt]).toEqual([
        null,
        null,
      ]);
    }
    // Idempotent: a repeated sweep changes nothing.
    expect(await sweep(at(2.01))).toEqual({
      windows: 0,
      expired: 0,
      reminders: 0,
    });
    expect(
      (await historyOf(started)).filter(
        (t) => t === 'PAYMENT_SETUP_WINDOW_STARTED',
      ),
    ).toHaveLength(1);
    // Shown to the business now that it applies.
    expect((await summaryOf(started)).deadline).toBe(at(16).toISOString());
    // Operators see the list (any operator) — business staff never.
    const list = (
      await asOperator('none', 'get', '/billing/payment-setup').expect(200)
    ).body as PlatformPaymentSetupListResponse;
    expect(list.enforced).toBe(true);
    expect(list.items.map((i) => i.tenantId)).toEqual(
      expect.arrayContaining([
        started.tenantId,
        legacy.tenantId,
        fromComplimentary.tenantId,
      ]),
    );
    expect(list.items.map((i) => i.tenantId)).not.toContain(
      excluded.paying.tenantId,
    );
    await request(app.getHttpServer())
      .get('/api/v1/platform/billing/payment-setup')
      .set('Authorization', `Bearer ${staffToken(started.key)}`)
      .expect(401);
  });

  it('B2. reminders 7, 3 and 1 days before (deduplicated, only with notifications on); expiry suspends for billing', async () => {
    notify(true);
    // A SECURITY suspension is never touched.
    await prisma.tenant.update({
      where: { id: security.tenantId },
      data: { status: 'SUSPENDED', suspensionReason: 'SECURITY' },
    });
    for (let day = 3; day <= 16; day++) await sweep(at(day));
    await sweep(at(16.5));
    notify(false);
    const reminders = await prisma.billingNotification.findMany({
      where: {
        subscriptionId: started.subscriptionId,
        kind: 'PAYMENT_SETUP_ENDING',
      },
      select: { dedupeKey: true },
    });
    expect(reminders.map((r) => r.dedupeKey.split(':').pop()).sort()).toEqual([
      '1',
      '3',
      '7',
    ]);
    // Expired: suspended for billing, the business told; data kept.
    const row = await subOf(started);
    expect(row.paymentSetupExpiredAt).not.toBeNull();
    expect(row.status).toBe('ACTIVE');
    expect(await tenantOf(started)).toEqual({
      status: 'SUSPENDED',
      suspensionReason: 'BILLING',
    });
    expect(await historyOf(started)).toEqual(
      expect.arrayContaining(['PAYMENT_SETUP_EXPIRED', 'BILLING_SUSPENDED']),
    );
    expect(
      await prisma.billingNotification.count({
        where: {
          subscriptionId: started.subscriptionId,
          kind: 'PAYMENT_SETUP_EXPIRED',
        },
      }),
    ).toBe(1);
    // BILLING_WIND_DOWN: billing stays reachable; general administration not.
    expect(await summaryOf(started)).toMatchObject({
      required: true,
      expired: true,
      deadline: null,
    });
    const blocked = await asStaff(started, 'get', '/locations').expect(403);
    expect((blocked.body as { code: string }).code).toBe(
      'BUSINESS_BILLING_SUSPENDED',
    );
    // The SECURITY suspension stays exactly as it was.
    expect(await tenantOf(security)).toEqual({
      status: 'SUSPENDED',
      suspensionReason: 'SECURITY',
    });
    // Excluded businesses are untouched.
    for (const b of Object.values(excluded)) {
      expect(await tenantOf(b)).toEqual({
        status: 'ACTIVE',
        suspensionReason: null,
      });
    }
  });

  // --- C. outages, pauses, fluctuations: one window per episode -----------------------

  it('C1. outages, sweep gaps and enforcement pauses never reset or extend a persisted deadline', async () => {
    const operatorId = await operator('extender', ['billing.accounts.manage']);
    const late = await business('late', 'awaiting');
    const capped = await business('capped', 'awaiting');
    const racer = await business('racer', 'awaiting');
    // Concurrency: two sweeps at once give ONE window.
    await Promise.all([sweep(at(17)), sweep(at(17))]);
    for (const b of [late, capped, racer]) {
      const row = await subOf(b);
      expect([row.paymentSetupWindowStartedAt, row.paymentSetupDueAt]).toEqual([
        at(17),
        at(31),
      ]);
      expect(
        (await historyOf(b)).filter(
          (t) => t === 'PAYMENT_SETUP_WINDOW_STARTED',
        ),
      ).toHaveLength(1);
    }
    // Extensions within the episode: 14 + 2 days = the 30-day maximum.
    const extend = (days: number, now: Date) =>
      lifecycle.extendPaymentSetup(
        capped.subscriptionId,
        { days, reason: 'Owner is waiting for a new card.' },
        operatorId,
        null,
        now,
      );
    await extend(14, at(18));
    await extend(2, at(19));
    expect((await subOf(capped)).paymentSetupDueAt).toEqual(at(47));

    // A sweep outage of 6 days (enforcement still on): nothing restarts.
    const activations = await prisma.billingEnforcementActivation.count();
    await sweep(at(25));
    expect(await prisma.billingEnforcementActivation.count()).toBe(
      activations + 1,
    );
    expect((await subOf(late)).paymentSetupDueAt).toEqual(at(31));
    expect((await subOf(capped)).paymentSetupDueAt).toEqual(at(47));
    // ...and the 30-day maximum still holds after it.
    await expect(extend(1, at(26))).rejects.toMatchObject({
      reason: 'EXTENSION_LIMIT',
    });

    // Enforcement paused for two weeks: nothing happens, no deadline shown...
    enforce(false);
    expect(await sweep(at(30))).toEqual({
      windows: 0,
      expired: 0,
      reminders: 0,
    });
    expect((await summaryOf(late)).deadline).toBeNull();
    // ...and re-enabled: the persisted deadline that passed applies now —
    // never a fresh 14 days.
    enforce(true);
    const resumed = await sweep(at(40));
    expect(resumed.windows).toBe(0);
    for (const b of [late, racer]) {
      const row = await subOf(b);
      expect(row.paymentSetupWindowStartedAt).toEqual(at(17));
      expect(row.paymentSetupExpiredAt).toEqual(at(40));
      expect(await tenantOf(b)).toEqual({
        status: 'SUSPENDED',
        suspensionReason: 'BILLING',
      });
      expect(
        (await historyOf(b)).filter(
          (t) => t === 'PAYMENT_SETUP_WINDOW_STARTED',
        ),
      ).toHaveLength(1);
    }
    // The extended deadline is honoured, then applies after another gap.
    expect((await subOf(capped)).paymentSetupExpiredAt).toBeNull();
    await sweep(at(47.5));
    expect((await subOf(capped)).paymentSetupExpiredAt).toEqual(at(47.5));
    expect((await subOf(capped)).paymentSetupWindowStartedAt).toEqual(at(17));
  });

  it('C2. payment failures and state fluctuations keep the same episode; only a genuinely new episode gets a new window', async () => {
    const b = await business('fluctuating', 'awaiting');
    await sweep(at(48));
    const before = await subOf(b);
    expect(before.paymentSetupDueAt).toEqual(at(62));
    const setState = async (
      data: Parameters<typeof prisma.tenantSubscription.update>[0]['data'],
      now: Date,
    ) => {
      await prisma.tenantSubscription.update({
        where: { id: b.subscriptionId },
        data,
      });
      await runSerializable(prisma, (tx) =>
        lifecycle.syncPaymentSetup(tx, b.subscriptionId, now),
      );
    };
    const same = async () => {
      const row = await subOf(b);
      expect({
        since: row.paymentSetupRequiredSince,
        start: row.paymentSetupWindowStartedAt,
        due: row.paymentSetupDueAt,
      }).toEqual({
        since: before.paymentSetupRequiredSince,
        start: before.paymentSetupWindowStartedAt,
        due: before.paymentSetupDueAt,
      });
    };
    // A first payment fails (past due), then is retried back to active
    // without setup: the same episode, the same deadline.
    await setState(
      { status: 'PAST_DUE', pastDueAt: at(49), graceEndsAt: at(56) },
      at(49),
    );
    await same();
    await sweep(at(50)); // never re-windowed or expired while past due
    await same();
    await setState(
      { status: 'ACTIVE', pastDueAt: null, graceEndsAt: null },
      at(51),
    );
    await sweep(at(51));
    await same();
    expect(
      (await historyOf(b)).filter((t) => t === 'PAYMENT_SETUP_REQUIRED'),
    ).toHaveLength(1);
    expect(
      (await historyOf(b)).filter((t) => t === 'PAYMENT_SETUP_WINDOW_STARTED'),
    ).toHaveLength(1);

    // Setup verified: the episode ends (completed).
    await setState(
      {
        externalSubscriptionId: `fake_sub_fluct_${run}`,
        recurringPaymentAuthorizedAt: at(52),
        currentPeriodStart: at(52),
        currentPeriodEnd: at(82),
      },
      at(52),
    );
    expect((await subOf(b)).paymentSetupRequiredSince).toBeNull();
    expect(await historyOf(b)).toEqual(
      expect.arrayContaining(['PAYMENT_SETUP_COMPLETED']),
    );
    // Later the subscription ends, and billing restarts without a
    // subscription: a genuinely NEW episode gets its own 14 days.
    await setState(
      {
        status: 'CANCELED',
        canceledAt: at(53),
        currentPeriodStart: null,
        currentPeriodEnd: null,
      },
      at(53),
    );
    await setState(
      {
        status: 'ACTIVE',
        canceledAt: null,
        externalSubscriptionId: null,
        recurringPaymentAuthorizedAt: null,
      },
      at(54),
    );
    await sweep(at(54));
    const renewed = await subOf(b);
    expect(renewed.paymentSetupWindowStartedAt).toEqual(at(54));
    expect(renewed.paymentSetupDueAt).toEqual(at(68));
    expect(
      (await historyOf(b)).filter((t) => t === 'PAYMENT_SETUP_WINDOW_STARTED'),
    ).toHaveLength(2);
  });

  // --- D. real time: extensions, Checkout, recovery ------------------------------------------------

  it('D1. operators extend a deadline (reason, recent sign-in, billing.accounts.manage) — never past 30 days', async () => {
    const b = await business('extend', 'awaiting');
    const now = new Date();
    await sweep(now); // a new activation (time jumped): its window starts now
    const before = await subOf(b);
    expect(before.paymentSetupWindowStartedAt).toEqual(now);
    const extend = (days: number, key = 'accounts', ago = 0) =>
      asOperator(
        key,
        'post',
        `/tenants/${b.tenantId}/billing/payment-setup/extension`,
        { days, reason: 'Owner is waiting for a new card.' },
        ago,
      );
    await extend(3, 'none').expect(403);
    await extend(3, 'accounts', 3600).expect(401);
    const first = (await extend(14).expect(200))
      .body as PlatformTenantBillingResponse;
    expect(first.paymentSetup).toMatchObject({
      deadline: new Date(now.getTime() + 28 * DAY).toISOString(),
      latestDeadline: new Date(now.getTime() + 30 * DAY).toISOString(),
      extensions: [
        expect.objectContaining({
          kind: 'PAYMENT_SETUP',
          days: 14,
          reason: 'Owner is waiting for a new card.',
        }),
      ],
    });
    await extend(2).expect(200);
    const limit = await extend(1).expect(409);
    expect((limit.body as { code: string }).code).toBe(
      'BILLING_EXTENSION_LIMIT',
    );
    expect((await subOf(b)).paymentSetupDueAt).toEqual(
      new Date(now.getTime() + 30 * DAY),
    );
    expect(await historyOf(b)).toEqual(
      expect.arrayContaining(['PAYMENT_SETUP_EXTENDED']),
    );
    expect(
      await prisma.platformAuditEvent.count({
        where: {
          action: 'platform.billing.payment_setup_extended',
          targetId: b.tenantId,
        },
      }),
    ).toBe(2);
    // The database refuses past 30 days too.
    await expect(
      prisma.tenantSubscription.update({
        where: { id: b.subscriptionId },
        data: { paymentSetupDueAt: new Date(now.getTime() + 31 * DAY) },
      }),
    ).rejects.toThrow();
  });

  it('D2. opening Checkout again never resets or extends the deadline (entry path 3: abandoned Checkout)', async () => {
    const b = await business('checkout', 'awaiting');
    await sweep(new Date());
    const before = await subOf(b);
    const first = await asStaff(b, 'post', '/billing/checkout').expect(201);
    fake.expireCheckout((first.body as { url: string }).url.split('/').pop()!);
    await prisma.billingCheckoutSession.updateMany({
      where: { subscriptionId: b.subscriptionId },
      data: { status: 'EXPIRED' },
    });
    await asStaff(b, 'post', '/billing/checkout').expect(201);
    await sweep(new Date());
    const after = await subOf(b);
    expect({
      since: after.paymentSetupRequiredSince,
      start: after.paymentSetupWindowStartedAt,
      due: after.paymentSetupDueAt,
    }).toEqual({
      since: before.paymentSetupRequiredSince,
      start: before.paymentSetupWindowStartedAt,
      due: before.paymentSetupDueAt,
    });
  });

  it('D3. recovery only after verified setup AND payment; an unpaid first invoice keeps the suspension; duplicates are safe', async () => {
    // `started` expired and is suspended for billing (B2).
    expect(await tenantOf(started)).toEqual({
      status: 'SUSPENDED',
      suspensionReason: 'BILLING',
    });
    // Checkout is reachable while suspended; no trial after an expired window.
    const checkout = await asStaff(started, 'post', '/billing/checkout').expect(
      201,
    );
    const sessionId = (checkout.body as { url: string }).url.split('/').pop()!;
    expect(
      await prisma.billingCheckoutSession.findFirstOrThrow({
        where: { subscriptionId: started.subscriptionId, status: 'OPEN' },
      }),
    ).toMatchObject({ trialDays: 0 });
    // Completed, but the first invoice is not paid: still suspended.
    const created = fake.completeCheckout(sessionId, {
      hasPaymentMethod: true,
      firstInvoice: 'open',
    });
    const ids = {
      sub: created.externalSubscriptionId,
      customer: created.externalCustomerId,
    };
    await deliver(ids, 'checkout.completed', { session: sessionId });
    await deliver(ids, 'invoice.payment_failed', {
      reference: created.latestInvoiceId!,
    });
    await sweep(new Date());
    expect(await tenantOf(started)).toEqual({
      status: 'SUSPENDED',
      suspensionReason: 'BILLING',
    });
    expect((await subOf(started)).paymentSetupExpiredAt).not.toBeNull();
    // Paid (verified by the provider): restored, setup completed — once.
    fake.setInvoice(
      created.latestInvoiceId!,
      'paid',
      created.externalSubscriptionId,
      created.externalCustomerId,
    );
    const paid = await deliver(ids, 'invoice.paid', {
      reference: created.latestInvoiceId!,
    });
    await lifecycle.recordAndApply(paid.verified); // a duplicate delivery
    await sweep(new Date());
    expect(await tenantOf(started)).toEqual({
      status: 'ACTIVE',
      suspensionReason: null,
    });
    const row = await subOf(started);
    expect([
      row.paymentSetupRequiredSince,
      row.paymentSetupDueAt,
      row.paymentSetupExpiredAt,
    ]).toEqual([null, null, null]);
    const history = await historyOf(started);
    expect(history.filter((t) => t === 'PAYMENT_SETUP_COMPLETED')).toHaveLength(
      1,
    );
    expect(
      history.filter((t) => t === 'BILLING_SUSPENSION_LIFTED'),
    ).toHaveLength(1);
    expect((await summaryOf(started)).required).toBe(false);
  });

  it('D4. a SECURITY suspension is never lifted by setting up payment; tenants see only their own', async () => {
    // The SECURITY-suspended business never expired into a billing suspension.
    expect(await tenantOf(security)).toEqual({
      status: 'SUSPENDED',
      suspensionReason: 'SECURITY',
    });
    // Another business's tenant id with this business's staff identity.
    await request(app.getHttpServer())
      .get('/api/v1/admin/billing')
      .set('Authorization', `Bearer ${staffToken(legacy.key)}`)
      .set('X-Tenant-Id', fromComplimentary.tenantId)
      .expect((res) => expect(res.status).toBeGreaterThanOrEqual(401));
  });

  it('D5. the enforcement sweep runs the payment setup step only when enabled', async () => {
    enforce(false);
    expect(await enforcement.sweep(new Date())).toMatchObject({
      enabled: false,
    });
    enforce(true);
    expect(await enforcement.sweep(new Date())).toMatchObject({
      enabled: true,
      failed: 0,
    });
    enforce(false);
  });
});
