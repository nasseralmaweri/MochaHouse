import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  PlatformBillingPolicy,
  PlatformPlan,
  PlatformTenantSubscriptionResponse,
} from '@mocha-house/contracts';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  type ScratchDatabase,
} from '@mocha-house/testing';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { signPlatformDevJwt } from '../platform-auth/infrastructure/platform-dev-jwt';
import { EntitlementsService } from '../subscriptions/application/entitlements.service';
import {
  BillingLifecycleError,
  BillingLifecycleService,
} from './application/billing-lifecycle.service';
import type {
  FakeEventBody,
  FakeSaasBillingProvider,
} from './provider/fake-saas-billing-provider';
import { SAAS_BILLING_PROVIDER } from './provider/saas-billing-provider';

// SC3a — the subscription-billing foundation end to end on the real
// AppModule in a SCRATCH database (billing history is append-only):
//   * Founding businesses stay COMPLIMENTARY and are never billed (E3);
//   * list prices: versioned independently, previous price archived,
//     agreed prices kept (grandfathered), configurable annual discount,
//     database immutability (E4);
//   * the billing policy: configurable, bounded, audited (E5/E6);
//   * provider events: recorded first and applied at most once under
//     duplicate, delayed and out-of-order delivery; matched ONLY through our
//     stored provider ids; metadata tenant ids cross-checked; test/live
//     separation (requirements 3 and 4);
//   * upgrades activate modules only after their payment (E8);
//   * grace expiry and trial expiry change billing state only — no charge
//     and, in SC3a, no change to the business's suspension (E5/E6/E7);
//   * nothing here touches restaurant payments.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);

