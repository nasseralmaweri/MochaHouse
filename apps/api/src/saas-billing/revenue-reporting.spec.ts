import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  PlatformPermission,
  PlatformRevenueReport,
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
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { signPlatformDevJwt } from '../platform-auth/infrastructure/platform-dev-jwt';
import { RevenueReportingService } from './application/revenue-reporting.service';
import type { FakeSaasBillingProvider } from './provider/fake-saas-billing-provider';
import { SAAS_BILLING_PROVIDER } from './provider/saas-billing-provider';

// SC3f — CENTERIVO SaaS revenue reporting, end to end on the real AppModule
// (fake provider) in a SCRATCH database with known billing fixtures:
//   * billing.reports.view enforced on the route (operators without it, and
//     business staff, are refused); every report read audited;
//   * contracted MRR/ARR from the subscribed price versions, per currency,
//     PAST_DUE as at risk; trials, unpaid setups, ended and complimentary
//     businesses excluded; the rebuilt history matches the current records;
//   * churn only when a paid subscription ends; trial cohorts; each failed
//     invoice once and recovery only on a verified payment; cash, refunds and
//     credits never double-counted; complimentary counts and list-price
//     equivalents;
//   * invoice amounts captured from verified provider reads, backfilled by
//     reconciliation, never invented or cleared;
//   * only CENTERIVO billing data is read — never restaurant sales,
//     orders, customer payments or gift cards.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const NOW = new Date('2026-06-15T12:00:00Z');
const d = (iso: string) => new Date(iso);

jest.setTimeout(240_000);

