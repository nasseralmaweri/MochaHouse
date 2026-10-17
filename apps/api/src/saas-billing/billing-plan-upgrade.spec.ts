import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  AdminBillingResponse,
  AdminPlanOptionsResponse,
  BillingPlanChangeConfirmResponse,
  BillingPlanChangePreview,
  InternalMeResponse,
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
import { BillingPlanChangeService } from './application/billing-plan-change.service';
import { PlanChangeMaintenanceService } from './application/plan-change-maintenance.service';
import type {
  FakeEventBody,
  FakeSaasBillingProvider,
} from './provider/fake-saas-billing-provider';
import { SAAS_BILLING_PROVIDER } from './provider/saas-billing-provider';

// SC3d-2 — paid upgrades and monthly -> annual, end to end on the real
// AppModule (fake provider) in a SCRATCH database:
//   * only the business's billing.manage user confirms (operators preview,
//     with a recent sign-in and a reason, never charge);
//   * everything is re-checked and the charge must equal the preview exactly;
//   * one open change, the provider's "apply only if paid" update with the
//     change's own idempotency key; new features only once paid AND the new
//     price is verified;
//   * a failed attempt (declined card, 3-D Secure) keeps the change waiting —
//     never a delinquency; paying later applies it; the provider's expiry
//     abandons it; money collected after we closed it is reviewed;
//   * a different paid amount is applied and reviewed (never "refunded");
//   * the sweep expires previews, re-sends an interrupted submission with
//     the SAME request inside the idempotency window, and only inspects
//     after it.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const DAY = 24 * 60 * 60 * 1000;

jest.setTimeout(180_000);

