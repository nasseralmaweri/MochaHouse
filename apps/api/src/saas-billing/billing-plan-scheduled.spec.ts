import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ConflictException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  AdminBillingResponse,
  BillingPlanChangeConfirmResponse,
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
import { BillingPlanChangeService } from './application/billing-plan-change.service';
import { PlanChangeMaintenanceService } from './application/plan-change-maintenance.service';
import type {
  FakeEventBody,
  FakeSaasBillingProvider,
} from './provider/fake-saas-billing-provider';
import { SAAS_BILLING_PROVIDER } from './provider/saas-billing-provider';

// SC3d-3 — scheduled plan changes, end to end on the real AppModule (fake
// provider) in a SCRATCH database:
//   * downgrades and annual -> monthly take effect at the period end, the
//     plan chosen during a trial at the trial end; nothing is charged now;
//   * only the business's billing.manage user confirms or cancels;
//     operators cannot;
//   * at least an hour before the date (re-checked right before the
//     provider call); a cardless trial cannot choose (its expiry stays);
//   * applied when the provider's live subscription shows the switch —
//     paid or not (a failed renewal is delinquency at the NEW price);
//   * cancelling RELEASES the schedule (the subscription untouched);
//   * a schedule removed, released, cancelled or altered outside CENTERIVO
//     is never recreated: reviewed, the current plan kept;
//   * webhooks may be late or repeated; the sweep is the backstop.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

jest.setTimeout(180_000);

