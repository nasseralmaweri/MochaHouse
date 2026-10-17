import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  PLATFORM_PERMISSIONS,
  type InternalPermissionKey,
  type PlatformCaseDetailResponse,
  type PlatformComplimentaryListResponse,
  type PlatformComplimentaryView,
  type PlatformMeResponse,
  type PlatformPermission,
} from '@mocha-house/contracts';
import {
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  type ScratchDatabase,
} from '@mocha-house/testing';
import {
  grantPlatformPermission,
  revokePlatformPermission,
} from '@mocha-house/database/dist/platform/operator-provisioning';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { signPlatformDevJwt } from '../platform-auth/infrastructure/platform-dev-jwt';
import { PLATFORM_PERMISSION_KEY } from '../platform-auth/authorization/platform-permission.guard';
import { BillingLifecycleService } from './application/billing-lifecycle.service';
import { BillingComplimentaryService } from './application/billing-complimentary.service';
import { PlatformBillingController } from './api/platform-billing.controller';
import type {
  FakeEventBody,
  FakeSaasBillingProvider,
} from './provider/fake-saas-billing-provider';
import { SAAS_BILLING_PROVIDER } from './provider/saas-billing-provider';

// SC3e-2 — operator billing controls, end to end on the real AppModule (fake
// provider) in a SCRATCH database:
//   * platform-operator permissions: database-backed, re-read per request,
//     granted only by the CLI (audited), least privilege; missing, revoked
//     and insufficient permissions are refused;
//   * complimentary arrangements: an explicit plan version; a paying
//     business only after its paid period (verified provider cancellation,
//     started once the provider ended it); refused while invoices are
//     unpaid or anything is open; withdrawal; a cancellation undone outside
//     CENTERIVO is withdrawn and reviewed (never re-issued); expiry and
//     revocation return the business to billing (no charge, no new trial,
//     no reactivated subscription); SECURITY suspensions untouched;
//   * review cases: recheck (no provider write), a verified schedule
//     release (never cancelled), closing with an outcome and a note;
//   * invoice history across a verified earlier (replaced) subscription.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

jest.setTimeout(240_000);

