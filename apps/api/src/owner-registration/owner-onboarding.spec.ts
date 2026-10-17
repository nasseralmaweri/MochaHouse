import 'dotenv/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  ONBOARDING_NOT_ELIGIBLE,
  ONBOARDING_PLAN_UNAVAILABLE,
  ONBOARDING_PRICE_CHANGED,
  PLATFORM_PLAN_NOT_SELF_SERVICE,
  type InternalBusinessesResponse,
  type InternalMeResponse,
  type OwnerBusinessCreateResponse,
  type OwnerOnboardingStatus,
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
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { signPlatformDevJwt } from '../platform-auth/infrastructure/platform-dev-jwt';
import { EntitlementsService } from '../subscriptions/application/entitlements.service';
import { StorefrontFeaturesService } from '../subscriptions/application/storefront-features.service';
import { initialLoginPassword } from './application/owner-registration.service';
import {
  LocalDevOwnerRegistrationProvider,
  deriveDevOwnerRegistrationCode,
} from './infrastructure/local-dev-owner-registration.provider';

// SC4b — a verified, self-registered owner creates their ONE business, end
// to end on the real AppModule (dev identity provider) in a SCRATCH
// database of its own. Covers: who may (B2, B4); the exact plan version and
// price, never substituted (B1); what one provisioning creates and that it
// impersonates no operator (B3); idempotency and concurrency; the payment
// setup pending restrictions (core only, no sales, no checkout) and that
// operator-billed businesses are unaffected; tenant isolation; the operator
// plan toggle; and recovery of an interrupted registration.
const FOUNDING_VERSION = '01a0db02-f800-7000-8000-00000000f002';

