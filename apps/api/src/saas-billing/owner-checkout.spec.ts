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
  AdminInitialPlanOptionsResponse,
  OwnerBusinessCreateResponse,
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
import { EntitlementsService } from '../subscriptions/application/entitlements.service';
import { StorefrontFeaturesService } from '../subscriptions/application/storefront-features.service';
import { deriveDevOwnerRegistrationCode } from '../owner-registration/infrastructure/local-dev-owner-registration.provider';
import { SAAS_BILLING_PROVIDER } from './provider/saas-billing-provider';
import { BillingAccountService } from './application/billing-account.service';
import type {
  FakeEventBody,
  FakeSaasBillingProvider,
} from './provider/fake-saas-billing-provider';

// SC4c — a self-service business's FIRST payment setup, end to end on the
// real AppModule with the fake billing provider (test mode; no real
// charges), in a SCRATCH database of its own. Covers: the provider customer
// created only when payment setup starts, once (reconciled after an
// interruption, never duplicated); Checkout at exactly the chosen price,
// with the trial from the existing rules; nothing unlocked by a redirect —
// only by the provider's verified events; changing the plan before paying
// (an open Checkout ended first, a completed one refusing); a retired price
// requiring a new choice; and tenant isolation.
describe('SC4c self-service first payment setup (integration, scratch database)', () => {
  let scratch: ScratchDatabase;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let fake: FakeSaasBillingProvider;
  const originalEnv = { ...process.env };
  const INTERNAL_SECRET = `sc4c-internal-${randomUUID()}`;
  const run = randomUUID().replace(/-/g, '').slice(0, 8);
  let growth: {
    planId: string;
    versionId: string;
    month: string;
    year: string;
  };

  const emailOf = (key: string) => `sc4c-${key}-${run}@example.com`;
  const token = (email: string) =>
    signInternalDevJwt(
      { sub: `internal-dev:${email}`, email, name: null, email_verified: true },
      INTERNAL_SECRET,
      3600,
    );
  const http = () => request(app.getHttpServer());
  const admin = (
    method: 'get' | 'post',
    email: string,
    tenantId: string,
    path: string,
    body?: object,
  ) => {
    const req = http()
      [method](`/api/v1/admin/billing${path}`)
      .set('Authorization', `Bearer ${token(email)}`)
      .set('X-Tenant-Id', tenantId);
    return body ? req.send(body) : req;
  };
  const subscriptionOf = (tenantId: string) =>
    prisma.tenantSubscription.findUniqueOrThrow({
      where: { subscriberTenantId: tenantId },
    });
  const calls = (op: string) => fake.calls.filter((c) => c.op === op).length;

  let seq = 0;
  async function webhook(type: string, data: FakeEventBody['data']) {
    const body: FakeEventBody = {
      id: `evt_${run}_${seq++}`,
      type,
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      data,
    };
    const signed = fake.signEvent(body);
    const res = await http()
      .post('/api/v1/billing/webhooks/fake')
      .set('Content-Type', 'application/json')
      .set('x-billing-signature', signed.signatureHeader)
      .send(signed.rawBody);
    return { res, signed };
  }

  async function ownerBusiness(
    key: string,
    price: 'month' | 'year' = 'month',
  ): Promise<{ email: string; tenantId: string }> {
    const email = emailOf(key);
    await http()
      .post('/api/v1/internal/registration/start')
      .send({ email })
      .expect(202);
    await http()
      .post('/api/v1/internal/registration/complete')
      .send({
        email,
        code: deriveDevOwnerRegistrationCode(email, 'sign-up', INTERNAL_SECRET),
        password: 'Correct-Horse-9-Battery',
        displayName: 'Owner',
        termsVersion: 'terms-1',
        privacyVersion: 'privacy-1',
        acceptLegal: true,
      })
      .expect(200);
    const res = await http()
      .post('/api/v1/internal/onboarding/business')
      .set('Authorization', `Bearer ${token(email)}`)
      .send({
        businessName: `Cafe ${key}`,
        planVersionId: growth.versionId,
        planPriceId: price === 'month' ? growth.month : growth.year,
        expectedPrice:
          price === 'month'
            ? { interval: 'MONTH', currency: 'USD', amountMinorUnits: 4900 }
            : { interval: 'YEAR', currency: 'USD', amountMinorUnits: 49000 },
      })
      .expect(201);
    return {
      email,
      tenantId: (res.body as OwnerBusinessCreateResponse).business.id,
    };
  }

  async function openCheckout(email: string, tenantId: string) {
    const res = await admin('post', email, tenantId, '/checkout').expect(201);
    const url = (res.body as AdminBillingCheckoutResponse).url;
    return { url, sessionId: url.split('/').pop()! };
  }

  const setPolicy = (trialDays: number, trialRequiresPaymentMethod: boolean) =>
    prisma.billingPolicy.update({
      where: { id: 'default' },
      data: { trialDays, trialRequiresPaymentMethod },
    });

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc4c_checkout',
    );
    await applyMigrations(
      scratch.url,
      listMigrations(
        join(__dirname, '../../../../packages/database/prisma/migrations'),
      ),
    );
    Object.assign(process.env, {
      DATABASE_URL: scratch.url,
      INTERNAL_AUTH_PROVIDER: 'dev',
      INTERNAL_AUTH_DEV_JWT_SECRET: INTERNAL_SECRET,
      RATE_LIMIT_ENABLED: '0',
      SAAS_BILLING_PROVIDER: 'fake',
      SAAS_BILLING_TRIAL_CLAIM_SECRET: `sc4c-claims-${randomUUID()}`,
      BILLING_CHECKOUT_RETURN_URL: 'http://localhost:3000/admin/billing',
      SELF_SERVICE_REGISTRATION_ENABLED: '1',
      SELF_SERVICE_TERMS_VERSION: 'terms-1',
      SELF_SERVICE_PRIVACY_VERSION: 'privacy-1',
      SELF_SERVICE_REGISTRATION_SECRET: `sc4c-registration-${randomUUID()}`,
    });
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
    fake = app.get(SAAS_BILLING_PROVIDER);

    const plan = await prisma.subscriptionPlan.create({
      data: {
        key: `growth-${run}`,
        name: 'Growth',
        selfServiceAvailable: true,
        versions: {
          create: {
            version: 1,
            status: 'PUBLISHED',
            moduleKeys: ['loyalty', 'crm'],
            publishedAt: new Date(),
          },
        },
        prices: {
          create: [
            { interval: 'MONTH', currency: 'USD', amountMinorUnits: 4900 },
            { interval: 'YEAR', currency: 'USD', amountMinorUnits: 49000 },
          ],
        },
      },
      include: { versions: true, prices: true },
    });
    growth = {
      planId: plan.id,
      versionId: plan.versions[0].id,
      month: plan.prices.find((p) => p.interval === 'MONTH')!.id,
      year: plan.prices.find((p) => p.interval === 'YEAR')!.id,
    };
  });

  beforeEach(() => setPolicy(14, true));

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      process.env = { ...originalEnv };
      await scratch?.drop();
    }
  });

  it('shows the first payment setup with the trial disclosed, creates the provider customer only when setup starts, and only once', async () => {
    const { email, tenantId } = await ownerBusiness('setup');
    // Before setup starts: no provider customer at all (C1).
    expect(await subscriptionOf(tenantId)).toMatchObject({
      billingProvider: null,
      externalCustomerId: null,
    });
    const view = (await admin('get', email, tenantId, '').expect(200))
      .body as AdminBillingResponse;
    expect(view).toMatchObject({
      billing: { state: 'AWAITING_SETUP', initialSetupPending: true },
      canSetUpPayment: true,
      initialSetup: {
        selectionAvailable: true,
        trial: { days: 14, requiresPaymentMethod: true },
        canChangeSelection: true,
      },
    });
    expect(calls('createCustomer')).toBe(0);

    const first = await openCheckout(email, tenantId);
    const sub = await subscriptionOf(tenantId);
    expect(sub).toMatchObject({
      billingMode: 'BILLED',
      billingProvider: 'fake',
      planPriceId: growth.month,
      trialStartedAt: null,
    });
    expect(sub.externalCustomerId).toMatch(/^fake_cus_/);
    // Checkout at exactly the chosen price, with the policy's trial.
    const checkout = fake.checkouts.get(first.sessionId)!;
    expect(checkout).toMatchObject({
      externalCustomerId: sub.externalCustomerId,
      externalPriceId: fake.prices.get(growth.month),
      trialDays: 14,
      requiresPaymentMethod: true,
    });

    // Leaving and coming back (or a double click): the same Checkout and
    // never a second customer.
    const again = await openCheckout(email, tenantId);
    expect(again.url).toBe(first.url);
    await Promise.all([
      admin('post', email, tenantId, '/checkout'),
      admin('post', email, tenantId, '/checkout'),
    ]);
    expect(calls('createCustomer')).toBe(1);
    expect(fake.customersByTenant.get(tenantId)).toHaveLength(1);
    expect(
      await prisma.billingCheckoutSession.count({
        where: { subscriptionId: sub.id, status: 'OPEN' },
      }),
    ).toBe(1);
  });

  it('unlocks nothing on a browser redirect — only the provider-verified trial; duplicate deliveries change nothing', async () => {
    const entitlements = app.get(EntitlementsService);
    const storefront = app.get(StorefrontFeaturesService);
    const { email, tenantId } = await ownerBusiness('activate');
    const subscriptionId = (await subscriptionOf(tenantId)).id;
    await prisma.tenantModuleGrant.create({
      data: { subscriptionId, moduleKey: 'giftcards' },
    });
    const { sessionId } = await openCheckout(email, tenantId);
    const sub = await subscriptionOf(tenantId);

    // The owner finished Checkout and came back (?checkout=success), but no
    // provider event has arrived: still restricted.
    const snapshot = fake.completeCheckout(sessionId, {
      hasPaymentMethod: true,
    });
    await admin('get', email, tenantId, '?checkout=success').expect(200);
    expect([...(await entitlements.forTenant(tenantId)).modules]).toEqual([
      'core',
    ]);
    expect((await storefront.forCheckout(tenantId)).salesOpen).toBe(false);

    const linked = await webhook('checkout.completed', {
      session: sessionId,
      customer: sub.externalCustomerId,
      subscription: snapshot.externalSubscriptionId,
    });
    expect(linked.res.status).toBe(200);
    const activated = await subscriptionOf(tenantId);
    expect(activated).toMatchObject({
      status: 'TRIALING',
      trialRequiresPaymentMethod: true,
      externalSubscriptionId: snapshot.externalSubscriptionId,
    });
    expect(activated.trialStartedAt).toBeInstanceOf(Date);
    expect(activated.recurringPaymentAuthorizedAt).toBeInstanceOf(Date);
    const unlocked = await entitlements.forTenant(tenantId);
    expect([...unlocked.modules].sort()).toEqual(
      ['core', 'crm', 'giftcards', 'loyalty'].sort(),
    );
    expect((await storefront.forCheckout(tenantId)).salesOpen).toBe(true);
    const view = (await admin('get', email, tenantId, '').expect(200))
      .body as AdminBillingResponse;
    expect(view).toMatchObject({
      billing: { state: 'TRIALING', initialSetupPending: false },
      initialSetup: null,
      canSetUpPayment: false,
    });

    // A duplicate (or late) delivery: nothing more.
    const history = await prisma.tenantSubscriptionEvent.count({
      where: { subscriptionId },
    });
    await http()
      .post('/api/v1/billing/webhooks/fake')
      .set('Content-Type', 'application/json')
      .set('x-billing-signature', linked.signed.signatureHeader)
      .send(linked.signed.rawBody)
      .expect(200);
    expect(
      await prisma.tenantSubscriptionEvent.count({ where: { subscriptionId } }),
    ).toBe(history);
    // Payment is set up: the plan can no longer be changed this way.
    await admin('post', email, tenantId, '/initial-plan', {
      planVersionId: growth.versionId,
      planPriceId: growth.year,
      expectedPrice: {
        interval: 'YEAR',
        currency: 'USD',
        amountMinorUnits: 49000,
      },
    }).expect(409);
  });

  it('keeps everything restricted when the first payment is not made (no trial)', async () => {
    await setPolicy(0, true);
    const entitlements = app.get(EntitlementsService);
    const { email, tenantId } = await ownerBusiness('unpaid');
    const { sessionId } = await openCheckout(email, tenantId);
    const sub = await subscriptionOf(tenantId);
    expect(fake.checkouts.get(sessionId)!.trialDays).toBe(0);
    const snapshot = fake.completeCheckout(sessionId, {
      hasPaymentMethod: true,
      firstInvoice: 'open',
    });
    await webhook('checkout.completed', {
      session: sessionId,
      customer: sub.externalCustomerId,
      subscription: snapshot.externalSubscriptionId,
    });
    const after = await subscriptionOf(tenantId);
    expect(after.currentPeriodStart).toBeNull();
    expect(after.trialStartedAt).toBeNull();
    expect(await entitlements.forTenant(tenantId)).toMatchObject({
      salesEnabled: false,
      paymentSetupPending: true,
    });
  });

  it('reconciles an interrupted customer creation (reusing the customer it made) and a provider timeout, never creating a second customer', async () => {
    // A customer an earlier attempt created whose answer was lost.
    const a = await ownerBusiness('lost');
    const lost = fake.createLostCustomer(a.tenantId);
    const createdBefore = calls('createCustomer');
    await openCheckout(a.email, a.tenantId);
    expect((await subscriptionOf(a.tenantId)).externalCustomerId).toBe(lost);
    expect(calls('createCustomer')).toBe(createdBefore);

    // A timeout while creating: nothing recorded; the retry converges on ONE.
    const b = await ownerBusiness('timeout');
    fake.failOp = { op: 'createCustomer', code: 'timeout' };
    await admin('post', b.email, b.tenantId, '/checkout').expect(503);
    expect(await subscriptionOf(b.tenantId)).toMatchObject({
      billingProvider: null,
      externalCustomerId: null,
    });
    await openCheckout(b.email, b.tenantId);
    expect(fake.customersByTenant.get(b.tenantId)).toHaveLength(1);
    expect((await subscriptionOf(b.tenantId)).externalCustomerId).toBe(
      fake.customersByTenant.get(b.tenantId)![0],
    );
  });

  it('lets the owner change the plan or price before paying — ending an open Checkout first, never at an amount they did not see', async () => {
    const { email, tenantId } = await ownerBusiness('change');
    const options = (
      await admin('get', email, tenantId, '/initial-plan-options').expect(200)
    ).body as AdminInitialPlanOptionsResponse;
    expect(options.current).toEqual({
      planVersionId: growth.versionId,
      planPriceId: growth.month,
    });
    expect(options.plans.map((p) => p.planVersionId)).toEqual([
      growth.versionId,
    ]);

    const { sessionId } = await openCheckout(email, tenantId);
    const yearly = {
      planVersionId: growth.versionId,
      planPriceId: growth.year,
      expectedPrice: {
        interval: 'YEAR',
        currency: 'USD',
        amountMinorUnits: 49000,
      },
    };
    // Not as shown: refused, nothing changed.
    await admin('post', email, tenantId, '/initial-plan', {
      ...yearly,
      expectedPrice: {
        interval: 'YEAR',
        currency: 'USD',
        amountMinorUnits: 39000,
      },
    }).expect(409);
    expect((await subscriptionOf(tenantId)).planPriceId).toBe(growth.month);
    expect(fake.checkouts.get(sessionId)!.status).toBe('open');

    const res = await admin(
      'post',
      email,
      tenantId,
      '/initial-plan',
      yearly,
    ).expect(200);
    expect((res.body as AdminBillingResponse).billing.price).toMatchObject({
      amountMinorUnits: 49000,
      interval: 'YEAR',
    });
    const sub = await subscriptionOf(tenantId);
    expect(sub.planPriceId).toBe(growth.year);
    // The old Checkout can no longer be completed.
    expect(fake.checkouts.get(sessionId)!.status).toBe('expired');
    expect(
      await prisma.billingCheckoutSession.count({
        where: { subscriptionId: sub.id, status: 'OPEN' },
      }),
    ).toBe(0);
    expect(
      await prisma.tenantSubscriptionEvent.findFirstOrThrow({
        where: { subscriptionId: sub.id, type: 'PLAN_CHANGED' },
      }),
    ).toMatchObject({
      source: 'OWNER',
      actorPlatformOperatorId: null,
      planPriceId: growth.year,
    });
    // A new Checkout uses the new price (and the same customer).
    const next = await openCheckout(email, tenantId);
    expect(fake.checkouts.get(next.sessionId)!.externalPriceId).toBe(
      fake.prices.get(growth.year),
    );
    expect(fake.customersByTenant.get(tenantId)).toHaveLength(1);

    // A Checkout already completed (its confirmation on the way): refused.
    fake.completeCheckout(next.sessionId, { hasPaymentMethod: true });
    const late = await admin('post', email, tenantId, '/initial-plan', {
      planVersionId: growth.versionId,
      planPriceId: growth.month,
      expectedPrice: {
        interval: 'MONTH',
        currency: 'USD',
        amountMinorUnits: 4900,
      },
    }).expect(409);
    expect((late.body as { code: string }).code).toBe(
      'BILLING_CHECKOUT_PROCESSING',
    );
    expect((await subscriptionOf(tenantId)).planPriceId).toBe(growth.year);
  });

  it('requires a new choice when the chosen price was retired — never charged or substituted', async () => {
    const { email, tenantId } = await ownerBusiness('retired', 'year');
    await prisma.subscriptionPlanPrice.update({
      where: { id: growth.year },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    });
    // (A price is never un-archived: later tests use the monthly price.)
    const view = (await admin('get', email, tenantId, '').expect(200))
      .body as AdminBillingResponse;
    expect(view).toMatchObject({
      canSetUpPayment: false,
      initialSetup: { selectionAvailable: false },
    });
    const refused = await admin('post', email, tenantId, '/checkout').expect(
      409,
    );
    expect((refused.body as { code: string }).code).toBe(
      'BILLING_SELECTION_UNAVAILABLE',
    );
    expect((await subscriptionOf(tenantId)).billingProvider).toBeNull();
    expect(fake.customersByTenant.get(tenantId)).toBeUndefined();
    // The retired price is not offered again.
    const options = (
      await admin('get', email, tenantId, '/initial-plan-options').expect(200)
    ).body as AdminInitialPlanOptionsResponse;
    expect(options.plans[0].prices.map((p) => p.planPriceId)).toEqual([
      growth.month,
    ]);
    await admin('post', email, tenantId, '/initial-plan', {
      planVersionId: growth.versionId,
      planPriceId: growth.month,
      expectedPrice: {
        interval: 'MONTH',
        currency: 'USD',
        amountMinorUnits: 4900,
      },
    }).expect(200);
    await openCheckout(email, tenantId);
  });

  // --- review fixes: a plan change racing payment setup; retired prices ----------

  // A separate self-service plan with one monthly price (one ACTIVE price
  // per plan and interval).
  async function extraPlan(key: string, amountMinorUnits: number) {
    const plan = await prisma.subscriptionPlan.create({
      data: {
        key: `${key}-${run}`,
        name: key,
        selfServiceAvailable: true,
        versions: {
          create: {
            version: 1,
            status: 'PUBLISHED',
            moduleKeys: [],
            publishedAt: new Date(),
          },
        },
        prices: {
          create: { interval: 'MONTH', currency: 'USD', amountMinorUnits },
        },
      },
      include: { versions: true, prices: true },
    });
    return { versionId: plan.versions[0].id, priceId: plan.prices[0].id };
  }

  it('never opens a Checkout at a price other than the one checked when a plan change races it', async () => {
    const other = await extraPlan('race', 5900);
    const otherPrice = { id: other.priceId };
    const sneakChange = async (tenantId: string) => {
      // What a concurrent plan change commits mid-request.
      await prisma.tenantSubscription.update({
        where: { subscriberTenantId: tenantId },
        data: {
          planPriceId: otherPrice.id,
          billingStateVersion: { increment: 1 },
        },
      });
    };
    try {
      // Changed while the customer was being created.
      const a = await ownerBusiness('race-customer');
      // (The lookup that runs just before the customer is created.)
      const customerSpy = jest
        .spyOn(fake, 'findCustomerForTenant')
        .mockImplementationOnce(async () => {
          await sneakChange(a.tenantId);
          return null;
        });
      try {
        const res = await admin(
          'post',
          a.email,
          a.tenantId,
          '/checkout',
        ).expect(409);
        expect((res.body as { code: string }).code).toBe(
          'BILLING_SELECTION_LOCKED',
        );
      } finally {
        customerSpy.mockRestore();
      }
      // Changed while the price was being synced, just before the Checkout
      // is recorded.
      const b = await ownerBusiness('race-sync');
      // On a plan whose price is not synced to the provider yet.
      const fresh = await extraPlan('race-fresh', 7900);
      await admin('post', b.email, b.tenantId, '/initial-plan', {
        planVersionId: fresh.versionId,
        planPriceId: fresh.priceId,
        expectedPrice: {
          interval: 'MONTH',
          currency: 'USD',
          amountMinorUnits: 7900,
        },
      }).expect(200);
      // (The plan's product is synced first.)
      const priceSpy = jest
        .spyOn(fake, 'ensureProduct')
        .mockImplementationOnce(async (input) => {
          await sneakChange(b.tenantId);
          return { externalProductId: `fake_prod_${input.planId}` };
        });
      try {
        await admin('post', b.email, b.tenantId, '/checkout').expect(409);
      } finally {
        priceSpy.mockRestore();
      }
      for (const tenantId of [a.tenantId, b.tenantId]) {
        const sub = await subscriptionOf(tenantId);
        expect(
          await prisma.billingCheckoutSession.count({
            where: { subscriptionId: sub.id },
          }),
        ).toBe(0);
      }
    } finally {
      await prisma.subscriptionPlan.update({
        where: { key: `race-${run}` },
        data: { selfServiceAvailable: false },
      });
    }
  });

  it('ends an open Checkout at a retired price — when the operator archives it and when the owner retries', async () => {
    const accounts = app.get(BillingAccountService);
    const seasonal = await extraPlan('seasonal', 6900);
    const tempPrice = { id: seasonal.priceId };
    // Two businesses with a Checkout open at that price.
    const opened: { email: string; tenantId: string; sessionId: string }[] = [];
    for (const key of ['archived-op', 'archived-owner']) {
      const owner = await ownerBusiness(key);
      await admin('post', owner.email, owner.tenantId, '/initial-plan', {
        planVersionId: seasonal.versionId,
        planPriceId: tempPrice.id,
        expectedPrice: {
          interval: 'MONTH',
          currency: 'USD',
          amountMinorUnits: 6900,
        },
      }).expect(200);
      opened.push({
        ...owner,
        ...(await openCheckout(owner.email, owner.tenantId)),
      });
    }
    await prisma.subscriptionPlanPrice.update({
      where: { id: tempPrice.id },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    });
    // The operator's archive ends them (the hook the console route runs).
    await accounts.endSelfServiceCheckoutsAtPrice(tempPrice.id);
    for (const { sessionId } of opened) {
      expect(fake.checkouts.get(sessionId)!.status).toBe('expired');
    }
    // Owner retry: refused, nothing reopened at the retired price.
    const [owner] = opened;
    const refused = await admin(
      'post',
      owner.email,
      owner.tenantId,
      '/checkout',
    ).expect(409);
    expect((refused.body as { code: string }).code).toBe(
      'BILLING_SELECTION_UNAVAILABLE',
    );
    const sub = await subscriptionOf(owner.tenantId);
    expect(
      await prisma.billingCheckoutSession.count({
        where: { subscriptionId: sub.id, status: 'OPEN' },
      }),
    ).toBe(0);
  });

  it('keeps every business to itself', async () => {
    const a = await ownerBusiness('iso-a');
    const b = await ownerBusiness('iso-b');
    // Owner A against business B: refused before anything is read or done.
    for (const [method, path] of [
      ['get', ''],
      ['get', '/initial-plan-options'],
      ['post', '/checkout'],
      ['post', '/initial-plan'],
    ] as const) {
      await admin(method, a.email, b.tenantId, path, {}).expect(403);
    }
    expect((await subscriptionOf(b.tenantId)).billingProvider).toBeNull();
  });
});