describe('SC3d-2 paid upgrades (integration, scratch database)', () => {
  let scratch: ScratchDatabase;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let lifecycle: BillingLifecycleService;
  let planChanges: BillingPlanChangeService;
  let maintenance: PlanChangeMaintenanceService;
  let fake: FakeSaasBillingProvider;
  const originalEnv = { ...process.env };
  const PLATFORM_SECRET = `sc3d2-platform-${randomUUID()}`;
  const INTERNAL_SECRET = `sc3d2-internal-${randomUUID()}`;
  const run = randomUUID().replace(/-/g, '').slice(0, 8);
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
        sub: `internal-dev:sc3d2-${key}-${run}`,
        email: `sc3d2-${key}-${run}@example.com`,
        name: null,
        email_verified: true,
      },
      INTERNAL_SECRET,
      3600,
    );
  const asStaff = (
    method: 'get' | 'post',
    key: string,
    tenantId: string,
    path: string,
    body?: unknown,
  ) => {
    const req = request(app.getHttpServer())
      [method](`/api/v1/admin/billing${path}`)
      .set('Authorization', `Bearer ${staffToken(key)}`)
      .set('X-Tenant-Id', tenantId);
    return body !== undefined ? req.send(body as object) : req;
  };
  const operator = (path: string, body: unknown, signedInSecondsAgo = 0) =>
    request(app.getHttpServer())
      .post(`/api/v1/platform${path}`)
      .set(
        'Authorization',
        `Bearer ${signPlatformDevJwt(
          {
            sub: `platform-dev:sc3d2-${run}`,
            mfa: true,
            iat: Math.floor(Date.now() / 1000) - signedInSecondsAgo,
          },
          PLATFORM_SECRET,
          3600,
        )}`,
      )
      .send(body as object);
  const codeOf = (response: { body: unknown }) =>
    (response.body as { code: string }).code;

  interface Business {
    key: string;
    tenantId: string;
    subscriptionId: string;
    customer: string;
    sub: string;
    ownerId: string;
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
        externalSubject: `internal-dev:sc3d2-${key}-${run}`,
        email: `sc3d2-${key}-${run}@example.com`,
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

  async function business(label: string, priceKey: string): Promise<Business> {
    const tenantId = randomUUID();
    await prisma.tenant.create({
      data: {
        id: tenantId,
        slug: `sc3d2-${label}-${run}`,
        name: `SC3d2 ${label}`,
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
      },
    });
    fake.subscriptions.set(sub, {
      externalSubscriptionId: sub,
      externalCustomerId: customer,
      status: 'active',
      livemode: false,
      hasPaymentMethod: true,
      paymentMethodSource: 'SUBSCRIPTION',
      cancelAtPeriodEnd: false,
      trialStart: null,
      trialEnd: null,
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
      currentPeriodStart: new Date(Date.now() - 10 * DAY),
      currentPeriodEnd: new Date(Date.now() + 20 * DAY),
    });
    const ownerId = await staff(
      tenantId,
      label,
      MANAGE,
      'platform-administrator',
    );
    return {
      key: label,
      tenantId,
      subscriptionId: subscription.id,
      customer,
      sub,
      ownerId,
    };
  }

  const previewFor = async (b: Business, priceKey: string) =>
    (
      await asStaff('post', b.key, b.tenantId, '/plan-change/preview', {
        planPriceId: prices[priceKey].id,
      }).expect(200)
    ).body as BillingPlanChangePreview;
  const confirm = (b: Business, previewId: string, key = b.key) =>
    asStaff('post', key, b.tenantId, '/plan-change/confirm', { previewId });
  const subscriptionOf = (b: Business) =>
    prisma.tenantSubscription.findUniqueOrThrow({
      where: { id: b.subscriptionId },
    });
  const changeOf = (id: string) =>
    prisma.billingPlanChange.findUniqueOrThrow({ where: { id } });
  const historyOf = async (b: Business) =>
    (
      await prisma.tenantSubscriptionEvent.findMany({
        where: { subscriptionId: b.subscriptionId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { type: true },
      })
    ).map((e) => e.type);
  const casesOf = async (b: Business) =>
    (
      await prisma.billingReconciliationCase.findMany({
        where: { subscriptionId: b.subscriptionId, status: 'OPEN' },
        select: { kind: true, detail: true },
      })
    ).map((c) => c);
  const chargesFor = (key: string) =>
    fake.calls.filter((c) => c.op === 'changePriceNow' && c.key === key).length;

  let seq = 0;
  async function deliver(
    b: Business,
    type: string,
    data: Partial<FakeEventBody['data']> = {},
  ) {
    const occurred = Math.floor(Date.now() / 1000) + seq++;
    const body: FakeEventBody = {
      id: `evt_${run}_${seq++}`,
      type,
      created: occurred,
      livemode: false,
      data: { subscription: b.sub, customer: b.customer, ...data },
    };
    const signed = fake.signEvent(body, new Date(occurred * 1000));
    return lifecycle.recordAndApply(
      fake.verifyEvent({ ...signed, now: new Date(occurred * 1000) }),
    );
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3d2_upgrade',
    );
    await applyMigrations(scratch.url, listMigrations(MIGRATIONS));
    process.env.DATABASE_URL = scratch.url;
    process.env.PLATFORM_AUTH_PROVIDER = 'dev';
    process.env.PLATFORM_AUTH_DEV_JWT_SECRET = PLATFORM_SECRET;
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = INTERNAL_SECRET;
    process.env.RATE_LIMIT_ENABLED = '0';
    process.env.SAAS_BILLING_PROVIDER = 'fake';
    process.env.SAAS_BILLING_TRIAL_CLAIM_SECRET = `sc3d2-claims-${randomUUID()}`;
    process.env.PLAN_CHANGE_SWEEP_DISABLED = '1';
    delete process.env.BILLING_ENFORCEMENT_ENABLED;
    delete process.env.BILLING_NOTIFICATIONS_ENABLED;
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    await app.init();
    prisma = app.get(PrismaService);
    lifecycle = app.get(BillingLifecycleService);
    planChanges = app.get(BillingPlanChangeService);
    maintenance = app.get(PlanChangeMaintenanceService);
    fake = app.get(SAAS_BILLING_PROVIDER);

    await prisma.platformOperator.create({
      data: {
        externalProvider: 'platform-dev',
        externalSubject: `platform-dev:sc3d2-${run}`,
        email: `sc3d2-${run}@example.test`,
        status: 'ACTIVE',
      },
    });
    const plans: Record<string, string> = {};
    for (const key of ['growth', 'pro']) {
      const plan = await prisma.subscriptionPlan.create({
        data: {
          key: `${key}-${run}`,
          name: key === 'growth' ? 'Growth' : 'Pro',
        },
      });
      const version = await prisma.subscriptionPlanVersion.create({
        data: {
          planId: plan.id,
          version: 1,
          moduleKeys: key === 'pro' ? ['crm', 'marketing'] : ['crm'],
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
    ) => {
      const row = await prisma.subscriptionPlanPrice.create({
        data: {
          planId: plans[plan],
          interval,
          currency: 'USD',
          amountMinorUnits,
        },
      });
      const ext = `fake_price_${key}_${run}`;
      await prisma.subscriptionPlanPrice.update({
        where: { id: row.id },
        data: { externalPriceId: ext },
      });
      fake.priceCatalog.set(ext, {
        amountMinorUnits,
        currency: 'usd',
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
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      process.env = { ...originalEnv };
      await scratch?.drop();
    }
  });

  it('the business confirms an upgrade: charged once, exactly the preview, applied only when paid and verified', async () => {
    const b = await business('upgrade', 'growthMonthly');
    const view = (await asStaff('get', b.key, b.tenantId, '').expect(200))
      .body as AdminBillingResponse;
    expect(view).toMatchObject({ canChangePlan: true, planChange: null });
    const options = (
      await asStaff('get', b.key, b.tenantId, '/plan-options').expect(200)
    ).body as AdminPlanOptionsResponse;
    expect(options.options.find((o) => o.current)?.planPriceId).toBe(
      prices.growthMonthly.id,
    );

    const preview = await previewFor(b, 'proMonthly');
    const confirmed = (await confirm(b, preview.previewId).expect(200))
      .body as BillingPlanChangeConfirmResponse;
    expect(confirmed.planChange).toMatchObject({
      id: preview.previewId,
      status: 'APPLIED',
      amountDueMinorUnits: 3333,
    });
    const key = `centerivo-plan-change-${preview.previewId}-change-now`;
    expect(chargesFor(key)).toBe(1);
    expect(await subscriptionOf(b)).toMatchObject({
      planPriceId: prices.proMonthly.id,
      planVersionId: prices.proMonthly.planVersionId,
      status: 'ACTIVE',
      pendingChangeKind: null,
    });
    expect(await changeOf(preview.previewId)).toMatchObject({
      status: 'APPLIED',
      amountPaidMinorUnits: 3333,
    });
    expect(await historyOf(b)).toEqual([
      'PLAN_CHANGE_PENDING',
      'PLAN_CHANGE_APPLIED',
    ]);
    expect(
      await prisma.internalAuditEvent.count({
        where: {
          tenantId: b.tenantId,
          action: 'billing.plan_change_confirmed',
        },
      }),
    ).toBe(1);
    const me = (
      await request(app.getHttpServer())
        .get('/api/v1/internal/me')
        .set('Authorization', `Bearer ${staffToken(b.key)}`)
        .set('X-Tenant-Id', b.tenantId)
        .expect(200)
    ).body as InternalMeResponse;
    expect(me.entitlements.modules).toContain('marketing');
    expect(await casesOf(b)).toEqual([]);

    // The same preview again: refused; nothing charged twice.
    expect(codeOf(await confirm(b, preview.previewId).expect(409))).toBe(
      'BILLING_PLAN_CHANGE_PREVIEW_EXPIRED',
    );
    expect(chargesFor(key)).toBe(1);
  });

  it('two confirmations at once charge once', async () => {
    const b = await business('race', 'growthMonthly');
    const preview = await previewFor(b, 'proMonthly');
    const results = await Promise.all([
      confirm(b, preview.previewId),
      confirm(b, preview.previewId),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      chargesFor(`centerivo-plan-change-${preview.previewId}-change-now`),
    ).toBe(1);
  });

  it('re-checks everything before charging: a changed charge, a changed plan, an expired preview, another business, view-only staff', async () => {
    const b = await business('recheck', 'growthMonthly');
    let preview = await previewFor(b, 'proMonthly');
    fake.previewAdjust = { taxMinorUnits: 1 };
    expect(codeOf(await confirm(b, preview.previewId).expect(409))).toBe(
      'BILLING_PLAN_CHANGE_PREVIEW_CHANGED',
    );
    fake.previewAdjust = { amountDueMinorUnits: 3334 };
    expect(codeOf(await confirm(b, preview.previewId).expect(409))).toBe(
      'BILLING_PLAN_CHANGE_PREVIEW_CHANGED',
    );
    // Expired (the service's clock 11 minutes later).
    await expect(
      planChanges.confirm(
        b.tenantId,
        preview.previewId,
        b.ownerId,
        new Date(Date.now() + 11 * 60 * 1000),
      ),
    ).rejects.toMatchObject({
      response: { code: 'BILLING_PLAN_CHANGE_PREVIEW_EXPIRED' },
    });
    // The provider bills something else now.
    preview = await previewFor(b, 'proMonthly');
    fake.setSubscription(b.sub, {
      items: [
        {
          externalItemId: 'fake_si_other',
          externalPriceId: prices.growthYearly.ext,
          quantity: 1,
        },
      ],
    });
    expect(codeOf(await confirm(b, preview.previewId).expect(409))).toBe(
      'BILLING_PLAN_CHANGE_UNVERIFIED',
    );
    fake.setSubscription(b.sub, {
      items: [
        {
          externalItemId: `fake_si_recheck_${run}`,
          externalPriceId: prices.growthMonthly.ext,
          quantity: 1,
        },
      ],
    });
    // Another business's preview id from this business: not found.
    const other = await business('recheck-other', 'growthMonthly');
    const theirs = await previewFor(other, 'proMonthly');
    await confirm(b, theirs.previewId).expect(404);
    // View-only staff cannot confirm.
    await staff(b.tenantId, 'recheck-viewer', ['billing.view'], 'viewer');
    await confirm(b, preview.previewId, 'recheck-viewer').expect(403);
    // Only our preview id, exactly.
    await asStaff('post', b.key, b.tenantId, '/plan-change/confirm', {
      previewId: preview.previewId,
      amount: 1,
    }).expect(400);
    expect(
      fake.calls.filter(
        (c) => c.op === 'changePriceNow' && c.key.includes(preview.previewId),
      ),
    ).toEqual([]);
    expect((await subscriptionOf(b)).planPriceId).toBe(prices.growthMonthly.id);
  });

  it('a failed payment (declined card or 3-D Secure) keeps the change waiting — never a delinquency — and paying later applies it', async () => {
    const b = await business('declined', 'growthMonthly');
    const preview = await previewFor(b, 'proMonthly');
    fake.failNextChangePayment = true;
    const confirmed = (await confirm(b, preview.previewId).expect(200))
      .body as BillingPlanChangeConfirmResponse;
    expect(confirmed.planChange.status).toBe('PAYMENT_NEEDED');
    const change = await changeOf(preview.previewId);
    expect(change.status).toBe('AWAITING_PAYMENT');
    expect(await subscriptionOf(b)).toMatchObject({
      planPriceId: prices.growthMonthly.id,
      status: 'ACTIVE',
      pendingChangeKind: 'UPGRADE',
      pendingChangeReference: change.externalInvoiceId,
      pastDueAt: null,
    });
    // The provider reports the failed attempt: ignored (still waiting).
    const failed = await deliver(b, 'invoice.payment_failed', {
      reference: change.externalInvoiceId!,
    });
    expect(failed.outcome).toBe('PLAN_CHANGE_PAYMENT_PENDING');
    expect(await subscriptionOf(b)).toMatchObject({
      status: 'ACTIVE',
      pastDueAt: null,
      pendingChangeKind: 'UPGRADE',
    });
    expect(await changeOf(preview.previewId)).toMatchObject({
      status: 'AWAITING_PAYMENT',
    });

    // The page offers the provider's own invoice page.
    const view = (await asStaff('get', b.key, b.tenantId, '').expect(200))
      .body as AdminBillingResponse;
    expect(view).toMatchObject({
      canChangePlan: false,
      planChange: { status: 'PAYMENT_NEEDED' },
    });
    const pay = (
      await asStaff('post', b.key, b.tenantId, '/plan-change/pay').expect(200)
    ).body as { url: string };
    expect(pay.url).toBe(
      `https://invoice.fake.test/i/${change.externalInvoiceId}`,
    );
    // A second change is refused meanwhile.
    expect(
      codeOf(
        await asStaff('post', b.key, b.tenantId, '/plan-change/preview', {
          planPriceId: prices.growthYearly.id,
        }).expect(409),
      ),
    ).toBe('BILLING_PLAN_CHANGE_IN_PROGRESS');

    // Paid (e.g. after 3-D Secure): the provider applies it; the webhook
    // settles it.
    fake.payPendingChange(b.sub);
    await deliver(b, 'invoice.paid', {
      reference: change.externalInvoiceId!,
      amount: 3333,
      currency: 'usd',
    });
    expect(await changeOf(preview.previewId)).toMatchObject({
      status: 'APPLIED',
      amountPaidMinorUnits: 3333,
    });
    expect(await subscriptionOf(b)).toMatchObject({
      planPriceId: prices.proMonthly.id,
      pendingChangeKind: null,
      pastDueAt: null,
    });
    expect(await historyOf(b)).toEqual([
      'PLAN_CHANGE_PENDING',
      'PLAN_CHANGE_APPLIED',
    ]);
  });

  it("the provider's pending update applied (subscription event) settles it too", async () => {
    const b = await business('applied-event', 'growthMonthly');
    const preview = await previewFor(b, 'proMonthly');
    fake.failNextChangePayment = true;
    await confirm(b, preview.previewId).expect(200);
    fake.payPendingChange(b.sub);
    await deliver(b, 'subscription.changed');
    expect(await changeOf(preview.previewId)).toMatchObject({
      status: 'APPLIED',
    });
    expect((await subscriptionOf(b)).planPriceId).toBe(prices.proMonthly.id);
  });

  it('only the provider discarding the change abandons it; money collected afterwards is reviewed, never adopted', async () => {
    const b = await business('expired', 'growthMonthly');
    const preview = await previewFor(b, 'proMonthly');
    fake.failNextChangePayment = true;
    await confirm(b, preview.previewId).expect(200);
    const invoiceId = (await changeOf(preview.previewId)).externalInvoiceId!;
    // The sweep before expiry: still waiting.
    await maintenance.sweep();
    expect(await changeOf(preview.previewId)).toMatchObject({
      status: 'AWAITING_PAYMENT',
    });
    fake.expirePendingChange(b.sub);
    await deliver(b, 'subscription.changed');
    expect(await changeOf(preview.previewId)).toMatchObject({
      status: 'EXPIRED',
      failureCode: 'PAYMENT_NOT_COMPLETED',
    });
    expect(await subscriptionOf(b)).toMatchObject({
      planPriceId: prices.growthMonthly.id,
      pendingChangeKind: null,
      status: 'ACTIVE',
      pastDueAt: null,
    });
    expect(await historyOf(b)).toEqual([
      'PLAN_CHANGE_PENDING',
      'PLAN_CHANGE_ABANDONED',
    ]);
    await asStaff('post', b.key, b.tenantId, '/plan-change/pay').expect(409);

    // Somehow paid afterwards: reviewed with the references, not adopted.
    fake.setInvoice(invoiceId, 'paid', b.sub, b.customer, {
      amountMinorUnits: 3333,
      billingReason: 'subscription_update',
    });
    await deliver(b, 'invoice.paid', {
      reference: invoiceId,
      amount: 3333,
      currency: 'usd',
    });
    const cases = await casesOf(b);
    expect(cases.map((c) => c.kind)).toEqual(['UPGRADE_PAID_NOT_APPLIED']);
    expect(cases[0].detail).toContain(invoiceId);
    expect((await subscriptionOf(b)).planPriceId).toBe(prices.growthMonthly.id);
  });

  it('a different paid amount: applied (the money was collected) and reviewed with both amounts — never presented as refunded', async () => {
    const b = await business('mismatch', 'growthMonthly');
    const preview = await previewFor(b, 'proMonthly');
    fake.paidAdjust = 3000;
    await confirm(b, preview.previewId).expect(200);
    expect(await changeOf(preview.previewId)).toMatchObject({
      status: 'APPLIED',
      amountPaidMinorUnits: 3000,
    });
    expect((await subscriptionOf(b)).planPriceId).toBe(prices.proMonthly.id);
    const [mismatch] = await casesOf(b);
    expect(mismatch.kind).toBe('PLAN_CHANGE_AMOUNT_MISMATCH');
    expect(mismatch.detail).toContain('expected 3333 USD');
    expect(mismatch.detail).toContain('paid 3000 USD');
    expect(mismatch.detail).toContain('Nothing was refunded');
  });

  it('monthly -> annual: paid now, a new annual period starts', async () => {
    const b = await business('annual', 'growthMonthly');
    const preview = await previewFor(b, 'growthYearly');
    expect(preview.timing).toBe('IMMEDIATE');
    const confirmed = (await confirm(b, preview.previewId).expect(200))
      .body as BillingPlanChangeConfirmResponse;
    expect(confirmed.planChange.status).toBe('APPLIED');
    const after = await subscriptionOf(b);
    expect(after.planPriceId).toBe(prices.growthYearly.id);
    expect(after.planVersionId).toBe(prices.growthYearly.planVersionId);
    expect(after.currentPeriodEnd!.getTime()).toBeGreaterThan(
      Date.now() + 360 * DAY,
    );
  });

  it('an interrupted submission is re-sent with the SAME request inside the idempotency window; after it, only inspected', async () => {
    const b = await business('interrupted', 'growthMonthly');
    const preview = await previewFor(b, 'proMonthly');
    fake.failOp = { op: 'changePriceNow', code: 'api_connection_error' };
    const confirmed = (await confirm(b, preview.previewId).expect(200))
      .body as BillingPlanChangeConfirmResponse;
    expect(confirmed.planChange.status).toBe('PROCESSING');
    expect((await subscriptionOf(b)).planPriceId).toBe(prices.growthMonthly.id);
    await maintenance.sweep(new Date(Date.now() + 3 * 60 * 1000));
    expect(await changeOf(preview.previewId)).toMatchObject({
      status: 'APPLIED',
    });
    // Two attempts, ONE operation (the same idempotency key).
    expect(
      chargesFor(`centerivo-plan-change-${preview.previewId}-change-now`),
    ).toBe(2);

    // Past the window: never re-sent; the provider shows nothing happened.
    const late = await business('late', 'growthMonthly');
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const latePreview = await planChanges.preview(
      late.tenantId,
      prices.proMonthly.id,
      {
        kind: 'STAFF',
        internalUserId: late.ownerId,
      },
      old,
    );
    fake.failOp = { op: 'changePriceNow', code: 'api_connection_error' };
    await planChanges.confirm(
      late.tenantId,
      latePreview.previewId,
      late.ownerId,
      new Date(old.getTime() + 60_000),
    );
    const before = chargesFor(
      `centerivo-plan-change-${latePreview.previewId}-change-now`,
    );
    await maintenance.sweep();
    expect(
      chargesFor(`centerivo-plan-change-${latePreview.previewId}-change-now`),
    ).toBe(before);
    expect(await changeOf(latePreview.previewId)).toMatchObject({
      status: 'FAILED',
      failureCode: 'NOT_SUBMITTED',
    });
  });

  it('a late replay is re-checked: a moved price ends the change without a second request; past 30 minutes it is never re-sent', async () => {
    const b = await business('moved', 'growthMonthly');
    const preview = await previewFor(b, 'proMonthly');
    fake.failOp = { op: 'changePriceNow', code: 'api_connection_error' };
    await confirm(b, preview.previewId).expect(200);
    const key = `centerivo-plan-change-${preview.previewId}-change-now`;
    expect(chargesFor(key)).toBe(1);
    fake.previewAdjust = { amountDueMinorUnits: 4000 };
    await maintenance.sweep(new Date(Date.now() + 3 * 60 * 1000));
    expect(chargesFor(key)).toBe(1);
    expect(await changeOf(preview.previewId)).toMatchObject({
      status: 'FAILED',
      failureCode: 'PREVIEW_CHANGED',
    });
    expect((await subscriptionOf(b)).planPriceId).toBe(prices.growthMonthly.id);

    const slow = await business('slow', 'growthMonthly');
    const slowPreview = await previewFor(slow, 'proMonthly');
    fake.failOp = { op: 'changePriceNow', code: 'api_connection_error' };
    await confirm(slow, slowPreview.previewId).expect(200);
    await maintenance.sweep(new Date(Date.now() + 31 * 60 * 1000));
    expect(
      chargesFor(`centerivo-plan-change-${slowPreview.previewId}-change-now`),
    ).toBe(1);
    expect(await changeOf(slowPreview.previewId)).toMatchObject({
      status: 'FAILED',
      failureCode: 'NOT_SUBMITTED',
    });
  });

  it('an upgrade invoice failing with no matching change is never a delinquency (reviewed instead)', async () => {
    const b = await business('unlinked', 'growthMonthly');
    const invoice = `in_unlinked_${run}`;
    fake.setInvoice(invoice, 'open', b.sub, b.customer, {
      billingReason: 'subscription_update',
    });
    const outcome = await deliver(b, 'invoice.payment_failed', {
      reference: invoice,
    });
    expect(outcome).toMatchObject({
      status: 'IGNORED',
      outcome: 'PLAN_CHANGE_INVOICE_UNLINKED',
    });
    expect(await subscriptionOf(b)).toMatchObject({
      status: 'ACTIVE',
      pastDueAt: null,
      graceEndsAt: null,
    });
    expect((await casesOf(b)).map((c) => c.kind)).toEqual([
      'PLAN_CHANGE_UNCERTAIN',
    ]);
  });

  it('the provider dropping the change while its invoice stays open is reviewed, and its payment is no longer offered', async () => {
    const b = await business('dropped', 'growthMonthly');
    const preview = await previewFor(b, 'proMonthly');
    fake.failNextChangePayment = true;
    await confirm(b, preview.previewId).expect(200);
    fake.setSubscription(b.sub, { hasPendingUpdate: false });
    await maintenance.sweep();
    expect(await changeOf(preview.previewId)).toMatchObject({
      status: 'REVIEW',
    });
    expect((await casesOf(b)).map((c) => c.kind)).toContain(
      'PLAN_CHANGE_UNCERTAIN',
    );
    await asStaff('post', b.key, b.tenantId, '/plan-change/pay').expect(409);
    // Paid anyway, later: flagged on its own case.
    const invoiceId = (await changeOf(preview.previewId)).externalInvoiceId!;
    fake.payPendingChange(b.sub);
    await deliver(b, 'invoice.paid', {
      reference: invoiceId,
      amount: 3333,
      currency: 'usd',
    });
    expect((await casesOf(b)).map((c) => c.kind)).toContain(
      'UPGRADE_PAID_NOT_APPLIED',
    );
  });

  it('the sweep expires abandoned previews', async () => {
    const b = await business('stale', 'growthMonthly');
    const preview = await previewFor(b, 'proMonthly');
    await maintenance.sweep(new Date(Date.now() + 11 * 60 * 1000));
    expect(await changeOf(preview.previewId)).toMatchObject({
      status: 'EXPIRED',
    });
    expect(codeOf(await confirm(b, preview.previewId).expect(409))).toBe(
      'BILLING_PLAN_CHANGE_PREVIEW_EXPIRED',
    );
  });

  it('a plan change invoice seen before its change recorded it is retried, never treated as an ordinary payment', async () => {
    const b = await business('early', 'growthMonthly');
    const preview = await previewFor(b, 'proMonthly');
    await prisma.billingPlanChange.update({
      where: { id: preview.previewId },
      data: { status: 'REQUESTED', confirmedAt: new Date() },
    });
    fake.setInvoice(`in_early_${run}`, 'paid', b.sub, b.customer, {
      amountMinorUnits: 3333,
      billingReason: 'subscription_update',
    });
    const outcome = await deliver(b, 'invoice.paid', {
      reference: `in_early_${run}`,
      amount: 3333,
      currency: 'usd',
    });
    expect(outcome).toMatchObject({
      status: 'FAILED',
      outcome: 'PLAN_CHANGE_NOT_RECORDED_YET',
    });
    expect(await historyOf(b)).toEqual([]);
  });

  it('operators prepare previews with a recent sign-in and a reason, and can never confirm a charge', async () => {
    const b = await business('operator', 'growthMonthly');
    const path = `/tenants/${b.tenantId}/billing/plan-change/preview`;
    await operator(path, { planPriceId: prices.proMonthly.id }).expect(400);
    await operator(path, {
      planPriceId: prices.proMonthly.id,
      reason: 'short',
    }).expect(400);
    expect(
      codeOf(
        await operator(
          path,
          {
            planPriceId: prices.proMonthly.id,
            reason: 'Owner asked by phone for Pro.',
          },
          3600,
        ).expect(401),
      ),
    ).toBe('REAUTHENTICATION_REQUIRED');
    const prepared = (
      await operator(path, {
        planPriceId: prices.proMonthly.id,
        reason: '  Owner asked by phone for Pro.  ',
      }).expect(200)
    ).body as BillingPlanChangePreview;
    expect(await changeOf(prepared.previewId)).toMatchObject({
      actorKind: 'OPERATOR',
      operatorReason: 'Owner asked by phone for Pro.',
      status: 'PREVIEWED',
    });
    // There is no operator confirmation route.
    await operator(`/tenants/${b.tenantId}/billing/plan-change/confirm`, {
      previewId: prepared.previewId,
    }).expect(404);
    expect(
      fake.calls.filter(
        (c) => c.op === 'changePriceNow' && c.key.includes(prepared.previewId),
      ),
    ).toEqual([]);
    // The business itself may confirm what was prepared for it.
    await confirm(b, prepared.previewId).expect(200);
    expect(await changeOf(prepared.previewId)).toMatchObject({
      status: 'APPLIED',
    });
  });
});
