import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  AdminBillingRecoveryResponse,
  AdminBillingResponse,
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
import { BillingLifecycleService } from './application/billing-lifecycle.service';
import type {
  FakeEventBody,
  FakeSaasBillingProvider,
} from './provider/fake-saas-billing-provider';
import { SAAS_BILLING_PROVIDER } from './provider/saas-billing-provider';

// SC3c-2 — billing recovery, end to end on the real AppModule (fake
// provider, enforcement ON) in a SCRATCH database:
//   * restarting an ENDED subscription: only after the provider confirms the
//     old one ended; one Checkout at a time; never a trial; linked only
//     when the new subscription's first invoice is verifiably PAID; late
//     events of the replaced subscription never act on the new one;
//   * paying an outstanding invoice: found and verified from OUR records
//     (never a client value); access returns only when the provider's
//     subscription is active and nothing else is outstanding;
//   * the Customer Portal: only under a checked test-mode configuration
//     that cannot change the subscription;
//   * billing.manage only — during FULL access and the billing wind-down,
//     never a SECURITY suspension; cross-tenant isolation.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const DAY = 24 * 60 * 60 * 1000;

describe('SC3c-2 billing recovery (integration, scratch database)', () => {
  let scratch: ScratchDatabase;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let lifecycle: BillingLifecycleService;
  let fake: FakeSaasBillingProvider;
  const originalEnv = { ...process.env };
  const INTERNAL_SECRET = `sc3c2-internal-${randomUUID()}`;
  const run = randomUUID().replace(/-/g, '').slice(0, 8);
  let versionId: string;
  let priceId: string;

  const MANAGE: InternalPermissionKey[] = [
    'billing.view',
    'billing.manage',
    'locations.view',
  ];

  const staffToken = (key: string) =>
    signInternalDevJwt(
      {
        sub: `internal-dev:sc3c2-${key}-${run}`,
        email: `sc3c2-${key}-${run}@example.com`,
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
    const role = await prisma.internalRole.create({
      data: {
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
        externalSubject: `internal-dev:sc3c2-${key}-${run}`,
        email: `sc3c2-${key}-${run}@example.com`,
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

  // A BILLED business linked to a provider customer and subscription (the
  // fake holds the subscription with `providerStatus`).
  async function business(
    label: string,
    state: Record<string, unknown>,
    providerStatus: 'active' | 'canceled' | 'unpaid' | 'trialing',
  ): Promise<Business> {
    const tenantId = randomUUID();
    await prisma.tenant.create({
      data: {
        id: tenantId,
        slug: `sc3c2-${label}-${run}`,
        name: `SC3c2 ${label}`,
        status: 'ACTIVE',
      },
    });
    const customer = `fake_cus_${label}_${run}`;
    const sub = `fake_sub_${label}_${run}`;
    const subscription = await prisma.tenantSubscription.create({
      data: {
        subscriberTenantId: tenantId,
        planVersionId: versionId,
        billingMode: 'BILLED',
        billingProvider: 'fake',
        planPriceId: priceId,
        externalCustomerId: customer,
        externalSubscriptionId: sub,
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
      trialEnd: null,
      latestInvoiceId: null,
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

  // Suspended for billing BY ENFORCEMENT (as the sweep records it).
  async function billingSuspended(b: Business) {
    const row = await prisma.tenantSubscription.findUniqueOrThrow({
      where: { id: b.subscriptionId },
    });
    await prisma.tenant.update({
      where: { id: b.tenantId },
      data: { status: 'SUSPENDED', suspensionReason: 'BILLING' },
    });
    await prisma.tenantSubscriptionEvent.create({
      data: {
        subscriptionId: b.subscriptionId,
        type: 'BILLING_SUSPENDED',
        fromStatus: row.status,
        toStatus: row.status,
        source: 'SYSTEM',
      },
    });
  }

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
        ...(type === 'invoice.paid' ? { amount: 4900, currency: 'usd' } : {}),
        ...data,
      },
    };
    const signed = fake.signEvent(body, new Date(occurred * 1000));
    const verified = fake.verifyEvent({
      ...signed,
      now: new Date(occurred * 1000),
    });
    return { body, verified, result: await lifecycle.recordAndApply(verified) };
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
  const billingOf = async (b: Business, key = b.key) =>
    (await asStaff('get', key, b.tenantId, '/admin/billing').expect(200))
      .body as AdminBillingResponse;

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3c2_recovery',
    );
    await applyMigrations(scratch.url, listMigrations(MIGRATIONS));
    process.env.DATABASE_URL = scratch.url;
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = INTERNAL_SECRET;
    process.env.RATE_LIMIT_ENABLED = '0';
    process.env.SAAS_BILLING_PROVIDER = 'fake';
    process.env.SAAS_BILLING_TRIAL_CLAIM_SECRET = `sc3c2-claims-${randomUUID()}`;
    process.env.BILLING_CHECKOUT_RETURN_URL =
      'https://admin.example.test/admin/billing';
    process.env.BILLING_ENFORCEMENT_ENABLED = '1';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    await app.init();
    prisma = app.get(PrismaService);
    lifecycle = app.get(BillingLifecycleService);
    fake = app.get(SAAS_BILLING_PROVIDER);

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
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      process.env = { ...originalEnv };
      await scratch?.drop();
    }
  });

  const expiredTrial = () => ({
    status: 'TRIAL_EXPIRED' as const,
    trialStartedAt: new Date(Date.now() - 20 * DAY),
    trialEndsAt: new Date(Date.now() - 6 * DAY),
    trialRequiresPaymentMethod: false,
  });

  // --- Restarting an ended subscription -----------------------------------------

  it('restarts an expired trial: only once the old subscription ended, never with a trial, linked only when the first invoice is PAID — and the old subscription can no longer act', async () => {
    const b = await business('restart', expiredTrial(), 'active');
    await billingSuspended(b);
    const before = await subscriptionOf(b);

    // Wind-down: billing.manage may recover.
    const view = await billingOf(b);
    expect(view).toMatchObject({
      canRestartSubscription: true,
      canPayInvoice: false,
      // Restarted, not edited.
      canManagePaymentMethod: false,
    });

    // The provider has not ended the old subscription yet: refused.
    expect(
      (
        await asStaff(
          'post',
          b.key,
          b.tenantId,
          '/admin/billing/checkout',
        ).expect(409)
      ).body,
    ).toMatchObject({ code: 'BILLING_SUBSCRIPTION_NOT_ENDED' });
    fake.subscriptions.get(b.sub)!.status = 'canceled';

    // One Checkout (re-used under a repeated request), with no trial.
    const first = (
      await asStaff('post', b.key, b.tenantId, '/admin/billing/checkout', {
        trialDays: 30,
        priceId: 'evil',
        subscription: 'evil',
      }).expect(201)
    ).body as { url: string };
    const again = (
      await asStaff(
        'post',
        b.key,
        b.tenantId,
        '/admin/billing/checkout',
      ).expect(201)
    ).body as { url: string };
    expect(again.url).toBe(first.url);
    const row = await prisma.billingCheckoutSession.findFirstOrThrow({
      where: { subscriptionId: b.subscriptionId },
    });
    expect(row).toMatchObject({
      trialDays: 0,
      trialClaimKey: null,
      requiresPaymentMethod: true,
      replacesExternalSubscriptionId: b.sub,
      status: 'OPEN',
    });
    // Audited — without the provider's page URL.
    const audit = await prisma.internalAuditEvent.findMany({
      where: { action: 'billing.recovery_started', tenantId: b.tenantId },
    });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain('https://');

    // The owner completes Checkout, but its first invoice is not paid yet:
    // not linked, retryable, still expired and suspended.
    const sessionId = first.url.split('/').pop()!;
    const created = fake.completeCheckout(sessionId, {
      hasPaymentMethod: true,
      firstInvoice: 'open',
    });
    const newSub = {
      sub: created.externalSubscriptionId,
      customer: b.customer,
    };
    // A notification about the NEW subscription before the link: retried.
    expect(
      (await deliver(newSub, 'subscription.changed')).result,
    ).toMatchObject({ status: 'FAILED', outcome: 'NO_MATCHING_SUBSCRIPTION' });
    const notPaid = await deliver(b, 'checkout.completed', {
      session: sessionId,
    });
    expect(notPaid.result).toMatchObject({
      status: 'FAILED',
      outcome: 'REPLACEMENT_NOT_PAID',
    });
    expect((await subscriptionOf(b)).externalSubscriptionId).toBe(b.sub);
    expect(await tenantOf(b)).toEqual({
      status: 'SUSPENDED',
      suspensionReason: 'BILLING',
    });

    // Paid: linked atomically, ACTIVE, suspension lifted; no new trial.
    fake.setInvoice(
      created.latestInvoiceId!,
      'paid',
      created.externalSubscriptionId,
      b.customer,
    );
    const linked = await lifecycle.recordAndApply(notPaid.verified);
    expect(linked).toMatchObject({ status: 'APPLIED' });
    const after = await subscriptionOf(b);
    expect(after).toMatchObject({
      status: 'ACTIVE',
      externalSubscriptionId: created.externalSubscriptionId,
      canceledAt: null,
      recoveryEndsAt: null,
      trialStartedAt: before.trialStartedAt,
    });
    expect(await tenantOf(b)).toEqual({
      status: 'ACTIVE',
      suspensionReason: null,
    });
    expect(await historyOf(b)).toEqual(
      expect.arrayContaining([
        'SUBSCRIPTION_REPLACED',
        'BILLING_SUSPENSION_LIFTED',
      ]),
    );
    expect(
      await prisma.billingTrialClaim.count({
        where: { subscriptionId: b.subscriptionId },
      }),
    ).toBe(0);
    // The previous subscription id is kept (the replacement record).
    expect(
      await prisma.billingCheckoutSession.findUniqueOrThrow({
        where: { id: row.id },
      }),
    ).toMatchObject({
      status: 'COMPLETED',
      replacesExternalSubscriptionId: b.sub,
    });

    // Redelivered completion: nothing more.
    const replay = await lifecycle.recordAndApply(notPaid.verified);
    expect(replay).toMatchObject({ duplicate: true });

    // Late events of the REPLACED subscription never act on the new one.
    const versionBefore = (await subscriptionOf(b)).billingStateVersion;
    for (const type of ['subscription.changed', 'subscription.ended']) {
      expect((await deliver(b, type)).result).toMatchObject({
        status: 'IGNORED',
        outcome: 'SUPERSEDED_SUBSCRIPTION',
      });
    }
    expect((await subscriptionOf(b)).billingStateVersion).toBe(versionBefore);

    // The new subscription's own events now apply.
    expect(
      (await deliver(newSub, 'subscription.changed')).result.status,
    ).not.toBe('FAILED');
  });

  it('a restart the provider turned into a trial is never accepted', async () => {
    const b = await business('restart-trial', expiredTrial(), 'canceled');
    const { url } = (
      await asStaff(
        'post',
        b.key,
        b.tenantId,
        '/admin/billing/checkout',
      ).expect(201)
    ).body as { url: string };
    const sessionId = url.split('/').pop()!;
    const created = fake.completeCheckout(sessionId, {
      hasPaymentMethod: true,
    });
    fake.setSubscription(created.externalSubscriptionId, {
      status: 'trialing',
      trialStart: new Date(),
      trialEnd: new Date(Date.now() + 30 * DAY),
    });
    const outcome = await deliver(b, 'checkout.completed', {
      session: sessionId,
    });
    expect(outcome.result).toMatchObject({
      status: 'REJECTED',
      outcome: 'UNEXPECTED_TRIAL',
    });
    expect(await subscriptionOf(b)).toMatchObject({
      status: 'TRIAL_EXPIRED',
      externalSubscriptionId: b.sub,
    });
  });

  // --- Paying an outstanding invoice --------------------------------------------

  it('pays an outstanding invoice from OUR records; access returns only when the provider is active and nothing else is outstanding', async () => {
    const pastDueAt = new Date(Date.now() - 20 * DAY);
    const b = await business(
      'unpaid',
      {
        status: 'UNPAID',
        recurringPaymentAuthorizedAt: new Date(Date.now() - 60 * DAY),
        pastDueAt,
        graceEndsAt: new Date(Date.now() - 6 * DAY),
      },
      'unpaid',
    );
    await billingSuspended(b);
    const older = `inv_older_${run}`;
    const newer = `inv_newer_${run}`;
    fake.setInvoice(older, 'open', b.sub, b.customer, {
      createdAt: new Date(Date.now() - 40 * DAY),
    });
    fake.setInvoice(newer, 'open', b.sub, b.customer, {
      createdAt: new Date(Date.now() - 10 * DAY),
    });
    // Another business's open invoice is never offered.
    fake.setInvoice(
      `inv_foreign_${run}`,
      'open',
      `fake_sub_other_${run}`,
      'x',
      {
        createdAt: new Date(Date.now() - 90 * DAY),
      },
    );

    expect(await billingOf(b)).toMatchObject({ canPayInvoice: true });
    const link = (
      await asStaff(
        'post',
        b.key,
        b.tenantId,
        '/admin/billing/recovery/invoice',
        {
          invoiceId: 'inv_attacker',
          url: 'https://evil.example/pay',
        },
      ).expect(200)
    ).body as AdminBillingRecoveryResponse;
    // The OLDEST outstanding invoice, on the provider's own page.
    expect(link.url).toBe(`https://invoice.fake.test/i/${older}`);
    const audit = await prisma.internalAuditEvent.findFirstOrThrow({
      where: { action: 'billing.recovery_started', tenantId: b.tenantId },
    });
    expect(audit).toMatchObject({
      targetType: 'billing_subscription',
      targetId: 'company',
      afterData: {
        kind: 'INVOICE_PAYMENT',
        subscriptionId: b.subscriptionId,
        reference: older,
      },
    });

    // Paying the older one alone does NOT restore access (still outstanding).
    fake.setInvoice(older, 'paid', b.sub, b.customer);
    const partial = await deliver(b, 'invoice.paid', { reference: older });
    expect(partial.result).toMatchObject({
      status: 'FAILED',
      outcome: 'RECOVERY_INCOMPLETE',
    });
    expect(await tenantOf(b)).toEqual({
      status: 'SUSPENDED',
      suspensionReason: 'BILLING',
    });

    // Everything paid, but the provider still says unpaid: still not.
    fake.setInvoice(newer, 'paid', b.sub, b.customer);
    expect(
      (await deliver(b, 'invoice.paid', { reference: newer })).result,
    ).toMatchObject({ status: 'FAILED', outcome: 'RECOVERY_INCOMPLETE' });

    // The provider reactivates the subscription: the payment applies.
    fake.subscriptions.get(b.sub)!.status = 'active';
    const restored = await lifecycle.recordAndApply(partial.verified);
    expect(restored).toMatchObject({ status: 'APPLIED' });
    expect((await subscriptionOf(b)).status).toBe('ACTIVE');
    expect(await tenantOf(b)).toEqual({
      status: 'ACTIVE',
      suspensionReason: null,
    });

    // An unreadable open invoice still counts as outstanding (fail closed).
    const c = await business(
      'unpaid-unknown',
      {
        status: 'UNPAID',
        recurringPaymentAuthorizedAt: new Date(Date.now() - 60 * DAY),
        pastDueAt,
        graceEndsAt: new Date(Date.now() - 6 * DAY),
      },
      'active',
    );
    await billingSuspended(c);
    fake.setInvoice(`inv_c_paid_${run}`, 'paid', c.sub, c.customer);
    fake.unreadableOpenInvoices.set(c.sub, [
      {
        externalInvoiceId: `inv_c_unknown_${run}`,
        status: 'open',
        externalSubscriptionId: null,
        externalCustomerId: c.customer,
        livemode: false,
        amountPaidMinorUnits: 0,
        amountDueMinorUnits: 4900,
        currency: 'usd',
        createdAt: new Date(),
        hostedInvoiceUrl: null,
      },
    ]);
    expect(
      (await deliver(c, 'invoice.paid', { reference: `inv_c_paid_${run}` }))
        .result,
    ).toMatchObject({ status: 'FAILED', outcome: 'RECOVERY_INCOMPLETE' });
    expect((await tenantOf(c)).status).toBe('SUSPENDED');

    // Nothing left to pay now.
    expect(
      (
        await asStaff(
          'post',
          b.key,
          b.tenantId,
          '/admin/billing/recovery/invoice',
        ).expect(409)
      ).body,
    ).toMatchObject({ code: 'BILLING_NOTHING_TO_PAY' });
  });

  it('the provider reporting an UNPAID subscription active again, with nothing outstanding, completes the recovery', async () => {
    const pastDueAt = new Date(Date.now() - 20 * DAY);
    const b = await business(
      'reactivated',
      {
        status: 'UNPAID',
        recurringPaymentAuthorizedAt: new Date(Date.now() - 60 * DAY),
        pastDueAt,
        graceEndsAt: new Date(Date.now() - 6 * DAY),
      },
      'unpaid',
    );
    await billingSuspended(b);
    const invoice = `inv_reactivated_${run}`;
    fake.setInvoice(invoice, 'open', b.sub, b.customer);

    // Still unpaid at the provider: nothing changes.
    expect((await deliver(b, 'subscription.changed')).result.status).not.toBe(
      'APPLIED',
    );
    expect((await subscriptionOf(b)).status).toBe('UNPAID');

    // Paid, but its payment event came too early (provider still unpaid)
    // and is not applied; the provider then reports the subscription
    // active with nothing open: recovered.
    fake.setInvoice(invoice, 'paid', b.sub, b.customer);
    expect(
      (await deliver(b, 'invoice.paid', { reference: invoice })).result,
    ).toMatchObject({ status: 'FAILED', outcome: 'RECOVERY_INCOMPLETE' });
    fake.subscriptions.get(b.sub)!.status = 'active';
    expect((await deliver(b, 'subscription.changed')).result).toMatchObject({
      status: 'APPLIED',
      outcome: 'RECOVERED UNPAID->ACTIVE',
    });
    expect((await subscriptionOf(b)).status).toBe('ACTIVE');
    expect(await tenantOf(b)).toEqual({
      status: 'ACTIVE',
      suspensionReason: null,
    });
  });

  // --- The Customer Portal ---------------------------------------------------------

  it('opens the Customer Portal only for our own customer, under a checked configuration that cannot change the subscription', async () => {
    const b = await business(
      'portal',
      { recurringPaymentAuthorizedAt: new Date() },
      'active',
    );
    const ok = (
      await asStaff(
        'post',
        b.key,
        b.tenantId,
        '/admin/billing/recovery/portal',
        {
          customer: 'fake_cus_attacker',
        },
      ).expect(200)
    ).body as AdminBillingRecoveryResponse;
    expect(ok.url).toMatch(/^https:\/\/billing\.fake\.test\//);
    expect(fake.portalSessions.at(-1)).toEqual({
      customer: b.customer,
      returnUrl: 'https://admin.example.test/admin/billing?portal=returned',
    });

    const safe = { ...fake.portalConfiguration };
    for (const unsafe of [
      { subscriptionCancel: true },
      { subscriptionUpdate: true },
      { customerUpdate: true },
      { loginPage: true },
      { paymentMethodUpdate: false },
      { active: false },
      { livemode: true },
      { accountId: 'acct_someoneelse01' },
      // e.g. pausing: any feature not explicitly allowed.
      { otherEnabledFeatures: ['subscription_pause'] },
    ]) {
      fake.portalConfiguration = { ...safe, ...unsafe };
      expect(
        (
          await asStaff(
            'post',
            b.key,
            b.tenantId,
            '/admin/billing/recovery/portal',
          ).expect(503)
        ).body,
      ).toMatchObject({ code: 'BILLING_UNAVAILABLE' });
    }
    fake.portalConfiguration = safe;

    // Not configured: not offered, and refused.
    fake.portalConfigurationId = null;
    try {
      expect(await billingOf(b)).toMatchObject({
        canManagePaymentMethod: false,
      });
      await asStaff(
        'post',
        b.key,
        b.tenantId,
        '/admin/billing/recovery/portal',
      ).expect(503);
    } finally {
      fake.portalConfigurationId = safe.configurationId;
    }
  });

  // --- Authorization, precedence, isolation -------------------------------------------

  it('recovery is for billing.manage only, never during a SECURITY suspension, never another business', async () => {
    const b = await business('authz', expiredTrial(), 'canceled');
    // A billing.view-only member: sees billing, recovers nothing.
    await staff(b.tenantId, 'authz-viewer', ['billing.view'], `viewer-${run}`);
    expect(await billingOf(b, 'authz-viewer')).toMatchObject({
      canRestartSubscription: false,
      canPayInvoice: false,
      canManagePaymentMethod: false,
    });
    for (const path of [
      '/admin/billing/checkout',
      '/admin/billing/recovery/invoice',
      '/admin/billing/recovery/portal',
    ]) {
      await asStaff('post', 'authz-viewer', b.tenantId, path).expect(403);
    }

    // During the billing wind-down: recovery yes, general administration no.
    await billingSuspended(b);
    await asStaff(
      'post',
      b.key,
      b.tenantId,
      '/admin/billing/recovery/portal',
    ).expect(200);
    expect(
      (await asStaff('get', b.key, b.tenantId, '/admin/locations').expect(403))
        .body,
    ).toMatchObject({ code: 'BUSINESS_BILLING_SUSPENDED' });

    // A SECURITY suspension admits no recovery at all.
    await prisma.tenant.update({
      where: { id: b.tenantId },
      data: { suspensionReason: 'SECURITY' },
    });
    for (const path of [
      '/admin/billing/checkout',
      '/admin/billing/recovery/invoice',
      '/admin/billing/recovery/portal',
    ]) {
      const res = await asStaff('post', b.key, b.tenantId, path).expect(403);
      expect(res.body).not.toMatchObject({
        code: 'BUSINESS_BILLING_SUSPENDED',
      });
    }

    // Another business: never reachable, never its customer.
    const other = await business(
      'authz-other',
      { recurringPaymentAuthorizedAt: new Date() },
      'active',
    );
    const sessionsBefore = fake.portalSessions.length;
    await asStaff(
      'post',
      b.key,
      other.tenantId,
      '/admin/billing/recovery/portal',
    ).expect(403);
    await asStaff(
      'post',
      b.key,
      other.tenantId,
      '/admin/billing/checkout',
    ).expect(403);
    expect(fake.portalSessions.length).toBe(sessionsBefore);
  });
});
