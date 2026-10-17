import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  InternalBusinessesResponse,
  InternalMeResponse,
  InternalPermissionKey,
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
import { EntitlementsService } from '../subscriptions/application/entitlements.service';
import { BillingLifecycleService } from './application/billing-lifecycle.service';
import { BillingEnforcementService } from './application/billing-enforcement.service';
import type {
  FakeEventBody,
  FakeSaasBillingProvider,
} from './provider/fake-saas-billing-provider';
import { SAAS_BILLING_PROVIDER } from './provider/saas-billing-provider';

// SC3c-1 — billing enforcement (BILLING_ENFORCEMENT_ENABLED=1 here), end to
// end on the real AppModule in a SCRATCH database:
//   * an unauthorized trial expires: premium modules stop at once, core
//     stays for the recovery window, then a billing suspension; nothing is
//     charged; a verified payment restores it;
//   * grace: full access while PAST_DUE; suspended when it is over; only a
//     VERIFIED paid invoice restores it, once (repeated / delayed / unpaid
//     events change nothing); operators cannot simply reactivate it;
//   * the billing wind-down: staff see and complete ACCEPTED orders, refunds
//     stay behind the existing (disabled) closure workflow, billing is
//     readable — nothing else, no new sales;
//   * SECURITY suspension precedence; Tenant #1 never billing-suspended;
//     enforcement off changes nothing; cross-tenant isolation.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const DAY = 24 * 60 * 60 * 1000;

