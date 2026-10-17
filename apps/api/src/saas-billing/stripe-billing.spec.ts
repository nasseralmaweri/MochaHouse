import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  AdminBillingCheckoutResponse,
  AdminBillingResponse,
  InternalPermissionKey,
  PlatformReconciliationCaseListResponse,
  PlatformReconciliationRunResponse,
  PlatformTenantBillingResponse,
} from '@mocha-house/contracts';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  type ScratchDatabase,
} from '@mocha-house/testing';
import { AppModule } from '../app.module';
import { grantPlatformPermissions } from '../../test/platform-permissions';
import { PrismaService } from '../prisma/prisma.service';
import { signPlatformDevJwt } from '../platform-auth/infrastructure/platform-dev-jwt';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import type {
  FakeEventBody,
  FakeSaasBillingProvider,
} from './provider/fake-saas-billing-provider';
import { SAAS_BILLING_PROVIDER } from './provider/saas-billing-provider';
import { BillingLifecycleService } from './application/billing-lifecycle.service';

// SC3b — billing through the provider boundary (the fake provider, signed
// like Stripe; the Stripe adapter itself is covered against the real SDK in
// stripe-saas-billing-provider.spec.ts), end to end on the real AppModule
// with raw-body webhooks, in a SCRATCH database:
//   * an operator starts billing (guards: Founding, plan price, recent
//     sign-in); the owner opens hosted Checkout from TRUSTED context only —
//     no client value is read, one open session at a time, reused;
//   * webhooks: signature over the raw body, unknown sessions and customers,
//     live mode, duplicate / delayed / out-of-order delivery, transient
//     provider failure (503, then applied), a suspended business;
//   * trial safety: a cardless trial expires (distinct from cancellation)
//     and nothing is charged; an authorized trial converts; one trial per
//     owner email;
//   * tenant isolation and permissions; review-only reconciliation;
//   * restaurant payments untouched.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);