describe('SC3d-3 scheduled plan changes (integration, scratch database)', () => {
  let scratch: ScratchDatabase;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let lifecycle: BillingLifecycleService;
  let planChanges: BillingPlanChangeService;
  let maintenance: PlanChangeMaintenanceService;
  let fake: FakeSaasBillingProvider;
  const originalEnv = { ...process.env };
  const PLATFORM_SECRET = `sc3d3-platform-${randomUUID()}`;
  const INTERNAL_SECRET = `sc3d3-internal-${randomUUID()}`;
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
        sub: `internal-dev:sc3d3-${key}-${run}`,
        email: `sc3d3-${key}-${run}@example.com`,
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
  const operator = (path: string, body: unknown) =>
    request(app.getHttpServer())
      .post(`/api/v1/platform${path}`)
      .set(
        'Authorization',
        `Bearer ${signPlatformDevJwt(
          {
            sub: `platform-dev:sc3d3-${run}`,
            mfa: true,
            iat: Math.floor(Date.now() / 1000),
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
    periodEnd: Date;
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
        externalSubject: `internal-dev:sc3d3-${key}-${run}`,
        email: `sc3d3-${key}-${run}@example.com`,
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

  // An ACTIVE business (or a trial: authorized with a card, or cardless),
  // billed by the fake provider, its period (or trial) ending `endsIn` from
  // now.
  async function business(
    label: string,
    priceKey: string,
    opts: { trial?: 'authorized' | 'cardless'; endsIn?: number } = {},
  ): Promise<Business> {
    const tenantId = randomUUID();
    await prisma.tenant.create({
      data: {
        id: tenantId,
        slug: `sc3d3-${label}-${run}`,
        name: `SC3d3 ${label}`,
        status: 'ACTIVE',
      },
    });
    const customer = `fake_cus_${label}_${run}`;
    const sub = `fake_sub_${label}_${run}`;
    const price = prices[priceKey];
    const trial = opts.trial !== undefined;
    const cardless = opts.trial === 'cardless';
    const periodStart = new Date(Date.now() - (trial ? 7 : 10) * DAY);
    const periodEnd = new Date(Date.now() + (opts.endsIn ?? 20 * DAY));
    const subscription = await prisma.tenantSubscription.create({
      data: {
        subscriberTenantId: tenantId,
        planVersionId: price.planVersionId,
        billingMode: 'BILLED',
        billingProvider: 'fake',
        planPriceId: price.id,
        externalCustomerId: customer,
        externalSubscriptionId: sub,
        status: trial ? 'TRIALING' : 'ACTIVE',
        recurringPaymentAuthorizedAt: cardless
          ? null
          : new Date(Date.now() - 40 * DAY),
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        ...(trial
          ? {
              trialStartedAt: periodStart,
              trialEndsAt: periodEnd,
              trialRequiresPaymentMethod: false,
            }
          : {}),
      },
    });
    fake.subscriptions.set(sub, {
      externalSubscriptionId: sub,
      externalCustomerId: customer,
      status: trial ? 'trialing' : 'active',
      livemode: false,
      hasPaymentMethod: !cardless,
      paymentMethodSource: cardless ? null : 'SUBSCRIPTION',
      cancelAtPeriodEnd: false,
      trialStart: trial ? periodStart : null,
      trialEnd: trial ? periodEnd : null,
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
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
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
      periodEnd,
    };
  }

  const preview = (b: Business, priceKey: string) =>
    asStaff('post', b.key, b.tenantId, '/plan-change/preview', {
      planPriceId: prices[priceKey].id,
    });
  const previewFor = async (b: Business, priceKey: string) =>
    (await preview(b, priceKey).expect(200)).body as BillingPlanChangePreview;
  const confirm = (b: Business, previewId: string, key = b.key) =>
    asStaff('post', key, b.tenantId, '/plan-change/confirm', { previewId });
  const cancel = (b: Business, planChangeId: string, key = b.key) =>
    asStaff('post', key, b.tenantId, '/plan-change/cancel', { planChangeId });
  // Confirms a scheduled change; returns its id and provider schedule.
  async function schedule(b: Business, priceKey: string) {
    const p = await previewFor(b, priceKey);
    const confirmed = (await confirm(b, p.previewId).expect(200))
      .body as BillingPlanChangeConfirmResponse;
    expect(confirmed.planChange.status).toBe('SCHEDULED');
    const change = await changeOf(p.previewId);
    return { id: p.previewId, scheduleId: change.externalScheduleId! };
  }
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
        select: { kind: true },
      })
    ).map((c) => c.kind);
  const callsOf = (op: string, id: string) =>
    fake.calls.filter((c) => c.op === op && c.key.includes(id)).length;
  const providerWrites = (id: string) =>
    fake.calls.filter(
      (c) =>
        [
          'changePriceNow',
          'schedulePriceChangeAtPeriodEnd',
          'releaseSchedule',
        ].includes(c.op) && c.key.includes(id),
    );

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
  // The renewal (or first) invoice for the period after the switch.
  async function renewal(
    b: Business,
    status: 'paid' | 'open',
    amountMinorUnits: number,
  ) {
    const snapshot = fake.subscriptions.get(b.sub)!;
    const invoice = `in_renewal_${b.key}_${run}`;
    fake.setInvoice(invoice, status, b.sub, b.customer, {
      amountMinorUnits,
      billingReason: 'subscription_cycle',
    });
    return status === 'paid'
      ? deliver(b, 'invoice.paid', {
          reference: invoice,
          amount: amountMinorUnits,
          currency: 'usd',
          periodStart: Math.floor(
            snapshot.currentPeriodStart!.getTime() / 1000,
          ),
          periodEnd: Math.floor(snapshot.currentPeriodEnd!.getTime() / 1000),
        })
      : deliver(b, 'invoice.payment_failed', { reference: invoice });
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3d3_scheduled',
    );
    await applyMigrations(scratch.url, listMigrations(MIGRATIONS));
    process.env.DATABASE_URL = scratch.url;
    process.env.PLATFORM_AUTH_PROVIDER = 'dev';
    process.env.PLATFORM_AUTH_DEV_JWT_SECRET = PLATFORM_SECRET;
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = INTERNAL_SECRET;
    process.env.RATE_LIMIT_ENABLED = '0';
    process.env.SAAS_BILLING_PROVIDER = 'fake';
    process.env.SAAS_BILLING_TRIAL_CLAIM_SECRET = `sc3d3-claims-${randomUUID()}`;
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
        externalSubject: `platform-dev:sc3d3-${run}`,
        email: `sc3d3-${run}@example.test`,
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

  it('a downgrade is scheduled for the period end: nothing charged, the plan kept until the verified switch, then applied (paid)', async () => {
    const b = await business('down', 'proMonthly');
    const p = await previewFor(b, 'growthMonthly');
    expect(p).toMatchObject({ timing: 'PERIOD_END', chargeNow: null });
    expect(p.modules.lost.map((m) => m.key)).toEqual(['marketing']);
    expect(p.modules.gained).toEqual([]);
    expect(new Date(p.nextRecurring.startsAt!).getTime()).toBe(
      b.periodEnd.getTime(),
    );

    const confirmed = (await confirm(b, p.previewId).expect(200))
      .body as BillingPlanChangeConfirmResponse;
    expect(confirmed.planChange).toMatchObject({
      id: p.previewId,
      status: 'SCHEDULED',
      timing: 'PERIOD_END',
      effectiveAt: b.periodEnd.toISOString(),
      // SC3e-1 — the features it removes, for the status line.
      modulesLost: [expect.objectContaining({ key: 'marketing' })],
    });
    // One schedule, with the change's own key; nothing charged.
    expect(callsOf('schedulePriceChangeAtPeriodEnd', p.previewId)).toBe(1);
    expect(callsOf('changePriceNow', p.previewId)).toBe(0);
    const change = await changeOf(p.previewId);
    expect(change).toMatchObject({ status: 'SCHEDULED' });
    expect(fake.subscriptions.get(b.sub)!.scheduleId).toBe(
      change.externalScheduleId,
    );
    // The current plan (and its features) until the date.
    expect(await subscriptionOf(b)).toMatchObject({
      planPriceId: prices.proMonthly.id,
      planVersionId: prices.proMonthly.planVersionId,
      pendingChangeKind: 'DOWNGRADE',
      status: 'ACTIVE',
    });
    const audit = await prisma.internalAuditEvent.findFirstOrThrow({
      where: { tenantId: b.tenantId, action: 'billing.plan_change_confirmed' },
    });
    expect(audit.afterData).toMatchObject({
      amountDueMinorUnits: null,
      timing: 'PERIOD_END',
      effectiveAt: b.periodEnd.toISOString(),
    });
    const view = (await asStaff('get', b.key, b.tenantId, '').expect(200))
      .body as AdminBillingResponse;
    expect(view).toMatchObject({
      canChangePlan: false,
      planChange: { status: 'SCHEDULED', timing: 'PERIOD_END' },
    });
    // One change at a time.
    expect(codeOf(await preview(b, 'growthYearly').expect(409))).toBe(
      'BILLING_PLAN_CHANGE_IN_PROGRESS',
    );

    // An early (or repeated) subscription event changes nothing.
    await deliver(b, 'subscription.changed');
    expect((await changeOf(p.previewId)).status).toBe('SCHEDULED');

    // The provider switches at the period end; the renewal is paid.
    fake.switchSchedule(change.externalScheduleId!);
    await renewal(b, 'paid', 4900);
    expect(await changeOf(p.previewId)).toMatchObject({ status: 'APPLIED' });
    const after = await subscriptionOf(b);
    expect(after).toMatchObject({
      planPriceId: prices.growthMonthly.id,
      planVersionId: prices.growthMonthly.planVersionId,
      pendingChangeKind: null,
      status: 'ACTIVE',
      pastDueAt: null,
    });
    expect(after.currentPeriodStart!.getTime()).toBe(b.periodEnd.getTime());
    // Late and duplicate webhooks: nothing more.
    const history = await historyOf(b);
    await deliver(b, 'subscription.changed');
    await deliver(b, 'subscription.changed');
    expect(await historyOf(b)).toEqual(history);
    expect(history.filter((t) => t === 'PLAN_CHANGE_APPLIED')).toHaveLength(1);
    expect(history[0]).toBe('PLAN_CHANGE_PENDING');
    expect(await casesOf(b)).toEqual([]);
    // Nothing deleted: the business and its records stay.
    expect(
      await prisma.tenant.findUniqueOrThrow({ where: { id: b.tenantId } }),
    ).toMatchObject({ status: 'ACTIVE' });
    expect(providerWrites(p.previewId).map((c) => c.op)).toEqual([
      'schedulePriceChangeAtPeriodEnd',
    ]);
  });

  it('a failed renewal after the switch is delinquency at the NEW lower plan — the higher plan is never kept', async () => {
    const b = await business('down-failed', 'proMonthly');
    const { id, scheduleId } = await schedule(b, 'growthMonthly');
    fake.switchSchedule(scheduleId);
    // The failed renewal arrives BEFORE the subscription event.
    await renewal(b, 'open', 4900);
    expect(await changeOf(id)).toMatchObject({ status: 'APPLIED' });
    expect(await subscriptionOf(b)).toMatchObject({
      planPriceId: prices.growthMonthly.id,
      planVersionId: prices.growthMonthly.planVersionId,
      status: 'PAST_DUE',
      pendingChangeKind: null,
    });
    // The delayed subscription event: nothing more.
    const history = await historyOf(b);
    await deliver(b, 'subscription.changed');
    expect(await historyOf(b)).toEqual(history);
    expect(await subscriptionOf(b)).toMatchObject({
      planPriceId: prices.growthMonthly.id,
      status: 'PAST_DUE',
    });
  });

  it('annual -> monthly is scheduled for the annual renewal and starts a monthly period there', async () => {
    const b = await business('to-monthly', 'growthYearly', {
      endsIn: 100 * DAY,
    });
    const p = await previewFor(b, 'growthMonthly');
    expect(p.timing).toBe('PERIOD_END');
    expect(p.modules).toEqual({ lost: [], gained: [] });
    const { id, scheduleId } = await (async () => {
      await confirm(b, p.previewId).expect(200);
      const change = await changeOf(p.previewId);
      return { id: p.previewId, scheduleId: change.externalScheduleId! };
    })();
    expect((await subscriptionOf(b)).planPriceId).toBe(prices.growthYearly.id);
    fake.switchSchedule(scheduleId);
    await deliver(b, 'subscription.changed');
    expect(await changeOf(id)).toMatchObject({ status: 'APPLIED' });
    const after = await subscriptionOf(b);
    expect(after.planPriceId).toBe(prices.growthMonthly.id);
    expect(
      after.currentPeriodEnd!.getTime() - after.currentPeriodStart!.getTime(),
    ).toBe(30 * DAY);
  });

  it('the business cancels: the schedule is RELEASED, the subscription untouched; only billing.manage, only its own, once', async () => {
    const b = await business('cancel', 'proMonthly');
    const { id, scheduleId } = await schedule(b, 'growthMonthly');
    await staff(b.tenantId, `${b.key}-viewer`, ['billing.view'], 'viewer');
    await cancel(b, id, `${b.key}-viewer`).expect(403);
    const other = await business('cancel-other', 'proMonthly');
    await cancel(other, id).expect(404);
    await asStaff('post', b.key, b.tenantId, '/plan-change/cancel', {
      planChangeId: id,
      extra: true,
    }).expect(400);
    await asStaff('post', b.key, b.tenantId, '/plan-change/cancel', {
      planChangeId: 'not-a-uuid',
    }).expect(400);
    // Operators have no confirm or cancel route.
    await operator(`/tenants/${b.tenantId}/billing/plan-change/cancel`, {
      planChangeId: id,
    }).expect(404);
    expect((await changeOf(id)).status).toBe('SCHEDULED');

    const canceled = (await cancel(b, id).expect(200))
      .body as BillingPlanChangeConfirmResponse;
    expect(canceled.planChange).toMatchObject({ id, status: 'CANCELED' });
    expect(callsOf('releaseSchedule', id)).toBe(1);
    // Released, never cancelled: the subscription is exactly as it was.
    const live = fake.subscriptions.get(b.sub)!;
    expect(live).toMatchObject({ status: 'active', scheduleId: null });
    expect(live.items![0].externalPriceId).toBe(prices.proMonthly.ext);
    expect(await subscriptionOf(b)).toMatchObject({
      planPriceId: prices.proMonthly.id,
      status: 'ACTIVE',
      pendingChangeKind: null,
      cancelAtPeriodEnd: false,
    });
    expect(await historyOf(b)).toEqual([
      'PLAN_CHANGE_PENDING',
      'PLAN_CHANGE_ABANDONED',
    ]);
    expect(
      await prisma.internalAuditEvent.count({
        where: {
          tenantId: b.tenantId,
          action: 'billing.plan_change_canceled',
        },
      }),
    ).toBe(1);
    expect(codeOf(await cancel(b, id).expect(409))).toBe(
      'BILLING_PLAN_CHANGE_NOT_CANCELABLE',
    );
    expect(callsOf('releaseSchedule', id)).toBe(1);
    // The released-schedule webhook changes nothing more.
    const history = await historyOf(b);
    await deliver(b, 'subscription.changed');
    expect(await historyOf(b)).toEqual(history);
    expect(await casesOf(b)).toEqual([]);
    // A new change may be made.
    await previewFor(b, 'growthMonthly');
    expect(scheduleId).toBeTruthy();
  });

  it('a release seen first by its own webhook (or the sweep) is the cancellation, not a disruption', async () => {
    const b = await business('cancel-race', 'proMonthly');
    const { id, scheduleId } = await schedule(b, 'growthMonthly');
    // As cancelScheduled leaves it between the release and its own
    // transaction: marked, released at the provider.
    await prisma.billingPlanChange.update({
      where: { id },
      data: { failureCode: 'CANCEL_REQUESTED' },
    });
    fake.alterSchedule(scheduleId, { status: 'released', detach: true });
    await deliver(b, 'subscription.changed');
    expect(await changeOf(id)).toMatchObject({
      status: 'CANCELED',
      failureCode: null,
    });
    expect(await subscriptionOf(b)).toMatchObject({
      planPriceId: prices.proMonthly.id,
      pendingChangeKind: null,
    });
    expect(await casesOf(b)).toEqual([]);
  });

  it('one hour before the date: refused to schedule or cancel; the date is re-checked right before the provider call', async () => {
    const late = await business('cutoff', 'proMonthly', {
      endsIn: 50 * 60_000,
    });
    expect(codeOf(await preview(late, 'growthMonthly').expect(409))).toBe(
      'BILLING_PLAN_CHANGE_TOO_LATE',
    );

    // Cancelling within the hour.
    const b = await business('cutoff-cancel', 'proMonthly', {
      endsIn: 2 * HOUR,
    });
    const { id } = await schedule(b, 'growthMonthly');
    await expect(
      planChanges.cancelScheduled(
        b.tenantId,
        id,
        b.ownerId,
        new Date(b.periodEnd.getTime() - 30 * 60_000),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(callsOf('releaseSchedule', id)).toBe(0);
    expect((await changeOf(id)).status).toBe('SCHEDULED');

    // The date moved at the provider after the preview: refused.
    const moved = await business('cutoff-moved', 'proMonthly');
    const p = await previewFor(moved, 'growthMonthly');
    const live = fake.subscriptions.get(moved.sub)!;
    fake.subscriptions.set(moved.sub, {
      ...live,
      currentPeriodEnd: new Date(live.currentPeriodEnd!.getTime() + DAY),
    });
    expect(codeOf(await confirm(moved, p.previewId).expect(409))).toBe(
      'BILLING_PLAN_CHANGE_PREVIEW_CHANGED',
    );
    expect(callsOf('schedulePriceChangeAtPeriodEnd', p.previewId)).toBe(0);

    // Interrupted, then replayed past the cut-off: never sent.
    const race = await business('cutoff-race', 'proMonthly', {
      endsIn: 2 * HOUR,
    });
    const rp = await previewFor(race, 'growthMonthly');
    fake.failOp = {
      op: 'schedulePriceChangeAtPeriodEnd',
      code: 'api_connection_error',
    };
    const pending = (await confirm(race, rp.previewId).expect(200))
      .body as BillingPlanChangeConfirmResponse;
    expect(pending.planChange.status).toBe('PROCESSING');
    await planChanges.submitScheduled(
      rp.previewId,
      new Date(race.periodEnd.getTime() - 30 * 60_000),
    );
    expect(await changeOf(rp.previewId)).toMatchObject({
      status: 'FAILED',
      failureCode: 'NO_LONGER_SCHEDULEABLE',
    });
    expect(callsOf('schedulePriceChangeAtPeriodEnd', rp.previewId)).toBe(1);
    expect(await subscriptionOf(race)).toMatchObject({
      planPriceId: prices.proMonthly.id,
      pendingChangeKind: null,
    });
  });

  it('a trial chooses the plan it becomes: the trial end kept, nothing charged now, the new plan only at the switch', async () => {
    const b = await business('trial', 'growthMonthly', {
      trial: 'authorized',
      endsIn: 7 * DAY,
    });
    const p = await previewFor(b, 'proMonthly');
    expect(p).toMatchObject({ timing: 'TRIAL_END', chargeNow: null });
    expect(p.modules.gained.map((m) => m.key)).toEqual(['marketing']);
    expect(p.nextRecurring).toMatchObject({ amountMinorUnits: 9900 });
    expect(new Date(p.nextRecurring.startsAt!).getTime()).toBe(
      b.periodEnd.getTime(),
    );
    const confirmed = (await confirm(b, p.previewId).expect(200))
      .body as BillingPlanChangeConfirmResponse;
    expect(confirmed.planChange).toMatchObject({
      status: 'SCHEDULED',
      timing: 'TRIAL_END',
      effectiveAt: b.periodEnd.toISOString(),
    });
    expect(callsOf('changePriceNow', p.previewId)).toBe(0);
    // Still the trial, on its plan (no premium features during the trial).
    expect(await subscriptionOf(b)).toMatchObject({
      status: 'TRIALING',
      planPriceId: prices.growthMonthly.id,
      planVersionId: prices.growthMonthly.planVersionId,
      trialEndsAt: b.periodEnd,
    });
    expect(fake.subscriptions.get(b.sub)).toMatchObject({
      status: 'trialing',
      trialEnd: b.periodEnd,
    });
    // At the trial end the provider switches; the first invoice is paid.
    const change = await changeOf(p.previewId);
    fake.switchSchedule(change.externalScheduleId!);
    await renewal(b, 'paid', 9900);
    expect(await changeOf(p.previewId)).toMatchObject({ status: 'APPLIED' });
    expect(await subscriptionOf(b)).toMatchObject({
      status: 'ACTIVE',
      planPriceId: prices.proMonthly.id,
      planVersionId: prices.proMonthly.planVersionId,
    });
  });

  it('a cardless trial cannot choose a plan (payment method first): its expiry and recovery stay', async () => {
    const b = await business('trial-cardless', 'growthMonthly', {
      trial: 'cardless',
      endsIn: 7 * DAY,
    });
    expect(codeOf(await preview(b, 'proMonthly').expect(409))).toBe(
      'BILLING_PLAN_CHANGE_PAYMENT_METHOD_REQUIRED',
    );
    // Nothing recorded or scheduled.
    expect(
      await prisma.billingPlanChange.count({
        where: { subscriptionId: b.subscriptionId },
      }),
    ).toBe(0);
    expect(fake.subscriptions.get(b.sub)!.scheduleId).toBeNull();
    // The trial ends without payment: it expires, nothing charged.
    await deliver(b, 'subscription.trial_ended');
    expect(await subscriptionOf(b)).toMatchObject({
      status: 'TRIAL_EXPIRED',
      planPriceId: prices.growthMonthly.id,
      pendingChangeKind: null,
    });
  });

  it('a schedule released, cancelled, re-priced or removed outside CENTERIVO is never recreated: reviewed, the current plan kept', async () => {
    const outcomes: Record<string, Awaited<ReturnType<typeof schedule>>> = {};
    const cases: Business[] = [];
    for (const label of ['released', 'repriced', 'removed']) {
      const b = await business(`ext-${label}`, 'proMonthly');
      outcomes[label] = await schedule(b, 'growthMonthly');
      cases.push(b);
    }
    const [released, repriced, removed] = cases;
    fake.alterSchedule(outcomes.released.scheduleId, {
      status: 'released',
      detach: true,
    });
    fake.alterSchedule(outcomes.repriced.scheduleId, {
      toExternalPriceId: prices.growthYearly.ext,
    });
    fake.alterSchedule(outcomes.removed.scheduleId, { remove: true });
    for (const b of cases) await deliver(b, 'subscription.changed');
    // Repriced: the subscription event may not come — the sweep sees it too.
    await maintenance.sweep();
    for (const [b, label] of [
      [released, 'released'],
      [repriced, 'repriced'],
      [removed, 'removed'],
    ] as const) {
      expect(await changeOf(outcomes[label].id)).toMatchObject({
        status: 'REVIEW',
      });
      expect(await subscriptionOf(b)).toMatchObject({
        planPriceId: prices.proMonthly.id,
        pendingChangeKind: null,
        status: 'ACTIVE',
      });
      expect(await casesOf(b)).toContain('SCHEDULED_CHANGE_DISRUPTED');
      // Never recreated (one schedule request, ever).
      expect(
        callsOf('schedulePriceChangeAtPeriodEnd', outcomes[label].id),
      ).toBe(1);
    }
    // The re-priced schedule is not adopted when it switches.
    fake.switchSchedule(outcomes.repriced.scheduleId);
    await deliver(repriced, 'subscription.changed');
    expect((await subscriptionOf(repriced)).planPriceId).toBe(
      prices.proMonthly.id,
    );
  });

  it('the subscription ending (schedule cancelled with it) closes the change; an overdue switch is reviewed', async () => {
    const ended = await business('ended', 'proMonthly');
    const e = await schedule(ended, 'growthMonthly');
    fake.alterSchedule(e.scheduleId, { status: 'canceled', detach: true });
    fake.subscriptions.set(ended.sub, {
      ...fake.subscriptions.get(ended.sub)!,
      status: 'canceled',
    });
    await deliver(ended, 'subscription.changed');
    expect(await changeOf(e.id)).toMatchObject({
      status: 'CANCELED',
      failureCode: 'SUBSCRIPTION_ENDED',
    });
    expect((await subscriptionOf(ended)).pendingChangeKind).toBeNull();

    const overdue = await business('overdue', 'proMonthly');
    const o = await schedule(overdue, 'growthMonthly');
    await maintenance.sweep(new Date(overdue.periodEnd.getTime() + HOUR));
    expect((await changeOf(o.id)).status).toBe('SCHEDULED');
    await maintenance.sweep(new Date(overdue.periodEnd.getTime() + 3 * HOUR));
    expect((await changeOf(o.id)).status).toBe('REVIEW');
    expect(await subscriptionOf(overdue)).toMatchObject({
      planPriceId: prices.proMonthly.id,
      pendingChangeKind: null,
    });
    expect(await casesOf(overdue)).toContain('SCHEDULED_CHANGE_DISRUPTED');
  });

  it('the sweep applies a switch whose webhooks never came; a completed schedule after the switch is applied too', async () => {
    const b = await business('missed', 'proMonthly');
    const { id, scheduleId } = await schedule(b, 'growthMonthly');
    fake.switchSchedule(scheduleId);
    fake.alterSchedule(scheduleId, { status: 'completed', detach: true });
    const result = await maintenance.sweep();
    expect(result.scheduledSettled).toBeGreaterThanOrEqual(1);
    expect(await changeOf(id)).toMatchObject({ status: 'APPLIED' });
    expect((await subscriptionOf(b)).planPriceId).toBe(prices.growthMonthly.id);
    const history = await historyOf(b);
    await maintenance.sweep();
    await deliver(b, 'subscription.changed');
    expect(await historyOf(b)).toEqual(history);
  });

  it('two confirmations at once create one schedule; an interrupted creation is replayed with the same key, or closed after the window', async () => {
    const b = await business('twice', 'proMonthly');
    const p = await previewFor(b, 'growthMonthly');
    const results = await Promise.all([
      confirm(b, p.previewId),
      confirm(b, p.previewId),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(callsOf('schedulePriceChangeAtPeriodEnd', p.previewId)).toBe(1);
    expect((await changeOf(p.previewId)).status).toBe('SCHEDULED');

    const r = await business('replayed', 'proMonthly');
    const rp = await previewFor(r, 'growthMonthly');
    fake.failOp = {
      op: 'schedulePriceChangeAtPeriodEnd',
      code: 'api_connection_error',
    };
    await confirm(r, rp.previewId).expect(200);
    expect((await changeOf(rp.previewId)).status).toBe('REQUESTED');
    await maintenance.sweep(new Date(Date.now() + 3 * 60_000));
    expect((await changeOf(rp.previewId)).status).toBe('SCHEDULED');
    expect(
      fake.calls.filter(
        (c) =>
          c.op === 'schedulePriceChangeAtPeriodEnd' &&
          c.key === `centerivo-plan-change-${rp.previewId}-schedule`,
      ),
    ).toHaveLength(2);

    // Past the window with nothing at the provider: closed, never re-sent.
    const old = await business('old', 'proMonthly');
    const then = new Date(Date.now() - 2 * HOUR);
    const op = await planChanges.preview(
      old.tenantId,
      prices.growthMonthly.id,
      { kind: 'STAFF', internalUserId: old.ownerId },
      then,
    );
    fake.failOp = {
      op: 'schedulePriceChangeAtPeriodEnd',
      code: 'api_connection_error',
    };
    await planChanges.confirm(
      old.tenantId,
      op.previewId,
      old.ownerId,
      new Date(then.getTime() + 60_000),
    );
    await maintenance.sweep();
    expect(await changeOf(op.previewId)).toMatchObject({
      status: 'FAILED',
      failureCode: 'NOT_SUBMITTED',
    });
    expect(callsOf('schedulePriceChangeAtPeriodEnd', op.previewId)).toBe(1);
  });
});