describe('SC3a subscription-billing foundation (integration, scratch database)', () => {
  let scratch: ScratchDatabase;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let lifecycle: BillingLifecycleService;
  let fake: FakeSaasBillingProvider;
  let entitlements: EntitlementsService;
  const originalEnv = { ...process.env };
  const PLATFORM_SECRET = `sc3a-platform-${randomUUID()}`;
  const run = randomUUID().replace(/-/g, '').slice(0, 8);

  let planId: string;
  let v1: string; // crm
  let v2: string; // crm + loyalty
  let paymentAttemptsBefore: number;

  const operatorToken = (iat?: number) =>
    signPlatformDevJwt(
      { sub: `platform-dev:sc3a-${run}`, mfa: true, ...(iat ? { iat } : {}) },
      PLATFORM_SECRET,
      3600,
    );
  const platform = (
    method: 'get' | 'post' | 'put',
    path: string,
    body?: object,
    token: string = operatorToken(),
  ) => {
    const req = request(app.getHttpServer())
      [method](`/api/v1/platform${path}`)
      .set('Authorization', `Bearer ${token}`);
    return body ? req.send(body) : req;
  };

  // A business billed through the fake provider.
  async function billedBusiness(label: string) {
    const tenantId = randomUUID();
    await prisma.tenant.create({
      data: {
        id: tenantId,
        slug: `sc3a-${label}-${run}`,
        name: `SC3a ${label}`,
        status: 'ACTIVE',
      },
    });
    const subscription = await prisma.tenantSubscription.create({
      data: {
        subscriberTenantId: tenantId,
        planVersionId: v1,
        billingMode: 'BILLED',
        billingProvider: 'fake',
        externalSubscriptionId: `fake_sub_${label}_${run}`,
        externalCustomerId: `fake_cus_${label}_${run}`,
      },
    });
    return { tenantId, subscription };
  }

  let seq = 0;
  async function deliver(
    sub: {
      externalSubscriptionId: string | null;
      externalCustomerId: string | null;
    },
    type: string,
    data: Partial<FakeEventBody['data']> = {},
    over: Partial<FakeEventBody> = {},
  ) {
    const occurred = over.created ?? Math.floor(Date.now() / 1000) + seq++;
    const body: FakeEventBody = {
      id: `evt_${run}_${seq++}`,
      type,
      created: occurred,
      livemode: false,
      data: {
        subscription: sub.externalSubscriptionId,
        customer: sub.externalCustomerId,
        ...(type === 'invoice.paid' ? { amount: 4900, currency: 'usd' } : {}),
        ...data,
      },
      ...over,
    };
    const signed = fake.signEvent(body, new Date(occurred * 1000));
    const verified = fake.verifyEvent({
      ...signed,
      now: new Date(occurred * 1000),
    });
    return {
      body,
      signed,
      verified,
      result: await lifecycle.recordAndApply(verified),
    };
  }

  const reload = (id: string) =>
    prisma.tenantSubscription.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3a_billing',
    );
    await applyMigrations(scratch.url, listMigrations(MIGRATIONS));
    process.env.DATABASE_URL = scratch.url;
    process.env.PLATFORM_AUTH_PROVIDER = 'dev';
    process.env.PLATFORM_AUTH_DEV_JWT_SECRET = PLATFORM_SECRET;
    process.env.RATE_LIMIT_ENABLED = '0';
    process.env.SAAS_BILLING_PROVIDER = 'fake';
    process.env.SAAS_BILLING_TRIAL_CLAIM_SECRET = `sc3a-claims-${randomUUID()}`;
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    await app.init();
    prisma = app.get(PrismaService);
    lifecycle = app.get(BillingLifecycleService);
    fake = app.get(SAAS_BILLING_PROVIDER);
    entitlements = app.get(EntitlementsService, { strict: false });

    await prisma.platformOperator.create({
      data: {
        externalProvider: 'platform-dev',
        externalSubject: `platform-dev:sc3a-${run}`,
        email: `sc3a-${run}@example.test`,
        status: 'ACTIVE',
      },
    });
    const plan = await prisma.subscriptionPlan.create({
      data: { key: `growth-${run}`, name: 'Growth' },
    });
    planId = plan.id;
    const publish = async (version: number, moduleKeys: string[]) => {
      const row = await prisma.subscriptionPlanVersion.create({
        data: { planId, version, moduleKeys },
      });
      await prisma.subscriptionPlanVersion.update({
        where: { id: row.id },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });
      return row.id;
    };
    v1 = await publish(1, ['crm']);
    v2 = await publish(2, ['crm', 'loyalty']);
    paymentAttemptsBefore = await prisma.paymentAttempt.count();
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      process.env = { ...originalEnv };
      await scratch?.drop();
    }
  });

  // --- Founding compatibility (E3) -------------------------------------------

  it('Founding (Mocha House) stays COMPLIMENTARY, ACTIVE and fully entitled; it can never carry billing state', async () => {
    const sub = await prisma.tenantSubscription.findUniqueOrThrow({
      where: { subscriberTenantId: TENANT_1_MOCHA_HOUSE_ID },
    });
    expect(sub).toMatchObject({
      billingMode: 'COMPLIMENTARY',
      status: 'ACTIVE',
      billingProvider: null,
      planPriceId: null,
      recurringPaymentAuthorizedAt: null,
    });
    const view = (
      await platform(
        'get',
        `/tenants/${TENANT_1_MOCHA_HOUSE_ID}/subscription`,
      ).expect(200)
    ).body as PlatformTenantSubscriptionResponse;
    expect(view.subscription).toMatchObject({
      billingMode: 'COMPLIMENTARY',
      status: 'ACTIVE',
    });
    expect(view.modules).toHaveLength(10);

    // The database refuses billing state on a complimentary subscription.
    await expect(
      prisma.tenantSubscription.update({
        where: { id: sub.id },
        data: {
          billingProvider: 'fake',
          externalSubscriptionId: 'fake_sub_founding',
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.tenantSubscription.update({
        where: { id: sub.id },
        data: { status: 'PAST_DUE' },
      }),
    ).rejects.toThrow();
    // Billing lifecycle changes are refused for it.
    await expect(
      lifecycle.startTrial(sub.id, 'owner@example.test', null),
    ).rejects.toMatchObject({ reason: 'COMPLIMENTARY' });
  });

  // --- Prices (E4) ------------------------------------------------------------

  it('list prices: versioned, previous one archived, annual from a configurable discount, agreed prices kept', async () => {
    let plan = (
      await platform('post', `/plans/${planId}/prices`, {
        interval: 'MONTH',
        amountMinorUnits: 4900,
      }).expect(201)
    ).body as PlatformPlan;
    const monthly1 = plan.prices.find(
      (p) => p.interval === 'MONTH' && p.status === 'ACTIVE',
    )!;
    expect(monthly1.amountMinorUnits).toBe(4900);

    plan = (
      await platform('post', `/plans/${planId}/prices`, {
        interval: 'YEAR',
        annualDiscountBasisPoints: 1500,
      }).expect(201)
    ).body as PlatformPlan;
    expect(
      plan.prices.find((p) => p.interval === 'YEAR' && p.status === 'ACTIVE')
        ?.amountMinorUnits,
    ).toBe(49980);

    // A business that agreed to the first monthly price.
    const { subscription } = await billedBusiness('grandfathered');
    await prisma.tenantSubscription.update({
      where: { id: subscription.id },
      data: { planPriceId: monthly1.id },
    });

    plan = (
      await platform('post', `/plans/${planId}/prices`, {
        interval: 'MONTH',
        amountMinorUnits: 5900,
      }).expect(201)
    ).body as PlatformPlan;
    const monthly = plan.prices.filter((p) => p.interval === 'MONTH');
    expect(monthly.map((p) => [p.amountMinorUnits, p.status])).toEqual([
      [5900, 'ACTIVE'],
      [4900, 'ARCHIVED'],
    ]);
    expect(monthly[1].subscriberCount).toBe(1);
    expect((await reload(subscription.id)).planPriceId).toBe(monthly1.id);

    // Archive, and archive again (409).
    await platform(
      'post',
      `/plans/${planId}/prices/${monthly[0].id}/archive`,
    ).expect(200);
    const again = await platform(
      'post',
      `/plans/${planId}/prices/${monthly[0].id}/archive`,
    ).expect(409);
    expect(again.body).toMatchObject({ code: 'PRICE_NOT_ACTIVE' });

    // An annual discount needs an ACTIVE monthly price.
    const noMonthly = await platform('post', `/plans/${planId}/prices`, {
      interval: 'YEAR',
      annualDiscountBasisPoints: 1000,
    }).expect(409);
    expect(noMonthly.body).toMatchObject({ code: 'NO_MONTHLY_PRICE' });
    await platform('post', `/plans/${planId}/prices`, {
      interval: 'MONTH',
      amountMinorUnits: 0,
    }).expect(400);
    await platform('post', `/plans/${planId}/prices`, {
      interval: 'MONTH',
      currency: 'EUR',
      amountMinorUnits: 100,
    }).expect(400);

    // Audited against the plan.
    expect(
      await prisma.platformAuditEvent.count({
        where: {
          targetType: 'plan',
          targetId: planId,
          action: { startsWith: 'platform.plan.price_' },
        },
      }),
    ).toBe(4);
  });

  it('the database keeps prices immutable and one ACTIVE per interval', async () => {
    const price = await prisma.subscriptionPlanPrice.create({
      data: {
        planId,
        interval: 'MONTH',
        currency: 'USD',
        amountMinorUnits: 7000,
      },
    });
    await expect(
      prisma.subscriptionPlanPrice.update({
        where: { id: price.id },
        data: { amountMinorUnits: 1 },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.subscriptionPlanPrice.delete({ where: { id: price.id } }),
    ).rejects.toThrow();
    await expect(
      prisma.subscriptionPlanPrice.create({
        data: {
          planId,
          interval: 'MONTH',
          currency: 'USD',
          amountMinorUnits: 8000,
        },
      }),
    ).rejects.toThrow();
    await prisma.subscriptionPlanPrice.update({
      where: { id: price.id },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    });
    await expect(
      prisma.subscriptionPlanPrice.update({
        where: { id: price.id },
        data: { status: 'ACTIVE', archivedAt: null },
      }),
    ).rejects.toThrow();
  });

  it('price and policy changes need a recent sign-in', async () => {
    const stale = operatorToken(Math.floor(Date.now() / 1000) - 20 * 60);
    const res = await platform(
      'post',
      `/plans/${planId}/prices`,
      { interval: 'MONTH', amountMinorUnits: 100 },
      stale,
    ).expect(401);
    expect(res.body).toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' });
    await platform(
      'put',
      '/billing/policy',
      { trialDays: 7, trialRequiresPaymentMethod: true, gracePeriodDays: 7 },
      stale,
    ).expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/platform/billing/policy')
      .expect(401);
  });

  // --- Billing policy (E5/E6) --------------------------------------------------

  it('the billing policy defaults to a 14-day trial with a payment method and 14 days of grace; changes are bounded and audited', async () => {
    const initial = (await platform('get', '/billing/policy').expect(200))
      .body as PlatformBillingPolicy;
    expect(initial).toMatchObject({
      trialDays: 14,
      trialRequiresPaymentMethod: true,
      gracePeriodDays: 14,
    });

    await platform('put', '/billing/policy', {
      trialDays: 91,
      trialRequiresPaymentMethod: true,
      gracePeriodDays: 14,
    }).expect(400);
    const updated = (
      await platform('put', '/billing/policy', {
        trialDays: 10,
        trialRequiresPaymentMethod: false,
        gracePeriodDays: 7,
      }).expect(200)
    ).body as PlatformBillingPolicy;
    expect(updated).toMatchObject({
      trialDays: 10,
      trialRequiresPaymentMethod: false,
      gracePeriodDays: 7,
    });
    expect(
      await prisma.platformAuditEvent.count({
        where: { action: 'platform.billing.policy_updated' },
      }),
    ).toBe(1);
    await expect(
      prisma.billingPolicy.update({
        where: { id: 'default' },
        data: { gracePeriodDays: 0 },
      }),
    ).rejects.toThrow();
    // Restore the defaults for the tests below.
    await platform('put', '/billing/policy', {
      trialDays: 14,
      trialRequiresPaymentMethod: true,
      gracePeriodDays: 14,
    }).expect(200);
  });

  // --- Provider events (requirements 3 and 4) ----------------------------------

  it('records every delivery first and applies it once: duplicates and redeliveries change nothing', async () => {
    const { subscription } = await billedBusiness('dup');
    const first = await deliver(subscription, 'payment_method.authorized');
    expect(first.result).toMatchObject({
      status: 'APPLIED',
      duplicate: false,
      subscriptionId: subscription.id,
    });

    const redelivery = await lifecycle.recordAndApply(first.verified);
    expect(redelivery).toMatchObject({ status: 'APPLIED', duplicate: true });
    expect(
      await prisma.tenantSubscriptionEvent.count({
        where: { subscriptionId: subscription.id, type: 'PAYMENT_AUTHORIZED' },
      }),
    ).toBe(1);
    expect(
      await prisma.billingProviderEvent.count({
        where: { externalEventId: first.body.id },
      }),
    ).toBe(1);

    // The same event id with different content is never applied.
    const tampered = fake.signEvent(
      { ...first.body, data: { ...first.body.data, reference: 'other' } },
      new Date(first.body.created * 1000),
    );
    const mismatch = await lifecycle.recordAndApply(
      fake.verifyEvent({
        ...tampered,
        now: new Date(first.body.created * 1000),
      }),
    );
    expect(mismatch).toMatchObject({
      status: 'REJECTED',
      outcome: 'PAYLOAD_MISMATCH',
    });

    // A valid but no-op event (a second authorization) is recorded as IGNORED.
    const second = await deliver(subscription, 'payment_method.authorized');
    expect(second.result).toMatchObject({
      status: 'IGNORED',
      outcome: 'NO_CHANGE',
    });
  });

  it('out-of-order delivery never rolls the state back; the grace period is fixed at the first failure', async () => {
    const { subscription } = await billedBusiness('order');
    const base = Math.floor(Date.now() / 1000);
    await deliver(
      subscription,
      'payment_method.authorized',
      {},
      { created: base },
    );
    const failure = await deliver(
      subscription,
      'invoice.payment_failed',
      { reference: 'inv_1' },
      { created: base + 10 },
    );
    expect(failure.result).toMatchObject({
      status: 'APPLIED',
      outcome: 'ACTIVE->PAST_DUE',
    });
    const pastDue = await reload(subscription.id);
    expect(pastDue.graceEndsAt!.getTime() - pastDue.pastDueAt!.getTime()).toBe(
      14 * 86_400_000,
    );

    // An older success arriving late is ignored.
    const late = await deliver(
      subscription,
      'invoice.paid',
      { reference: 'inv_0' },
      { created: base + 5 },
    );
    expect(late.result).toMatchObject({ status: 'IGNORED', outcome: 'STALE' });
    expect((await reload(subscription.id)).status).toBe('PAST_DUE');

    // A later retry failure keeps the original grace.
    await deliver(
      subscription,
      'invoice.payment_failed',
      { reference: 'inv_1' },
      { created: base + 20 },
    );
    expect((await reload(subscription.id)).graceEndsAt).toEqual(
      pastDue.graceEndsAt,
    );

    // Recovery.
    const paid = await deliver(
      subscription,
      'invoice.paid',
      {
        reference: 'inv_1',
        periodStart: base + 30,
        periodEnd: base + 30 + 30 * 86400,
      },
      { created: base + 30 },
    );
    expect(paid.result).toMatchObject({
      status: 'APPLIED',
      outcome: 'PAST_DUE->ACTIVE',
    });
    expect(await reload(subscription.id)).toMatchObject({
      status: 'ACTIVE',
      pastDueAt: null,
      graceEndsAt: null,
    });
  });

  it('matches a business only through our stored provider ids; mismatched metadata, customers and modes are rejected', async () => {
    const { subscription, tenantId } = await billedBusiness('match');
    const other = await billedBusiness('other');

    const claim = await deliver(subscription, 'payment_method.authorized', {
      tenantId: other.tenantId,
    });
    expect(claim.result).toMatchObject({
      status: 'REJECTED',
      outcome: 'TENANT_CLAIM_MISMATCH',
    });
    const customer = await deliver(
      {
        externalSubscriptionId: subscription.externalSubscriptionId,
        externalCustomerId: other.subscription.externalCustomerId,
      },
      'payment_method.authorized',
    );
    expect(customer.result).toMatchObject({
      status: 'REJECTED',
      outcome: 'CUSTOMER_MISMATCH',
    });
    const unknown = await deliver(
      {
        externalSubscriptionId: `fake_sub_unknown_${run}`,
        externalCustomerId: null,
      },
      'payment_method.authorized',
      { tenantId },
    );
    // Possibly early (before our ids were stored): retryable, never final.
    expect(unknown.result).toMatchObject({
      status: 'FAILED',
      outcome: 'NO_MATCHING_SUBSCRIPTION',
    });
    const live = await deliver(
      subscription,
      'payment_method.authorized',
      {},
      { livemode: true },
    );
    expect(live.result).toMatchObject({
      status: 'REJECTED',
      outcome: 'LIVEMODE_MISMATCH',
    });
    const unsupported = await deliver(subscription, 'customer.updated');
    expect(unsupported.result).toMatchObject({
      status: 'IGNORED',
      outcome: 'UNSUPPORTED_TYPE',
    });

    // None of these changed either business.
    for (const id of [subscription.id, other.subscription.id]) {
      expect((await reload(id)).recurringPaymentAuthorizedAt).toBeNull();
    }
    // A matching claim is accepted.
    const ok = await deliver(subscription, 'payment_method.authorized', {
      tenantId,
    });
    expect(ok.result).toMatchObject({ status: 'APPLIED' });
  });

  it('the event ledger keeps identity and final outcomes immutable', async () => {
    const row = await prisma.billingProviderEvent.findFirstOrThrow({
      where: { status: 'APPLIED' },
    });
    await expect(
      prisma.billingProviderEvent.update({
        where: { id: row.id },
        data: { externalEventId: 'changed' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.billingProviderEvent.update({
        where: { id: row.id },
        data: { status: 'FAILED' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.billingProviderEvent.delete({ where: { id: row.id } }),
    ).rejects.toThrow();
  });

  // --- Plan changes (E8) --------------------------------------------------------

  it('an upgrade activates its modules only after its own payment is confirmed', async () => {
    const { subscription, tenantId } = await billedBusiness('upgrade');
    await deliver(subscription, 'payment_method.authorized');
    await deliver(subscription, 'invoice.paid', { reference: 'inv_first' });
    expect(
      [...(await entitlements.forTenant(tenantId)).modules].sort(),
    ).toEqual(['core', 'crm']);

    await lifecycle.applyInternal(
      subscription.id,
      {
        type: 'UPGRADE_REQUESTED',
        at: new Date(),
        planVersionId: v2,
        planPriceId: null,
        reference: 'inv_upgrade',
      },
      null,
    );
    // Pending: nothing gained yet, even when another invoice is paid.
    await deliver(subscription, 'invoice.paid', { reference: 'inv_other' });
    expect(
      [...(await entitlements.forTenant(tenantId)).modules].sort(),
    ).toEqual(['core', 'crm']);

    const confirmed = await deliver(subscription, 'invoice.paid', {
      reference: 'inv_upgrade',
    });
    expect(confirmed.result).toMatchObject({ status: 'APPLIED' });
    expect(
      [...(await entitlements.forTenant(tenantId)).modules].sort(),
    ).toEqual(['core', 'crm', 'loyalty']);
    expect(
      await prisma.tenantSubscriptionEvent.findMany({
        where: {
          subscriptionId: subscription.id,
          type: { in: ['PLAN_CHANGE_PENDING', 'PLAN_CHANGE_APPLIED'] },
        },
        select: { type: true, source: true, toPlanVersionId: true },
        orderBy: { createdAt: 'asc' },
      }),
    ).toEqual([
      { type: 'PLAN_CHANGE_PENDING', source: 'SYSTEM', toPlanVersionId: v2 },
      {
        type: 'PLAN_CHANGE_APPLIED',
        source: 'BILLING_PROVIDER',
        toPlanVersionId: v2,
      },
    ]);
  });

  // --- Grace, trials and cancellation (E5–E7) ------------------------------------

  it('grace expires only when over; UNPAID is a billing state — SC3a does not touch the business suspension', async () => {
    const { subscription, tenantId } = await billedBusiness('grace');
    await deliver(subscription, 'payment_method.authorized');
    await deliver(subscription, 'invoice.payment_failed', {
      reference: 'inv_g',
    });
    const pastDue = await reload(subscription.id);

    await expect(
      lifecycle.applyInternal(
        subscription.id,
        { type: 'GRACE_EXPIRED', at: new Date() },
        null,
      ),
    ).rejects.toMatchObject({ reason: 'GRACE_NOT_OVER' });
    const expired = await lifecycle.applyInternal(
      subscription.id,
      { type: 'GRACE_EXPIRED', at: pastDue.graceEndsAt! },
      null,
    );
    expect(expired).toMatchObject({
      state: { status: 'UNPAID' },
      suspension: 'SUSPEND_FOR_BILLING',
    });
    expect(
      await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
    ).toMatchObject({
      status: 'ACTIVE',
      suspensionReason: null,
    });
  });

  it('one trial per business and per owner email; a trial ending without authorization expires and charges nothing', async () => {
    await platform('put', '/billing/policy', {
      trialDays: 14,
      trialRequiresPaymentMethod: false,
      gracePeriodDays: 14,
    }).expect(200);
    const first = await billedBusiness('trial');
    const owner = `Owner.${run}@Example.test`;
    const state = await lifecycle.startTrial(
      first.subscription.id,
      owner,
      null,
    );
    expect(state).toMatchObject({
      status: 'TRIALING',
      trialRequiresPaymentMethod: false,
    });
    await expect(
      lifecycle.startTrial(first.subscription.id, owner, null),
    ).rejects.toBeInstanceOf(BillingLifecycleError);

    // The same owner (any letter case) cannot claim a second trial elsewhere.
    const second = await billedBusiness('trial2');
    await expect(
      lifecycle.startTrial(second.subscription.id, owner.toLowerCase(), null),
    ).rejects.toMatchObject({ reason: 'TRIAL_ALREADY_USED' });
    expect((await reload(second.subscription.id)).status).toBe('ACTIVE');

    const callsBefore = fake.calls.length;
    const ended = await deliver(first.subscription, 'subscription.trial_ended');
    expect(ended.result).toMatchObject({
      status: 'APPLIED',
      outcome: 'TRIALING->TRIAL_EXPIRED',
    });
    expect(fake.calls.length).toBe(callsBefore);
    await platform('put', '/billing/policy', {
      trialDays: 14,
      trialRequiresPaymentMethod: true,
      gracePeriodDays: 14,
    }).expect(200);

    // Trials that need a payment method do not start without one.
    const third = await billedBusiness('trial3');
    await expect(
      lifecycle.startTrial(
        third.subscription.id,
        `third-${run}@example.test`,
        null,
      ),
    ).rejects.toMatchObject({ reason: 'NOT_AUTHORIZED' });
  });

  it('cancellation takes effect at the period end as a billing state; the business, its owner and history stay', async () => {
    const { subscription, tenantId } = await billedBusiness('cancel');
    await deliver(subscription, 'payment_method.authorized');
    await deliver(subscription, 'subscription.cancel_scheduled');
    expect(await reload(subscription.id)).toMatchObject({
      status: 'ACTIVE',
      cancelAtPeriodEnd: true,
    });
    const ended = await deliver(subscription, 'subscription.ended');
    expect(ended.result).toMatchObject({
      status: 'APPLIED',
      outcome: 'ACTIVE->CANCELED',
    });
    expect(await reload(subscription.id)).toMatchObject({
      status: 'CANCELED',
      cancelAtPeriodEnd: false,
    });
    expect(
      await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
    ).toMatchObject({
      status: 'ACTIVE',
      suspensionReason: null,
    });
    expect(
      await prisma.tenantSubscriptionEvent.count({
        where: { subscriptionId: subscription.id },
      }),
    ).toBeGreaterThanOrEqual(3);
  });

  it('order-dependent refusals stay retryable; a late authorization is never dropped as stale', async () => {
    const { subscription } = await billedBusiness('retry');
    const base = Math.floor(Date.now() / 1000);
    // The undo arrives before the schedule it undoes.
    const undo = await deliver(
      subscription,
      'subscription.cancel_undone',
      {},
      { created: base + 20 },
    );
    expect(undo.result).toMatchObject({
      status: 'FAILED',
      outcome: 'NOTHING_TO_CANCEL',
    });
    await deliver(
      subscription,
      'subscription.cancel_scheduled',
      {},
      { created: base + 10 },
    );
    expect((await reload(subscription.id)).cancelAtPeriodEnd).toBe(true);
    // Redelivered, the undo now applies.
    const again = await lifecycle.recordAndApply(undo.verified);
    expect(again).toMatchObject({ status: 'APPLIED' });
    expect((await reload(subscription.id)).cancelAtPeriodEnd).toBe(false);

    // An authorization older than the newest applied event still counts.
    const late = await deliver(
      subscription,
      'payment_method.authorized',
      {},
      { created: base + 1 },
    );
    expect(late.result).toMatchObject({ status: 'APPLIED' });
    expect(
      (await reload(subscription.id)).recurringPaymentAuthorizedAt,
    ).not.toBeNull();
  });

  it('a $0 payment never activates or recovers a subscription', async () => {
    const { subscription } = await billedBusiness('zero');
    await deliver(subscription, 'payment_method.authorized');
    await deliver(subscription, 'invoice.payment_failed', {
      reference: 'inv_z',
    });
    const zero = await deliver(subscription, 'invoice.paid', {
      reference: 'inv_z0',
      amount: 0,
    });
    expect(zero.result).toMatchObject({
      status: 'IGNORED',
      outcome: 'NO_CHANGE',
    });
    expect((await reload(subscription.id)).status).toBe('PAST_DUE');
  });

  it('a BILLED subscription is never changed directly by the plan or add-on operations', async () => {
    const { tenantId } = await billedBusiness('direct');
    for (const [method, path, body] of [
      ['put', `/tenants/${tenantId}/subscription`, { planVersionId: v2 }],
      [
        'post',
        `/tenants/${tenantId}/subscription/add-ons`,
        { moduleKey: 'marketing' },
      ],
    ] as const) {
      const res = await platform(method, path, body).expect(409);
      expect(res.body).toMatchObject({ code: 'SUBSCRIPTION_BILLED' });
    }
    expect(
      [...(await entitlements.forTenant(tenantId)).modules].sort(),
    ).toEqual(['core', 'crm']);
  });

  it('a trial cannot start without the trial-claim secret configured', async () => {
    const { subscription } = await billedBusiness('nosecret');
    const secret = process.env.SAAS_BILLING_TRIAL_CLAIM_SECRET;
    delete process.env.SAAS_BILLING_TRIAL_CLAIM_SECRET;
    try {
      await platform('put', '/billing/policy', {
        trialDays: 14,
        trialRequiresPaymentMethod: false,
        gracePeriodDays: 14,
      }).expect(200);
      await expect(
        lifecycle.startTrial(subscription.id, `x-${run}@example.test`, null),
      ).rejects.toMatchObject({
        reason: 'TRIALS_UNAVAILABLE',
      });
      expect(
        await prisma.billingTrialClaim.count({
          where: { subscriptionId: subscription.id },
        }),
      ).toBe(0);
    } finally {
      process.env.SAAS_BILLING_TRIAL_CLAIM_SECRET = secret;
      await platform('put', '/billing/policy', {
        trialDays: 14,
        trialRequiresPaymentMethod: true,
        gracePeriodDays: 14,
      }).expect(200);
    }
  });

  it('never touched restaurant payments', async () => {
    expect(await prisma.paymentAttempt.count()).toBe(paymentAttemptsBefore);
  });
});