describe('SC3b Stripe-mode billing (integration, scratch database)', () => {
  let scratch: ScratchDatabase;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let fake: FakeSaasBillingProvider;
  const originalEnv = { ...process.env };
  const PLATFORM_SECRET = `sc3b-platform-${randomUUID()}`;
  const INTERNAL_SECRET = `sc3b-internal-${randomUUID()}`;
  const run = randomUUID().replace(/-/g, '').slice(0, 8);
  let planId: string;
  let versionId: string;
  let priceId: string;
  let paymentAttemptsBefore: number;

  const ALL: InternalPermissionKey[] = ['billing.view', 'billing.manage'];

  const operatorToken = (iat?: number) =>
    signPlatformDevJwt(
      { sub: `platform-dev:sc3b-${run}`, mfa: true, ...(iat ? { iat } : {}) },
      PLATFORM_SECRET,
      3600,
    );
  const staffToken = (key: string) =>
    signInternalDevJwt(
      {
        sub: `internal-dev:sc3b-${key}-${run}`,
        email: `sc3b-${key}-${run}@example.com`,
        name: null,
        email_verified: true,
      },
      INTERNAL_SECRET,
      3600,
    );
  const platform = (
    method: 'get' | 'post',
    path: string,
    body?: object,
    token = operatorToken(),
  ) => {
    const req = request(app.getHttpServer())
      [method](`/api/v1/platform${path}`)
      .set('Authorization', `Bearer ${token}`);
    return body ? req.send(body) : req;
  };
  const admin = (
    method: 'get' | 'post',
    staffKey: string,
    tenantId: string,
    path: string,
    body?: object,
  ) => {
    const req = request(app.getHttpServer())
      [method](`/api/v1/admin${path}`)
      .set('Authorization', `Bearer ${staffToken(staffKey)}`)
      .set('X-Tenant-Id', tenantId);
    return body ? req.send(body) : req;
  };

  let seq = 0;
  // A signed webhook delivered over HTTP (raw body, signature header).
  async function webhook(
    type: string,
    data: FakeEventBody['data'],
    over: Partial<FakeEventBody> = {},
  ) {
    const created = Math.floor(Date.now() / 1000);
    const body: FakeEventBody = {
      id: `evt_${run}_${seq++}`,
      type,
      created,
      livemode: false,
      data,
      ...over,
    };
    const signed = fake.signEvent(body);
    const res = await request(app.getHttpServer())
      .post('/api/v1/billing/webhooks/fake')
      .set('Content-Type', 'application/json')
      .set('x-billing-signature', signed.signatureHeader)
      .send(signed.rawBody);
    return { res, body, signed };
  }
  const redeliver = (signed: { rawBody: string; signatureHeader: string }) =>
    request(app.getHttpServer())
      .post('/api/v1/billing/webhooks/fake')
      .set('Content-Type', 'application/json')
      .set('x-billing-signature', signed.signatureHeader)
      .send(signed.rawBody);

  // A business on the Growth plan with a staff member holding `permissions`.
  async function business(
    label: string,
    permissions: InternalPermissionKey[] = ALL,
    ownerKey = label,
  ) {
    const tenantId = randomUUID();
    await prisma.tenant.create({
      data: {
        id: tenantId,
        slug: `sc3b-${label}-${run}`,
        name: `SC3b ${label}`,
        status: 'ACTIVE',
      },
    });
    await prisma.tenantSubscription.create({
      data: { subscriberTenantId: tenantId, planVersionId: versionId },
    });
    await staff(tenantId, ownerKey, permissions, true);
    return tenantId;
  }

  async function staff(
    tenantId: string,
    key: string,
    permissions: InternalPermissionKey[],
    administrator: boolean,
  ) {
    const role = administrator
      ? await prisma.internalRole.create({
          data: {
            tenantId,
            key: 'platform-administrator',
            displayName: 'Platform Administrator',
            permissions: {
              create: permissions.map((permissionKey) => ({ permissionKey })),
            },
          },
        })
      : await prisma.internalRole.create({
          data: {
            tenantId,
            key: `viewer-${key}-${run}`,
            displayName: 'Viewer',
            permissions: {
              create: permissions.map((permissionKey) => ({ permissionKey })),
            },
          },
        });
    const user = await prisma.internalUser.create({
      data: {
        tenantId,
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:sc3b-${key}-${run}`,
        email: `sc3b-${key}-${run}@example.com`,
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

  const subscriptionOf = (tenantId: string) =>
    prisma.tenantSubscription.findUniqueOrThrow({
      where: { subscriberTenantId: tenantId },
    });

  async function startBilling(tenantId: string) {
    return (
      await platform('post', `/tenants/${tenantId}/billing/start`, {
        planPriceId: priceId,
      }).expect(200)
    ).body as PlatformTenantBillingResponse;
  }

  async function openCheckout(tenantId: string, key: string) {
    const res = await admin('post', key, tenantId, '/billing/checkout').expect(
      201,
    );
    const url = (res.body as AdminBillingCheckoutResponse).url;
    const sessionId = url.split('/').pop()!;
    return { url, sessionId };
  }

  async function setPolicy(
    trialDays: number,
    trialRequiresPaymentMethod: boolean,
  ) {
    await prisma.billingPolicy.update({
      where: { id: 'default' },
      data: { trialDays, trialRequiresPaymentMethod },
    });
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3b_billing',
    );
    await applyMigrations(scratch.url, listMigrations(MIGRATIONS));
    process.env.DATABASE_URL = scratch.url;
    process.env.PLATFORM_AUTH_PROVIDER = 'dev';
    process.env.PLATFORM_AUTH_DEV_JWT_SECRET = PLATFORM_SECRET;
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = INTERNAL_SECRET;
    process.env.RATE_LIMIT_ENABLED = '0';
    process.env.SAAS_BILLING_PROVIDER = 'fake';
    process.env.SAAS_BILLING_TRIAL_CLAIM_SECRET = `sc3b-claims-${randomUUID()}`;
    process.env.BILLING_CHECKOUT_RETURN_URL =
      'https://admin.example.test/admin/billing';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({
      rawBody: true,
    });
    await app.init();
    prisma = app.get(PrismaService);
    fake = app.get(SAAS_BILLING_PROVIDER);

    const grantee = await prisma.platformOperator.create({
      data: {
        externalProvider: 'platform-dev',
        externalSubject: `platform-dev:sc3b-${run}`,
        email: `sc3b-${run}@example.test`,
        status: 'ACTIVE',
      },
    });
    await grantPlatformPermissions(prisma, grantee.id);
    const plan = await prisma.subscriptionPlan.create({
      data: { key: `growth-${run}`, name: 'Growth' },
    });
    planId = plan.id;
    const version = await prisma.subscriptionPlanVersion.create({
      data: { planId, version: 1, moduleKeys: ['crm'] },
    });
    await prisma.subscriptionPlanVersion.update({
      where: { id: version.id },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });
    versionId = version.id;
    priceId = (
      await prisma.subscriptionPlanPrice.create({
        data: {
          planId,
          interval: 'MONTH',
          currency: 'USD',
          amountMinorUnits: 4900,
        },
      })
    ).id;
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

  // --- Starting billing (operator) --------------------------------------------

  it('an operator starts billing at an ACTIVE price of the plan; Founding, foreign and archived prices, repeats and stale sign-ins are refused', async () => {
    const tenantId = await business('start');
    await platform(
      'post',
      `/tenants/${tenantId}/billing/start`,
      { planPriceId: priceId },
      operatorToken(Math.floor(Date.now() / 1000) - 20 * 60),
    ).expect(401);

    const started = await startBilling(tenantId);
    expect(started.billing).toMatchObject({
      state: 'AWAITING_SETUP',
      price: { amountMinorUnits: 4900, currency: 'USD', interval: 'MONTH' },
      paymentMethodOnFile: false,
    });
    const sub = await subscriptionOf(tenantId);
    expect(sub).toMatchObject({
      billingMode: 'BILLED',
      billingProvider: 'fake',
      planPriceId: priceId,
      externalSubscriptionId: null,
    });
    expect(sub.externalCustomerId).toMatch(/^fake_cus_/);
    // Deterministic customer: the same subscription's key.
    expect(
      fake.calls.filter(
        (c) =>
          c.op === 'createCustomer' && c.key === `centerivo-customer-${sub.id}`,
      ),
    ).toHaveLength(1);
    expect(
      await prisma.platformAuditEvent.count({
        where: {
          action: 'platform.tenant.billing_started',
          targetId: tenantId,
        },
      }),
    ).toBe(1);

    const again = await platform('post', `/tenants/${tenantId}/billing/start`, {
      planPriceId: priceId,
    }).expect(409);
    expect(again.body).toMatchObject({ code: 'ALREADY_BILLED' });

    const founding = await platform(
      'post',
      `/tenants/${TENANT_1_MOCHA_HOUSE_ID}/billing/start`,
      { planPriceId: priceId },
    ).expect(409);
    expect(founding.body).toMatchObject({ code: 'FOUNDING_COMPLIMENTARY' });

    const other = await prisma.subscriptionPlan.create({
      data: { key: `other-${run}`, name: 'Other' },
    });
    const foreignPrice = await prisma.subscriptionPlanPrice.create({
      data: {
        planId: other.id,
        interval: 'MONTH',
        currency: 'USD',
        amountMinorUnits: 100,
      },
    });
    const second = await business('start2');
    expect(
      (
        await platform('post', `/tenants/${second}/billing/start`, {
          planPriceId: foreignPrice.id,
        }).expect(409)
      ).body,
    ).toMatchObject({
      code: 'PRICE_NOT_FOR_PLAN',
    });
    const archived = await prisma.subscriptionPlanPrice.create({
      data: {
        planId,
        interval: 'YEAR',
        currency: 'USD',
        amountMinorUnits: 49000,
        status: 'ARCHIVED',
        archivedAt: new Date(),
      },
    });
    expect(
      (
        await platform('post', `/tenants/${second}/billing/start`, {
          planPriceId: archived.id,
        }).expect(409)
      ).body,
    ).toMatchObject({
      code: 'PRICE_NOT_ACTIVE',
    });
    await platform('post', `/tenants/${second}/billing/start`, {
      planPriceId: priceId,
      extra: 1,
    }).expect(400);
    expect((await subscriptionOf(second)).billingMode).toBe('COMPLIMENTARY');
  });

  // --- Checkout (owner) ---------------------------------------------------------

  it('the owner opens ONE Checkout from trusted context only; it is reused; client-sent ids are ignored', async () => {
    await setPolicy(14, true);
    const tenantId = await business('checkout');
    await startBilling(tenantId);
    const view = (
      await admin('get', 'checkout', tenantId, '/billing').expect(200)
    ).body as AdminBillingResponse;
    expect(view).toMatchObject({
      billing: { state: 'AWAITING_SETUP' },
      canSetUpPayment: true,
    });

    const evil = {
      planPriceId: randomUUID(),
      externalCustomerId: 'cus_attacker',
      tenantId: TENANT_1_MOCHA_HOUSE_ID,
      priceId: 'price_attacker',
    };
    const first = await admin(
      'post',
      'checkout',
      tenantId,
      '/billing/checkout',
      evil,
    ).expect(201);
    const url = (first.body as AdminBillingCheckoutResponse).url;
    expect(url).toMatch(/^https:\/\/checkout\.fake\.test\//);
    const second = await admin(
      'post',
      'checkout',
      tenantId,
      '/billing/checkout',
    ).expect(201);
    expect(second.body).toEqual(first.body);

    const rows = await prisma.billingCheckoutSession.findMany({
      where: { subscriptionId: (await subscriptionOf(tenantId)).id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'OPEN',
      planPriceId: priceId,
      trialDays: 14,
      requiresPaymentMethod: true,
    });
    const checkout = fake.checkouts.get(rows[0].externalSessionId!)!;
    expect(checkout.externalCustomerId).toBe(
      (await subscriptionOf(tenantId)).externalCustomerId,
    );
    expect(checkout.externalPriceId).toBe(fake.prices.get(priceId));
    // The provider price is synced once and recorded.
    expect(
      (
        await prisma.subscriptionPlanPrice.findUniqueOrThrow({
          where: { id: priceId },
        })
      ).externalPriceId,
    ).toBe(fake.prices.get(priceId));
  });

  it('concurrent Checkout requests create at most one session', async () => {
    const tenantId = await business('race');
    await startBilling(tenantId);
    const results = await Promise.all(
      [1, 2, 3].map(() => admin('post', 'race', tenantId, '/billing/checkout')),
    );
    for (const res of results) expect([201, 409]).toContain(res.status);
    const urls = new Set(
      results
        .filter((r) => r.status === 201)
        .map((r) => (r.body as AdminBillingCheckoutResponse).url),
    );
    expect(urls.size).toBe(1);
    expect(
      await prisma.billingCheckoutSession.count({
        where: { subscriptionId: (await subscriptionOf(tenantId)).id },
      }),
    ).toBe(1);
  });

  it('permissions and tenant isolation: viewers cannot set up payment; other businesses cannot reach it', async () => {
    const tenantId = await business('iso');
    await startBilling(tenantId);
    await staff(tenantId, `viewer-iso`, ['billing.view'], false);
    const viewer = (
      await admin('get', 'viewer-iso', tenantId, '/billing').expect(200)
    ).body as AdminBillingResponse;
    expect(viewer.canSetUpPayment).toBe(false);
    await admin('post', 'viewer-iso', tenantId, '/billing/checkout').expect(
      403,
    );

    const outsider = await business('outsider');
    // The outsider's staff naming the other business is refused.
    const crossRead = await admin('get', 'outsider', tenantId, '/billing');
    expect([401, 403]).toContain(crossRead.status);
    const crossWrite = await admin(
      'post',
      'outsider',
      tenantId,
      '/billing/checkout',
    );
    expect([401, 403]).toContain(crossWrite.status);
    // And their own business is complimentary: nothing to set up.
    expect(
      (
        await admin('post', 'outsider', outsider, '/billing/checkout').expect(
          409,
        )
      ).body,
    ).toMatchObject({
      code: 'BILLING_NOT_BILLED',
    });
    expect(
      await prisma.billingCheckoutSession.count({
        where: { subscriptionId: (await subscriptionOf(tenantId)).id },
      }),
    ).toBe(0);
  });

  // --- Webhooks and trial safety --------------------------------------------------

  it('a cardless trial: linked from OUR session only; trial expiry is recorded distinctly and nothing is charged', async () => {
    await setPolicy(14, false);
    const tenantId = await business('cardless');
    await startBilling(tenantId);
    const { sessionId } = await openCheckout(tenantId, 'cardless');
    const sub = await subscriptionOf(tenantId);
    // Opening Checkout consumed no trial.
    expect(
      await prisma.billingTrialClaim.count({
        where: { subscriptionId: sub.id },
      }),
    ).toBe(0);
    const snapshot = fake.completeCheckout(sessionId, {
      hasPaymentMethod: false,
    });

    const linked = await webhook('checkout.completed', {
      session: sessionId,
      customer: sub.externalCustomerId,
      subscription: snapshot.externalSubscriptionId,
    });
    expect(linked.res.status).toBe(200);
    const after = await subscriptionOf(tenantId);
    expect(after).toMatchObject({
      externalSubscriptionId: snapshot.externalSubscriptionId,
      status: 'TRIALING',
      trialRequiresPaymentMethod: false,
      recurringPaymentAuthorizedAt: null,
    });
    expect(
      await prisma.billingCheckoutSession.findFirstOrThrow({
        where: { subscriptionId: sub.id },
      }),
    ).toMatchObject({ status: 'COMPLETED' });
    expect(
      await prisma.billingTrialClaim.count({
        where: { subscriptionId: sub.id },
      }),
    ).toBe(1);

    // Duplicate delivery: nothing more.
    const historyBefore = await prisma.tenantSubscriptionEvent.count({
      where: { subscriptionId: sub.id },
    });
    expect((await redeliver(linked.signed)).status).toBe(200);
    expect(
      await prisma.tenantSubscriptionEvent.count({
        where: { subscriptionId: sub.id },
      }),
    ).toBe(historyBefore);

    // The trial ends with no payment method: the provider ENDS it.
    fake.setSubscription(snapshot.externalSubscriptionId, {
      status: 'canceled',
    });
    const ended = await webhook('subscription.changed', {
      subscription: snapshot.externalSubscriptionId,
      customer: sub.externalCustomerId,
    });
    expect(ended.res.status).toBe(200);
    expect(await subscriptionOf(tenantId)).toMatchObject({
      status: 'TRIAL_EXPIRED',
      canceledAt: null,
    });
    const types = (
      await prisma.tenantSubscriptionEvent.findMany({
        where: { subscriptionId: sub.id },
        orderBy: { createdAt: 'asc' },
      })
    ).map((e) => e.type);
    expect(types).toContain('TRIAL_EXPIRED');
    expect(types).not.toContain('CANCELED');
    expect(fake.calls.some((c) => c.op === 'retrieveInvoice')).toBe(false);
    // The business itself is untouched (tenant data and identity kept).
    expect(
      await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
    ).toMatchObject({ status: 'ACTIVE' });
  });

  it('an authorized trial converts on its first paid invoice', async () => {
    await setPolicy(14, true);
    const tenantId = await business('convert');
    await startBilling(tenantId);
    const { sessionId } = await openCheckout(tenantId, 'convert');
    const sub = await subscriptionOf(tenantId);
    const snapshot = fake.completeCheckout(sessionId, {
      hasPaymentMethod: true,
    });
    await webhook('checkout.completed', {
      session: sessionId,
      customer: sub.externalCustomerId,
      subscription: snapshot.externalSubscriptionId,
    });
    expect(await subscriptionOf(tenantId)).toMatchObject({
      status: 'TRIALING',
      trialRequiresPaymentMethod: true,
    });
    expect(
      (await subscriptionOf(tenantId)).recurringPaymentAuthorizedAt,
    ).not.toBeNull();

    fake.setSubscription(snapshot.externalSubscriptionId, { status: 'active' });
    await webhook('subscription.changed', {
      subscription: snapshot.externalSubscriptionId,
      customer: sub.externalCustomerId,
    });
    expect((await subscriptionOf(tenantId)).status).toBe('TRIALING');

    fake.setInvoice(
      'inv_convert',
      'paid',
      snapshot.externalSubscriptionId,
      sub.externalCustomerId,
    );
    const now = Math.floor(Date.now() / 1000);
    await webhook('invoice.paid', {
      subscription: snapshot.externalSubscriptionId,
      customer: sub.externalCustomerId,
      reference: 'inv_convert',
      amount: 4900,
      currency: 'usd',
      periodStart: now,
      periodEnd: now + 30 * 86400,
    });
    expect(await subscriptionOf(tenantId)).toMatchObject({ status: 'ACTIVE' });

    // A payment failure created BEFORE a subscription notification but
    // delivered after it is still applied (checked against the live invoice).
    fake.setSubscription(snapshot.externalSubscriptionId, {
      cancelAtPeriodEnd: true,
    });
    await webhook(
      'subscription.changed',
      {
        subscription: snapshot.externalSubscriptionId,
        customer: sub.externalCustomerId,
      },
      { created: now + 120 },
    );
    expect((await subscriptionOf(tenantId)).cancelAtPeriodEnd).toBe(true);
    fake.setInvoice(
      'inv_late_failure',
      'open',
      snapshot.externalSubscriptionId,
      sub.externalCustomerId,
    );
    const late = await webhook(
      'invoice.payment_failed',
      {
        subscription: snapshot.externalSubscriptionId,
        customer: sub.externalCustomerId,
        reference: 'inv_late_failure',
      },
      { created: now + 60 },
    );
    expect(late.res.status).toBe(200);
    expect(await subscriptionOf(tenantId)).toMatchObject({
      status: 'PAST_DUE',
    });
  });

  it("events for customers that aren't ours are acknowledged and ignored; ours are retried, then handed to review", async () => {
    const foreign = await webhook('subscription.changed', {
      subscription: `sub_elsewhere_${run}`,
      customer: `cus_elsewhere_${run}`,
    });
    expect(foreign.res.status).toBe(200);
    const foreignCheckout = await webhook('checkout.completed', {
      session: `cs_elsewhere_${run}`,
      customer: `cus_elsewhere_${run}`,
    });
    expect(foreignCheckout.res.status).toBe(200);
    expect(
      (
        await prisma.billingProviderEvent.findMany({
          where: {
            externalEventId: { in: [foreign.body.id, foreignCheckout.body.id] },
          },
          select: { status: true, outcome: true },
        })
      ).map((e) => `${e.status} ${e.outcome}`),
    ).toEqual(['IGNORED NOT_OURS', 'IGNORED NOT_OURS']);

    // Ours, but never linked: retryable (503) until the retries run out,
    // then closed and reviewed — not retried forever.
    const tenantId = await business('unlinked');
    await startBilling(tenantId);
    const sub = await subscriptionOf(tenantId);
    const unlinked = await webhook('subscription.changed', {
      subscription: `sub_unlinked_${run}`,
      customer: sub.externalCustomerId,
    });
    expect(unlinked.res.status).toBe(503);
    await prisma.billingProviderEvent.updateMany({
      where: { externalEventId: unlinked.body.id },
      data: { attempts: 11 },
    });
    expect((await redeliver(unlinked.signed)).status).toBe(200);
    const closed = await prisma.billingProviderEvent.findFirstOrThrow({
      where: { externalEventId: unlinked.body.id },
    });
    expect(closed).toMatchObject({
      status: 'REJECTED',
      outcome: 'NO_MATCHING_SUBSCRIPTION',
    });
    expect(
      await prisma.billingReconciliationCase.count({
        where: {
          billingProviderEventId: closed.id,
          kind: 'EVENT_RETRIES_EXHAUSTED',
          status: 'OPEN',
        },
      }),
    ).toBe(1);
    expect((await redeliver(unlinked.signed)).status).toBe(200);
  });

  it('out-of-order and transient failures are retried (503), never lost, and applied once', async () => {
    await setPolicy(14, false);
    const tenantId = await business('order');
    await startBilling(tenantId);
    const { sessionId } = await openCheckout(tenantId, 'order');
    const sub = await subscriptionOf(tenantId);
    const snapshot = fake.completeCheckout(sessionId, {
      hasPaymentMethod: false,
    });

    // The subscription notification arrives BEFORE the Checkout completion.
    const early = await webhook('subscription.changed', {
      subscription: snapshot.externalSubscriptionId,
      customer: sub.externalCustomerId,
    });
    expect(early.res.status).toBe(503);
    expect(
      await prisma.billingProviderEvent.findFirstOrThrow({
        where: { externalEventId: early.body.id },
      }),
    ).toMatchObject({
      status: 'FAILED',
      outcome: 'NO_MATCHING_SUBSCRIPTION',
    });

    // The provider is briefly unreadable: retryable.
    fake.failNext = 'rate_limit';
    const completion = await webhook('checkout.completed', {
      session: sessionId,
      customer: sub.externalCustomerId,
      subscription: snapshot.externalSubscriptionId,
    });
    expect(completion.res.status).toBe(503);
    expect(
      await prisma.billingProviderEvent.findFirstOrThrow({
        where: { externalEventId: completion.body.id },
      }),
    ).toMatchObject({
      status: 'FAILED',
      outcome: 'PROVIDER_ERROR',
    });
    expect((await subscriptionOf(tenantId)).externalSubscriptionId).toBeNull();

    // Redelivered: now applied, once.
    expect((await redeliver(completion.signed)).status).toBe(200);
    expect((await redeliver(early.signed)).status).toBe(200);
    expect(await subscriptionOf(tenantId)).toMatchObject({
      externalSubscriptionId: snapshot.externalSubscriptionId,
      status: 'TRIALING',
    });
    expect(
      await prisma.tenantSubscriptionEvent.count({
        where: { subscriptionId: sub.id, type: 'TRIAL_STARTED' },
      }),
    ).toBe(1);
  });

  it('refuses unverifiable, foreign and mismatched webhooks without changing anything', async () => {
    const tenantId = await business('hostile');
    await startBilling(tenantId);
    const { sessionId } = await openCheckout(tenantId, 'hostile');
    const sub = await subscriptionOf(tenantId);
    const snapshot = fake.completeCheckout(sessionId, {
      hasPaymentMethod: false,
    });

    // Bad signature, and a provider that is not the configured one.
    const signed = fake.signEvent({
      id: `evt_bad_${run}`,
      type: 'checkout.completed',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      data: { session: sessionId },
    });
    await request(app.getHttpServer())
      .post('/api/v1/billing/webhooks/fake')
      .set('Content-Type', 'application/json')
      .set(
        'x-billing-signature',
        // A definitely different signature (flip its first character).
        signed.signatureHeader.replace(/v1=(.)/, (_, c: string) =>
          c === '0' ? 'v1=1' : 'v1=0',
        ),
      )
      .send(signed.rawBody)
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/billing/webhooks/fake')
      .set('Content-Type', 'application/json')
      .send(signed.rawBody)
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/billing/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=00')
      .send(signed.rawBody)
      .expect(404);
    expect(
      await prisma.billingProviderEvent.count({
        where: { externalEventId: `evt_bad_${run}` },
      }),
    ).toBe(0);

    // Live mode: recorded and rejected.
    const live = await webhook(
      'checkout.completed',
      { session: sessionId, customer: sub.externalCustomerId },
      { livemode: true },
    );
    expect(live.res.status).toBe(200);
    // A session we never created: retryable, never linked.
    const unknown = await webhook('checkout.completed', {
      session: 'fake_cs_unknown',
      customer: sub.externalCustomerId,
    });
    expect(unknown.res.status).toBe(503);
    // A claimed business that is not the session's: rejected.
    const claim = await webhook('checkout.completed', {
      session: sessionId,
      customer: sub.externalCustomerId,
      tenantId: TENANT_1_MOCHA_HOUSE_ID,
    });
    expect(claim.res.status).toBe(200);
    // Another customer's completion of our session: rejected and reviewed.
    const customer = await webhook('checkout.completed', {
      session: sessionId,
      customer: 'fake_cus_attacker',
    });
    expect(customer.res.status).toBe(200);
    expect(
      await prisma.billingReconciliationCase.count({
        where: { subscriptionId: sub.id, kind: 'CHECKOUT_CUSTOMER_MISMATCH' },
      }),
    ).toBe(1);

    const outcomes = await prisma.billingProviderEvent.findMany({
      where: {
        externalEventId: {
          in: [live.body.id, unknown.body.id, claim.body.id, customer.body.id],
        },
      },
      select: { externalEventId: true, status: true, outcome: true },
    });
    expect(
      Object.fromEntries(
        outcomes.map((o) => [o.externalEventId, `${o.status} ${o.outcome}`]),
      ),
    ).toEqual({
      [live.body.id]: 'REJECTED LIVEMODE_MISMATCH',
      [unknown.body.id]: 'FAILED NO_MATCHING_CHECKOUT',
      [claim.body.id]: 'REJECTED TENANT_CLAIM_MISMATCH',
      [customer.body.id]: 'REJECTED CUSTOMER_MISMATCH',
    });
    expect((await subscriptionOf(tenantId)).externalSubscriptionId).toBeNull();
    void snapshot;
  });

  it("a suspended business's billing events still arrive, and never change its suspension", async () => {
    const tenantId = await business('suspended');
    await startBilling(tenantId);
    const { sessionId } = await openCheckout(tenantId, 'suspended');
    const sub = await subscriptionOf(tenantId);
    const snapshot = fake.completeCheckout(sessionId, {
      hasPaymentMethod: true,
    });
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { status: 'SUSPENDED', suspensionReason: 'SECURITY' },
    });
    const delivered = await webhook('checkout.completed', {
      session: sessionId,
      customer: sub.externalCustomerId,
      subscription: snapshot.externalSubscriptionId,
    });
    expect(delivered.res.status).toBe(200);
    expect((await subscriptionOf(tenantId)).externalSubscriptionId).toBe(
      snapshot.externalSubscriptionId,
    );
    expect(
      await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
    ).toMatchObject({ status: 'SUSPENDED', suspensionReason: 'SECURITY' });
  });

  // A second business owned by the same person (same email) as `ownerKey`'s.
  async function sameOwnerBusiness(label: string, ownerKey: string) {
    const tenantId = randomUUID();
    await prisma.tenant.create({
      data: {
        id: tenantId,
        slug: `sc3b-${label}-${run}`,
        name: `SC3b ${label}`,
        status: 'ACTIVE',
      },
    });
    await prisma.tenantSubscription.create({
      data: { subscriberTenantId: tenantId, planVersionId: versionId },
    });
    const role = await prisma.internalRole.create({
      data: {
        tenantId,
        key: 'platform-administrator',
        displayName: 'Admin',
        permissions: {
          create: ALL.map((permissionKey) => ({ permissionKey })),
        },
      },
    });
    const subject = `internal-dev:sc3b-${ownerKey}-${label}-${run}`;
    const email = `sc3b-${ownerKey}-${run}@example.com`;
    const user = await prisma.internalUser.create({
      data: {
        tenantId,
        externalProvider: 'internal-dev',
        externalSubject: subject,
        email,
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
    const checkout = () =>
      request(app.getHttpServer())
        .post('/api/v1/admin/billing/checkout')
        .set(
          'Authorization',
          `Bearer ${signInternalDevJwt({ sub: subject, email, name: null, email_verified: true }, INTERNAL_SECRET, 3600)}`,
        )
        .set('X-Tenant-Id', tenantId);
    return { tenantId, checkout };
  }

  const checkoutRow = async (tenantId: string) =>
    prisma.billingCheckoutSession.findFirstOrThrow({
      where: { subscriptionId: (await subscriptionOf(tenantId)).id },
      orderBy: { createdAt: 'desc' },
    });

  it('one trial per owner email: opening Checkout only holds it; the claim is consumed once the provider created the trial', async () => {
    await setPolicy(14, false);
    const first = await business('claim-a', ALL, 'claim-owner');
    await startBilling(first);
    const a = await openCheckout(first, 'claim-owner');
    const aRow = await checkoutRow(first);
    expect(aRow).toMatchObject({ trialDays: 14, status: 'OPEN' });
    expect(aRow.trialClaimKey).toMatch(/^[0-9a-f]{64}$/);
    // Opening Checkout consumed nothing.
    expect(
      await prisma.billingTrialClaim.count({
        where: { claimKey: aRow.trialClaimKey! },
      }),
    ).toBe(0);

    // The same owner's second business: asked to finish the first one.
    const second = await sameOwnerBusiness('claim-b', 'claim-owner');
    await startBilling(second.tenantId);
    // An operator cannot pre-empt the held trial either.
    await expect(
      app
        .get(BillingLifecycleService)
        .startTrial(
          (await subscriptionOf(second.tenantId)).id,
          `sc3b-claim-owner-${run}@example.com`,
          null,
        ),
    ).rejects.toMatchObject({ reason: 'TRIAL_ALREADY_USED' });
    const held = await second.checkout().expect(409);
    expect(held.body).toMatchObject({
      code: 'BILLING_TRIAL_PENDING_ELSEWHERE',
    });
    expect(
      await prisma.billingCheckoutSession.count({
        where: {
          subscriptionId: (await subscriptionOf(second.tenantId)).id,
        },
      }),
    ).toBe(0);

    // The first Checkout is abandoned (expired at the provider): the hold is
    // released and the second business is offered the trial.
    fake.expireCheckout(a.sessionId);
    const bRes = await second.checkout().expect(201);
    const bSession = (bRes.body as AdminBillingCheckoutResponse).url
      .split('/')
      .pop()!;
    expect(await checkoutRow(second.tenantId)).toMatchObject({
      trialDays: 14,
      trialClaimKey: aRow.trialClaimKey,
    });
    expect(
      await prisma.billingCheckoutSession.findUniqueOrThrow({
        where: { id: aRow.id },
      }),
    ).toMatchObject({ status: 'EXPIRED' });

    // Now the first business is the one asked to wait.
    expect(
      (
        await admin('post', 'claim-owner', first, '/billing/checkout').expect(
          409,
        )
      ).body,
    ).toMatchObject({ code: 'BILLING_TRIAL_PENDING_ELSEWHERE' });

    // The second business completes Checkout. Before the notification
    // arrives, the first is already offered no trial (it is being used).
    const bSub = await subscriptionOf(second.tenantId);
    const snapshot = fake.completeCheckout(bSession, {
      hasPaymentMethod: false,
    });
    await openCheckout(first, 'claim-owner');
    expect(await checkoutRow(first)).toMatchObject({
      trialDays: 0,
      trialClaimKey: null,
      requiresPaymentMethod: true,
    });

    // The verified trial consumes the claim, once, however often it is
    // delivered.
    const completion = await webhook('checkout.completed', {
      session: bSession,
      customer: bSub.externalCustomerId,
      subscription: snapshot.externalSubscriptionId,
    });
    expect(completion.res.status).toBe(200);
    expect((await redeliver(completion.signed)).status).toBe(200);
    expect(await subscriptionOf(second.tenantId)).toMatchObject({
      status: 'TRIALING',
    });
    expect(
      await prisma.billingTrialClaim.findMany({
        where: { claimKey: aRow.trialClaimKey! },
        select: { subscriptionId: true },
      }),
    ).toEqual([{ subscriptionId: bSub.id }]);
  });

  it('a trial whose claim another business already consumed is never accepted (reviewed; nothing charged)', async () => {
    await setPolicy(14, false);
    const tenantId = await business('claim-taken');
    await startBilling(tenantId);
    const { sessionId } = await openCheckout(tenantId, 'claim-taken');
    const row = await checkoutRow(tenantId);
    const sub = await subscriptionOf(tenantId);
    // Meanwhile the owner's claim was consumed for another business.
    const other = await business('claim-taken-other');
    await prisma.billingTrialClaim.create({
      data: {
        subscriptionId: (await subscriptionOf(other)).id,
        claimKey: row.trialClaimKey!,
      },
    });
    const snapshot = fake.completeCheckout(sessionId, {
      hasPaymentMethod: false,
    });
    const completion = await webhook('checkout.completed', {
      session: sessionId,
      customer: sub.externalCustomerId,
      subscription: snapshot.externalSubscriptionId,
    });
    expect(completion.res.status).toBe(200);
    const after = await subscriptionOf(tenantId);
    expect(after.status).not.toBe('TRIALING');
    expect(after.trialStartedAt).toBeNull();
    expect(
      await prisma.billingTrialClaim.count({
        where: { subscriptionId: sub.id },
      }),
    ).toBe(0);
    expect(
      await prisma.billingReconciliationCase.count({
        where: { subscriptionId: sub.id, kind: 'UNEXPECTED_TRIAL' },
      }),
    ).toBe(1);
  });

  // --- Reconciliation (review only) --------------------------------------------------

  it('reconciliation opens review cases (never duplicates, never changes money or state) and cases are resolved once', async () => {
    await setPolicy(0, true);
    const tenantId = await business('recon');
    await startBilling(tenantId);
    const { sessionId } = await openCheckout(tenantId, 'recon');
    const sub = await subscriptionOf(tenantId);
    const snapshot = fake.completeCheckout(sessionId, {
      hasPaymentMethod: true,
    });
    await webhook('checkout.completed', {
      session: sessionId,
      customer: sub.externalCustomerId,
      subscription: snapshot.externalSubscriptionId,
    });
    const before = await subscriptionOf(tenantId);

    // The provider says past due; we say active.
    fake.setSubscription(snapshot.externalSubscriptionId, {
      status: 'past_due',
    });
    const runOne = (await platform('post', '/billing/reconcile').expect(200))
      .body as PlatformReconciliationRunResponse;
    expect(runOne.subscriptionsChecked).toBeGreaterThan(0);
    const cases = (
      await platform('get', '/billing/reconciliation-cases').expect(200)
    ).body as PlatformReconciliationCaseListResponse;
    const mine = cases.cases.filter((c) => c.tenantId === tenantId);
    expect(mine.map((c) => c.kind)).toEqual(['STATE_MISMATCH']);
    await platform('post', '/billing/reconcile').expect(200);
    expect(
      await prisma.billingReconciliationCase.count({
        where: { subscriptionId: sub.id, status: 'OPEN' },
      }),
    ).toBe(1);
    // Nothing changed on the subscription.
    expect(await subscriptionOf(tenantId)).toMatchObject({
      status: before.status,
      billingStateVersion: before.billingStateVersion,
    });

    await platform(
      'post',
      `/billing/reconciliation-cases/${mine[0].id}/resolve`,
      {
        outcome: 'NO_ACTION_NEEDED',
        note: 'Reviewed in the provider dashboard.',
      },
    ).expect(200);
    expect(
      (
        await platform(
          'post',
          `/billing/reconciliation-cases/${mine[0].id}/resolve`,
          {
            outcome: 'NO_ACTION_NEEDED',
            note: 'Reviewed in the provider dashboard.',
          },
        ).expect(409)
      ).body,
    ).toMatchObject({
      code: 'CASE_ALREADY_RESOLVED',
    });
    await platform(
      'post',
      '/billing/reconcile',
      undefined,
      operatorToken(Math.floor(Date.now() / 1000) - 20 * 60),
    ).expect(401);
  });

  it("reconciliation: the customer's default payment method is legitimate; a removed one is reviewed", async () => {
    await setPolicy(0, true);
    const tenantId = await business('recon-pm');
    await startBilling(tenantId);
    const { sessionId } = await openCheckout(tenantId, 'recon-pm');
    const sub = await subscriptionOf(tenantId);
    const snapshot = fake.completeCheckout(sessionId, {
      hasPaymentMethod: false,
    });
    // The method is the CUSTOMER's default, not the subscription's own.
    fake.setSubscription(snapshot.externalSubscriptionId, {
      paymentMethodSource: 'CUSTOMER_DEFAULT',
    });
    await webhook('checkout.completed', {
      session: sessionId,
      customer: sub.externalCustomerId,
      subscription: snapshot.externalSubscriptionId,
    });
    expect(
      (await subscriptionOf(tenantId)).recurringPaymentAuthorizedAt,
    ).not.toBeNull();
    const paymentMethodCases = () =>
      prisma.billingReconciliationCase.findMany({
        where: {
          subscriptionId: sub.id,
          kind: { startsWith: 'PAYMENT_METHOD' },
        },
        select: { kind: true },
      });
    await platform('post', '/billing/reconcile').expect(200);
    expect(await paymentMethodCases()).toEqual([]);

    // The method is removed at the provider: the next charge would fail.
    fake.setSubscription(snapshot.externalSubscriptionId, {
      paymentMethodSource: null,
    });
    await platform('post', '/billing/reconcile').expect(200);
    expect(await paymentMethodCases()).toEqual([
      { kind: 'PAYMENT_METHOD_MISSING' },
    ]);
  });

  it('a trial the provider started that we never offered is reviewed, never accepted', async () => {
    await setPolicy(0, true);
    const tenantId = await business('notrial');
    await startBilling(tenantId);
    const { sessionId } = await openCheckout(tenantId, 'notrial');
    const sub = await subscriptionOf(tenantId);
    const snapshot = fake.completeCheckout(sessionId, {
      hasPaymentMethod: true,
    });
    fake.setSubscription(snapshot.externalSubscriptionId, {
      status: 'trialing',
      trialStart: new Date(),
      trialEnd: new Date(Date.now() + 30 * 86_400_000),
    });
    await webhook('checkout.completed', {
      session: sessionId,
      customer: sub.externalCustomerId,
      subscription: snapshot.externalSubscriptionId,
    });
    expect((await subscriptionOf(tenantId)).status).not.toBe('TRIALING');
    expect(
      await prisma.billingReconciliationCase.count({
        where: { subscriptionId: sub.id, kind: 'UNEXPECTED_TRIAL' },
      }),
    ).toBe(1);
  });

  it('never touched restaurant payments', async () => {
    expect(await prisma.paymentAttempt.count()).toBe(paymentAttemptsBefore);
  });
});