describe('SC3c-1 billing enforcement (integration, scratch database)', () => {
  let scratch: ScratchDatabase;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let lifecycle: BillingLifecycleService;
  let enforcement: BillingEnforcementService;
  let fake: FakeSaasBillingProvider;
  const originalEnv = { ...process.env };
  const PLATFORM_SECRET = `sc3c-platform-${randomUUID()}`;
  const INTERNAL_SECRET = `sc3c-internal-${randomUUID()}`;
  const run = randomUUID().replace(/-/g, '').slice(0, 8);
  let versionId: string;
  let priceId: string;
  let paymentAttemptsBefore: number;

  const STAFF: InternalPermissionKey[] = [
    'orders.view',
    'orders.manage_status',
    'orders.cancel',
    'billing.view',
    'billing.manage',
    'locations.view',
  ];

  const operatorToken = () =>
    signPlatformDevJwt(
      { sub: `platform-dev:sc3c-${run}`, mfa: true },
      PLATFORM_SECRET,
      3600,
    );
  const staffToken = (key: string) =>
    signInternalDevJwt(
      {
        sub: `internal-dev:sc3c-${key}-${run}`,
        email: `sc3c-${key}-${run}@example.com`,
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
    body?: object,
  ) => {
    const req = request(app.getHttpServer())
      [method](`/api/v1${path}`)
      .set('Authorization', `Bearer ${staffToken(key)}`)
      .set('X-Tenant-Id', tenantId);
    return body ? req.send(body) : req;
  };
  const platform = (path: string, body?: object) => {
    const req = request(app.getHttpServer())
      .post(`/api/v1/platform${path}`)
      .set('Authorization', `Bearer ${operatorToken()}`);
    return body ? req.send(body) : req;
  };

  interface Business {
    key: string;
    tenantId: string;
    subscriptionId: string;
    locationId: string;
    sub: { externalSubscriptionId: string; externalCustomerId: string };
  }

  // A BILLED business (fake provider) with an administrator holding STAFF
  // at corporate scope and one location.
  async function business(
    label: string,
    state: Record<string, unknown> = {},
  ): Promise<Business> {
    const key = `${label}`;
    const tenantId = randomUUID();
    await prisma.tenant.create({
      data: {
        id: tenantId,
        slug: `sc3c-${label}-${run}`,
        name: `SC3c ${label}`,
        status: 'ACTIVE',
      },
    });
    const sub = {
      externalSubscriptionId: `fake_sub_${label}_${run}`,
      externalCustomerId: `fake_cus_${label}_${run}`,
    };
    const subscription = await prisma.tenantSubscription.create({
      data: {
        subscriberTenantId: tenantId,
        planVersionId: versionId,
        billingMode: 'BILLED',
        billingProvider: 'fake',
        planPriceId: priceId,
        ...sub,
        ...state,
      },
    });
    // SC3c-2 — the provider's live subscription (read when a payment would
    // restore an unpaid business).
    fake.subscriptions.set(sub.externalSubscriptionId, {
      externalSubscriptionId: sub.externalSubscriptionId,
      externalCustomerId: sub.externalCustomerId,
      status: 'active',
      livemode: false,
      hasPaymentMethod: true,
      paymentMethodSource: 'SUBSCRIPTION',
      cancelAtPeriodEnd: false,
      trialStart: null,
      trialEnd: null,
      latestInvoiceId: null,
    });
    const location = await prisma.location.create({
      data: { tenantId, name: `Shop ${label}`, slug: `shop-${label}-${run}` },
    });
    const role = await prisma.internalRole.create({
      data: {
        tenantId,
        key: 'platform-administrator',
        displayName: 'Administrator',
        isSystem: true,
        permissions: {
          create: STAFF.map((permissionKey) => ({ permissionKey })),
        },
      },
    });
    const user = await prisma.internalUser.create({
      data: {
        tenantId,
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:sc3c-${key}-${run}`,
        email: `sc3c-${key}-${run}@example.com`,
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
    return {
      key,
      tenantId,
      subscriptionId: subscription.id,
      locationId: location.id,
      sub,
    };
  }

  async function order(
    b: Business,
    status: 'RECEIVED' | 'ACCEPTED',
    payment: 'SUCCEEDED' | 'PENDING' = 'SUCCEEDED',
  ) {
    const attempt = await prisma.paymentAttempt.create({
      data: {
        tenantId: b.tenantId,
        idempotencyKey: `sc3c_${randomUUID()}`,
        provider: 'test',
        locationId: b.locationId,
        amount: 400,
        currency: 'USD',
        status: payment,
      },
    });
    return (
      await prisma.order.create({
        data: {
          tenantId: b.tenantId,
          orderNumber: `SC3C-${randomUUID().slice(0, 12)}`,
          accessToken: randomUUID(),
          status,
          locationId: b.locationId,
          paymentAttemptId: attempt.id,
          guestName: 'Guest',
          guestPhone: '5550001111',
          currency: 'USD',
          subtotal: 400,
        },
      })
    ).id;
  }

  let seq = 0;
  // A verified provider event, applied through the lifecycle (the webhook
  // path minus HTTP, which SC3b covers).
  async function deliver(
    b: Business,
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
        subscription: b.sub.externalSubscriptionId,
        customer: b.sub.externalCustomerId,
        ...(type === 'invoice.paid' ? { amount: 4900, currency: 'usd' } : {}),
        ...data,
      },
      ...over,
    };
    const reference = body.data.reference;
    if (
      reference &&
      (type === 'invoice.paid' || type === 'invoice.payment_failed') &&
      !fake.invoices.has(reference)
    ) {
      fake.setInvoice(
        reference,
        type === 'invoice.paid' ? 'paid' : 'open',
        b.sub.externalSubscriptionId,
        b.sub.externalCustomerId,
      );
    }
    const signed = fake.signEvent(body, new Date(occurred * 1000));
    const verified = fake.verifyEvent({
      ...signed,
      now: new Date(occurred * 1000),
    });
    return lifecycle.recordAndApply(verified);
  }

  const tenantOf = (b: Business) =>
    prisma.tenant.findUniqueOrThrow({
      where: { id: b.tenantId },
      select: { status: true, suspensionReason: true },
    });
  const subscriptionOf = (b: Business) =>
    prisma.tenantSubscription.findUniqueOrThrow({
      where: { id: b.subscriptionId },
    });
  const historyOf = async (b: Business) =>
    (
      await prisma.tenantSubscriptionEvent.findMany({
        where: { subscriptionId: b.subscriptionId },
        orderBy: { createdAt: 'asc' },
        select: { type: true },
      })
    ).map((e) => e.type);
  const modulesOf = async (b: Business) =>
    (
      (await asStaff('get', b.key, b.tenantId, '/internal/me').expect(200))
        .body as InternalMeResponse
    ).entitlements.modules;

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3c_enforcement',
    );
    await applyMigrations(scratch.url, listMigrations(MIGRATIONS));
    process.env.DATABASE_URL = scratch.url;
    process.env.PLATFORM_AUTH_PROVIDER = 'dev';
    process.env.PLATFORM_AUTH_DEV_JWT_SECRET = PLATFORM_SECRET;
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = INTERNAL_SECRET;
    process.env.RATE_LIMIT_ENABLED = '0';
    process.env.SAAS_BILLING_PROVIDER = 'fake';
    process.env.SAAS_BILLING_TRIAL_CLAIM_SECRET = `sc3c-claims-${randomUUID()}`;
    process.env.BILLING_ENFORCEMENT_ENABLED = '1';
    delete process.env.ORDER_CLOSURE_ENABLED;
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    await app.init();
    prisma = app.get(PrismaService);
    lifecycle = app.get(BillingLifecycleService);
    enforcement = app.get(BillingEnforcementService);
    fake = app.get(SAAS_BILLING_PROVIDER);

    const grantee = await prisma.platformOperator.create({
      data: {
        externalProvider: 'platform-dev',
        externalSubject: `platform-dev:sc3c-${run}`,
        email: `sc3c-${run}@example.test`,
        status: 'ACTIVE',
      },
    });
    await grantPlatformPermissions(prisma, grantee.id);
    const plan = await prisma.subscriptionPlan.create({
      data: { key: `growth-${run}`, name: 'Growth' },
    });
    const version = await prisma.subscriptionPlanVersion.create({
      data: { planId: plan.id, version: 1, moduleKeys: ['crm'] },
    });
    await prisma.subscriptionPlanVersion.update({
      where: { id: version.id },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });
    versionId = version.id;
    priceId = (
      await prisma.subscriptionPlanPrice.create({
        data: {
          planId: plan.id,
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

  const now = () => new Date();
  const authorized = () => {
    const start = new Date(Date.now() - 10 * DAY);
    return {
      recurringPaymentAuthorizedAt: start,
      currentPeriodStart: start,
      currentPeriodEnd: new Date(start.getTime() + 30 * DAY),
    };
  };

  // --- Trial expiry and recovery -------------------------------------------

  it('an unauthorized trial expires: premium stops at once, core stays for the recovery window, then a billing suspension — nothing charged — and a verified payment restores it', async () => {
    const started = new Date(Date.now() - 14 * DAY);
    const b = await business('trial', {
      status: 'TRIALING',
      trialStartedAt: started,
      trialEndsAt: new Date(Date.now() - 60_000),
      trialRequiresPaymentMethod: false,
    });
    expect(await modulesOf(b)).toContain('crm');

    const ended = await deliver(b, 'subscription.trial_ended');
    expect(ended).toMatchObject({ status: 'APPLIED' });
    const expired = await subscriptionOf(b);
    expect(expired.status).toBe('TRIAL_EXPIRED');
    expect(expired.recurringPaymentAuthorizedAt).toBeNull();
    // The policy's 3-day window, from the expiry.
    expect(
      Math.abs(expired.recoveryEndsAt!.getTime() - (Date.now() + 3 * DAY)),
    ).toBeLessThan(60_000);
    // Premium modules stop at once; the business itself stays open.
    expect(await modulesOf(b)).toEqual(['core']);
    expect(await tenantOf(b)).toEqual({
      status: 'ACTIVE',
      suspensionReason: null,
    });

    // Not over yet: nothing happens.
    await enforcement.sweep(new Date(Date.now() + 2 * DAY));
    expect((await tenantOf(b)).status).toBe('ACTIVE');

    // Over: suspended for billing (once).
    const later = new Date(Date.now() + 3 * DAY + 120_000);
    await enforcement.sweep(later);
    expect(await tenantOf(b)).toEqual({
      status: 'SUSPENDED',
      suspensionReason: 'BILLING',
    });
    expect(await subscriptionOf(b)).toMatchObject({
      status: 'TRIAL_EXPIRED',
      recoveryEndsAt: null,
    });
    await enforcement.sweep(later);
    expect(
      (await historyOf(b)).filter((t) => t === 'BILLING_SUSPENDED'),
    ).toHaveLength(1);
    expect(await historyOf(b)).toEqual(
      expect.arrayContaining(['TRIAL_EXPIRED', 'RECOVERY_EXPIRED']),
    );
    // Never charged: no restaurant payment either.
    expect(await prisma.paymentAttempt.count()).toBe(paymentAttemptsBefore);

    // A verified payment restores the business and its plan.
    const paid = await deliver(b, 'invoice.paid', {
      reference: `inv_trial_${run}`,
      periodStart: Math.floor(Date.now() / 1000),
      periodEnd: Math.floor((Date.now() + 30 * DAY) / 1000),
    });
    expect(paid).toMatchObject({ status: 'APPLIED' });
    expect(await tenantOf(b)).toEqual({
      status: 'ACTIVE',
      suspensionReason: null,
    });
    expect((await subscriptionOf(b)).status).toBe('ACTIVE');
    expect(await modulesOf(b)).toContain('crm');
    expect(await historyOf(b)).toContain('BILLING_SUSPENSION_LIFTED');
  });

  // --- Grace periods and restoration ---------------------------------------

  it('grace keeps everything; when it is over the business is suspended; only a VERIFIED payment restores it, once — and an operator cannot simply reactivate it', async () => {
    const b = await business('grace', authorized());
    const other = await business('grace-other', authorized());

    expect(
      await deliver(b, 'invoice.payment_failed', {
        reference: `inv_grace_${run}`,
      }),
    ).toMatchObject({ status: 'APPLIED' });
    const pastDue = await subscriptionOf(b);
    expect(pastDue.status).toBe('PAST_DUE');
    expect(
      Math.abs(pastDue.graceEndsAt!.getTime() - (Date.now() + 14 * DAY)),
    ).toBeLessThan(60_000);
    expect(await modulesOf(b)).toContain('crm');

    // The other business is past due too, but later — never touched early.
    await deliver(other, 'invoice.payment_failed', {
      reference: `inv_other_${run}`,
    });
    await prisma.tenantSubscription.update({
      where: { id: other.subscriptionId },
      data: { graceEndsAt: new Date(Date.now() + 20 * DAY) },
    });

    await enforcement.sweep(new Date(Date.now() + 13 * DAY));
    expect((await tenantOf(b)).status).toBe('ACTIVE');
    const over = new Date(Date.now() + 14 * DAY + 120_000);
    const swept = await enforcement.sweep(over);
    expect(swept).toMatchObject({ enabled: true, failed: 0 });
    expect(await tenantOf(b)).toEqual({
      status: 'SUSPENDED',
      suspensionReason: 'BILLING',
    });
    expect((await subscriptionOf(b)).status).toBe('UNPAID');
    expect(await tenantOf(other)).toEqual({
      status: 'ACTIVE',
      suspensionReason: null,
    });
    expect((await subscriptionOf(other)).status).toBe('PAST_DUE');

    // An operator cannot lift it without payment.
    expect(
      (await platform(`/tenants/${b.tenantId}/reactivate`).expect(409)).body,
    ).toMatchObject({ code: 'BILLING_SUSPENSION_ACTIVE' });

    // A "paid" notification for an invoice the provider says is NOT paid:
    // refused, still suspended.
    fake.setInvoice(
      `inv_unpaid_${run}`,
      'open',
      b.sub.externalSubscriptionId,
      b.sub.externalCustomerId,
    );
    expect(
      await deliver(b, 'invoice.paid', { reference: `inv_unpaid_${run}` }),
    ).toMatchObject({ status: 'REJECTED', outcome: 'INVOICE_NOT_PAID' });
    expect((await tenantOf(b)).status).toBe('SUSPENDED');

    // SC3c-2 — that bogus invoice is voided at the provider (an open one
    // would still be outstanding and keep the business suspended).
    fake.setInvoice(
      `inv_unpaid_${run}`,
      'void',
      b.sub.externalSubscriptionId,
      b.sub.externalCustomerId,
    );
    // The real payment: restored, once.
    fake.setInvoice(
      `inv_grace_${run}`,
      'paid',
      b.sub.externalSubscriptionId,
      b.sub.externalCustomerId,
    );
    const paidAt = Math.floor(Date.now() / 1000) + 5;
    const first = await deliver(
      b,
      'invoice.paid',
      { reference: `inv_grace_${run}` },
      { created: paidAt, id: `evt_paid_${run}` },
    );
    expect(first).toMatchObject({ status: 'APPLIED' });
    const again = await deliver(
      b,
      'invoice.paid',
      { reference: `inv_grace_${run}` },
      { created: paidAt, id: `evt_paid_${run}` },
    );
    expect(again).toMatchObject({ duplicate: true });
    expect(await tenantOf(b)).toEqual({
      status: 'ACTIVE',
      suspensionReason: null,
    });
    expect(
      (await historyOf(b)).filter((t) => t === 'BILLING_SUSPENSION_LIFTED'),
    ).toHaveLength(1);

    // A delayed, older failure changes nothing afterwards.
    const late = await deliver(
      b,
      'invoice.payment_failed',
      { reference: `inv_grace_${run}` },
      { created: paidAt - 3600 },
    );
    expect(late.status).not.toBe('APPLIED');
    expect(await tenantOf(b)).toEqual({
      status: 'ACTIVE',
      suspensionReason: null,
    });
    expect((await subscriptionOf(b)).status).toBe('ACTIVE');
  });

  // --- The operational wind-down -------------------------------------------

  const advance = (
    b: Business,
    orderId: string,
    expectedStatus: string,
    locationId = b.locationId,
    tenantId = b.tenantId,
  ) =>
    asStaff('post', b.key, tenantId, `/admin/orders/${orderId}/advance`, {
      locationId,
      expectedStatus,
    });
  const statusOf = async (orderId: string) =>
    (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status;

  it('a BILLING suspension keeps a narrow wind-down: orders already taken are fulfilled, billing is readable — nothing else, no new sales', async () => {
    const b = await business('wind', authorized());
    const accepted = await order(b, 'ACCEPTED');
    const paidReceived = await order(b, 'RECEIVED');
    const unpaidReceived = await order(b, 'RECEIVED', 'PENDING');
    // Suspended for billing by an operator (recorded), after those orders.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await platform(`/tenants/${b.tenantId}/suspend`, {
      reason: 'BILLING',
    }).expect(200);
    // An order that appears after the suspension began (e.g. written by a
    // request in flight): never a sale the business may still make.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const newOrder = await order(b, 'RECEIVED');

    const me = (
      await asStaff('get', b.key, b.tenantId, '/internal/me').expect(200)
    ).body as InternalMeResponse;
    expect(me.business.access).toBe('BILLING_WIND_DOWN');
    const list = (
      await request(app.getHttpServer())
        .get('/api/v1/internal/businesses')
        .set('Authorization', `Bearer ${staffToken(b.key)}`)
        .expect(200)
    ).body as InternalBusinessesResponse;
    expect(list.businesses).toEqual([
      expect.objectContaining({ id: b.tenantId, access: 'BILLING_WIND_DOWN' }),
    ]);

    // Orders the business already took: visible.
    const orders = await asStaff(
      'get',
      b.key,
      b.tenantId,
      `/admin/orders?locationId=${b.locationId}`,
    ).expect(200);
    expect(JSON.stringify(orders.body)).toContain(accepted);
    await asStaff(
      'get',
      b.key,
      b.tenantId,
      `/admin/orders/${accepted}?locationId=${b.locationId}`,
    ).expect(200);

    // An already-accepted order moves on.
    await advance(b, accepted, 'ACCEPTED').expect(201);
    expect(await statusOf(accepted)).toBe('PREPARING');

    // A RECEIVED order PAID before the suspension: accepted and fulfilled
    // through its normal statuses.
    for (const from of ['RECEIVED', 'ACCEPTED', 'PREPARING', 'READY']) {
      await advance(b, paidReceived, from).expect(201);
    }
    expect(await statusOf(paidReceived)).toBe('COMPLETED');

    // An UNPAID order: refused.
    expect(
      (await advance(b, unpaidReceived, 'RECEIVED').expect(403)).body,
    ).toMatchObject({
      code: 'BUSINESS_BILLING_SUSPENDED',
    });
    expect(await statusOf(unpaidReceived)).toBe('RECEIVED');

    // A NEW order (after the suspension began), even paid: refused.
    expect(
      (await advance(b, newOrder, 'RECEIVED').expect(403)).body,
    ).toMatchObject({
      code: 'BUSINESS_BILLING_SUSPENDED',
    });
    expect(await statusOf(newOrder)).toBe('RECEIVED');

    // Refunds/reversals: no new mechanism — the existing order-closure
    // workflow stays disabled (404) and remains a separate, unresolved
    // capability.
    await asStaff(
      'post',
      b.key,
      b.tenantId,
      `/admin/orders/${unpaidReceived}/reject`,
      { locationId: b.locationId, reasonCode: 'OUT_OF_STOCK' },
    ).expect(404);

    // Billing is readable; payment recovery is SC3c-2. Everything else: no.
    await asStaff('get', b.key, b.tenantId, '/admin/billing').expect(200);
    for (const [method, path] of [
      ['post', '/admin/loyalty/rewards'],
      ['get', '/admin/locations'],
      ['post', '/admin/gift-cards'],
      ['get', '/admin/loyalty/settings'],
      ['get', '/admin/internal-users'],
    ] as const) {
      expect(
        (await asStaff(method, b.key, b.tenantId, path, {}).expect(403)).body,
      ).toMatchObject({ code: 'BUSINESS_BILLING_SUSPENDED' });
    }
  });

  it('the paid-order exception never applies to a SECURITY suspension or across businesses', async () => {
    // SECURITY: staff cannot reach the order at all.
    const sec = await business('wind-security', authorized());
    const secOrder = await order(sec, 'RECEIVED');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await platform(`/tenants/${sec.tenantId}/suspend`, {
      reason: 'SECURITY',
    }).expect(200);
    await advance(sec, secOrder, 'RECEIVED').expect(403);
    expect(await statusOf(secOrder)).toBe('RECEIVED');

    // Another business's paid order: unreachable from a wind-down session,
    // by its location (not authorized) or by this business's own location
    // (not found).
    const a = await business('wind-cross-a', authorized());
    const z = await business('wind-cross-z', authorized());
    const zOrder = await order(z, 'RECEIVED');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await platform(`/tenants/${a.tenantId}/suspend`, {
      reason: 'BILLING',
    }).expect(200);
    await advance(a, zOrder, 'RECEIVED', z.locationId).expect(403);
    await advance(a, zOrder, 'RECEIVED', a.locationId).expect(404);
    // Naming the other business itself: not a member (generic refusal).
    await advance(a, zOrder, 'RECEIVED', z.locationId, z.tenantId).expect(403);
    expect(await statusOf(zOrder)).toBe('RECEIVED');
  });

  // --- Security precedence ---------------------------------------------------

  it('a SECURITY suspension always wins: billing never suspends over it, never lifts it, and it replaces a BILLING suspension', async () => {
    const b = await business('security', authorized());
    await deliver(b, 'invoice.payment_failed', {
      reference: `inv_sec_${run}`,
    });
    await prisma.tenant.update({
      where: { id: b.tenantId },
      data: { status: 'SUSPENDED', suspensionReason: 'SECURITY' },
    });
    await enforcement.sweep(new Date(Date.now() + 15 * DAY));
    expect((await subscriptionOf(b)).status).toBe('UNPAID');
    expect(await tenantOf(b)).toEqual({
      status: 'SUSPENDED',
      suspensionReason: 'SECURITY',
    });
    expect(await historyOf(b)).not.toContain('BILLING_SUSPENDED');
    // No wind-down for a SECURITY suspension.
    await asStaff('get', b.key, b.tenantId, '/internal/me').expect(403);

    // Paying never lifts it.
    fake.setInvoice(
      `inv_sec_${run}`,
      'paid',
      b.sub.externalSubscriptionId,
      b.sub.externalCustomerId,
    );
    expect(
      await deliver(b, 'invoice.paid', { reference: `inv_sec_${run}` }),
    ).toMatchObject({ status: 'APPLIED' });
    expect((await subscriptionOf(b)).status).toBe('ACTIVE');
    expect(await tenantOf(b)).toEqual({
      status: 'SUSPENDED',
      suspensionReason: 'SECURITY',
    });

    // A BILLING suspension is replaced by an operator's SECURITY one.
    const c = await business('security-escalate', authorized());
    await prisma.tenant.update({
      where: { id: c.tenantId },
      data: { status: 'SUSPENDED', suspensionReason: 'BILLING' },
    });
    expect(
      (
        await platform(`/tenants/${c.tenantId}/suspend`, {
          reason: 'SECURITY',
        }).expect(200)
      ).body,
    ).toEqual({
      status: 'SUSPENDED',
      suspensionReason: 'SECURITY',
      changed: true,
    });
    await asStaff('get', c.key, c.tenantId, '/internal/me').expect(403);

    // Lifting that SECURITY suspension while the business still owes returns
    // it to the billing suspension — never plain ACTIVE — and its confirmed
    // payment then restores it.
    const d = await business('security-reactivate', authorized());
    await deliver(d, 'invoice.payment_failed', {
      reference: `inv_sec_d_${run}`,
    });
    await enforcement.sweep(new Date(Date.now() + 15 * DAY));
    expect(await tenantOf(d)).toEqual({
      status: 'SUSPENDED',
      suspensionReason: 'BILLING',
    });
    await platform(`/tenants/${d.tenantId}/suspend`, {
      reason: 'SECURITY',
    }).expect(200);
    expect(
      (await platform(`/tenants/${d.tenantId}/reactivate`).expect(200)).body,
    ).toEqual({
      status: 'SUSPENDED',
      suspensionReason: 'BILLING',
      changed: true,
    });
    fake.setInvoice(
      `inv_sec_d_${run}`,
      'paid',
      d.sub.externalSubscriptionId,
      d.sub.externalCustomerId,
    );
    await deliver(d, 'invoice.paid', { reference: `inv_sec_d_${run}` });
    expect(await tenantOf(d)).toEqual({
      status: 'ACTIVE',
      suspensionReason: null,
    });
  });

  it('a payment lifts only a suspension billing enforcement applied — never one an operator set', async () => {
    const e = await business('manual-billing', authorized());
    await deliver(e, 'invoice.payment_failed', {
      reference: `inv_manual_${run}`,
    });
    // An operator suspended it (reason BILLING) before enforcement did.
    await platform(`/tenants/${e.tenantId}/suspend`, {
      reason: 'BILLING',
    }).expect(200);
    await enforcement.sweep(new Date(Date.now() + 15 * DAY));
    expect((await subscriptionOf(e)).status).toBe('UNPAID');
    expect(await historyOf(e)).not.toContain('BILLING_SUSPENDED');
    fake.setInvoice(
      `inv_manual_${run}`,
      'paid',
      e.sub.externalSubscriptionId,
      e.sub.externalCustomerId,
    );
    await deliver(e, 'invoice.paid', { reference: `inv_manual_${run}` });
    expect((await subscriptionOf(e)).status).toBe('ACTIVE');
    // Still the operator's suspension: lifted only by an operator.
    expect(await tenantOf(e)).toEqual({
      status: 'SUSPENDED',
      suspensionReason: 'BILLING',
    });
  });

  // --- Isolation ---------------------------------------------------------------

  it("one business's suspension never reaches another's staff or data", async () => {
    const a = await business('iso-a', authorized());
    const z = await business('iso-z', authorized());
    const zOrder = await order(z, 'ACCEPTED');
    await prisma.tenant.update({
      where: { id: a.tenantId },
      data: { status: 'SUSPENDED', suspensionReason: 'BILLING' },
    });
    // A's staff cannot enter Z (not a member) — the generic refusal.
    await asStaff('get', a.key, z.tenantId, '/internal/me').expect(403);
    await asStaff(
      'get',
      a.key,
      z.tenantId,
      `/admin/orders/${zOrder}?locationId=${z.locationId}`,
    ).expect(403);
    // Z is unaffected: full access.
    expect(
      (
        (await asStaff('get', z.key, z.tenantId, '/internal/me').expect(200))
          .body as InternalMeResponse
      ).business.access,
    ).toBe('FULL');
    await asStaff('get', z.key, z.tenantId, '/admin/locations').expect(200);

    // A person in both: with no business chosen, the one FULL business is
    // entered (as before SC3c), never the suspended one.
    const zRole = await prisma.internalRole.findFirstOrThrow({
      where: { tenantId: z.tenantId },
    });
    const both = await prisma.internalUser.create({
      data: {
        tenantId: z.tenantId,
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:sc3c-${a.key}-${run}`,
        email: `sc3c-${a.key}-${run}@example.com`,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    await prisma.internalUserRoleAssignment.create({
      data: {
        tenantId: z.tenantId,
        internalUserId: both.id,
        roleId: zRole.id,
        scopeType: 'CORPORATE',
        scopeId: null,
      },
    });
    const implicit = (
      await request(app.getHttpServer())
        .get('/api/v1/internal/me')
        .set('Authorization', `Bearer ${staffToken(a.key)}`)
        .expect(200)
    ).body as InternalMeResponse;
    expect(implicit.business).toMatchObject({
      id: z.tenantId,
      access: 'FULL',
    });
  });

  // --- Exemptions and the switch ---------------------------------------------

  it('Founding (Tenant #1) is never suspended for billing (reviewed instead)', async () => {
    const tenantOne = await prisma.tenantSubscription.findUniqueOrThrow({
      where: { subscriberTenantId: TENANT_1_MOCHA_HOUSE_ID },
    });
    const pastDueAt = new Date(Date.now() - 20 * DAY);
    await prisma.tenantSubscription.update({
      where: { id: tenantOne.id },
      data: {
        billingMode: 'BILLED',
        billingProvider: 'fake',
        externalCustomerId: `fake_cus_tenant1_${run}`,
        planPriceId: priceId,
        status: 'PAST_DUE',
        recurringPaymentAuthorizedAt: pastDueAt,
        pastDueAt,
        graceEndsAt: new Date(Date.now() - DAY),
      },
    });
    await enforcement.sweep(now());
    expect(
      await prisma.tenant.findUniqueOrThrow({
        where: { id: TENANT_1_MOCHA_HOUSE_ID },
        select: { status: true },
      }),
    ).toEqual({ status: 'ACTIVE' });
    expect(
      await prisma.billingReconciliationCase.count({
        where: { subscriptionId: tenantOne.id, kind: 'SUSPENSION_EXEMPT' },
      }),
    ).toBe(1);
    // ...and keeps its plan's modules (exempt from enforcement altogether).
    const plan = await prisma.subscriptionPlanVersion.findUniqueOrThrow({
      where: { id: tenantOne.planVersionId },
      select: { moduleKeys: true },
    });
    const entitled = await app
      .get(EntitlementsService, { strict: false })
      .forTenant(TENANT_1_MOCHA_HOUSE_ID);
    for (const key of plan.moduleKeys) {
      expect(entitled.modules.has(key as never)).toBe(true);
    }
  });

  it('with enforcement OFF, billing state still moves but nothing is enforced on the business', async () => {
    process.env.BILLING_ENFORCEMENT_ENABLED = '0';
    try {
      const b = await business('off', {
        status: 'TRIALING',
        trialStartedAt: new Date(Date.now() - 14 * DAY),
        trialEndsAt: new Date(Date.now() - 60_000),
        trialRequiresPaymentMethod: false,
      });
      await deliver(b, 'subscription.trial_ended');
      expect((await subscriptionOf(b)).status).toBe('TRIAL_EXPIRED');
      // No entitlement change, no sweep, no suspension.
      expect(await modulesOf(b)).toContain('crm');
      expect(await enforcement.sweep(new Date(Date.now() + 10 * DAY))).toEqual({
        enabled: false,
        applied: 0,
        failed: 0,
      });
      expect(await tenantOf(b)).toEqual({
        status: 'ACTIVE',
        suspensionReason: null,
      });
      expect(
        (await platform('/billing/enforcement/sweep').expect(200)).body,
      ).toEqual({ enabled: false, applied: 0, failed: 0 });
    } finally {
      process.env.BILLING_ENFORCEMENT_ENABLED = '1';
    }
  });
});
