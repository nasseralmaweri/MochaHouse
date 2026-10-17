import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  BillingPlanChangePreview,
  InternalPermissionKey,
} from '@mocha-house/contracts';
import {
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  type ScratchDatabase,
} from '@mocha-house/testing';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { signPlatformDevJwt } from '../platform-auth/infrastructure/platform-dev-jwt';
import { BillingLifecycleService } from './application/billing-lifecycle.service';
import type {
  FakeEventBody,
  FakeSaasBillingProvider,
} from './provider/fake-saas-billing-provider';
import { SAAS_BILLING_PROVIDER } from './provider/saas-billing-provider';

// SC3d-1 — plan change PREVIEWS, end to end on the real AppModule (fake
// provider) in a SCRATCH database:
//   * the provider calculates the charge; the preview is recorded (valid 10
//     minutes) and NOTHING is charged or changed — no subscription update,
//     no schedule, no new modules;
//   * timing follows the owner decisions: upgrade / monthly -> annual now,
//     downgrade / annual -> monthly at the period end, a trial's plan at the
//     trial end;
//   * refused while not active or trialing, suspended, cancelling, in
//     another currency, for the same price, while another change is open, or
//     when the provider bills something our records don't (review case);
//   * only OUR price ids are accepted; billing.manage business-wide; the
//     business from the trusted context; operators audited.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const DAY = 24 * 60 * 60 * 1000;

jest.setTimeout(120_000);