describe('SC3e-2 operator billing controls (integration, scratch database)', () => {
  let scratch: ScratchDatabase;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let lifecycle: BillingLifecycleService;
  let complimentary: BillingComplimentaryService;
  let fake: FakeSaasBillingProvider;
  const originalEnv = { ...process.env };
  const PLATFORM_SECRET = `sc3e2-platform-${randomUUID()}`;
  const INTERNAL_SECRET = `sc3e2-internal-${randomUUID()}`;
  const run = randomUUID().replace(/-/g, '').slice(0, 8);
  const versions: Record<string, string> = {};
  const prices: Record<string, string> = {};
  const operators: Record<string, { id: string; email: string }> = {};

  // --- operators ------------------------------------------------------------------
  async function operator(
    key: string,
    permissions: readonly PlatformPermission[],
  ) {
    const email = `sc3e2-${key}-${run}@example.test`;
    const row = await prisma.platformOperator.create({
      data: {
        externalProvider: 'platform-dev',
        externalSubject: `platform-dev:sc3e2-${key}-${run}`,
        email,
        status: 'ACTIVE',
      },
    });
    for (const permission of permissions) {
      await grantPlatformPermission(prisma, {
        email,
        permission,
        reason: 'Granted for the SC3e-2 test.',
      });
    }
    operators[key] = { id: row.id, email };
    return row.id;
  }
  const operatorToken = (key: string, signedInSecondsAgo = 0) =>
    signPlatformDevJwt(
      {
        sub: `platform-dev:sc3e2-${key}-${run}`,
        mfa: true,
        iat: Math.floor(Date.now() / 1000) - signedInSecondsAgo,
      },
      PLATFORM_SECRET,
      3600,
    );
  const asOperator = (
    key: string,
    method: 'get' | 'post' | 'put',
    path: string,
    body?: unknown,
    signedInSecondsAgo = 0,
  ) => {
    const req = request(app.getHttpServer())
      [method](`/api/v1/platform${path}`)
      .set('Authorization', `Bearer ${operatorToken(key, signedInSecondsAgo)}`);
    return body !== undefined ? req.send(body as object) : req;
  };
  const codeOf = (response: { body: unknown }) =>
    (response.body as { code: string }).code;

  // --- businesses -----------------------------------------------------------------
  interface Business {
    key: string;
    tenantId: string;
    subscriptionId: string;
    customer: string;
    sub: string;
  }
  const staffToken = (key: string) =>
    signInternalDevJwt(
      {
        sub: `internal-dev:sc3e2-${key}-${run}`,
        email: `sc3e2-${key}-${run}@example.com`,
        name: null,
        email_verified: true,
      },
      INTERNAL_SECRET,
      3600,
    );
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
        externalSubject: `internal-dev:sc3e2-${key}-${run}`,
        email: `sc3e2-${key}-${run}@example.com`,
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

  // A billed business: paying (a live provider subscription), ended
  // (canceled) or awaiting setup (a customer, no subscription).
  async function business(
    label: string,
    kind: 'paying' | 'ended' | 'awaiting' = 'paying',
    over: { status?: 'PAST_DUE' } = {},
  ): Promise<Business> {
    const tenantId = randomUUID();
    await prisma.tenant.create({
      data: {
        id: tenantId,
        slug: `sc3e2-${label}-${run}`,
        name: `SC3e2 ${label}`,
        status: 'ACTIVE',
      },
    });
    const customer = `fake_cus_${label}_${run}`;
    const sub = `fake_sub_${label}_${run}`;
    const periodEnd = new Date(Date.now() + 20 * DAY);
    const subscription = await prisma.tenantSubscription.create({
      data: {
        subscriberTenantId: tenantId,
        planVersionId: versions.pro,
        billingMode: 'BILLED',
        billingProvider: 'fake',
        planPriceId: prices.pro,
        externalCustomerId: customer,
        externalSubscriptionId: kind === 'awaiting' ? null : sub,
        status: kind === 'ended' ? 'CANCELED' : (over.status ?? 'ACTIVE'),
        canceledAt: kind === 'ended' ? new Date(Date.now() - DAY) : null,
        recurringPaymentAuthorizedAt:
          kind === 'awaiting' ? null : new Date(Date.now() - 40 * DAY),
        currentPeriodStart:
          kind === 'paying' ? new Date(Date.now() - 10 * DAY) : null,
        currentPeriodEnd: kind === 'paying' ? periodEnd : null,
        ...(over.status === 'PAST_DUE'
          ? {
              pastDueAt: new Date(Date.now() - DAY),
              graceEndsAt: new Date(Date.now() + 6 * DAY),
            }
          : {}),
      },
    });
    if (kind !== 'awaiting') {
      fake.subscriptions.set(sub, {
        externalSubscriptionId: sub,
        externalCustomerId: customer,
        status: kind === 'ended' ? 'canceled' : 'active',
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
            externalPriceId: `fake_price_pro_${run}`,
            quantity: 1,
          },
        ],
        scheduleId: null,
        hasPendingUpdate: false,
        currentPeriodStart: new Date(Date.now() - 10 * DAY),
        currentPeriodEnd: periodEnd,
      });
    }
    await owner(tenantId, label);
    return {
      key: label,
      tenantId,
      subscriptionId: subscription.id,
      customer,
      sub,
    };
  }
  const subscriptionOf = (b: Business) =>
    prisma.tenantSubscription.findUniqueOrThrow({
      where: { id: b.subscriptionId },
    });
  const grantsOf = (b: Business) =>
    prisma.billingComplimentaryGrant.findMany({
      where: { subscriptionId: b.subscriptionId },
      orderBy: { createdAt: 'asc' },
    });
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
  const cancelCalls = (grantId: string) =>
    fake.calls.filter(
      (c) => c.op === 'setCancelAtPeriodEnd' && c.key.includes(grantId),
    ).length;

  const grant = (
    b: Business,
    body: Record<string, unknown> = {},
    key = 'comp',
    signedInSecondsAgo = 0,
  ) =>
    asOperator(
      key,
      'post',
      `/tenants/${b.tenantId}/billing/complimentary`,
      {
        planVersionId: versions.growth,
        endsAt: null,
        reason: 'Partner programme, approved by sales.',
        ...body,
      },
      signedInSecondsAgo,
    );

  let seq = 0;
  function deliver(
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
    // Through the webhook endpoint (it also settles a scheduled grant).
    return request(app.getHttpServer())
      .post('/api/v1/billing/webhooks/fake')
      .set('x-billing-signature', signed.signatureHeader)
      .set('content-type', 'application/json')
      .send(signed.rawBody);
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3e2_controls',
    );
    await applyMigrations(scratch.url, listMigrations(MIGRATIONS));
    process.env.DATABASE_URL = scratch.url;
    process.env.PLATFORM_AUTH_PROVIDER = 'dev';
    process.env.PLATFORM_AUTH_DEV_JWT_SECRET = PLATFORM_SECRET;
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = INTERNAL_SECRET;
    process.env.RATE_LIMIT_ENABLED = '0';
    process.env.SAAS_BILLING_PROVIDER = 'fake';
    process.env.SAAS_BILLING_TRIAL_CLAIM_SECRET = `sc3e2-claims-${randomUUID()}`;
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
    lifecycle = app.get(BillingLifecycleService);
    complimentary = app.get(BillingComplimentaryService);
    fake = app.get(SAAS_BILLING_PROVIDER);

    await operator('none', []);
    await operator('cases', ['billing.cases.manage']);
    await operator('comp', ['billing.complimentary.manage']);
    await operator('release', [
      'billing.cases.manage',
      'billing.schedules.release',
    ]);
    await operator('all', PLATFORM_PERMISSIONS);

    for (const [key, modules] of [
      ['pro', ['crm', 'marketing']],
      ['growth', ['crm']],
    ] as const) {
      const plan = await prisma.subscriptionPlan.create({
        data: { key: `${key}-${run}`, name: key === 'pro' ? 'Pro' : 'Growth' },
      });
      const version = await prisma.subscriptionPlanVersion.create({
        data: { planId: plan.id, version: 1, moduleKeys: [...modules] },
      });
      await prisma.subscriptionPlanVersion.update({
        where: { id: version.id },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });
      versions[key] = version.id;
      const price = await prisma.subscriptionPlanPrice.create({
        data: {
          planId: plan.id,
          interval: 'MONTH',
          currency: 'USD',
          amountMinorUnits: key === 'pro' ? 9900 : 4900,
        },
      });
      await prisma.subscriptionPlanPrice.update({
        where: { id: price.id },
        data: { externalPriceId: `fake_price_${key}_${run}` },
      });
      fake.priceCatalog.set(`fake_price_${key}_${run}`, {
        amountMinorUnits: key === 'pro' ? 9900 : 4900,
        currency: 'usd',
        interval: 'MONTH',
      });
      prices[key] = price.id;
    }
    const draft = await prisma.subscriptionPlanVersion.create({
      data: {
        planId: (
          await prisma.subscriptionPlan.findFirstOrThrow({
            where: { key: `pro-${run}` },
          })
        ).id,
        version: 2,
        moduleKeys: ['crm'],
      },
    });
    versions.draft = draft.id;
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      process.env = { ...originalEnv };
      await scratch?.drop();
    }
  });

  // --- D1: permissions ------------------------------------------------------------

  it('every operator billing write route requires a named permission; reads need none', () => {
    const writes = [
      'previewPlanChange',
      'assignBillingContact',
      'extendGrace',
      'startBilling',
      'reconcile',
      'sweepEnforcement',
      'resolveCase',
      'createPrice',
      'archivePrice',
      'updatePolicy',
      'grantComplimentary',
      'withdrawComplimentary',
      'revokeComplimentary',
      'recheckCase',
      'releaseCaseSchedule',
    ];
    const proto = PlatformBillingController.prototype as unknown as Record<
      string,
      object
    >;
    for (const method of writes) {
      expect(
        Reflect.getMetadata(PLATFORM_PERMISSION_KEY, proto[method]),
      ).toEqual(expect.stringMatching(/^billing\./));
    }
    expect(
      Reflect.getMetadata(PLATFORM_PERMISSION_KEY, proto.releaseCaseSchedule),
    ).toBe('billing.schedules.release');
    expect(
      Reflect.getMetadata(PLATFORM_PERMISSION_KEY, proto.grantComplimentary),
    ).toBe('billing.complimentary.manage');
    for (const read of [
      'getTenantBilling',
      'listCases',
      'getCase',
      'listComplimentary',
      'getComplimentary',
    ]) {
      expect(
        Reflect.getMetadata(PLATFORM_PERMISSION_KEY, proto[read]),
      ).toBeUndefined();
    }
  });

  it('missing, insufficient and revoked permissions are refused and audited; /me lists the live ones', async () => {
    const denied = await asOperator(
      'none',
      'post',
      '/billing/reconcile',
      {},
    ).expect(403);
    expect(codeOf(denied)).toBe('PLATFORM_PERMISSION_REQUIRED');
    expect(
      await prisma.platformAuditEvent.count({
        where: {
          actorPlatformOperatorId: operators.none.id,
          action: 'platform.access.denied',
          reasonCode: 'PERMISSION_REQUIRED',
        },
      }),
    ).toBe(1);
    // Reads need none.
    await asOperator('none', 'get', '/billing/reconciliation-cases').expect(
      200,
    );
    await asOperator('none', 'get', '/billing/complimentary').expect(200);
    // Insufficient: cases, not complimentary.
    const b = await business('perm');
    expect(codeOf(await grant(b, {}, 'cases').expect(403))).toBe(
      'PLATFORM_PERMISSION_REQUIRED',
    );
    // Granted, then revoked by the CLI: refused at once.
    const me = (await asOperator('cases', 'get', '/me').expect(200))
      .body as PlatformMeResponse;
    expect(me.permissions).toEqual(['billing.cases.manage']);
    await operator('revoked', ['billing.reconciliation.run']);
    await asOperator('revoked', 'post', '/billing/reconcile', {}).expect(200);
    await revokePlatformPermission(prisma, {
      email: operators.revoked.email,
      permission: 'billing.reconciliation.run',
      reason: 'No longer on the billing team.',
    });
    expect(
      codeOf(
        await asOperator('revoked', 'post', '/billing/reconcile', {}).expect(
          403,
        ),
      ),
    ).toBe('PLATFORM_PERMISSION_REQUIRED');
    expect(
      (
        (await asOperator('revoked', 'get', '/me').expect(200))
          .body as PlatformMeResponse
      ).permissions,
    ).toEqual([]);
    // The revoked grant is kept (history), and both changes were audited.
    expect(
      await prisma.platformOperatorPermission.findMany({
        where: { operatorId: operators.revoked.id },
        select: { permission: true, revokedAt: true, revokeReason: true },
      }),
    ).toMatchObject([
      {
        permission: 'billing.reconciliation.run',
        revokeReason: 'No longer on the billing team.',
      },
    ]);
    expect(
      (
        await prisma.platformOperatorPermission.findFirstOrThrow({
          where: { operatorId: operators.revoked.id },
        })
      ).revokedAt,
    ).toBeInstanceOf(Date);
    expect(
      (
        await prisma.platformAuditEvent.findMany({
          where: {
            targetType: 'platform_operator',
            targetId: operators.revoked.id,
          },
          select: { action: true, reasonCode: true },
        })
      )
        .map((e) => `${e.action}:${e.reasonCode}`)
        .sort(),
    ).toEqual([
      'platform.operator.permission_granted:BILLING_RECONCILIATION_RUN',
      'platform.operator.permission_revoked:BILLING_RECONCILIATION_RUN',
    ]);
  });

  it('the CLI grants only known permissions, with a reason, to an ACTIVE operator; idempotent; never through the API', async () => {
    await expect(
      grantPlatformPermission(prisma, {
        email: operators.none.email,
        permission: 'billing.everything',
        reason: 'Because I said so.',
      }),
    ).rejects.toThrow(/--permission must be one of/);
    await expect(
      grantPlatformPermission(prisma, {
        email: operators.none.email,
        permission: 'billing.cases.manage',
        reason: 'short',
      }),
    ).rejects.toThrow(/--reason is required/);
    const disabled = await prisma.platformOperator.create({
      data: {
        externalProvider: 'platform-dev',
        externalSubject: `platform-dev:off-${run}`,
        email: `sc3e2-off-${run}@example.test`,
        status: 'DISABLED',
      },
    });
    await expect(
      grantPlatformPermission(prisma, {
        email: disabled.email,
        permission: 'billing.cases.manage',
        reason: 'Reviewing cases this week.',
      }),
    ).rejects.toThrow(/Only an ACTIVE operator/);
    const again = await grantPlatformPermission(prisma, {
      email: operators.cases.email,
      permission: 'billing.cases.manage',
      reason: 'Granted for the SC3e-2 test.',
    });
    expect(again.changed).toBe(false);
    // The database refuses changing or deleting a grant.
    const row = await prisma.platformOperatorPermission.findFirstOrThrow({
      where: { operatorId: operators.cases.id },
    });
    await expect(
      prisma.platformOperatorPermission.update({
        where: { id: row.id },
        data: { permission: 'billing.schedules.release' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.platformOperatorPermission.delete({ where: { id: row.id } }),
    ).rejects.toThrow();
    // No platform route grants a permission.
    await asOperator(
      'all',
      'post',
      `/operators/${operators.none.id}/permissions`,
      { permission: 'billing.cases.manage' },
    ).expect(404);
  });

  // --- D2: paid -> complimentary at period end --------------------------------------

  it('a paying business becomes complimentary only after its paid period: cancellation verified, started when the provider ended it', async () => {
    const b = await business('paid');
    await prisma.billingInvoice.create({
      data: {
        subscriptionId: b.subscriptionId,
        provider: 'fake',
        externalInvoiceId: `in_paid_${run}`,
        externalCustomerId: b.customer,
        externalSubscriptionId: b.sub,
        status: 'paid',
        currency: 'usd',
        totalMinorUnits: 9900,
        amountDueMinorUnits: 9900,
        amountPaidMinorUnits: 9900,
        amountRemainingMinorUnits: 0,
        issuedAt: new Date(Date.now() - 10 * DAY),
        paidAt: new Date(Date.now() - 10 * DAY),
        syncedAt: new Date(),
      },
    });
    const view = (await grant(b).expect(200)).body as PlatformComplimentaryView;
    expect(view.current).toMatchObject({
      status: 'SCHEDULED',
      cancellationVerified: true,
      plan: { planName: 'Growth', moduleKeys: ['crm'] },
      endsAt: null,
      reason: 'Partner programme, approved by sales.',
      grantedBy: { email: operators.comp.email },
      previousStatus: 'ACTIVE',
      previousPlanName: 'Pro',
      attention: null,
    });
    expect(new Date(view.current!.effectiveAt!).getTime()).toBe(
      fake.subscriptions.get(b.sub)!.currentPeriodEnd!.getTime(),
    );
    // Still paying until then: billed, its plan, the provider set to cancel
    // at period end (verified), ours too.
    expect(fake.subscriptions.get(b.sub)).toMatchObject({
      status: 'active',
      cancelAtPeriodEnd: true,
    });
    expect(await subscriptionOf(b)).toMatchObject({
      billingMode: 'BILLED',
      planVersionId: versions.pro,
      cancelAtPeriodEnd: true,
      status: 'ACTIVE',
    });
    // The grant is recorded first, then the verified cancellation.
    expect(await historyOf(b)).toEqual([
      'COMPLIMENTARY_SCHEDULED',
      'CANCEL_SCHEDULED',
    ]);
    // Nothing refunded or credited; one cancellation request.
    expect(fake.calls.filter((c) => /refund|credit/i.test(c.op))).toEqual([]);
    expect(cancelCalls(view.current!.id)).toBe(1);

    // A delayed subscription event while still active changes nothing.
    await deliver(b, 'subscription.changed').expect(200);
    expect((await grantsOf(b))[0].status).toBe('SCHEDULED');

    // The period ends; the provider ends the subscription; its webhook
    // starts the arrangement.
    fake.endSubscription(b.sub);
    await deliver(b, 'subscription.ended').expect(200);
    const started = await subscriptionOf(b);
    expect(started).toMatchObject({
      billingMode: 'COMPLIMENTARY',
      planVersionId: versions.growth,
      planPriceId: null,
      billingProvider: null,
      externalSubscriptionId: null,
      externalCustomerId: null,
      status: 'ACTIVE',
    });
    expect((await grantsOf(b))[0]).toMatchObject({ status: 'ACTIVE' });
    expect((await grantsOf(b))[0].startedAt).toBeInstanceOf(Date);
    expect(
      (await historyOf(b)).filter((t) => t === 'COMPLIMENTARY_STARTED'),
    ).toHaveLength(1);
    // History and invoices kept.
    expect(
      await prisma.billingInvoice.count({
        where: { subscriptionId: b.subscriptionId },
      }),
    ).toBe(1);
    // A duplicate and a late event: nothing more.
    await deliver(b, 'subscription.ended').expect(200);
    await complimentary.sweep();
    expect(
      (await historyOf(b)).filter((t) => t === 'COMPLIMENTARY_STARTED'),
    ).toHaveLength(1);
    expect(await subscriptionOf(b)).toMatchObject({
      billingMode: 'COMPLIMENTARY',
    });
    // Visible in the console.
    const list = (
      await asOperator('none', 'get', '/billing/complimentary').expect(200)
    ).body as PlatformComplimentaryListResponse;
    expect(list.grants.find((g) => g.tenantId === b.tenantId)).toMatchObject({
      status: 'ACTIVE',
      businessName: 'SC3e2 paid',
    });
    const overview = (
      await asOperator('none', 'get', '/billing/overview').expect(200)
    ).body as { complimentary: { active: number } };
    expect(overview.complimentary.active).toBeGreaterThanOrEqual(1);
  });

  it('refuses while anything is unpaid or open, and validates every input', async () => {
    // Unpaid: an open invoice on an EARLIER subscription of the customer.
    const debt = await business('debt');
    fake.setInvoice(
      `in_old_${run}`,
      'open',
      `fake_sub_old_${run}`,
      debt.customer,
      { amountMinorUnits: 4900 },
    );
    expect(codeOf(await grant(debt).expect(409))).toBe(
      'BILLING_COMPLIMENTARY_UNPAID_INVOICES',
    );
    fake.setInvoice(
      `in_old_${run}`,
      'uncollectible',
      `fake_sub_old_${run}`,
      debt.customer,
      { amountMinorUnits: 4900 },
    );
    expect(codeOf(await grant(debt).expect(409))).toBe(
      'BILLING_COMPLIMENTARY_UNPAID_INVOICES',
    );
    expect(await grantsOf(debt)).toEqual([]);
    // Delinquent.
    const late = await business('late', 'paying', { status: 'PAST_DUE' });
    expect(codeOf(await grant(late).expect(409))).toBe(
      'BILLING_COMPLIMENTARY_UNPAID_INVOICES',
    );
    // A schedule attached at the provider.
    const scheduled = await business('sched');
    fake.subscriptions.set(scheduled.sub, {
      ...fake.subscriptions.get(scheduled.sub)!,
      scheduleId: 'fake_sched_x',
    });
    expect(codeOf(await grant(scheduled).expect(409))).toBe(
      'BILLING_COMPLIMENTARY_NOT_ELIGIBLE',
    );
    // An open Checkout.
    const checkout = await business('checkout', 'awaiting');
    await prisma.billingCheckoutSession.create({
      data: {
        subscriptionId: checkout.subscriptionId,
        planPriceId: prices.pro,
        trialDays: 0,
        requiresPaymentMethod: true,
      },
    });
    expect(codeOf(await grant(checkout).expect(409))).toBe(
      'BILLING_COMPLIMENTARY_NOT_ELIGIBLE',
    );
    // Inputs.
    const ok = await business('inputs');
    await grant(ok, { planVersionId: versions.draft }).expect(400);
    await grant(ok, { planVersionId: 'not-a-uuid' }).expect(400);
    await grant(ok, {
      endsAt: new Date(Date.now() + 60 * MINUTE).toISOString(),
    }).expect(400);
    await grant(ok, {
      endsAt: new Date(Date.now() + 4 * 365 * DAY).toISOString(),
    }).expect(400);
    await grant(ok, { reason: 'too short' }).expect(400);
    await grant(ok, { extra: true }).expect(400);
    // A recent sign-in is required.
    expect(codeOf(await grant(ok, {}, 'comp', 3600).expect(401))).toBe(
      'REAUTHENTICATION_REQUIRED',
    );
    // Two at once: one.
    const results = await Promise.all([grant(ok), grant(ok)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await grantsOf(ok)).toHaveLength(1);
    // Already open / already complimentary.
    expect(codeOf(await grant(ok).expect(409))).toBe(
      'BILLING_COMPLIMENTARY_IN_PROGRESS',
    );
  });

  it('a scheduled arrangement can be withdrawn (cancellation undone, verified); another business never reached', async () => {
    const b = await business('withdraw');
    const view = (await grant(b).expect(200)).body as PlatformComplimentaryView;
    const id = view.current!.id;
    const other = await business('withdraw-other');
    await asOperator(
      'comp',
      'post',
      `/tenants/${other.tenantId}/billing/complimentary/${id}/withdraw`,
      { reason: 'Not this business at all.' },
    ).expect(404);
    await asOperator(
      'comp',
      'post',
      `/tenants/${b.tenantId}/billing/complimentary/${id}/withdraw`,
      { reason: 'x' },
    ).expect(400);
    const after = (
      await asOperator(
        'comp',
        'post',
        `/tenants/${b.tenantId}/billing/complimentary/${id}/withdraw`,
        { reason: 'The partner deal fell through.' },
      ).expect(200)
    ).body as PlatformComplimentaryView;
    expect(after.current).toBeNull();
    expect(after.history[0]).toMatchObject({
      status: 'WITHDRAWN',
      finishCode: 'WITHDRAWN',
      finishedBy: { email: operators.comp.email },
    });
    expect(fake.subscriptions.get(b.sub)!.cancelAtPeriodEnd).toBe(false);
    expect(await subscriptionOf(b)).toMatchObject({
      billingMode: 'BILLED',
      cancelAtPeriodEnd: false,
      planVersionId: versions.pro,
    });
    expect(await historyOf(b)).toEqual([
      'COMPLIMENTARY_SCHEDULED',
      'CANCEL_SCHEDULED',
      'CANCEL_UNDONE',
      'COMPLIMENTARY_WITHDRAWN',
    ]);
    // Once ended, too late.
    const ended = await business('withdraw-late');
    const v2 = (await grant(ended).expect(200))
      .body as PlatformComplimentaryView;
    fake.endSubscription(ended.sub);
    expect(
      codeOf(
        await asOperator(
          'comp',
          'post',
          `/tenants/${ended.tenantId}/billing/complimentary/${v2.current!.id}/withdraw`,
          { reason: 'Too late to withdraw now.' },
        ).expect(409),
      ),
    ).toBe('BILLING_COMPLIMENTARY_NOT_WITHDRAWABLE');
  });

  it('a cancellation undone outside CENTERIVO withdraws the arrangement and is reviewed — never re-issued', async () => {
    const b = await business('undone');
    const view = (await grant(b).expect(200)).body as PlatformComplimentaryView;
    fake.subscriptions.set(b.sub, {
      ...fake.subscriptions.get(b.sub)!,
      cancelAtPeriodEnd: false,
    });
    await complimentary.sweep();
    expect((await grantsOf(b))[0]).toMatchObject({
      status: 'WITHDRAWN',
      finishCode: 'PROVIDER_UNDONE',
    });
    expect(await casesOf(b)).toContain('COMPLIMENTARY_CANCELLATION_UNDONE');
    expect(cancelCalls(view.current!.id)).toBe(1);
    expect(await subscriptionOf(b)).toMatchObject({
      billingMode: 'BILLED',
      cancelAtPeriodEnd: false,
    });
  });

  it('a cancellation the provider did not apply is re-sent with the same key in its window, then withdrawn', async () => {
    const b = await business('unverified');
    fake.ignoreCancelRequests = true;
    const view = (await grant(b).expect(200)).body as PlatformComplimentaryView;
    expect(view.current).toMatchObject({
      status: 'SCHEDULED',
      cancellationVerified: false,
      attention: 'CANCELLATION_UNVERIFIED',
    });
    await complimentary.sweep(new Date(Date.now() + 5 * MINUTE));
    expect(cancelCalls(view.current!.id)).toBe(2);
    expect(
      fake.calls
        .filter(
          (c) =>
            c.op === 'setCancelAtPeriodEnd' && c.key.includes(view.current!.id),
        )
        .every((c) => c.key.endsWith('-cancel')),
    ).toBe(true);
    await complimentary.sweep(new Date(Date.now() + 31 * MINUTE));
    fake.ignoreCancelRequests = false;
    expect((await grantsOf(b))[0]).toMatchObject({
      status: 'WITHDRAWN',
      finishCode: 'NOT_SUBMITTED',
    });
    expect(await subscriptionOf(b)).toMatchObject({
      billingMode: 'BILLED',
      cancelAtPeriodEnd: false,
    });
  });

  it('never starts while the customer owes money at the end of the paid period (debt is never waived)', async () => {
    const b = await business('debt-at-end');
    const view = (await grant(b).expect(200)).body as PlatformComplimentaryView;
    expect(view.current).toMatchObject({
      status: 'SCHEDULED',
      cancellationVerified: true,
    });
    // The renewal failed; the provider ended the subscription with the
    // invoice still open.
    fake.setInvoice(`in_dunning_${run}`, 'open', b.sub, b.customer, {
      amountMinorUnits: 9900,
    });
    fake.endSubscription(b.sub);
    await deliver(b, 'subscription.ended').expect(200);
    expect((await grantsOf(b))[0]).toMatchObject({
      status: 'WITHDRAWN',
      finishCode: 'UNPAID_AT_END',
    });
    expect(await subscriptionOf(b)).toMatchObject({ billingMode: 'BILLED' });
    expect(await casesOf(b)).toContain('COMPLIMENTARY_NOT_STARTED');
  });

  it('billing cannot be started on a business under an open arrangement (only ending it does)', async () => {
    const b = await business('start-blocked', 'ended');
    await grant(b).expect(200);
    expect(
      codeOf(
        await asOperator(
          'all',
          'post',
          `/tenants/${b.tenantId}/billing/start`,
          {
            planPriceId: prices.growth,
          },
        ).expect(409),
      ),
    ).toBe('BILLING_COMPLIMENTARY_IN_PROGRESS');
    expect(await subscriptionOf(b)).toMatchObject({
      billingMode: 'COMPLIMENTARY',
    });
  });

  // --- D4: expiry and revocation -------------------------------------------------------

  it('an ended subscription: complimentary at once; expiry returns it to billing (restart), never charged, no new trial, nothing reactivated', async () => {
    const b = await business('expiry', 'ended');
    const endsAt = new Date(Date.now() + 2 * DAY);
    const view = (await grant(b, { endsAt: endsAt.toISOString() }).expect(200))
      .body as PlatformComplimentaryView;
    expect(view.current).toMatchObject({
      status: 'ACTIVE',
      previousStatus: 'CANCELED',
    });
    expect(await subscriptionOf(b)).toMatchObject({
      billingMode: 'COMPLIMENTARY',
      planVersionId: versions.growth,
    });
    expect(cancelCalls(view.current!.id)).toBe(0);
    // Not yet.
    await complimentary.sweep(new Date(endsAt.getTime() - MINUTE));
    expect((await grantsOf(b))[0].status).toBe('ACTIVE');
    const writesBefore = fake.calls.filter((c) =>
      [
        'createCheckoutSession',
        'setCancelAtPeriodEnd',
        'changePriceNow',
      ].includes(c.op),
    ).length;
    await complimentary.sweep(new Date(endsAt.getTime() + MINUTE));
    expect((await grantsOf(b))[0]).toMatchObject({
      status: 'ENDED',
      finishCode: 'EXPIRED',
    });
    expect(await subscriptionOf(b)).toMatchObject({
      billingMode: 'BILLED',
      status: 'CANCELED',
      planVersionId: versions.pro,
      planPriceId: prices.pro,
      externalSubscriptionId: b.sub,
      externalCustomerId: b.customer,
    });
    expect(
      fake.calls.filter((c) =>
        [
          'createCheckoutSession',
          'setCancelAtPeriodEnd',
          'changePriceNow',
        ].includes(c.op),
      ).length,
    ).toBe(writesBefore);
    expect((await historyOf(b)).slice(-2)).toEqual([
      'COMPLIMENTARY_STARTED',
      'COMPLIMENTARY_ENDED',
    ]);
    // The business sees an ended subscription to restart (a new Checkout).
    const billing = (
      await request(app.getHttpServer())
        .get('/api/v1/admin/billing')
        .set('Authorization', `Bearer ${staffToken(b.key)}`)
        .set('X-Tenant-Id', b.tenantId)
        .expect(200)
    ).body as { billing: { state: string }; canRestartSubscription: boolean };
    expect(billing).toMatchObject({
      billing: { state: 'CANCELED' },
      canRestartSubscription: true,
    });
  });

  it('revoking for a business that never set up payment: back to payment setup, no trial offered', async () => {
    const b = await business('revoke', 'awaiting');
    const view = (await grant(b).expect(200)).body as PlatformComplimentaryView;
    const id = view.current!.id;
    await asOperator(
      'comp',
      'post',
      `/tenants/${b.tenantId}/billing/complimentary/${id}/withdraw`,
      { reason: 'Active grants are revoked.' },
    ).expect(409);
    await asOperator(
      'cases',
      'post',
      `/tenants/${b.tenantId}/billing/complimentary/${id}/revoke`,
      { reason: 'Without the permission.' },
    ).expect(403);
    const after = (
      await asOperator(
        'comp',
        'post',
        `/tenants/${b.tenantId}/billing/complimentary/${id}/revoke`,
        { reason: 'Partner agreement ended early.' },
      ).expect(200)
    ).body as PlatformComplimentaryView;
    expect(after.history[0]).toMatchObject({
      status: 'ENDED',
      finishCode: 'REVOKED',
    });
    expect(await subscriptionOf(b)).toMatchObject({
      billingMode: 'BILLED',
      status: 'ACTIVE',
      externalSubscriptionId: null,
    });
    // Payment setup: never a trial after a complimentary arrangement.
    await request(app.getHttpServer())
      .post('/api/v1/admin/billing/checkout')
      .set('Authorization', `Bearer ${staffToken(b.key)}`)
      .set('X-Tenant-Id', b.tenantId)
      .expect(201);
    // Trials are offered by policy — just not after an arrangement.
    expect(
      (
        await prisma.billingPolicy.findUniqueOrThrow({
          where: { id: 'default' },
        })
      ).trialDays,
    ).toBeGreaterThan(0);
    const session = await prisma.billingCheckoutSession.findFirstOrThrow({
      where: { subscriptionId: b.subscriptionId },
    });
    expect(session.trialDays).toBe(0);
  });

  it('a SECURITY suspension is never lifted by a complimentary arrangement', async () => {
    const b = await business('security', 'ended');
    await prisma.tenant.update({
      where: { id: b.tenantId },
      data: { status: 'SUSPENDED', suspensionReason: 'SECURITY' },
    });
    await grant(b).expect(200);
    expect(
      await prisma.tenant.findUniqueOrThrow({ where: { id: b.tenantId } }),
    ).toMatchObject({
      status: 'SUSPENDED',
      suspensionReason: 'SECURITY',
    });
  });

  // --- D5: review cases ---------------------------------------------------------------

  it('review cases: recheck (no write), a verified schedule release (never cancelled), close with an outcome and a note', async () => {
    const b = await business('case');
    const other = await business('case-other');
    // A leftover schedule on b's subscription, and one on another's.
    const { externalScheduleId } = await fake.schedulePriceChangeAtPeriodEnd({
      idempotencyKey: `leftover-${run}`,
      externalSubscriptionId: b.sub,
      fromExternalPriceId: `fake_price_pro_${run}`,
      toExternalPriceId: `fake_price_growth_${run}`,
      toInterval: 'MONTH',
    });
    const { externalScheduleId: foreign } =
      await fake.schedulePriceChangeAtPeriodEnd({
        idempotencyKey: `leftover-other-${run}`,
        externalSubscriptionId: other.sub,
        fromExternalPriceId: `fake_price_pro_${run}`,
        toExternalPriceId: `fake_price_growth_${run}`,
        toInterval: 'MONTH',
      });
    const reviewCase = await prisma.billingReconciliationCase.create({
      data: {
        kind: 'SCHEDULED_CHANGE_DISRUPTED',
        subscriptionId: b.subscriptionId,
        detail: 'Leftover schedule.',
      },
    });
    const detail = (
      await asOperator(
        'none',
        'get',
        `/billing/reconciliation-cases/${reviewCase.id}`,
      ).expect(200)
    ).body as PlatformCaseDetailResponse;
    expect(detail.provider).toMatchObject({
      schedule: { externalScheduleId, status: 'active' },
      scheduleIsOpenPlanChange: false,
    });
    // Recheck: the provider read again, nothing written.
    const writes = () =>
      fake.calls.filter((c) =>
        [
          'releaseSchedule',
          'setCancelAtPeriodEnd',
          'changePriceNow',
          'schedulePriceChangeAtPeriodEnd',
        ].includes(c.op),
      ).length;
    const before = writes();
    await asOperator(
      'none',
      'post',
      `/billing/reconciliation-cases/${reviewCase.id}/recheck`,
      {},
    ).expect(403);
    const recheck = await asOperator(
      'cases',
      'post',
      `/billing/reconciliation-cases/${reviewCase.id}/recheck`,
      {},
    ).expect(200);
    expect(['CONSISTENT', 'MISMATCH_FOUND']).toContain(
      (recheck.body as { result: string }).result,
    );
    expect(writes()).toBe(before);
    // Release: its own permission, a recent sign-in, the exact schedule.
    const release = (body: unknown, key = 'release', ago = 0) =>
      asOperator(
        key,
        'post',
        `/billing/reconciliation-cases/${reviewCase.id}/release-schedule`,
        body,
        ago,
      );
    await release(
      { externalScheduleId, reason: 'Leftover from a disrupted change.' },
      'cases',
    ).expect(403);
    await release(
      { externalScheduleId, reason: 'Leftover from a disrupted change.' },
      'release',
      3600,
    ).expect(401);
    await release({ externalScheduleId, reason: 'x' }).expect(400);
    expect(
      codeOf(
        await release({
          externalScheduleId: foreign,
          reason: 'Someone else’s schedule.',
        }).expect(409),
      ),
    ).toBe('BILLING_CASE_SCHEDULE_MISMATCH');
    // A schedule an open scheduled plan change holds: not here.
    const holder = await prisma.billingPlanChange.findFirst({
      where: { externalScheduleId },
    });
    expect(holder).toBeNull();
    const released = (
      await release({
        externalScheduleId,
        reason: 'Leftover from a disrupted change.',
      }).expect(200)
    ).body as PlatformCaseDetailResponse;
    expect(
      fake.calls.filter(
        (c) =>
          c.op === 'releaseSchedule' &&
          c.key ===
            `centerivo-case-${reviewCase.id}-release-${externalScheduleId}`,
      ),
    ).toHaveLength(1);
    // Released, never cancelled: the subscription is untouched; the other
    // business's schedule too.
    expect(fake.subscriptions.get(b.sub)).toMatchObject({
      status: 'active',
      scheduleId: null,
    });
    expect(fake.subscriptions.get(other.sub)!.scheduleId).toBe(foreign);
    expect(released.actions.map((a) => a.action)).toEqual([
      'RECHECKED',
      'SCHEDULE_RELEASED',
    ]);
    expect(released.actions[1]).toMatchObject({
      externalScheduleId,
      note: 'Leftover from a disrupted change.',
      actor: { email: operators.release.email },
    });
    // Nothing left to release now.
    expect(
      codeOf(
        await release({
          externalScheduleId,
          reason: 'Again, by mistake.',
        }).expect(409),
      ),
    ).toBe('BILLING_CASE_SCHEDULE_MISMATCH');
    // Close: an outcome and a note.
    await asOperator(
      'cases',
      'post',
      `/billing/reconciliation-cases/${reviewCase.id}/resolve`,
      {},
    ).expect(400);
    await asOperator(
      'cases',
      'post',
      `/billing/reconciliation-cases/${reviewCase.id}/resolve`,
      { outcome: 'ADOPT_PRICE', note: 'No.' },
    ).expect(400);
    await asOperator(
      'cases',
      'post',
      `/billing/reconciliation-cases/${reviewCase.id}/resolve`,
      { outcome: 'SCHEDULE_RELEASED', note: 'Released the leftover schedule.' },
    ).expect(200);
    expect(
      codeOf(
        await asOperator(
          'cases',
          'post',
          `/billing/reconciliation-cases/${reviewCase.id}/resolve`,
          {
            outcome: 'SCHEDULE_RELEASED',
            note: 'Released the leftover schedule.',
          },
        ).expect(409),
      ),
    ).toBe('CASE_ALREADY_RESOLVED');
    const closed = (
      await asOperator(
        'none',
        'get',
        `/billing/reconciliation-cases/${reviewCase.id}`,
      ).expect(200)
    ).body as PlatformCaseDetailResponse;
    expect(closed.case).toMatchObject({
      status: 'RESOLVED',
      resolutionOutcome: 'SCHEDULE_RELEASED',
      resolutionNote: 'Released the leftover schedule.',
    });
    expect(closed.actions.map((a) => a.action)).toEqual([
      'RECHECKED',
      'SCHEDULE_RELEASED',
      'CLOSED',
    ]);
    // The history is append-only.
    const action =
      await prisma.billingReconciliationCaseAction.findFirstOrThrow({
        where: { caseId: reviewCase.id },
      });
    await expect(
      prisma.billingReconciliationCaseAction.update({
        where: { id: action.id },
        data: { note: 'edited' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.billingReconciliationCaseAction.delete({
        where: { id: action.id },
      }),
    ).rejects.toThrow();
    // Unknown case.
    await asOperator(
      'cases',
      'post',
      `/billing/reconciliation-cases/${randomUUID()}/recheck`,
      {},
    ).expect(404);
  });

  it('a schedule an open scheduled plan change holds is not releasable here', async () => {
    const b = await business('case-held');
    const { externalScheduleId } = await fake.schedulePriceChangeAtPeriodEnd({
      idempotencyKey: `held-${run}`,
      externalSubscriptionId: b.sub,
      fromExternalPriceId: `fake_price_pro_${run}`,
      toExternalPriceId: `fake_price_growth_${run}`,
      toInterval: 'MONTH',
    });
    const sub = await subscriptionOf(b);
    await prisma.billingPlanChange
      .create({
        data: {
          subscriptionId: b.subscriptionId,
          timing: 'PERIOD_END',
          status: 'PREVIEWED',
          fromPlanVersionId: sub.planVersionId,
          fromPlanPriceId: prices.pro,
          toPlanVersionId: versions.growth,
          toPlanPriceId: prices.growth,
          currency: 'USD',
          nextRecurringMinorUnits: 4900,
          nextRecurringStartsAt: sub.currentPeriodEnd,
          previewExpiresAt: new Date(Date.now() + 10 * MINUTE),
          actorKind: 'STAFF',
        },
      })
      .then((change) =>
        prisma.billingPlanChange.update({
          where: { id: change.id },
          data: { status: 'REQUESTED', confirmedAt: new Date() },
        }),
      )
      .then((change) =>
        prisma.billingPlanChange.update({
          where: { id: change.id },
          data: { status: 'SCHEDULED', externalScheduleId },
        }),
      );
    const reviewCase = await prisma.billingReconciliationCase.create({
      data: { kind: 'PRICE_MISMATCH', subscriptionId: b.subscriptionId },
    });
    expect(
      codeOf(
        await asOperator(
          'release',
          'post',
          `/billing/reconciliation-cases/${reviewCase.id}/release-schedule`,
          { externalScheduleId, reason: 'Trying to release it.' },
        ).expect(409),
      ),
    ).toBe('BILLING_CASE_NOT_RELEASABLE');
    expect(fake.subscriptions.get(b.sub)!.scheduleId).toBe(externalScheduleId);
  });

  // --- D6: invoice history across a verified earlier subscription ------------------------

  it('invoices of an earlier subscription replaced by our own restart Checkout stay in the history; others never', async () => {
    const b = await business('restarted');
    const old = `fake_sub_restarted_old_${run}`;
    await prisma.billingCheckoutSession.create({
      data: {
        subscriptionId: b.subscriptionId,
        planPriceId: prices.pro,
        externalSessionId: `cs_${run}_restart`,
        status: 'COMPLETED',
        trialDays: 0,
        requiresPaymentMethod: true,
        replacesExternalSubscriptionId: old,
        completedAt: new Date(),
      },
    });
    fake.setInvoice(`in_old_paid_${run}`, 'paid', old, b.customer, {
      amountMinorUnits: 9900,
    });
    fake.setInvoice(
      `in_stranger_${run}`,
      'paid',
      `fake_sub_stranger_${run}`,
      b.customer,
      { amountMinorUnits: 9900 },
    );
    // An event naming the old subscription's invoice: recorded for b.
    await deliver(b, 'invoice.changed', {
      subscription: old,
      reference: `in_old_paid_${run}`,
    }).expect(200);
    // A subscription no record of ours proves: never.
    await deliver(b, 'invoice.changed', {
      subscription: `fake_sub_stranger_${run}`,
      reference: `in_stranger_${run}`,
    }).expect(200);
    const rows = await prisma.billingInvoice.findMany({
      where: { subscriptionId: b.subscriptionId },
    });
    expect(rows.map((r) => r.externalInvoiceId)).toEqual([
      `in_old_paid_${run}`,
    ]);
    // The reconciliation backfill reads the old subscription too.
    fake.setInvoice(`in_old_second_${run}`, 'paid', old, b.customer, {
      amountMinorUnits: 9900,
    });
    await asOperator('all', 'post', '/billing/reconcile', {}).expect(200);
    expect(
      (
        await prisma.billingInvoice.findMany({
          where: { subscriptionId: b.subscriptionId },
        })
      )
        .map((r) => r.externalInvoiceId)
        .sort(),
    ).toEqual([`in_old_paid_${run}`, `in_old_second_${run}`].sort());
    void lifecycle;
  });
});