describe('SC4b owner self-service provisioning (integration, scratch database)', () => {
  let scratch: ScratchDatabase;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let devProvider: LocalDevOwnerRegistrationProvider;
  const originalEnv = { ...process.env };
  const INTERNAL_SECRET = `sc4b-internal-${randomUUID()}`;
  const PLATFORM_SECRET = `sc4b-platform-${randomUUID()}`;
  const REGISTRATION_SECRET = `sc4b-registration-${randomUUID()}`;
  const run = randomUUID().replace(/-/g, '').slice(0, 8);
  const PASSWORD = 'Correct-Horse-9-Battery';

  let growth: {
    planId: string;
    versionId: string;
    month: string;
    year: string;
  };
  let hiddenVersionId: string;
  let hiddenPriceId: string;

  const emailOf = (key: string) => `sc4b-${key}-${run}@example.com`;
  const subjectOf = (email: string) => `internal-dev:${email}`;
  const ownerToken = (email: string) =>
    signInternalDevJwt(
      { sub: subjectOf(email), email, name: null, email_verified: true },
      INTERNAL_SECRET,
      3600,
    );
  const operatorToken = signPlatformDevJwt(
    { sub: `platform-dev:sc4b-${run}`, mfa: true },
    PLATFORM_SECRET,
    3600,
  );
  const http = () => request(app.getHttpServer());
  const status = (email: string) =>
    http()
      .get('/api/v1/internal/onboarding')
      .set('Authorization', `Bearer ${ownerToken(email)}`);
  const create = (email: string, body: Record<string, unknown> = {}) =>
    http()
      .post('/api/v1/internal/onboarding/business')
      .set('Authorization', `Bearer ${ownerToken(email)}`)
      .send({
        businessName: '  Ada’s   Coffee ',
        planVersionId: growth.versionId,
        planPriceId: growth.month,
        expectedPrice: {
          interval: 'MONTH',
          currency: 'USD',
          amountMinorUnits: 4900,
        },
        ...body,
      });

  async function register(email: string): Promise<void> {
    await http()
      .post('/api/v1/internal/registration/start')
      .send({ email })
      .expect(202);
    await http()
      .post('/api/v1/internal/registration/complete')
      .send({
        email,
        code: deriveDevOwnerRegistrationCode(email, 'sign-up', INTERNAL_SECRET),
        password: PASSWORD,
        displayName: 'Ada Owner',
        termsVersion: 'terms-1',
        privacyVersion: 'privacy-1',
        acceptLegal: true,
      })
      .expect(200);
  }

  const businessCount = () => prisma.tenant.count();

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc4b_onboarding',
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
      PLATFORM_AUTH_PROVIDER: 'dev',
      PLATFORM_AUTH_DEV_JWT_SECRET: PLATFORM_SECRET,
      RATE_LIMIT_ENABLED: '0',
      SELF_SERVICE_REGISTRATION_ENABLED: '1',
      SELF_SERVICE_TERMS_VERSION: 'terms-1',
      SELF_SERVICE_PRIVACY_VERSION: 'privacy-1',
      SELF_SERVICE_REGISTRATION_SECRET: REGISTRATION_SECRET,
    });
    delete process.env.BILLING_ENFORCEMENT_ENABLED;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    await app.init();
    prisma = app.get(PrismaService);
    devProvider = app.get(LocalDevOwnerRegistrationProvider);

    // A plan offered for self-service: an older published version (version
    // 1, superseded), the offered one (version 2), monthly and annual prices
    // plus an archived one.
    const plan = await prisma.subscriptionPlan.create({
      data: {
        key: `growth-${run}`,
        name: 'Growth',
        selfServiceAvailable: true,
        versions: {
          create: [
            {
              version: 1,
              status: 'PUBLISHED',
              moduleKeys: ['crm'],
              publishedAt: new Date(),
            },
            {
              version: 2,
              status: 'PUBLISHED',
              moduleKeys: ['loyalty', 'crm'],
              publishedAt: new Date(),
            },
          ],
        },
        prices: {
          create: [
            { interval: 'MONTH', currency: 'USD', amountMinorUnits: 4900 },
            { interval: 'YEAR', currency: 'USD', amountMinorUnits: 49000 },
            {
              interval: 'MONTH',
              currency: 'USD',
              amountMinorUnits: 3900,
              status: 'ARCHIVED',
              archivedAt: new Date(),
            },
          ],
        },
      },
      include: { versions: true, prices: true },
    });
    const byVersion = (n: number) =>
      plan.versions.find((v) => v.version === n)!.id;
    const price = (interval: 'MONTH' | 'YEAR', amount: number) =>
      plan.prices.find(
        (p) => p.interval === interval && p.amountMinorUnits === amount,
      )!.id;
    growth = {
      planId: plan.id,
      versionId: byVersion(2),
      month: price('MONTH', 4900),
      year: price('YEAR', 49000),
    };
    // A plan NOT offered for self-service.
    const hidden = await prisma.subscriptionPlan.create({
      data: {
        key: `hidden-${run}`,
        name: 'Hidden',
        versions: {
          create: {
            version: 1,
            status: 'PUBLISHED',
            moduleKeys: [],
            publishedAt: new Date(),
          },
        },
        prices: {
          create: { interval: 'MONTH', currency: 'USD', amountMinorUnits: 100 },
        },
      },
      include: { versions: true, prices: true },
    });
    hiddenVersionId = hidden.versions[0].id;
    hiddenPriceId = hidden.prices[0].id;
    await prisma.platformOperator.create({
      data: {
        externalProvider: 'platform-dev',
        externalSubject: `platform-dev:sc4b-${run}`,
        email: `sc4b-operator-${run}@example.test`,
        status: 'ACTIVE',
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

  // --- who may -----------------------------------------------------------------

  it('is off with registration (404), needs a login (401), and admits only a VERIFIED self-registered owner (403 otherwise)', async () => {
    const email = emailOf('who');
    process.env.SELF_SERVICE_REGISTRATION_ENABLED = '0';
    await status(email).expect(404);
    await create(email).expect(404);
    process.env.SELF_SERVICE_REGISTRATION_ENABLED = '1';

    await http().get('/api/v1/internal/onboarding').expect(401);
    // An operator-created staff login (no registration) — B4.
    const staff = await status(emailOf('operator-staff')).expect(403);
    expect((staff.body as { code: string }).code).toBe(ONBOARDING_NOT_ELIGIBLE);
    // A registration that is not verified yet.
    await http()
      .post('/api/v1/internal/registration/start')
      .send({ email })
      .expect(202);
    await status(email).expect(403);
    await create(email).expect(403);
    expect(await businessCount()).toBe(1);
  });

  it('offers only self-service plans (never Founding or hidden ones): their newest published version and active prices', async () => {
    const email = emailOf('plans');
    await register(email);
    const res = await status(email).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.body as OwnerOnboardingStatus;
    expect(body).toEqual({
      status: 'BUSINESS_REQUIRED',
      ownerName: 'Ada Owner',
      email,
      plans: [
        {
          planId: growth.planId,
          planVersionId: growth.versionId,
          name: 'Growth',
          description: null,
          modules: ['core', 'loyalty', 'crm'],
          prices: expect.arrayContaining([
            {
              planPriceId: growth.month,
              interval: 'MONTH',
              currency: 'USD',
              amountMinorUnits: 4900,
            },
            {
              planPriceId: growth.year,
              interval: 'YEAR',
              currency: 'USD',
              amountMinorUnits: 49000,
            },
          ]) as unknown,
        },
      ],
    });
    expect(
      (body as { plans: { prices: unknown[] }[] }).plans[0].prices,
    ).toHaveLength(2);
  });

  // --- the exact plan and price (B1) ---------------------------------------------

  it('never stores a different plan version or price than the owner saw — nothing is created', async () => {
    const email = emailOf('price');
    await register(email);
    const before = await businessCount();
    const older = await prisma.subscriptionPlanVersion.findFirstOrThrow({
      where: { planId: growth.planId, version: 1 },
    });
    const archived = await prisma.subscriptionPlanPrice.findFirstOrThrow({
      where: { planId: growth.planId, status: 'ARCHIVED' },
    });
    const cases: [Record<string, unknown>, string][] = [
      [
        {
          planVersionId: hiddenVersionId,
          planPriceId: hiddenPriceId,
          expectedPrice: {
            interval: 'MONTH',
            currency: 'USD',
            amountMinorUnits: 100,
          },
        },
        ONBOARDING_PLAN_UNAVAILABLE,
      ],
      [{ planVersionId: FOUNDING_VERSION }, ONBOARDING_PLAN_UNAVAILABLE],
      [{ planVersionId: older.id }, ONBOARDING_PLAN_UNAVAILABLE],
      [
        {
          planPriceId: archived.id,
          expectedPrice: {
            interval: 'MONTH',
            currency: 'USD',
            amountMinorUnits: 3900,
          },
        },
        ONBOARDING_PLAN_UNAVAILABLE,
      ],
      [{ planPriceId: hiddenPriceId }, ONBOARDING_PLAN_UNAVAILABLE],
      [
        {
          expectedPrice: {
            interval: 'MONTH',
            currency: 'USD',
            amountMinorUnits: 4800,
          },
        },
        ONBOARDING_PRICE_CHANGED,
      ],
      [
        {
          expectedPrice: {
            interval: 'MONTH',
            currency: 'EUR',
            amountMinorUnits: 4900,
          },
        },
        ONBOARDING_PRICE_CHANGED,
      ],
      [{ planPriceId: growth.year }, ONBOARDING_PRICE_CHANGED],
    ];
    for (const [body, code] of cases) {
      const res = await create(email, body).expect(409);
      expect((res.body as { code: string }).code).toBe(code);
    }
    await create(email, { businessName: 'x' }).expect(400);
    await create(email, { planVersionId: 'not-a-uuid' }).expect(400);
    expect(await businessCount()).toBe(before);
    expect(
      (await prisma.ownerRegistration.findUniqueOrThrow({ where: { email } }))
        .provisionedTenantId,
    ).toBeNull();
  });

  // --- what one provisioning creates (B3) ----------------------------------------

  it('creates the business, its roles, the owner bound to their own login, a payment-setup-pending subscription at the exact price, history and audit — no operator anywhere', async () => {
    const email = emailOf('create');
    await register(email);
    const operatorsBefore = await prisma.platformOperator.count();
    const operationsBefore = await prisma.tenantProvisioningOperation.count();

    const res = await create(email, {
      planPriceId: growth.year,
      expectedPrice: {
        interval: 'YEAR',
        currency: 'USD',
        amountMinorUnits: 49000,
      },
    }).expect(201);
    const body = res.body as OwnerBusinessCreateResponse;
    expect(body.replayed).toBe(false);
    expect(body.business.name).toBe('Ada’s Coffee');
    expect(body.business.slug).toMatch(/^ada-s-coffee-[a-z0-9]{6}$/);
    const tenantId = body.business.id;

    expect(
      await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
    ).toMatchObject({
      status: 'ACTIVE',
    });
    const owner = await prisma.internalUser.findFirstOrThrow({
      where: { tenantId },
      include: { roleAssignments: { include: { role: true } } },
    });
    expect(owner).toMatchObject({
      externalProvider: 'internal-dev',
      externalSubject: subjectOf(email),
      email,
      displayName: 'Ada Owner',
      status: 'ACTIVE',
    });
    expect(owner.roleAssignments.map((a) => [a.role.key, a.scopeType])).toEqual(
      [['platform-administrator', 'CORPORATE']],
    );
    expect(await prisma.internalRole.count({ where: { tenantId } })).toBe(2);

    const subscription = await prisma.tenantSubscription.findUniqueOrThrow({
      where: { subscriberTenantId: tenantId },
      include: { events: { orderBy: { type: 'asc' } } },
    });
    expect(subscription).toMatchObject({
      planVersionId: growth.versionId,
      planPriceId: growth.year,
      billingMode: 'BILLED',
      status: 'ACTIVE',
      billingProvider: null,
      externalCustomerId: null,
      externalSubscriptionId: null,
      recurringPaymentAuthorizedAt: null,
      trialStartedAt: null,
    });
    expect(subscription.paymentSetupRequiredSince).toBeInstanceOf(Date);
    expect(
      subscription.events.map((e) => [
        e.type,
        e.source,
        e.actorPlatformOperatorId,
        e.planPriceId,
      ]),
    ).toEqual([
      ['PLAN_ASSIGNED', 'OWNER', null, growth.year],
      ['PAYMENT_SETUP_REQUIRED', 'OWNER', null, growth.year],
    ]);
    expect(
      await prisma.tenantBillingContact.findUniqueOrThrow({
        where: { tenantId },
      }),
    ).toMatchObject({ internalUserId: owner.id });

    const registration = await prisma.ownerRegistration.findUniqueOrThrow({
      where: { email },
    });
    expect(registration.provisionedTenantId).toBe(tenantId);
    expect(registration.provisionedAt).toBeInstanceOf(Date);
    expect(
      await prisma.platformAuditEvent.findMany({
        where: {
          action: 'platform.tenant.self_provisioned',
          targetId: tenantId,
        },
      }),
    ).toEqual([
      expect.objectContaining({
        outcome: 'SUCCEEDED',
        actorPlatformOperatorId: null,
        identityProvider: 'internal-dev',
        identitySubject: subjectOf(email),
        targetType: 'tenant',
      }),
    ]);
    expect(await prisma.platformOperator.count()).toBe(operatorsBefore);
    expect(await prisma.tenantProvisioningOperation.count()).toBe(
      operationsBefore,
    );

    // Now BUSINESS_CREATED.
    expect((await status(email).expect(200)).body).toEqual({
      status: 'BUSINESS_CREATED',
      business: { id: tenantId, name: 'Ada’s Coffee' },
    });
    // The link is permanent (database guard).
    await expect(
      prisma.ownerRegistration.update({
        where: { email },
        data: { provisionedTenantId: null, provisionedAt: null },
      }),
    ).rejects.toThrow();
  });

  it('one business per owner: a retry or concurrent requests return the same business and never create a second', async () => {
    const email = emailOf('once');
    await register(email);
    const before = await businessCount();
    const results = await Promise.all([
      create(email),
      create(email),
      create(email),
    ]);
    const ids = new Set(
      results.map((r) => {
        expect([200, 201]).toContain(r.status);
        return (r.body as OwnerBusinessCreateResponse).business.id;
      }),
    );
    expect(ids.size).toBe(1);
    expect(await businessCount()).toBe(before + 1);
    // A later request, even for a different plan or name: the same business.
    const again = await create(email, {
      businessName: 'Another Business',
      planPriceId: growth.year,
      expectedPrice: {
        interval: 'YEAR',
        currency: 'USD',
        amountMinorUnits: 49000,
      },
    });
    expect(again.status).toBe(201);
    expect(again.body as OwnerBusinessCreateResponse).toMatchObject({
      replayed: true,
      business: { id: [...ids][0], name: 'Ada’s Coffee' },
    });
    expect(await businessCount()).toBe(before + 1);
  });

  // --- payment setup pending: what the owner gets --------------------------------

  it('admits the owner to their business only, with core only, no sales and no payment setup yet', async () => {
    const email = emailOf('pending');
    await register(email);
    const tenantId = (
      (await create(email).expect(201)).body as OwnerBusinessCreateResponse
    ).business.id;
    const token = ownerToken(email);

    const listed = await http()
      .get('/api/v1/internal/businesses')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(
      (listed.body as InternalBusinessesResponse).businesses.map((b) => b.id),
    ).toEqual([tenantId]);

    const me = await http()
      .get('/api/v1/internal/me')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', tenantId)
      .expect(200);
    expect((me.body as InternalMeResponse).entitlements).toEqual({
      modules: ['core'],
      planName: 'Growth',
      paymentSetupPending: true,
    });
    // A paid module of the chosen plan is not available yet.
    await http()
      .get('/api/v1/admin/loyalty/rewards')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', tenantId)
      .expect(403);
    // Core works.
    await http()
      .get('/api/v1/admin/locations')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', tenantId)
      .expect(200);

    const billing = await http()
      .get('/api/v1/admin/billing')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', tenantId)
      .expect(200);
    expect(billing.body).toMatchObject({
      billing: {
        state: 'AWAITING_SETUP',
        paymentSetupOpensSoon: true,
        price: { amountMinorUnits: 4900 },
      },
      canSetUpPayment: false,
    });
    await http()
      .post('/api/v1/admin/billing/checkout')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', tenantId)
      .expect((r) => expect(r.status).toBeGreaterThanOrEqual(400));
    expect(await prisma.billingCheckoutSession.count()).toBe(0);

    // No customer sales.
    const storefront = app.get(StorefrontFeaturesService);
    expect((await storefront.forCheckout(tenantId)).salesOpen).toBe(false);
    expect(
      (await storefront.forCheckout(TENANT_1_MOCHA_HOUSE_ID)).salesOpen,
    ).toBe(true);

    // Never another business, never the platform.
    await http()
      .get('/api/v1/internal/me')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', TENANT_1_MOCHA_HOUSE_ID)
      .expect(403);
    await http()
      .get('/api/v1/platform/tenants')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('lifts the restrictions only once the billing provider has authorized billing, and never affects operator-billed businesses', async () => {
    const entitlements = app.get(EntitlementsService);
    const email = emailOf('authorized');
    await register(email);
    const tenantId = (
      (await create(email).expect(201)).body as OwnerBusinessCreateResponse
    ).business.id;
    expect((await entitlements.forTenant(tenantId)).salesEnabled).toBe(false);
    // Provider-verified setup (as webhooks record it).
    await prisma.tenantSubscription.update({
      where: { subscriberTenantId: tenantId },
      data: {
        billingProvider: 'fake',
        externalCustomerId: `cus_${run}`,
        externalSubscriptionId: `sub_${run}`,
        recurringPaymentAuthorizedAt: new Date(),
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
      },
    });
    const after = await entitlements.forTenant(tenantId);
    expect(after).toMatchObject({
      salesEnabled: true,
      paymentSetupPending: false,
    });
    expect([...after.modules].sort()).toEqual(['core', 'crm', 'loyalty']);

    // An operator-provisioned business billed by an operator but not set up
    // yet keeps the existing rules (enforcement off: its plan's modules).
    const tenant = await prisma.tenant.create({
      data: {
        slug: `sc4b-operator-billed-${run}`,
        name: 'Operator billed',
        status: 'ACTIVE',
      },
    });
    await prisma.tenantSubscription.create({
      data: {
        subscriberTenantId: tenant.id,
        planVersionId: growth.versionId,
        billingMode: 'BILLED',
        billingProvider: 'fake',
        externalCustomerId: `cus_op_${run}`,
        planPriceId: growth.month,
        paymentSetupRequiredSince: new Date(),
      },
    });
    const operatorBilled = await entitlements.forTenant(tenant.id);
    expect(operatorBilled).toMatchObject({
      salesEnabled: true,
      paymentSetupPending: false,
    });
    expect(operatorBilled.modules.has('loyalty')).toBe(true);
  });

  it('keeps the payment-setup-pending state exact (database CHECK)', async () => {
    const email = emailOf('check');
    await register(email);
    const tenantId = (
      (await create(email).expect(201)).body as OwnerBusinessCreateResponse
    ).business.id;
    const where = { subscriberTenantId: tenantId };
    // Without a provider customer: no authorization, no trial, no period, not
    // TRIALING, never without its price.
    for (const data of [
      { recurringPaymentAuthorizedAt: new Date() },
      { paymentSetupRequiredSince: null },
      { status: 'CANCELED' as const, canceledAt: new Date() },
    ]) {
      await expect(
        prisma.tenantSubscription.update({ where, data }),
      ).rejects.toThrow();
    }
  });

  // --- operator control of the offering ----------------------------------------------

  it('lets an operator offer or withdraw a plan for self-service (audited), never Founding', async () => {
    const founding = await prisma.subscriptionPlan.findUniqueOrThrow({
      where: { key: 'founding' },
    });
    const put = (planId: string, available: boolean) =>
      http()
        .put(`/api/v1/platform/plans/${planId}/self-service`)
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({ available });
    const refused = await put(founding.id, true).expect(409);
    expect((refused.body as { code: string }).code).toBe(
      PLATFORM_PLAN_NOT_SELF_SERVICE,
    );
    await expect(
      prisma.subscriptionPlan.update({
        where: { id: founding.id },
        data: { selfServiceAvailable: true },
      }),
    ).rejects.toThrow();

    const hidden = await prisma.subscriptionPlanVersion.findUniqueOrThrow({
      where: { id: hiddenVersionId },
    });
    const offered = await put(hidden.planId, true).expect(200);
    expect(
      (offered.body as { selfServiceAvailable: boolean }).selfServiceAvailable,
    ).toBe(true);
    await put(hidden.planId, false).expect(200);
    expect(
      await prisma.platformAuditEvent.count({
        where: {
          action: 'platform.plan.self_service_changed',
          targetId: hidden.planId,
        },
      }),
    ).toBe(2);
    // Owners cannot use the console route.
    await http()
      .put(`/api/v1/platform/plans/${hidden.planId}/self-service`)
      .set('Authorization', `Bearer ${ownerToken(emailOf('create'))}`)
      .send({ available: true })
      .expect(401);
  });

  // --- registration recovery ---------------------------------------------------------

  it('recovers a registration interrupted after its login was created: the login is proven ours by the server-only initial password', async () => {
    const email = emailOf('recover');
    // An earlier start created the login but stopped before recording it.
    const registration = await prisma.ownerRegistration.create({
      data: {
        email,
        identityProvider: 'internal-dev',
        initialPasswordNonce: randomBytes(32).toString('hex'),
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    await devProvider.createLogin(
      email,
      initialLoginPassword(REGISTRATION_SECRET, registration),
    );

    await http()
      .post('/api/v1/internal/registration/start')
      .send({ email })
      .expect(202);
    await http()
      .post('/api/v1/internal/registration/complete')
      .send({
        email,
        code: deriveDevOwnerRegistrationCode(email, 'sign-up', INTERNAL_SECRET),
        password: PASSWORD,
        displayName: 'Recovered Owner',
        termsVersion: 'terms-1',
        privacyVersion: 'privacy-1',
        acceptLegal: true,
      })
      .expect(200);
    expect(
      await prisma.ownerRegistration.findUniqueOrThrow({ where: { email } }),
    ).toMatchObject({
      status: 'VERIFIED',
      identitySubject: subjectOf(email),
    });
    expect(await devProvider.signIn(email, PASSWORD)).not.toBeNull();
  });

  it('never recovers onto a login it did not create', async () => {
    const email = emailOf('foreign');
    await devProvider.createLogin(email, 'Someone-Elses-Pass-1');
    await http()
      .post('/api/v1/internal/registration/start')
      .send({ email })
      .expect(202);
    await http()
      .post('/api/v1/internal/registration/complete')
      .send({
        email,
        code: deriveDevOwnerRegistrationCode(email, 'sign-up', INTERNAL_SECRET),
        password: PASSWORD,
        displayName: 'Not Me',
        termsVersion: 'terms-1',
        privacyVersion: 'privacy-1',
        acceptLegal: true,
      })
      .expect(400);
    expect(
      await prisma.ownerRegistration.findUniqueOrThrow({ where: { email } }),
    ).toMatchObject({
      status: 'PENDING_VERIFICATION',
      identitySubject: null,
    });
    devProvider.confirmOutOfBand(email);
    expect(
      await devProvider.signIn(email, 'Someone-Elses-Pass-1'),
    ).not.toBeNull();
  });
});
