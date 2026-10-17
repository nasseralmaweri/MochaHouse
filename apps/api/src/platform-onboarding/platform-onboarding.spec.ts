import 'dotenv/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  AdminGettingStartedResponse,
  OwnerBusinessCreateResponse,
  PlatformOnboardingBusinessListResponse,
  PlatformPermission,
  PlatformRegistrationControlView,
  PlatformRegistrationListResponse,
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
import { deriveDevOwnerRegistrationCode } from '../owner-registration/infrastructure/local-dev-owner-registration.provider';
import { isRegistrationPaused } from '../owner-registration/application/registration-control';
import { maskEmail } from './application/platform-onboarding.service';

// SC4e — Platform Console onboarding oversight, end to end on the real
// AppModule in a SCRATCH database: permission enforcement on every route
// (and nothing for business staff), registration reports that mask
// unverified emails and never expose secrets or login identifiers, the
// pause that stops NEW registrations and codes but never existing ones or
// the deployment's master flag, concurrency-safe and audited, and the
// onboarding progress that is each business's own SC4d checklist.
jest.setTimeout(240_000);

describe('SC4e platform onboarding oversight (integration, scratch database)', () => {
  let scratch: ScratchDatabase;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const PLATFORM_SECRET = `sc4e-platform-${randomUUID()}`;
  const INTERNAL_SECRET = `sc4e-internal-${randomUUID()}`;
  const run = randomUUID().replace(/-/g, '').slice(0, 8);
  let growth: { versionId: string; month: string };

  async function operator(key: string, permissions: PlatformPermission[]) {
    const row = await prisma.platformOperator.create({
      data: {
        externalProvider: 'platform-dev',
        externalSubject: `platform-dev:sc4e-${key}-${run}`,
        email: `sc4e-${key}-${run}@example.test`,
        status: 'ACTIVE',
      },
    });
    if (permissions.length) {
      await grantPlatformPermissions(prisma, row.id, permissions);
    }
    return row.id;
  }
  const platformToken = (key: string, signedInSecondsAgo = 0) =>
    signPlatformDevJwt(
      {
        sub: `platform-dev:sc4e-${key}-${run}`,
        mfa: true,
        iat: Math.floor(Date.now() / 1000) - signedInSecondsAgo,
      },
      PLATFORM_SECRET,
      3600,
    );
  const http = () => request(app.getHttpServer());
  const platform = (
    key: string,
    method: 'get' | 'post',
    path: string,
    body?: object,
    signedInSecondsAgo = 0,
  ) => {
    const req = http()
      [method](`/api/v1/platform/onboarding${path}`)
      .set('Authorization', `Bearer ${platformToken(key, signedInSecondsAgo)}`);
    return body ? req.send(body) : req;
  };
  const staffToken = (email: string) =>
    signInternalDevJwt(
      { sub: `internal-dev:${email}`, email, name: null, email_verified: true },
      INTERNAL_SECRET,
      3600,
    );
  const emailOf = (key: string) => `sc4e-${key}-${run}@example.com`;
  const code = (
    email: string,
    purpose: 'sign-up' | 'password-setup' = 'sign-up',
  ) => deriveDevOwnerRegistrationCode(email, purpose, INTERNAL_SECRET);
  const start = (email: string) =>
    http().post('/api/v1/internal/registration/start').send({ email });
  const complete = (email: string) =>
    http()
      .post('/api/v1/internal/registration/complete')
      .send({
        email,
        code: code(email),
        password: 'Correct-Horse-9-Battery',
        displayName: 'Owner',
        termsVersion: 'terms-1',
        privacyVersion: 'privacy-1',
        acceptLegal: true,
      });

  async function verifiedOwner(key: string): Promise<string> {
    const email = emailOf(key);
    await start(email).expect(202);
    await complete(email).expect(200);
    return email;
  }
  async function ownerBusiness(key: string) {
    const email = await verifiedOwner(key);
    const res = await http()
      .post('/api/v1/internal/onboarding/business')
      .set('Authorization', `Bearer ${staffToken(email)}`)
      .send({
        businessName: `Cafe ${key}`,
        planVersionId: growth.versionId,
        planPriceId: growth.month,
        expectedPrice: {
          interval: 'MONTH',
          currency: 'USD',
          amountMinorUnits: 4900,
        },
      })
      .expect(201);
    return {
      email,
      tenantId: (res.body as OwnerBusinessCreateResponse).business.id,
    };
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc4e_onboarding',
    );
    await applyMigrations(
      scratch.url,
      listMigrations(
        join(__dirname, '../../../../packages/database/prisma/migrations'),
      ),
    );
    Object.assign(process.env, {
      DATABASE_URL: scratch.url,
      PLATFORM_AUTH_PROVIDER: 'dev',
      PLATFORM_AUTH_DEV_JWT_SECRET: PLATFORM_SECRET,
      INTERNAL_AUTH_PROVIDER: 'dev',
      INTERNAL_AUTH_DEV_JWT_SECRET: INTERNAL_SECRET,
      RATE_LIMIT_ENABLED: '0',
      SAAS_BILLING_PROVIDER: 'fake',
      SAAS_BILLING_TRIAL_CLAIM_SECRET: `sc4e-claims-${randomUUID()}`,
      BILLING_CHECKOUT_RETURN_URL: 'http://localhost:3000/admin/billing',
      // Test-only, in this scratch database: registration on so the flows
      // that feed the reports can run.
      SELF_SERVICE_REGISTRATION_ENABLED: '1',
      SELF_SERVICE_TERMS_VERSION: 'terms-1',
      SELF_SERVICE_PRIVACY_VERSION: 'privacy-1',
      SELF_SERVICE_REGISTRATION_SECRET: `sc4e-registration-${randomUUID()}`,
      SELF_SERVICE_REGISTRATION_DAILY_LIMIT: '40',
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

    const plan = await prisma.subscriptionPlan.create({
      data: {
        key: `growth-${run}`,
        name: 'Growth',
        selfServiceAvailable: true,
        versions: {
          create: {
            version: 1,
            status: 'PUBLISHED',
            moduleKeys: ['loyalty'],
            publishedAt: new Date(),
          },
        },
        prices: {
          create: [
            { interval: 'MONTH', currency: 'USD', amountMinorUnits: 4900 },
          ],
        },
      },
      include: { versions: true, prices: true },
    });
    growth = { versionId: plan.versions[0].id, month: plan.prices[0].id };

    await operator('none', []);
    await operator('viewer', ['onboarding.view']);
    await operator('manager', ['onboarding.view', 'onboarding.manage']);
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      process.env = { ...originalEnv };
      await scratch?.drop();
    }
  });

  it('requires the onboarding permissions on every route, audits refusals, and never admits business staff', async () => {
    for (const [method, path] of [
      ['get', '/registrations'],
      ['get', '/businesses'],
      ['get', '/registration-control'],
      ['post', '/registration-control'],
    ] as const) {
      await platform('none', method, path, {
        paused: true,
        reason: 'Testing the permission check',
      }).expect(403);
      await http()[method](`/api/v1/platform/onboarding${path}`).expect(401);
    }
    expect(
      await prisma.platformAuditEvent.count({
        where: {
          action: 'platform.access.denied',
          reasonCode: 'PERMISSION_REQUIRED',
        },
      }),
    ).toBeGreaterThanOrEqual(4);

    // View-only: reads yes, the pause no.
    await platform('viewer', 'get', '/registration-control').expect(200);
    await platform('viewer', 'post', '/registration-control', {
      paused: true,
      reason: 'A viewer must not be able to pause',
    }).expect(403);

    // A business owner's staff token is not a platform credential.
    const owner = await ownerBusiness('staff');
    await http()
      .get('/api/v1/platform/onboarding/registrations')
      .set('Authorization', `Bearer ${staffToken(owner.email)}`)
      .expect(401);
    await http()
      .get('/api/v1/platform/onboarding/registrations')
      .set('Authorization', `Bearer ${staffToken(owner.email)}`)
      .set('X-Tenant-Id', owner.tenantId)
      .expect(401);
  });

  it('lists registrations newest first with unverified emails masked and no secrets, filters issues, and audits each view', async () => {
    const pendingEmail = emailOf('pending');
    await start(pendingEmail).expect(202);
    const expiredEmail = emailOf('expired');
    await start(expiredEmail).expect(202);
    await prisma.ownerRegistration.update({
      where: { email: expiredEmail },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const stalledEmail = emailOf('stalled');
    await start(stalledEmail).expect(202);
    await prisma.ownerRegistration.update({
      where: { email: stalledEmail },
      data: { verificationAttempts: 5 },
    });
    const noBusinessEmail = await verifiedOwner('nobusiness');
    const business = await ownerBusiness('listed');

    const before = await prisma.platformAuditEvent.count({
      where: { action: 'platform.onboarding.registrations_viewed' },
    });
    const all = (
      await platform('viewer', 'get', '/registrations?pageSize=50').expect(200)
    ).body as PlatformRegistrationListResponse;
    // Masked addresses look alike, so rows are matched by registration id.
    const idOf = new Map(
      (
        await prisma.ownerRegistration.findMany({
          select: { id: true, email: true },
        })
      ).map((row) => [row.email, row.id]),
    );
    const byEmail = (email: string) =>
      all.items.find((row) => row.id === idOf.get(email));

    expect(byEmail(pendingEmail)).toMatchObject({
      email: maskEmail(pendingEmail),
      emailMasked: true,
      status: 'PENDING_VERIFICATION',
      codesSent: 1,
      verifiedAt: null,
      business: null,
      issue: null,
    });
    expect(maskEmail(pendingEmail)).toBe(`s***@example.com`);
    expect(byEmail(expiredEmail)?.issue).toBe('EXPIRED');
    expect(byEmail(stalledEmail)).toMatchObject({
      issue: 'STALLED',
      failedAttempts: 5,
    });
    expect(byEmail(noBusinessEmail)).toMatchObject({
      email: noBusinessEmail,
      emailMasked: false,
      status: 'VERIFIED',
      issue: 'NO_BUSINESS',
    });
    expect(byEmail(business.email)?.business).toMatchObject({
      id: business.tenantId,
      name: 'Cafe listed',
    });
    // Newest first.
    const created = all.items.map((row) => row.createdAt);
    expect([...created].sort().reverse()).toEqual(created);

    // Never: login identifiers, the initial-password nonce, codes, secrets.
    const raw = JSON.stringify(all);
    expect(raw).not.toMatch(
      /identitySubject|initialPasswordNonce|identityProvider|internal-dev:/,
    );
    const nonces = await prisma.ownerRegistration.findMany({
      select: { initialPasswordNonce: true },
    });
    for (const { initialPasswordNonce } of nonces)
      expect(raw).not.toContain(initialPasswordNonce);
    expect(raw).not.toContain(code(pendingEmail));
    // An unverified address never appears in full.
    expect(raw).not.toContain(pendingEmail);

    const filtered = async (filter: string) =>
      (
        (
          await platform(
            'viewer',
            'get',
            `/registrations?filter=${filter}&pageSize=50`,
          ).expect(200)
        ).body as PlatformRegistrationListResponse
      ).items.map((row) => row.issue);
    expect(new Set(await filtered('expired'))).toEqual(new Set(['EXPIRED']));
    expect(new Set(await filtered('stalled'))).toEqual(new Set(['STALLED']));
    expect(new Set(await filtered('no-business'))).toEqual(
      new Set(['NO_BUSINESS']),
    );
    const withBusiness = (
      await platform(
        'viewer',
        'get',
        '/registrations?filter=with-business',
      ).expect(200)
    ).body as PlatformRegistrationListResponse;
    expect(withBusiness.items.every((row) => row.business !== null)).toBe(true);

    const today = new Date().toISOString().slice(0, 10);
    const dated = (
      await platform(
        'viewer',
        'get',
        `/registrations?createdFrom=${today}&createdTo=${today}`,
      ).expect(200)
    ).body as PlatformRegistrationListResponse;
    expect(dated.total).toBe(all.total);
    const none = (
      await platform(
        'viewer',
        'get',
        '/registrations?createdTo=2000-01-01',
      ).expect(200)
    ).body as PlatformRegistrationListResponse;
    expect(none.total).toBe(0);

    for (const bad of [
      'filter=everything',
      'pageSize=51',
      'page=0',
      'createdFrom=2026-02-30',
      'createdFrom=2026-05-02&createdTo=2026-05-01',
      'filter=all&filter=expired',
    ]) {
      await platform('viewer', 'get', `/registrations?${bad}`).expect(400);
    }

    expect(
      await prisma.platformAuditEvent.count({
        where: { action: 'platform.onboarding.registrations_viewed' },
      }),
    ).toBeGreaterThan(before);
  });

  it('pauses and resumes new registrations: audited, concurrency-safe, blocking new starts and codes but not completion', async () => {
    const view = async () =>
      (await platform('viewer', 'get', '/registration-control').expect(200))
        .body as PlatformRegistrationControlView;
    const initial = await view();
    expect(initial).toMatchObject({
      flag: 'ON',
      paused: false,
      accepting: true,
      lastChange: null,
      quota: { limit: 40, windowHours: 24, nextFreeAt: null },
    });
    expect(initial.quota.usedInWindow).toBe(
      await prisma.ownerRegistration.count({
        where: { createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } },
      }),
    );

    // Input checks, the permission and a recent sign-in.
    for (const body of [
      { paused: true, reason: 'short' },
      { paused: 'yes', reason: 'A long enough reason here' },
      { paused: true, reason: 'A long enough reason here', extra: 1 },
      { paused: true },
    ]) {
      await platform('manager', 'post', '/registration-control', body).expect(
        400,
      );
    }
    const stale = await platform(
      'manager',
      'post',
      '/registration-control',
      {
        paused: true,
        reason: 'Signed in too long ago',
      },
      24 * 3600,
    ).expect(401);
    expect(stale.body).toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' });

    // A registration that already has its code, before the pause.
    const inFlight = emailOf('inflight');
    await start(inFlight).expect(202);
    const codesBefore = (
      await prisma.ownerRegistration.findUniqueOrThrow({
        where: { email: inFlight },
      })
    ).codesSent;

    // Two operators pausing at once: exactly one change is recorded.
    const results = await Promise.all([
      platform('manager', 'post', '/registration-control', {
        paused: true,
        reason: 'Abuse spike from one domain',
      }),
      platform('manager', 'post', '/registration-control', {
        paused: true,
        reason: 'Abuse spike from one domain',
      }),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(await prisma.registrationControlChange.count()).toBe(1);
    const paused = await view();
    expect(paused).toMatchObject({
      paused: true,
      accepting: false,
      lastChange: {
        paused: true,
        reason: 'Abuse spike from one domain',
        operatorEmail: `sc4e-manager-${run}@example.test`,
      },
    });
    const change = await prisma.registrationControlChange.findFirstOrThrow();
    expect(
      await prisma.platformAuditEvent.count({
        where: { action: 'platform.registration.paused', targetId: change.id },
      }),
    ).toBe(1);

    // While paused: no new registration and no new code — answered like the
    // quota (503), whatever the address.
    const blocked = emailOf('blocked');
    await start(blocked).expect(503);
    await start(inFlight).expect(503);
    expect(
      await prisma.ownerRegistration.count({ where: { email: blocked } }),
    ).toBe(0);
    expect(
      (
        await prisma.ownerRegistration.findUniqueOrThrow({
          where: { email: inFlight },
        })
      ).codesSent,
    ).toBe(codesBefore);
    // A code sent before the pause still completes.
    await complete(inFlight).expect(200);

    // Resuming needs a reason too; then registration works again.
    await platform('manager', 'post', '/registration-control', {
      paused: true,
      reason: 'Pausing again is refused',
    }).expect(409);
    await platform('manager', 'post', '/registration-control', {
      paused: false,
      reason: 'Abuse source blocked upstream',
    }).expect(200);
    expect(
      await prisma.platformAuditEvent.count({
        where: { action: 'platform.registration.resumed' },
      }),
    ).toBe(1);
    await start(blocked).expect(202);
    const resumed = await view();
    expect(resumed).toMatchObject({ paused: false, accepting: true });
    expect(resumed.history.map((change) => change.paused)).toEqual([
      false,
      true,
    ]);

    // The history is append-only.
    await expect(
      prisma.registrationControlChange.updateMany({
        data: { reason: 'Rewritten history attempt' },
      }),
    ).rejects.toThrow();
  });

  it('never lets the pause turn registration on while the deployment flag is off', async () => {
    const flag = process.env.SELF_SERVICE_REGISTRATION_ENABLED;
    process.env.SELF_SERVICE_REGISTRATION_ENABLED = '0';
    try {
      const view = (
        await platform('viewer', 'get', '/registration-control').expect(200)
      ).body as PlatformRegistrationControlView;
      expect(view).toMatchObject({
        flag: 'OFF',
        paused: false,
        accepting: false,
      });
      // Resume when not paused is refused; nothing could enable it anyway.
      await platform('manager', 'post', '/registration-control', {
        paused: false,
        reason: 'Trying to turn registration on',
      }).expect(409);
      await start(emailOf('flag-off')).expect(404);

      process.env.SELF_SERVICE_REGISTRATION_ENABLED = '1';
      process.env.SELF_SERVICE_REGISTRATION_SECRET = 'too-short';
      const misconfigured = (
        await platform('viewer', 'get', '/registration-control').expect(200)
      ).body as PlatformRegistrationControlView;
      expect(misconfigured).toMatchObject({
        flag: 'MISCONFIGURED',
        accepting: false,
      });
    } finally {
      process.env.SELF_SERVICE_REGISTRATION_ENABLED = flag;
      process.env.SELF_SERVICE_REGISTRATION_SECRET =
        originalEnv.SELF_SERVICE_REGISTRATION_SECRET ??
        `sc4e-registration-${randomUUID()}`;
    }
  });

  it('treats an unreadable pause state as paused (fails closed)', async () => {
    const broken = {
      registrationControlChange: {
        findFirst: () => Promise.reject(new Error('database unavailable')),
      },
    } as unknown as PrismaService;
    expect(await isRegistrationPaused(broken)).toBe(true);
  });

  it("shows each self-service business's own getting-started progress, with filters and stuck businesses", async () => {
    const fresh = await ownerBusiness('progress');
    // A business created well over a week ago that never set anything up.
    const oldTenant = randomUUID();
    await prisma.tenant.create({
      data: {
        id: oldTenant,
        slug: `sc4e-old-${run}`,
        name: 'Old Cafe',
        status: 'ACTIVE',
      },
    });
    const longAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    await prisma.ownerRegistration.create({
      data: {
        email: emailOf('old'),
        identityProvider: 'internal-dev',
        identitySubject: `internal-dev:${emailOf('old')}`,
        initialPasswordNonce: randomBytes(32).toString('hex'),
        expiresAt: longAgo,
        status: 'VERIFIED',
        verifiedAt: longAgo,
        displayName: 'Old owner',
        termsVersion: 'terms-1',
        privacyVersion: 'privacy-1',
        legalAcceptedAt: longAgo,
        provisionedTenantId: oldTenant,
        provisionedAt: longAgo,
        createdAt: longAgo,
      },
    });

    const list = async (query = '') =>
      (
        await platform(
          'viewer',
          'get',
          `/businesses?pageSize=50${query}`,
        ).expect(200)
      ).body as PlatformOnboardingBusinessListResponse;
    const all = await list();
    expect(all).toMatchObject({
      filter: 'all',
      stuckDays: 7,
      truncated: false,
    });
    const row = all.items.find((item) => item.tenantId === fresh.tenantId)!;
    expect(row).toMatchObject({
      name: 'Cafe progress',
      setupComplete: false,
      stuck: false,
    });

    // Exactly the checklist the business itself sees.
    const own = (
      await http()
        .get('/api/v1/admin/getting-started')
        .set('Authorization', `Bearer ${staffToken(fresh.email)}`)
        .set('X-Tenant-Id', fresh.tenantId)
        .expect(200)
    ).body as AdminGettingStartedResponse;
    expect(row.steps).toEqual(own.steps);
    expect(row.completedCount).toBe(own.completedCount);

    // Only self-service businesses (an operator-created one never appears).
    const operatorTenant = randomUUID();
    await prisma.tenant.create({
      data: {
        id: operatorTenant,
        slug: `sc4e-op-${run}`,
        name: 'Operator Cafe',
        status: 'ACTIVE',
      },
    });
    expect(
      (await list()).items.some((item) => item.tenantId === operatorTenant),
    ).toBe(false);

    const ids = async (query: string) =>
      (await list(query)).items.map((item) => item.tenantId);
    expect(await ids('&filter=awaiting-payment')).toEqual(
      expect.arrayContaining([fresh.tenantId]),
    );
    expect(await ids('&filter=missing-location')).toEqual(
      expect.arrayContaining([fresh.tenantId, oldTenant]),
    );
    expect(await ids('&filter=stuck')).toEqual([oldTenant]);
    expect(await ids('&filter=stuck&stuckDays=30')).toEqual([]);
    const summary = (await list()).summary;
    expect(summary.stuck).toBe(1);
    expect(summary.businesses).toBe(all.total);

    for (const bad of [
      'filter=done',
      'stuckDays=0',
      'stuckDays=91',
      'stuckDays=abc',
      'pageSize=500',
    ]) {
      await platform('viewer', 'get', `/businesses?${bad}`).expect(400);
    }
  });
});