describe('SC3f revenue reporting (integration, scratch database)', () => {
  let scratch: ScratchDatabase;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let reports: RevenueReportingService;
  let fake: FakeSaasBillingProvider;
  const originalEnv = { ...process.env };
  const PLATFORM_SECRET = `sc3f-platform-${randomUUID()}`;
  const INTERNAL_SECRET = `sc3f-internal-${randomUUID()}`;
  const run = randomUUID().replace(/-/g, '').slice(0, 8);
  const operators: Record<string, string> = {};
  const prices: Record<string, string> = {};
  const versions: Record<string, string> = {};

  async function operator(key: string, permissions: PlatformPermission[]) {
    const row = await prisma.platformOperator.create({
      data: {
        externalProvider: 'platform-dev',
        externalSubject: `platform-dev:sc3f-${key}-${run}`,
        email: `sc3f-${key}-${run}@example.test`,
        status: 'ACTIVE',
      },
    });
    await grantPlatformPermissions(prisma, row.id, permissions);
    operators[key] = row.id;
  }
  const asOperator = (
    key: string,
    path: string,
    method: 'get' | 'post' = 'get',
  ) =>
    request(app.getHttpServer())
      [method](`/api/v1/platform${path}`)
      .set(
        'Authorization',
        `Bearer ${signPlatformDevJwt(
          {
            sub: `platform-dev:sc3f-${key}-${run}`,
            mfa: true,
            iat: Math.floor(Date.now() / 1000),
          },
          PLATFORM_SECRET,
          3600,
        )}`,
      );

  // --- fixtures ----------------------------------------------------------------------
  interface Business {
    tenantId: string;
    subscriptionId: string;
    customer: string;
    sub: string;
  }
  let seq = 0;
  async function business(
    label: string,
    state: {
      billingMode?: 'BILLED' | 'COMPLIMENTARY';
      status?: 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'TRIALING' | 'UNPAID';
      price?: string | null;
      provider?: boolean; // a provider subscription exists
      paid?: boolean; // a paid period exists
    },
  ): Promise<Business> {
    const tenantId = randomUUID();
    await prisma.tenant.create({
      data: {
        id: tenantId,
        slug: `sc3f-${label}-${run}`,
        name: `SC3f ${label}`,
        status: 'ACTIVE',
      },
    });
    const customer = `fake_cus_${label}_${run}`;
    const sub = `fake_sub_${label}_${run}`;
    const billed = (state.billingMode ?? 'BILLED') === 'BILLED';
    const row = await prisma.tenantSubscription.create({
      data: {
        subscriberTenantId: tenantId,
        planVersionId: versions.pro,
        billingMode: state.billingMode ?? 'BILLED',
        ...(billed
          ? {
              billingProvider: 'fake',
              planPriceId:
                state.price === undefined ? prices.proMonth : state.price,
              externalCustomerId: customer,
              externalSubscriptionId: state.provider === false ? null : sub,
              recurringPaymentAuthorizedAt:
                state.provider === false ? null : d('2026-01-01T00:00:00Z'),
              currentPeriodStart:
                state.paid === false ? null : d('2026-06-01T00:00:00Z'),
              currentPeriodEnd:
                state.paid === false ? null : d('2026-07-01T00:00:00Z'),
              ...(state.status === 'PAST_DUE'
                ? {
                    pastDueAt: d('2026-06-01T00:00:00Z'),
                    graceEndsAt: d('2026-06-20T00:00:00Z'),
                  }
                : {}),
              ...(state.status === 'TRIALING'
                ? {
                    trialStartedAt: d('2026-06-05T00:00:00Z'),
                    trialEndsAt: d('2026-06-19T00:00:00Z'),
                    trialRequiresPaymentMethod: false,
                  }
                : {}),
              ...(state.status === 'CANCELED'
                ? { canceledAt: d('2026-04-20T00:00:00Z') }
                : {}),
            }
          : {}),
        status: state.status ?? 'ACTIVE',
      },
    });
    return { tenantId, subscriptionId: row.id, customer, sub };
  }
  const event = (
    b: Business,
    type:
      | 'TRIAL_STARTED'
      | 'PAYMENT_SUCCEEDED'
      | 'PAYMENT_FAILED'
      | 'CANCELED'
      | 'TRIAL_EXPIRED'
      | 'PLAN_CHANGE_APPLIED',
    at: string,
    fromStatus: 'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'CANCELED',
    toStatus: 'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'CANCELED' | 'TRIAL_EXPIRED',
    planPriceId: string | null = null,
  ) =>
    prisma.tenantSubscriptionEvent.create({
      data: {
        subscriptionId: b.subscriptionId,
        type,
        fromStatus,
        toStatus,
        planPriceId,
        source: 'SYSTEM',
        ...(type === 'PLAN_CHANGE_APPLIED'
          ? { toPlanVersionId: versions.pro }
          : {}),
        createdAt: d(at),
      },
    });
  const checkout = (b: Business, priceId: string, at: string) =>
    prisma.billingCheckoutSession.create({
      data: {
        subscriptionId: b.subscriptionId,
        planPriceId: priceId,
        externalSessionId: `cs_${run}_${seq++}`,
        status: 'COMPLETED',
        trialDays: 0,
        requiresPaymentMethod: true,
        completedAt: d(at),
        createdAt: d(at),
      },
    });
  const invoice = (
    b: Business,
    over: {
      status?: string;
      currency?: string;
      total?: number;
      paid?: number;
      issuedAt: string;
      paidAt?: string | null;
      tax?: number | null;
      attempts?: number | null;
      balanceApplied?: number;
    },
  ) => {
    const total = over.total ?? 9900;
    const tax = over.tax === undefined ? 0 : over.tax;
    const status = over.status ?? 'paid';
    return prisma.billingInvoice.create({
      data: {
        subscriptionId: b.subscriptionId,
        provider: 'fake',
        externalInvoiceId: `in_${run}_${seq++}`,
        externalCustomerId: b.customer,
        externalSubscriptionId: b.sub,
        status,
        currency: over.currency ?? 'usd',
        totalMinorUnits: total,
        amountDueMinorUnits: total,
        amountPaidMinorUnits: over.paid ?? (status === 'paid' ? total : 0),
        amountRemainingMinorUnits: status === 'paid' ? 0 : total,
        balanceAppliedMinorUnits: over.balanceApplied ?? 0,
        issuedAt: d(over.issuedAt),
        paidAt:
          over.paidAt === undefined
            ? status === 'paid'
              ? d(over.issuedAt)
              : null
            : over.paidAt === null
              ? null
              : d(over.paidAt),
        syncedAt: NOW,
        ...(tax === null
          ? {}
          : {
              subtotalMinorUnits: total - tax,
              discountMinorUnits: 0,
              taxMinorUnits: tax,
              totalExcludingTaxMinorUnits: total - tax,
            }),
        attemptCount:
          over.attempts === undefined
            ? status === 'paid'
              ? 1
              : 0
            : over.attempts,
      },
    });
  };

  const report = (from = '2026-01', to = '2026-06') =>
    reports.report(
      { from, to },
      { id: operators.reports } as never,
      undefined,
      NOW,
    );

  let A: Business;
  let B: Business;
  let C: Business;
  let D: Business;
  let E: Business;
  let refundInvoiceId: string;

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3f_reports',
    );
    await applyMigrations(scratch.url, listMigrations(MIGRATIONS));
    process.env.DATABASE_URL = scratch.url;
    process.env.PLATFORM_AUTH_PROVIDER = 'dev';
    process.env.PLATFORM_AUTH_DEV_JWT_SECRET = PLATFORM_SECRET;
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = INTERNAL_SECRET;
    process.env.RATE_LIMIT_ENABLED = '0';
    process.env.SAAS_BILLING_PROVIDER = 'fake';
    process.env.SAAS_BILLING_TRIAL_CLAIM_SECRET = `sc3f-claims-${randomUUID()}`;
    process.env.PLAN_CHANGE_SWEEP_DISABLED = '1';
    process.env.BILLING_CHECKOUT_RETURN_URL =
      'http://localhost:3000/admin/billing';
    delete process.env.BILLING_ENFORCEMENT_ENABLED;
    delete process.env.BILLING_NOTIFICATIONS_ENABLED;
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({
      rawBody: true,
    });
    await app.init();
    prisma = app.get(PrismaService);
    reports = app.get(RevenueReportingService);
    fake = app.get(SAAS_BILLING_PROVIDER);

    await operator('none', []);
    await operator('reports', ['billing.reports.view']);
    await operator('recon', ['billing.reconciliation.run']);

    for (const [key, name] of [
      ['pro', 'Pro'],
      ['growth', 'Growth'],
    ] as const) {
      const plan = await prisma.subscriptionPlan.create({
        data: { key: `${key}-${run}`, name },
      });
      const version = await prisma.subscriptionPlanVersion.create({
        data: { planId: plan.id, version: 1, moduleKeys: ['crm'] },
      });
      await prisma.subscriptionPlanVersion.update({
        where: { id: version.id },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });
      versions[key] = version.id;
      for (const [interval, currency, amount] of key === 'pro'
        ? ([
            ['MONTH', 'USD', 9900],
            ['YEAR', 'USD', 99_000],
            ['MONTH', 'EUR', 8900],
          ] as const)
        : ([['MONTH', 'USD', 4900]] as const)) {
        const price = await prisma.subscriptionPlanPrice.create({
          data: {
            planId: plan.id,
            interval,
            currency,
            amountMinorUnits: amount,
          },
        });
        prices[
          key === 'pro'
            ? interval === 'YEAR'
              ? 'proYear'
              : currency === 'EUR'
                ? 'proEur'
                : 'proMonth'
            : 'growthMonth'
        ] = price.id;
      }
    }
    // A newer catalog price for Pro must NOT change what A pays.
    const proPlan = await prisma.subscriptionPlan.findFirstOrThrow({
      where: { key: `pro-${run}` },
    });
    await prisma.subscriptionPlanPrice.update({
      where: { id: prices.proMonth },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    });
    await prisma.subscriptionPlanPrice.create({
      data: {
        planId: proPlan.id,
        interval: 'MONTH',
        currency: 'USD',
        amountMinorUnits: 12_900,
      },
    });

    // A — USD monthly Pro, paying since January.
    A = await business('a', { price: prices.proMonth });
    await checkout(A, prices.proMonth, '2026-01-10T00:00:00Z');
    await event(
      A,
      'PAYMENT_SUCCEEDED',
      '2026-01-10T00:00:01Z',
      'ACTIVE',
      'ACTIVE',
    );
    // B — USD annual Pro since February; payment failed in June (at risk).
    B = await business('b', { price: prices.proYear, status: 'PAST_DUE' });
    await checkout(B, prices.proYear, '2026-02-01T00:00:00Z');
    await event(
      B,
      'PAYMENT_SUCCEEDED',
      '2026-02-01T00:00:01Z',
      'ACTIVE',
      'ACTIVE',
    );
    await event(
      B,
      'PAYMENT_FAILED',
      '2026-06-01T00:00:00Z',
      'ACTIVE',
      'PAST_DUE',
    );
    // C — EUR monthly Pro since March (never combined with USD).
    C = await business('c', { price: prices.proEur });
    await checkout(C, prices.proEur, '2026-03-01T00:00:00Z');
    await event(
      C,
      'PAYMENT_SUCCEEDED',
      '2026-03-01T00:00:01Z',
      'ACTIVE',
      'ACTIVE',
    );
    // D — USD monthly Growth from January; ended in April (churn).
    D = await business('d', {
      price: prices.growthMonth,
      status: 'CANCELED',
      paid: false,
    });
    await checkout(D, prices.growthMonth, '2026-01-05T00:00:00Z');
    await event(
      D,
      'PAYMENT_SUCCEEDED',
      '2026-01-05T00:00:01Z',
      'ACTIVE',
      'ACTIVE',
    );
    await event(D, 'CANCELED', '2026-04-20T00:00:00Z', 'ACTIVE', 'CANCELED');
    // E — a May trial that converted on Growth (via a plan change).
    E = await business('e', { price: prices.growthMonth });
    await checkout(E, prices.proMonth, '2026-05-01T00:00:00Z');
    await event(
      E,
      'TRIAL_STARTED',
      '2026-05-01T00:00:01Z',
      'ACTIVE',
      'TRIALING',
    );
    await event(
      E,
      'PAYMENT_SUCCEEDED',
      '2026-05-15T00:00:00Z',
      'TRIALING',
      'ACTIVE',
    );
    await event(
      E,
      'PLAN_CHANGE_APPLIED',
      '2026-05-20T00:00:00Z',
      'ACTIVE',
      'ACTIVE',
      prices.growthMonth,
    );
    // F — billing started, never set up (not paying). G — still trialing.
    await business('f', { provider: false, paid: false });
    const G = await business('g', { status: 'TRIALING', paid: false });
    await event(
      G,
      'TRIAL_STARTED',
      '2026-06-05T00:00:00Z',
      'ACTIVE',
      'TRIALING',
    );
    // H — complimentary with no arrangement (e.g. Founding); I — with one.
    await business('h', { billingMode: 'COMPLIMENTARY' });
    const I = await business('i', { billingMode: 'COMPLIMENTARY' });
    await prisma.billingComplimentaryGrant.create({
      data: {
        subscriptionId: I.subscriptionId,
        status: 'ACTIVE',
        planVersionId: versions.pro,
        reason: 'Partner programme grant.',
        grantedByOperatorId: operators.recon,
        previousStatus: 'ACTIVE',
        previousPlanVersionId: versions.pro,
        previousPlanPriceId: prices.proMonth,
        previousBillingProvider: 'fake',
        previousExternalCustomerId: `cus_i_${run}`,
        startedAt: d('2026-05-10T00:00:00Z'),
      },
    });

    // Its history, as the grant flow writes it.
    await prisma.tenantSubscriptionEvent.create({
      data: {
        subscriptionId: I.subscriptionId,
        type: 'COMPLIMENTARY_STARTED',
        fromStatus: 'ACTIVE',
        toStatus: 'ACTIVE',
        fromPlanVersionId: versions.pro,
        toPlanVersionId: versions.pro,
        source: 'SYSTEM',
        createdAt: d('2026-05-10T00:00:00Z'),
      },
    });
    // Invoices.
    await invoice(A, { issuedAt: '2026-05-10T00:00:00Z', tax: 900 });
    // A's June invoice failed twice, then paid (recovered) — one failure.
    await invoice(A, {
      issuedAt: '2026-06-10T00:00:00Z',
      paidAt: '2026-06-12T00:00:00Z',
      tax: 900,
      attempts: 3,
    });
    // B's annual renewal failed and is still open.
    await invoice(B, {
      issuedAt: '2026-06-01T00:00:00Z',
      status: 'open',
      total: 99_000,
      attempts: 1,
    });
    // C in EUR.
    await invoice(C, {
      issuedAt: '2026-06-01T00:00:00Z',
      currency: 'eur',
      total: 8900,
    });
    // E's first paid invoice, recorded before SC3f (amounts unknown).
    const legacy = await invoice(E, {
      issuedAt: '2026-05-15T00:00:00Z',
      total: 9900,
      tax: null,
      attempts: null,
      balanceApplied: 500,
    });
    refundInvoiceId = legacy.id;
    // A refund (cash) and a credit (future invoices) — completed.
    await prisma.billingAdjustment.create({
      data: {
        subscriptionId: E.subscriptionId,
        invoiceId: legacy.id,
        origin: 'EXTERNAL',
        kind: 'REFUND',
        status: 'RECORDED',
        currency: 'usd',
        totalMinorUnits: 2000,
        taxMinorUnits: 0,
        externalRefundId: `re_${run}`,
        finishedAt: d('2026-05-25T00:00:00Z'),
      },
    });
    await prisma.billingAdjustment.create({
      data: {
        subscriptionId: E.subscriptionId,
        invoiceId: legacy.id,
        origin: 'EXTERNAL',
        kind: 'CREDIT',
        status: 'RECORDED',
        currency: 'usd',
        totalMinorUnits: 1000,
        taxMinorUnits: 0,
        externalCreditNoteId: `cn_${run}`,
        finishedAt: d('2026-05-26T00:00:00Z'),
      },
    });
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      process.env = { ...originalEnv };
      await scratch?.drop();
    }
  });

  it('needs billing.reports.view: refused without it and for business staff; audited when read', async () => {
    const refused = await asOperator('none', '/billing/reports/revenue').expect(
      403,
    );
    expect((refused.body as { code: string }).code).toBe(
      'PLATFORM_PERMISSION_REQUIRED',
    );
    const staff = signInternalDevJwt(
      {
        sub: `internal-dev:sc3f-staff-${run}`,
        email: `sc3f-staff-${run}@example.com`,
        name: null,
        email_verified: true,
      },
      INTERNAL_SECRET,
      3600,
    );
    await request(app.getHttpServer())
      .get('/api/v1/platform/billing/reports/revenue')
      .set('Authorization', `Bearer ${staff}`)
      .expect(401);
    const ok = (
      await asOperator('reports', '/billing/reports/revenue').expect(200)
    ).body as PlatformRevenueReport;
    expect(ok.environment).toBe('DEVELOPMENT');
    expect(ok.months).toHaveLength(12);
    expect(
      await prisma.platformAuditEvent.count({
        where: {
          action: 'platform.billing.revenue_report_viewed',
          actorPlatformOperatorId: operators.reports,
        },
      }),
    ).toBe(1);
    // Nothing about an individual business.
    const text = JSON.stringify(ok);
    for (const name of ['SC3f a', 'SC3f b', A.tenantId, A.subscriptionId]) {
      expect(text).not.toContain(name);
    }
    // Bounded periods only.
    for (const query of [
      'from=2024-01&to=2026-06',
      'from=2026-07&to=2026-06',
      'to=2099-01',
      'from=June',
    ]) {
      await asOperator('reports', `/billing/reports/revenue?${query}`).expect(
        400,
      );
    }
  });

  it('reports contracted MRR/ARR per currency from the subscribed prices; PAST_DUE at risk; others excluded', async () => {
    const r = await report();
    expect(r.current.recurring).toEqual([
      {
        currency: 'EUR',
        mrrMinorUnits: 8900,
        arrMinorUnits: 106_800,
        atRiskMrrMinorUnits: 0,
        activePaidSubscriptions: 1,
        atRiskSubscriptions: 0,
        monthlySubscriptions: 1,
        annualSubscriptions: 0,
      },
      {
        // A 9900 + B 99000/12 (8250) + E 4900; never the newer 12900 price.
        currency: 'USD',
        mrrMinorUnits: 9900 + 8250 + 4900,
        arrMinorUnits: 118_800 + 99_000 + 58_800,
        atRiskMrrMinorUnits: 8250,
        activePaidSubscriptions: 3,
        atRiskSubscriptions: 1,
        monthlySubscriptions: 2,
        annualSubscriptions: 1,
      },
    ]);
    expect(
      r.current.byPlan.map(
        (p) =>
          `${p.currency} ${p.planName} ${p.interval} ${p.subscriptions} ${p.mrrMinorUnits}`,
      ),
    ).toEqual([
      'EUR Pro MONTH 1 8900',
      'USD Growth MONTH 1 4900',
      'USD Pro MONTH 1 9900',
      'USD Pro YEAR 1 8250',
    ]);
    // H, plus any complimentary business the migrations seed (Founding).
    const complimentary = await prisma.tenantSubscription.count({
      where: { billingMode: 'COMPLIMENTARY' },
    });
    expect(r.current.complimentary).toEqual({
      withArrangement: 1,
      withoutArrangement: complimentary - 1,
      listPriceEquivalent: [{ currency: 'USD', mrrMinorUnits: 9900 }],
    });
    // The rebuilt history ends exactly in the current records.
    expect(r.dataQuality.incompleteSubscriptions).toBe(0);
    expect(r.dataQuality.violations).toEqual([]);
    const june = r.months.find((m) => m.month === '2026-06')!;
    expect(june.recurring).toEqual(r.current.recurring);
  });

  it('rebuilds each month: growth, churn only when the paid subscription ended, and the right denominators', async () => {
    const r = await report();
    const month = (key: string) => r.months.find((m) => m.month === key)!;
    const usd = (key: string) =>
      month(key).recurring.find((x) => x.currency === 'USD')?.mrrMinorUnits ??
      0;
    expect(r.months.map((m) => m.status)).toEqual(Array(6).fill('COMPLETE'));
    expect(usd('2026-01')).toBe(9900 + 4900);
    expect(usd('2026-02')).toBe(9900 + 4900 + 8250);
    expect(usd('2026-04')).toBe(9900 + 8250);
    // E converted in May at Pro, then changed to Growth on May 20.
    expect(usd('2026-05')).toBe(9900 + 8250 + 4900);
    expect(month('2026-04').churn).toEqual({
      ended: 1,
      endedOther: 0,
      movedToComplimentary: 0,
      revenue: [
        { currency: 'EUR', startMrrMinorUnits: 8900, churnedMrrMinorUnits: 0 },
        {
          currency: 'USD',
          startMrrMinorUnits: 9900 + 4900 + 8250,
          churnedMrrMinorUnits: 4900,
        },
      ],
    });
    expect(month('2026-04').activePaidAtStart).toBe(4);
    expect(month('2026-05').churn.ended).toBe(0);
    expect(r.trialCohorts.filter((c) => c.started > 0)).toEqual([
      {
        month: '2026-05',
        started: 1,
        converted: 1,
        expired: 0,
        inProgress: 0,
        complete: true,
      },
      {
        month: '2026-06',
        started: 1,
        converted: 0,
        expired: 0,
        inProgress: 1,
        complete: false,
      },
    ]);
  });

  it('cash, failures, recovery, refunds and credits — each counted once, per currency', async () => {
    const r = await report();
    const may = r.months.find((m) => m.month === '2026-05')!;
    const june = r.months.find((m) => m.month === '2026-06')!;
    expect(may.cash).toEqual([
      {
        currency: 'USD',
        collectedMinorUnits: 9900 + 9900,
        // E's invoice has no verified amounts: tax unknown, never zero.
        taxMinorUnits: null,
        refundsMinorUnits: 2000,
        refundsOutsideProviderMinorUnits: 0,
        creditsIssuedMinorUnits: 1000,
        balanceAppliedMinorUnits: 500,
        recoveredMinorUnits: 0,
      },
    ]);
    expect(may.failedInvoices).toEqual({
      count: 0,
      amountDue: [],
      unverified: 1,
    });
    expect(june.cash).toEqual([
      expect.objectContaining({
        currency: 'EUR',
        collectedMinorUnits: 8900,
        taxMinorUnits: 0,
      }),
      expect.objectContaining({
        currency: 'USD',
        collectedMinorUnits: 9900,
        taxMinorUnits: 900,
        recoveredMinorUnits: 9900,
      }),
    ]);
    // A's (failed twice, then paid) and B's (still open): two failed invoices.
    expect(june.failedInvoices).toEqual({
      count: 2,
      amountDue: [{ currency: 'USD', minorUnits: 9900 + 99_000 }],
      unverified: 0,
    });
    expect(june.recoveredInvoices).toBe(1);
    expect(r.adjustments).toEqual([
      {
        currency: 'USD',
        kind: 'CREDIT',
        origin: 'EXTERNAL',
        count: 1,
        totalMinorUnits: 1000,
      },
      {
        currency: 'USD',
        kind: 'REFUND',
        origin: 'EXTERNAL',
        count: 1,
        totalMinorUnits: 2000,
      },
    ]);
    expect(r.dataQuality.invoicesWithoutAmounts).toBe(1);
    expect(june.complimentaryAtEnd).toBe(1);
    expect(
      r.months.find((m) => m.month === '2026-04')!.complimentaryAtEnd,
    ).toBe(0);
  });

  it('captures invoice amounts from verified provider reads, backfills through reconciliation, never clears them', async () => {
    const live = await business('live', { price: prices.proMonth });
    fake.subscriptions.set(live.sub, {
      externalSubscriptionId: live.sub,
      externalCustomerId: live.customer,
      status: 'active',
      livemode: false,
      hasPaymentMethod: true,
      paymentMethodSource: 'SUBSCRIPTION',
      cancelAtPeriodEnd: false,
      trialStart: null,
      trialEnd: null,
      latestInvoiceId: null,
      items: [],
      scheduleId: null,
      hasPendingUpdate: false,
      currentPeriodStart: d('2026-06-01T00:00:00Z'),
      currentPeriodEnd: d('2026-07-01T00:00:00Z'),
    });
    const external = `in_live_${run}`;
    fake.setInvoice(external, 'paid', live.sub, live.customer, {
      amountMinorUnits: 11_000,
    });
    fake.invoiceDetails.set(external, {
      amounts: {
        subtotalMinorUnits: 10_500,
        discountMinorUnits: 500,
        taxMinorUnits: 1000,
        totalExcludingTaxMinorUnits: 10_000,
      },
      attemptCount: 2,
    });
    // Recorded before SC3f: no amounts yet.
    const row = await prisma.billingInvoice.create({
      data: {
        subscriptionId: live.subscriptionId,
        provider: 'fake',
        externalInvoiceId: external,
        externalCustomerId: live.customer,
        externalSubscriptionId: live.sub,
        status: 'paid',
        currency: 'usd',
        totalMinorUnits: 11_000,
        amountDueMinorUnits: 11_000,
        amountPaidMinorUnits: 11_000,
        amountRemainingMinorUnits: 0,
        issuedAt: fake.invoices.get(external)!.createdAt,
        paidAt: fake.invoices.get(external)!.createdAt,
        syncedAt: d('2026-01-01T00:00:00Z'),
      },
    });
    expect(row.taxMinorUnits).toBeNull();
    await asOperator('recon', '/billing/reconcile', 'post').expect(200);
    const filled = await prisma.billingInvoice.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(filled).toMatchObject({
      subtotalMinorUnits: 10_500,
      discountMinorUnits: 500,
      taxMinorUnits: 1000,
      totalExcludingTaxMinorUnits: 10_000,
      attemptCount: 2,
    });
    // Never cleared back to unknown; never partly captured.
    await expect(
      prisma.billingInvoice.update({
        where: { id: row.id },
        data: {
          subtotalMinorUnits: null,
          discountMinorUnits: null,
          taxMinorUnits: null,
          totalExcludingTaxMinorUnits: null,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.billingInvoice.update({
        where: { id: row.id },
        data: { attemptCount: null },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.billingInvoice.update({
        where: { id: refundInvoiceId },
        data: { taxMinorUnits: 10 },
      }),
    ).rejects.toThrow();
  });

  it('reads only CENTERIVO billing data — never restaurant sales, orders, payments or gift cards', () => {
    for (const file of [
      'application/revenue-reporting.service.ts',
      'domain/revenue-metrics.ts',
      'api/platform-revenue.controller.ts',
    ]) {
      const source = readFileSync(join(__dirname, file), 'utf8');
      expect(source).not.toMatch(
        /prisma\.(order|orderItem|payment\w*|giftCard\w*|customer\w*|loyalty\w*|refund\w*)\b/i,
      );
      expect(source).not.toMatch(
        /from '\.\.\/\.\.\/(orders|payments|gift-cards|customers|checkout)\//,
      );
    }
  });
});