describe('SC3d-1 plan change preview (integration, scratch database)', () => {
  let scratch: ScratchDatabase;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let lifecycle: BillingLifecycleService;
  let fake: FakeSaasBillingProvider;
  const originalEnv = { ...process.env };
  const PLATFORM_SECRET = `sc3d1-platform-${randomUUID()}`;
  const INTERNAL_SECRET = `sc3d1-internal-${randomUUID()}`;
  const run = randomUUID().replace(/-/g, '').slice(0, 8);
  let operatorId: string;
  const prices: Record<
    string,
    { id: string; planVersionId: string; ext: string }
  > = {};

  const MANAGE: InternalPermissionKey[] = [
    'billing.view',
    'billing.manage',
    'locations.view',
  ];

  const staffToken = (key: string) =>
    signInternalDevJwt(
      {
        sub: `internal-dev:sc3d1-${key}-${run}`,
        email: `sc3d1-${key}-${run}@example.com`,
        name: null,
        email_verified: true,
      },
      INTERNAL_SECRET,
      3600,
    );
  const preview = (key: string, tenantId: string, body: unknown) =>
    request(app.getHttpServer())
      .post('/api/v1/admin/billing/plan-change/preview')
      .set('Authorization', `Bearer ${staffToken(key)}`)
      .set('X-Tenant-Id', tenantId)
      .send(body as object);
  const operatorPreview = (tenantId: string, body: unknown) =>
    request(app.getHttpServer())
      .post(`/api/v1/platform/tenants/${tenantId}/billing/plan-change/preview`)
      .set(
        'Authorization',
        `Bearer ${signPlatformDevJwt({ sub: `platform-dev:sc3d1-${run}`, mfa: true }, PLATFORM_SECRET, 3600)}`,
      )
      // SC3d-2 — an operator preview always carries a written reason.
      .send({
        reason: 'Requested by the business owner.',
        ...(body as object),
      });

  interface Business {
    key: string;
    tenantId: string;
    subscriptionId: string;
    customer: string;
    sub: string;
  }

  async function staff(
    tenantId: string,
    key: string,
    permissions: InternalPermissionKey[],
    roleKey: string,
  ) {
    const role = await prisma.internalRole.upsert({
      where: { tenantId_key: { tenantId, key: roleKey } },
      update: {},
      create: {
        tenantId,
        key: roleKey,
        displayName: roleKey,
        isSystem: roleKey === 'platform-administrator',
        permissions: {
          create: permissions.map((permissionKey) => ({ permissionKey })),
        },
      },
    });
    const user = await prisma.internalUser.create({
      data: {
        tenantId,
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:sc3d1-${key}-${run}`,
        email: `sc3d1-${key}-${run}@example.com`,
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
    return user.id;
  }

  // A BILLED business on `priceKey`, linked to a provider subscription that
  // bills exactly that price (one item).
  async function business(
    label: string,
    priceKey: string,
    state: Record<string, unknown> = {},
    providerStatus: 'active' | 'trialing' = 'active',
  ): Promise<Business> {
    const tenantId = randomUUID();
    await prisma.tenant.create({
      data: {
        id: tenantId,
        slug: `sc3d1-${label}-${run}`,
        name: `SC3d1 ${label}`,
        status: 'ACTIVE',
      },
    });
    const customer = `fake_cus_${label}_${run}`;
    const sub = `fake_sub_${label}_${run}`;
    const price = prices[priceKey];
    const subscription = await prisma.tenantSubscription.create({
      data: {
        subscriberTenantId: tenantId,
        planVersionId: price.planVersionId,
        billingMode: 'BILLED',
        billingProvider: 'fake',
        planPriceId: price.id,
        externalCustomerId: customer,
        externalSubscriptionId: sub,
        status: 'ACTIVE',
        recurringPaymentAuthorizedAt: new Date(Date.now() - 40 * DAY),
        currentPeriodStart: new Date(Date.now() - 10 * DAY),
        currentPeriodEnd: new Date(Date.now() + 20 * DAY),
        ...state,
      },
    });
    fake.subscriptions.set(sub, {
      externalSubscriptionId: sub,
      externalCustomerId: customer,
      status: providerStatus,
      livemode: false,
      hasPaymentMethod: true,
      paymentMethodSource: 'SUBSCRIPTION',
      cancelAtPeriodEnd: false,
      trialStart: null,
      trialEnd:
        providerStatus === 'trialing' ? new Date(Date.now() + 7 * DAY) : null,
      latestInvoiceId: null,
      items: [
        {
          externalItemId: `fake_si_${label}_${run}`,
          externalPriceId: price.ext,
          quantity: 1,
        },
      ],
      scheduleId: null,
      hasPendingUpdate: false,
      currentPeriodEnd: new Date(Date.now() + 20 * DAY),
    });
    await staff(tenantId, label, MANAGE, 'platform-administrator');
    return {
      key: label,
      tenantId,
      subscriptionId: subscription.id,
      customer,
      sub,
    };
  }

  const changesOf = (b: Business) =>
    prisma.billingPlanChange.findMany({
      where: { subscriptionId: b.subscriptionId },
    });
  const casesOf = async (b: Business) =>
    (
      await prisma.billingReconciliationCase.findMany({
        where: { subscriptionId: b.subscriptionId, status: 'OPEN' },
        select: { kind: true },
      })
    ).map((c) => c.kind);
  const codeOf = (response: { body: unknown }) =>
    (response.body as { code: string }).code;
  const CHANGES = [
    'changePriceNow',
    'schedulePriceChangeAtPeriodEnd',
    'releaseSchedule',
  ];

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3d1_plan_change',
    );
    await applyMigrations(scratch.url, listMigrations(MIGRATIONS));
    process.env.DATABASE_URL = scratch.url;
    process.env.PLATFORM_AUTH_PROVIDER = 'dev';
    process.env.PLATFORM_AUTH_DEV_JWT_SECRET = PLATFORM_SECRET;
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = INTERNAL_SECRET;
    process.env.RATE_LIMIT_ENABLED = '0';
    process.env.SAAS_BILLING_PROVIDER = 'fake';
    process.env.SAAS_BILLING_TRIAL_CLAIM_SECRET = `sc3d1-claims-${randomUUID()}`;
    delete process.env.BILLING_ENFORCEMENT_ENABLED;
    delete process.env.BILLING_NOTIFICATIONS_ENABLED;
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    await app.init();
    prisma = app.get(PrismaService);
    lifecycle = app.get(BillingLifecycleService);
    fake = app.get(SAAS_BILLING_PROVIDER);

    operatorId = (
      await prisma.platformOperator.create({
        data: {
          externalProvider: 'platform-dev',
          externalSubject: `platform-dev:sc3d1-${run}`,
          email: `sc3d1-${run}@example.test`,
          status: 'ACTIVE',
        },
      })
    ).id;
    // Growth (49 / month, 490 / year), Pro (99 / month; EUR; an archived
    // price), Lite (19 / month).
    const plans: Record<string, string> = {};
    for (const key of ['growth', 'pro', 'lite']) {
      const plan = await prisma.subscriptionPlan.create({
        data: {
          key: `${key}-${run}`,
          name: key[0].toUpperCase() + key.slice(1),
        },
      });
      const version = await prisma.subscriptionPlanVersion.create({
        data: {
          planId: plan.id,
          version: 1,
          moduleKeys: key === 'lite' ? [] : ['crm'],
        },
      });
      await prisma.subscriptionPlanVersion.update({
        where: { id: version.id },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });
      plans[key] = plan.id;
      plans[`${key}:version`] = version.id;
    }
    const price = async (
      key: string,
      plan: string,
      amountMinorUnits: number,
      interval: 'MONTH' | 'YEAR',
      currency = 'USD',
      status: 'ACTIVE' | 'ARCHIVED' = 'ACTIVE',
    ) => {
      const row = await prisma.subscriptionPlanPrice.create({
        data: {
          planId: plans[plan],
          interval,
          currency,
          amountMinorUnits,
          status,
          archivedAt: status === 'ARCHIVED' ? new Date() : null,
        },
      });
      const ext = `fake_price_${key}_${run}`;
      await prisma.subscriptionPlanPrice.update({
        where: { id: row.id },
        data: { externalPriceId: ext },
      });
      fake.priceCatalog.set(ext, {
        amountMinorUnits,
        currency: currency.toLowerCase(),
        interval,
      });
      prices[key] = {
        id: row.id,
        planVersionId: plans[`${plan}:version`],
        ext,
      };
    };
    await price('growthMonthly', 'growth', 4900, 'MONTH');
    await price('growthYearly', 'growth', 49000, 'YEAR');
    await price('proMonthly', 'pro', 9900, 'MONTH');
    await price('proEuro', 'pro', 9900, 'MONTH', 'EUR');
    await price('proArchived', 'pro', 8900, 'MONTH', 'USD', 'ARCHIVED');
    await price('liteMonthly', 'lite', 1900, 'MONTH');
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      process.env = { ...originalEnv };
      await scratch?.drop();
    }
  });

  it("an upgrade is previewed with the provider's own charge, recorded for 10 minutes, and NOTHING changes", async () => {
    const b = await business('upgrade', 'growthMonthly');
    const before = await prisma.tenantSubscription.findUniqueOrThrow({
      where: { id: b.subscriptionId },
    });
    const providerBefore = structuredClone(fake.subscriptions.get(b.sub));
    fake.previewAdjust = { taxMinorUnits: 120, discountMinorUnits: 300 };
    const started = Date.now();

    const body = (
      await preview(b.key, b.tenantId, {
        planPriceId: prices.proMonthly.id,
      }).expect(200)
    ).body as BillingPlanChangePreview;
    expect(body.timing).toBe('IMMEDIATE');
    expect(body.current).toEqual({
      planName: 'Growth',
      price: { amountMinorUnits: 4900, currency: 'USD', interval: 'MONTH' },
    });
    expect(body.target.planName).toBe('Pro');
    // (99 - 49) for the 20 of 30 days left, as the provider calculated it.
    expect(body.chargeNow).toEqual({
      amountDueMinorUnits: 3333,
      totalMinorUnits: 3333,
      taxMinorUnits: 120,
      discountMinorUnits: 300,
      prorationMinorUnits: 3333,
      currency: 'USD',
    });
    expect(body.nextRecurring).toMatchObject({
      amountMinorUnits: 9900,
      currency: 'USD',
      interval: 'MONTH',
    });
    expect(new Date(body.nextRecurring.startsAt!).getTime()).toBeGreaterThan(
      Date.now() + 19 * DAY,
    );
    const expires = new Date(body.expiresAt).getTime();
    expect(expires - started).toBeGreaterThanOrEqual(10 * 60 * 1000 - 5000);
    expect(expires - started).toBeLessThanOrEqual(10 * 60 * 1000 + 5000);

    const [row] = await changesOf(b);
    expect(row).toMatchObject({
      id: body.previewId,
      status: 'PREVIEWED',
      timing: 'IMMEDIATE',
      fromPlanPriceId: prices.growthMonthly.id,
      toPlanPriceId: prices.proMonthly.id,
      toPlanVersionId: prices.proMonthly.planVersionId,
      currency: 'USD',
      previewAmountDueMinorUnits: 3333,
      externalItemId: `fake_si_upgrade_${run}`,
      actorKind: 'STAFF',
      actorPlatformOperatorId: null,
    });
    expect(row.prorationDate!.getTime() % 1000).toBe(0);
    expect(
      await prisma.internalAuditEvent.count({
        where: {
          tenantId: b.tenantId,
          action: 'billing.plan_change_previewed',
        },
      }),
    ).toBe(1);

    // Nothing changed: our subscription, the provider's, and no change call.
    const after = await prisma.tenantSubscription.findUniqueOrThrow({
      where: { id: b.subscriptionId },
    });
    expect(after).toEqual(before);
    expect(fake.subscriptions.get(b.sub)).toEqual(providerBefore);
    expect(fake.calls.filter((c) => CHANGES.includes(c.op))).toEqual([]);
  });

  it('timing: monthly -> annual now (a new period), annual -> monthly and downgrades at the period end, a trial at its end', async () => {
    const toAnnual = await business('to-annual', 'growthMonthly');
    const annual = (
      await preview(toAnnual.key, toAnnual.tenantId, {
        planPriceId: prices.growthYearly.id,
      }).expect(200)
    ).body as BillingPlanChangePreview;
    expect(annual.timing).toBe('IMMEDIATE');
    expect(annual.chargeNow?.amountDueMinorUnits).toBe(49000 - 3267);
    expect(annual.nextRecurring).toMatchObject({
      amountMinorUnits: 49000,
      interval: 'YEAR',
      startsAt: null,
    });

    const toMonthly = await business('to-monthly', 'growthYearly');
    const monthly = (
      await preview(toMonthly.key, toMonthly.tenantId, {
        planPriceId: prices.proMonthly.id,
      }).expect(200)
    ).body as BillingPlanChangePreview;
    expect(monthly).toMatchObject({ timing: 'PERIOD_END', chargeNow: null });

    const down = await business('down', 'proMonthly');
    const lite = (
      await preview(down.key, down.tenantId, {
        planPriceId: prices.liteMonthly.id,
      }).expect(200)
    ).body as BillingPlanChangePreview;
    expect(lite).toMatchObject({ timing: 'PERIOD_END', chargeNow: null });
    expect(lite.nextRecurring.amountMinorUnits).toBe(1900);
    const [row] = await changesOf(down);
    expect(row).toMatchObject({
      previewAmountDueMinorUnits: null,
      prorationDate: null,
      externalItemId: null,
    });

    const trial = await business(
      'trial',
      'growthMonthly',
      {
        status: 'TRIALING',
        trialStartedAt: new Date(Date.now() - 7 * DAY),
        trialEndsAt: new Date(Date.now() + 7 * DAY),
        trialRequiresPaymentMethod: false,
      },
      'trialing',
    );
    const after = (
      await preview(trial.key, trial.tenantId, {
        planPriceId: prices.proMonthly.id,
      }).expect(200)
    ).body as BillingPlanChangePreview;
    expect(after).toMatchObject({ timing: 'TRIAL_END', chargeNow: null });
    expect(new Date(after.nextRecurring.startsAt!).getTime()).toBeGreaterThan(
      Date.now() + 6 * DAY,
    );
    expect(fake.calls.filter((c) => CHANGES.includes(c.op))).toEqual([]);
  });

  it('refuses businesses that must recover billing first, are paused or cancelling, and prices that do not qualify', async () => {
    const code = async (b: Business, priceKey: string) =>
      codeOf(
        await preview(b.key, b.tenantId, {
          planPriceId: prices[priceKey].id,
        }).expect(409),
      );
    for (const status of [
      'PAST_DUE',
      'UNPAID',
      'TRIAL_EXPIRED',
      'CANCELED',
    ] as const) {
      const b = await business(
        `s-${status.toLowerCase().replace(/_/g, '-')}`,
        'growthMonthly',
        {
          status,
          ...(status === 'PAST_DUE' || status === 'UNPAID'
            ? {
                pastDueAt: new Date(Date.now() - DAY),
                graceEndsAt: new Date(Date.now() + DAY),
              }
            : {}),
          ...(status === 'CANCELED' ? { canceledAt: new Date() } : {}),
          ...(status === 'TRIAL_EXPIRED'
            ? {
                trialStartedAt: new Date(Date.now() - 20 * DAY),
                trialEndsAt: new Date(Date.now() - 6 * DAY),
                trialRequiresPaymentMethod: false,
              }
            : {}),
        },
      );
      expect(await code(b, 'proMonthly')).toBe(
        'BILLING_PLAN_CHANGE_UNAVAILABLE',
      );
    }
    const cancelling = await business('cancelling', 'growthMonthly', {
      cancelAtPeriodEnd: true,
    });
    expect(await code(cancelling, 'proMonthly')).toBe(
      'BILLING_PLAN_CHANGE_UNAVAILABLE',
    );

    const ok = await business('prices', 'growthMonthly');
    expect(await code(ok, 'growthMonthly')).toBe(
      'BILLING_PLAN_CHANGE_SAME_PRICE',
    );
    expect(await code(ok, 'proEuro')).toBe('BILLING_PLAN_CHANGE_CURRENCY');
    expect(await code(ok, 'proArchived')).toBe(
      'BILLING_PLAN_CHANGE_UNAVAILABLE',
    );
    await preview(ok.key, ok.tenantId, { planPriceId: randomUUID() }).expect(
      404,
    );
    // Only OUR price id, exactly: a provider id or anything extra is refused.
    await preview(ok.key, ok.tenantId, {
      planPriceId: prices.proMonthly.ext,
    }).expect(400);
    await preview(ok.key, ok.tenantId, {
      externalPriceId: prices.proMonthly.ext,
    }).expect(400);
    await preview(ok.key, ok.tenantId, {
      planPriceId: prices.proMonthly.id,
      amount: 1,
    }).expect(400);
    expect(await changesOf(ok)).toEqual([]);
  });

  it('a paused business (billing wind-down) cannot preview; view-only staff cannot; another business is never reached', async () => {
    const paused = await business('paused', 'growthMonthly');
    await prisma.tenant.update({
      where: { id: paused.tenantId },
      data: { status: 'SUSPENDED', suspensionReason: 'BILLING' },
    });
    const refused = await preview(paused.key, paused.tenantId, {
      planPriceId: prices.proMonthly.id,
    });
    expect([403, 409]).toContain(refused.status);

    const b = await business('viewer', 'growthMonthly');
    await staff(b.tenantId, 'viewer-only', ['billing.view'], 'viewer');
    await preview('viewer-only', b.tenantId, {
      planPriceId: prices.proMonthly.id,
    }).expect(403);

    // Staff of A asking with B's business id is refused by the tenant
    // resolution; B's subscription is untouched.
    const other = await business('other', 'growthMonthly');
    const cross = await preview(b.key, other.tenantId, {
      planPriceId: prices.proMonthly.id,
    });
    expect([401, 403, 404]).toContain(cross.status);
    expect(await changesOf(other)).toEqual([]);
  });

  it('a change already in flight blocks a new one (ours, the provider schedule or a pending update)', async () => {
    const b = await business('inflight', 'growthMonthly');
    const body = (
      await preview(b.key, b.tenantId, {
        planPriceId: prices.proMonthly.id,
      }).expect(200)
    ).body as BillingPlanChangePreview;
    // Previews alone never block.
    await preview(b.key, b.tenantId, {
      planPriceId: prices.proMonthly.id,
    }).expect(200);
    await prisma.billingPlanChange.update({
      where: { id: body.previewId },
      data: { status: 'REQUESTED', confirmedAt: new Date() },
    });
    expect(
      codeOf(
        await preview(b.key, b.tenantId, {
          planPriceId: prices.liteMonthly.id,
        }).expect(409),
      ),
    ).toBe('BILLING_PLAN_CHANGE_IN_PROGRESS');

    const scheduled = await business('scheduled', 'growthMonthly');
    fake.setSubscription(scheduled.sub, { scheduleId: 'fake_sub_sched_x' });
    expect(
      codeOf(
        await preview(scheduled.key, scheduled.tenantId, {
          planPriceId: prices.proMonthly.id,
        }).expect(409),
      ),
    ).toBe('BILLING_PLAN_CHANGE_IN_PROGRESS');
    const pending = await business('pending', 'growthMonthly');
    fake.setSubscription(pending.sub, { hasPendingUpdate: true });
    expect(
      codeOf(
        await preview(pending.key, pending.tenantId, {
          planPriceId: prices.proMonthly.id,
        }).expect(409),
      ),
    ).toBe('BILLING_PLAN_CHANGE_IN_PROGRESS');
  });

  it('the provider billing another price than our records: refused, reviewed, nothing adopted', async () => {
    const b = await business('mismatch', 'growthMonthly');
    fake.setSubscription(b.sub, {
      items: [
        {
          externalItemId: 'fake_si_x',
          externalPriceId: prices.proMonthly.ext,
          quantity: 1,
        },
      ],
    });
    expect(
      codeOf(
        await preview(b.key, b.tenantId, {
          planPriceId: prices.liteMonthly.id,
        }).expect(409),
      ),
    ).toBe('BILLING_PLAN_CHANGE_UNVERIFIED');
    expect(await casesOf(b)).toEqual(['PRICE_MISMATCH']);
    expect(await changesOf(b)).toEqual([]);
    expect(
      (
        await prisma.tenantSubscription.findUniqueOrThrow({
          where: { id: b.subscriptionId },
        })
      ).planPriceId,
    ).toBe(prices.growthMonthly.id);

    // The webhook sync reviews it too (never adopts it).
    const w = await business('webhook-mismatch', 'growthMonthly');
    fake.setSubscription(w.sub, {
      items: [
        {
          externalItemId: 'fake_si_y',
          externalPriceId: prices.proMonthly.ext,
          quantity: 1,
        },
      ],
    });
    const occurred = Math.floor(Date.now() / 1000);
    const event: FakeEventBody = {
      id: `evt_${run}_mm`,
      type: 'subscription.changed',
      created: occurred,
      livemode: false,
      data: { subscription: w.sub, customer: w.customer },
    };
    const signed = fake.signEvent(event, new Date(occurred * 1000));
    await lifecycle.recordAndApply(
      fake.verifyEvent({ ...signed, now: new Date(occurred * 1000) }),
    );
    expect(await casesOf(w)).toContain('PRICE_MISMATCH');
    expect(
      (
        await prisma.tenantSubscription.findUniqueOrThrow({
          where: { id: w.subscriptionId },
        })
      ).planPriceId,
    ).toBe(prices.growthMonthly.id);
  });

  it('an operator previews on behalf of a business (audited; nothing changes)', async () => {
    const b = await business('operator', 'growthMonthly');
    const body = (
      await operatorPreview(b.tenantId, {
        planPriceId: prices.proMonthly.id,
      }).expect(200)
    ).body as BillingPlanChangePreview;
    expect(body.timing).toBe('IMMEDIATE');
    const [row] = await changesOf(b);
    expect(row).toMatchObject({
      actorKind: 'OPERATOR',
      actorPlatformOperatorId: operatorId,
    });
    expect(
      await prisma.platformAuditEvent.count({
        where: {
          action: 'platform.billing.plan_change_previewed',
          targetId: b.tenantId,
          actorPlatformOperatorId: operatorId,
        },
      }),
    ).toBe(1);
    await operatorPreview(randomUUID(), {
      planPriceId: prices.proMonthly.id,
    }).expect(404);
    expect(fake.calls.filter((c) => CHANGES.includes(c.op))).toEqual([]);
  });

  it('the database keeps one open change per business and never changes what was previewed', async () => {
    const b = await business('db', 'growthMonthly');
    const first = (
      await preview(b.key, b.tenantId, {
        planPriceId: prices.proMonthly.id,
      }).expect(200)
    ).body as BillingPlanChangePreview;
    const second = (
      await preview(b.key, b.tenantId, {
        planPriceId: prices.liteMonthly.id,
      }).expect(200)
    ).body as BillingPlanChangePreview;
    await prisma.billingPlanChange.update({
      where: { id: first.previewId },
      data: { status: 'REQUESTED', confirmedAt: new Date() },
    });
    await expect(
      prisma.billingPlanChange.update({
        where: { id: second.previewId },
        data: { status: 'SCHEDULED' },
      }),
    ).rejects.toThrow();
    // What was previewed is fixed: a different charge needs a new preview.
    await expect(
      prisma.billingPlanChange.update({
        where: { id: first.previewId },
        data: { previewAmountDueMinorUnits: 1 },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.billingPlanChange.update({
        where: { id: first.previewId },
        data: { prorationDate: new Date() },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.billingPlanChange.delete({ where: { id: first.previewId } }),
    ).rejects.toThrow();
    // A finished change is final.
    await prisma.billingPlanChange.update({
      where: { id: second.previewId },
      data: { status: 'EXPIRED', finishedAt: new Date() },
    });
    await expect(
      prisma.billingPlanChange.update({
        where: { id: second.previewId },
        data: { status: 'PREVIEWED', finishedAt: null },
      }),
    ).rejects.toThrow();
  });

  it('previews per business are bounded (30 an hour)', async () => {
    const b = await business('capped', 'growthMonthly');
    const first = (
      await preview(b.key, b.tenantId, {
        planPriceId: prices.liteMonthly.id,
      }).expect(200)
    ).body as BillingPlanChangePreview;
    const row = await prisma.billingPlanChange.findUniqueOrThrow({
      where: { id: first.previewId },
    });
    await prisma.billingPlanChange.createMany({
      data: Array.from({ length: 29 }, () => ({
        subscriptionId: row.subscriptionId,
        timing: row.timing,
        fromPlanVersionId: row.fromPlanVersionId,
        fromPlanPriceId: row.fromPlanPriceId,
        toPlanVersionId: row.toPlanVersionId,
        toPlanPriceId: row.toPlanPriceId,
        currency: row.currency,
        nextRecurringMinorUnits: row.nextRecurringMinorUnits,
        previewExpiresAt: row.previewExpiresAt,
        actorKind: row.actorKind,
      })),
    });
    await preview(b.key, b.tenantId, {
      planPriceId: prices.liteMonthly.id,
    }).expect(429);
    expect(await changesOf(b)).toHaveLength(30);
  });

  it('a provider outage changes nothing and records nothing', async () => {
    const b = await business('outage', 'growthMonthly');
    fake.failNext = 'api_connection_error';
    expect(
      codeOf(
        await preview(b.key, b.tenantId, {
          planPriceId: prices.proMonthly.id,
        }).expect(503),
      ),
    ).toBe('BILLING_UNAVAILABLE');
    expect(await changesOf(b)).toEqual([]);
  });
});
