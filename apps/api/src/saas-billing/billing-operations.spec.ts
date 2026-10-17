import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  InternalMeResponse,
  InternalPermissionKey,
  PlatformBillingOverview,
  PlatformTenantBillingResponse,
} from '@mocha-house/contracts';
import { resolveBillingRecipient } from '@mocha-house/database';
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
import { BillingLifecycleService } from './application/billing-lifecycle.service';
import { BillingEnforcementService } from './application/billing-enforcement.service';
import type {
  FakeEventBody,
  FakeSaasBillingProvider,
} from './provider/fake-saas-billing-provider';
import { SAAS_BILLING_PROVIDER } from './provider/saas-billing-provider';

// SC3c-3 — billing contacts, grace extensions / exceptions and billing
// notices, end to end on the real AppModule (fake provider, enforcement and
// billing notifications ON) in a SCRATCH database:
//   * the billing contact is one of the business's OWN eligible staff
//     (never another business's), initialised from the first owner and
//     reassigned only by an operator (audited);
//   * billing email goes to a recently VERIFIED address only, designated
//     contact first, then the earliest eligible administrator, else nobody;
//   * an operator gives more time only to a PAST_DUE / UNPAID business whose
//     provider subscription is still recoverable: at most 14 days each and
//     60 per unpaid episode, a written reason, a recent sign-in, audited; an
//     UNPAID exception lifts ONLY a BILLING suspension, never marks anything
//     paid, expires automatically, and ends when the provider ends the
//     subscription (review case);
//   * notices are queued once per actual billing event or episode.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const DAY = 24 * 60 * 60 * 1000;

jest.setTimeout(120_000);

describe('SC3c-3 billing operations (integration, scratch database)', () => {
  let scratch: ScratchDatabase;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let lifecycle: BillingLifecycleService;
  let enforcement: BillingEnforcementService;
  let fake: FakeSaasBillingProvider;
  const originalEnv = { ...process.env };
  const PLATFORM_SECRET = `sc3c3-platform-${randomUUID()}`;
  const INTERNAL_SECRET = `sc3c3-internal-${randomUUID()}`;
  const run = randomUUID().replace(/-/g, '').slice(0, 8);
  let versionId: string;
  let priceId: string;
  let operatorId: string;

  const MANAGE: InternalPermissionKey[] = [
    'billing.view',
    'billing.manage',
    'locations.view',
  ];

  const operatorToken = (signedInSecondsAgo = 0) =>
    signPlatformDevJwt(
      {
        sub: `platform-dev:sc3c3-${run}`,
        mfa: true,
        iat: Math.floor(Date.now() / 1000) - signedInSecondsAgo,
      },
      PLATFORM_SECRET,
      3600,
    );
  const platform = (
    method: 'get' | 'post' | 'put',
    path: string,
    body?: unknown,
    signedInSecondsAgo = 0,
  ) => {
    const req = request(app.getHttpServer())
      [method](`/api/v1/platform${path}`)
      .set('Authorization', `Bearer ${operatorToken(signedInSecondsAgo)}`);
    return body !== undefined ? req.send(body as object) : req;
  };
  const staffToken = (key: string, emailVerified: boolean) =>
    signInternalDevJwt(
      {
        sub: `internal-dev:sc3c3-${key}-${run}`,
        email: `sc3c3-${key}-${run}@example.com`,
        name: null,
        email_verified: emailVerified,
      },
      INTERNAL_SECRET,
      3600,
    );
  const me = (key: string, tenantId: string, emailVerified = true) =>
    request(app.getHttpServer())
      .get('/api/v1/internal/me')
      .set('Authorization', `Bearer ${staffToken(key, emailVerified)}`)
      .set('X-Tenant-Id', tenantId);

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
    extra: Record<string, unknown> = {},
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
        externalSubject: `internal-dev:sc3c3-${key}-${run}`,
        email: `sc3c3-${key}-${run}@example.com`,
        status: 'ACTIVE',
        activatedAt: new Date(),
        ...extra,
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

  const verified = (key: string, at = new Date()) => ({
    verifiedEmail: `sc3c3-${key}-${run}@example.com`,
    emailVerifiedAt: at,
  });

  // A BILLED business with an owner (platform-administrator) whose email is
  // verified, linked to a provider subscription in `providerStatus`.
  async function business(
    label: string,
    state: Record<string, unknown>,
    providerStatus: 'active' | 'past_due' | 'unpaid' | 'canceled',
  ): Promise<Business> {
    const tenantId = randomUUID();
    await prisma.tenant.create({
      data: {
        id: tenantId,
        slug: `sc3c3-${label}-${run}`,
        name: `SC3c3 ${label}`,
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
        recurringPaymentAuthorizedAt: new Date(Date.now() - 60 * DAY),
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
    const ownerId = await staff(
      tenantId,
      label,
      MANAGE,
      'platform-administrator',
      verified(label),
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

  const pastDue = (graceDays = 5) => ({
    status: 'PAST_DUE' as const,
    pastDueAt: new Date(Date.now() - 9 * DAY),
    graceEndsAt: new Date(Date.now() + graceDays * DAY),
  });
  const unpaid = () => ({
    status: 'UNPAID' as const,
    pastDueAt: new Date(Date.now() - 20 * DAY),
    graceEndsAt: new Date(Date.now() - 6 * DAY),
  });

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
      data: { subscription: b.sub, customer: b.customer, ...data },
    };
    const signed = fake.signEvent(body, new Date(occurred * 1000));
    const event = fake.verifyEvent({
      ...signed,
      now: new Date(occurred * 1000),
    });
    return lifecycle.recordAndApply(event);
  }

  const extend = (b: Business, body: unknown, signedInSecondsAgo = 0) =>
    platform(
      'post',
      `/tenants/${b.tenantId}/billing/grace-extension`,
      body,
      signedInSecondsAgo,
    );
  const subscriptionOf = (b: Business) =>
    prisma.tenantSubscription.findUniqueOrThrow({
      where: { id: b.subscriptionId },
    });
  const tenantOf = (b: Business) =>
    prisma.tenant.findUniqueOrThrow({
      where: { id: b.tenantId },
      select: { status: true, suspensionReason: true },
    });
  const historyOf = async (b: Business) =>
    (
      await prisma.tenantSubscriptionEvent.findMany({
        where: { subscriptionId: b.subscriptionId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { type: true },
      })
    ).map((e) => e.type);
  const noticesOf = async (b: Business) =>
    (
      await prisma.billingNotification.findMany({
        where: { subscriptionId: b.subscriptionId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { kind: true },
      })
    ).map((n) => n.kind);
  const casesOf = async (b: Business) =>
    (
      await prisma.billingReconciliationCase.findMany({
        where: { subscriptionId: b.subscriptionId, status: 'OPEN' },
        select: { kind: true },
      })
    ).map((c) => c.kind);
  const REASON = 'Customer called: card replaced, paying Friday.';

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc3c3_billing_ops',
    );
    await applyMigrations(scratch.url, listMigrations(MIGRATIONS));
    process.env.DATABASE_URL = scratch.url;
    process.env.PLATFORM_AUTH_PROVIDER = 'dev';
    process.env.PLATFORM_AUTH_DEV_JWT_SECRET = PLATFORM_SECRET;
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = INTERNAL_SECRET;
    process.env.RATE_LIMIT_ENABLED = '0';
    process.env.SAAS_BILLING_PROVIDER = 'fake';
    process.env.SAAS_BILLING_TRIAL_CLAIM_SECRET = `sc3c3-claims-${randomUUID()}`;
    process.env.BILLING_ENFORCEMENT_ENABLED = '1';
    process.env.BILLING_NOTIFICATIONS_ENABLED = '1';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    await app.init();
    prisma = app.get(PrismaService);
    lifecycle = app.get(BillingLifecycleService);
    enforcement = app.get(BillingEnforcementService);
    fake = app.get(SAAS_BILLING_PROVIDER);

    operatorId = (
      await prisma.platformOperator.create({
        data: {
          externalProvider: 'platform-dev',
          externalSubject: `platform-dev:sc3c3-${run}`,
          email: `sc3c3-${run}@example.test`,
          status: 'ACTIVE',
        },
      })
    ).id;
    await grantPlatformPermissions(prisma, operatorId);
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

  // --- Billing contact -------------------------------------------------------------

  it('starts billing with the first owner as the billing contact; an operator reassigns it only to this business’s own eligible staff (audited)', async () => {
    const tenantId = randomUUID();
    await prisma.tenant.create({
      data: {
        id: tenantId,
        slug: `sc3c3-start-${run}`,
        name: 'Start',
        status: 'ACTIVE',
      },
    });
    await prisma.tenantSubscription.create({
      data: { subscriberTenantId: tenantId, planVersionId: versionId },
    });
    const owner = await staff(
      tenantId,
      'start-owner',
      MANAGE,
      'platform-administrator',
    );
    const manager = await staff(
      tenantId,
      'start-mgr',
      MANAGE,
      'billing-manager',
    );
    const viewer = await staff(
      tenantId,
      'start-view',
      ['billing.view'],
      'viewer',
    );
    const suspended = await staff(
      tenantId,
      'start-susp',
      MANAGE,
      'billing-manager',
      {
        status: 'SUSPENDED',
      },
    );
    const other = await business(
      'contact-other',
      { status: 'ACTIVE' },
      'active',
    );

    const started = (
      await platform('post', `/tenants/${tenantId}/billing/start`, {
        planPriceId: priceId,
      }).expect(200)
    ).body as PlatformTenantBillingResponse;
    expect(started.contact.designated?.internalUserId).toBe(owner);
    // Not verified yet: nobody to email (no stale sign-in is trusted).
    expect(started.contact.designated?.ineligibleReason).toBe(
      'EMAIL_NOT_VERIFIED',
    );
    expect(started.contact.recipient).toBeNull();
    expect(
      started.contact.candidates.map((c) => c.internalUserId).sort(),
    ).toEqual([owner, manager].sort());

    const assign = (body: unknown, ago = 0) =>
      platform('put', `/tenants/${tenantId}/billing/contact`, body, ago);
    // Another business's staff, view-only staff and suspended staff: refused.
    for (const internalUserId of [other.ownerId, viewer, suspended]) {
      expect((await assign({ internalUserId }).expect(409)).body).toMatchObject(
        {
          code: 'BILLING_CONTACT_NOT_ELIGIBLE',
        },
      );
    }
    await assign({ internalUserId: manager, extra: 1 }).expect(400);
    await assign({ internalUserId: 'nope' }).expect(400);
    // A sign-in long ago: re-authenticate first.
    expect(
      (await assign({ internalUserId: manager }, 3600).expect(401)).body,
    ).toMatchObject({
      code: 'REAUTHENTICATION_REQUIRED',
    });
    expect(
      (
        await prisma.tenantBillingContact.findUniqueOrThrow({
          where: { tenantId },
        })
      ).internalUserId,
    ).toBe(owner);

    const view = (await assign({ internalUserId: manager }).expect(200))
      .body as PlatformTenantBillingResponse;
    expect(view.contact.designated?.internalUserId).toBe(manager);
    expect(
      await prisma.platformAuditEvent.count({
        where: {
          action: 'platform.billing.contact_assigned',
          targetType: 'tenant',
          targetId: tenantId,
          actorPlatformOperatorId: operatorId,
        },
      }),
    ).toBe(1);
    // Who was designated and who was replaced are recorded too.
    expect(
      (
        await prisma.platformAuditEvent.findMany({
          where: {
            action: 'platform.billing.contact_assigned',
            targetType: 'internal_user',
            targetId: { in: [owner, manager] },
          },
          select: { targetId: true, reasonCode: true },
        })
      ).sort((x, y) => (x.reasonCode ?? '').localeCompare(y.reasonCode ?? '')),
    ).toEqual([
      { targetId: manager, reasonCode: 'BILLING_CONTACT_DESIGNATED' },
      { targetId: owner, reasonCode: 'BILLING_CONTACT_REPLACED' },
    ]);
    // Still one contact row for the business.
    expect(
      await prisma.tenantBillingContact.count({ where: { tenantId } }),
    ).toBe(1);
  });

  it('the database refuses a billing contact from another business and never moves a contact to another business', async () => {
    const a = await business('db-a', { status: 'ACTIVE' }, 'active');
    const b = await business('db-b', { status: 'ACTIVE' }, 'active');
    await expect(
      prisma.tenantBillingContact.create({
        data: { tenantId: a.tenantId, internalUserId: b.ownerId },
      }),
    ).rejects.toThrow();
    const contact = await prisma.tenantBillingContact.create({
      data: { tenantId: a.tenantId, internalUserId: a.ownerId },
    });
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "TenantBillingContact" SET "tenantId" = $1 WHERE id = $2`,
        b.tenantId,
        contact.id,
      ),
    ).rejects.toThrow();
  });

  it('billing email goes to a recently verified address only: designated contact, else the earliest eligible administrator, else nobody', async () => {
    const b = await business('rcpt', { status: 'ACTIVE' }, 'active');
    const manager = await staff(
      b.tenantId,
      'rcpt-mgr',
      MANAGE,
      'billing-manager',
    );
    await prisma.tenantBillingContact.create({
      data: { tenantId: b.tenantId, internalUserId: manager },
    });
    const now = new Date();
    // The contact never verified: the owner (administrator) receives it.
    let r = await resolveBillingRecipient(prisma, b.tenantId, now);
    expect(r.designated?.ineligibleReason).toBe('EMAIL_NOT_VERIFIED');
    expect(r.recipient).toMatchObject({
      internalUserId: b.ownerId,
      source: 'FALLBACK_ADMINISTRATOR',
    });

    // Verified recently: the contact receives it.
    await prisma.internalUser.update({
      where: { id: manager },
      data: verified('rcpt-mgr'),
    });
    r = await resolveBillingRecipient(prisma, b.tenantId, now);
    expect(r.recipient).toMatchObject({
      internalUserId: manager,
      source: 'CONTACT',
    });

    // Verified 91 days ago: stale — never permanent proof.
    await prisma.internalUser.update({
      where: { id: manager },
      data: verified('rcpt-mgr', new Date(Date.now() - 91 * DAY)),
    });
    r = await resolveBillingRecipient(prisma, b.tenantId, now);
    expect(r.designated?.ineligibleReason).toBe('EMAIL_VERIFICATION_STALE');
    expect(r.recipient?.source).toBe('FALLBACK_ADMINISTRATOR');

    // The stored address changed since it was verified: not verified.
    await prisma.internalUser.update({
      where: { id: manager },
      data: { ...verified('rcpt-mgr'), email: `changed-${run}@example.com` },
    });
    r = await resolveBillingRecipient(prisma, b.tenantId, now);
    expect(r.designated?.ineligibleReason).toBe('EMAIL_NOT_VERIFIED');

    // Lost billing.manage / suspended: not eligible, whatever the email.
    await prisma.internalUser.update({
      where: { id: manager },
      data: {
        ...verified('rcpt-mgr'),
        email: `sc3c3-rcpt-mgr-${run}@example.com`,
        status: 'SUSPENDED',
      },
    });
    r = await resolveBillingRecipient(prisma, b.tenantId, now);
    expect(r.designated?.ineligibleReason).toBe('NOT_ACTIVE');

    // Nobody eligible: no recipient.
    await prisma.internalUser.update({
      where: { id: b.ownerId },
      data: { verifiedEmail: null, emailVerifiedAt: null },
    });
    r = await resolveBillingRecipient(prisma, b.tenantId, now);
    expect(r.recipient).toBeNull();
    // Another business's verified owner is never considered.
    const other = await business('rcpt-other', { status: 'ACTIVE' }, 'active');
    expect(r.candidates.map((c) => c.internalUserId)).not.toContain(
      other.ownerId,
    );
  });

  it('a sign-in records the verified email only when the identity provider asserts it for the stored address, and clears it otherwise', async () => {
    const b = await business('stamp', { status: 'ACTIVE' }, 'active');
    await prisma.internalUser.update({
      where: { id: b.ownerId },
      data: { verifiedEmail: null, emailVerifiedAt: null },
    });
    await me(b.key, b.tenantId, true).expect(200);
    let user = await prisma.internalUser.findUniqueOrThrow({
      where: { id: b.ownerId },
    });
    expect(user.verifiedEmail).toBe(`sc3c3-stamp-${run}@example.com`);
    expect(user.emailVerifiedAt).not.toBeNull();
    await me(b.key, b.tenantId, false).expect(200);
    user = await prisma.internalUser.findUniqueOrThrow({
      where: { id: b.ownerId },
    });
    expect(user).toMatchObject({ verifiedEmail: null, emailVerifiedAt: null });
  });

  // --- Grace extensions ---------------------------------------------------------------

  it('extends a PAST_DUE grace period (recent sign-in, written reason, audited) — at most 14 days each and 60 per unpaid episode', async () => {
    const b = await business('extend', pastDue(5), 'past_due');
    const before = await subscriptionOf(b);

    await extend(b, { days: 15, reason: REASON }).expect(400);
    await extend(b, { days: 0, reason: REASON }).expect(400);
    await extend(b, { days: 3.5, reason: REASON }).expect(400);
    await extend(b, { days: 7, reason: 'short' }).expect(400);
    await extend(b, { days: 7, reason: REASON, paid: true }).expect(400);
    expect(
      (await extend(b, { days: 7, reason: REASON }, 3600).expect(401)).body,
    ).toMatchObject({
      code: 'REAUTHENTICATION_REQUIRED',
    });
    expect(await subscriptionOf(b)).toMatchObject({
      graceEndsAt: before.graceEndsAt,
    });

    const view = (
      await extend(b, { days: 7, reason: `  ${REASON}  ` }).expect(200)
    ).body as PlatformTenantBillingResponse;
    const after = await subscriptionOf(b);
    expect(after.status).toBe('PAST_DUE');
    expect(after.graceEndsAt!.getTime()).toBe(
      before.graceEndsAt!.getTime() + 7 * DAY,
    );
    expect(after.pastDueAt).toEqual(before.pastDueAt);
    expect(view.extensions).toHaveLength(1);
    expect(view.extensions[0]).toMatchObject({
      kind: 'GRACE_EXTENDED',
      days: 7,
      reason: REASON,
    });
    expect(view.extensionDaysRemaining).toBe(53);
    expect(await historyOf(b)).toEqual(['GRACE_EXTENDED']);
    expect(
      await prisma.platformAuditEvent.count({
        where: {
          action: 'platform.billing.grace_extended',
          targetId: b.tenantId,
          actorPlatformOperatorId: operatorId,
        },
      }),
    ).toBe(1);

    // 7 + 14 + 14 + 14 = 49; 12 more would pass 60.
    for (let i = 0; i < 3; i++)
      await extend(b, { days: 14, reason: REASON }).expect(200);
    expect(
      (await extend(b, { days: 12, reason: REASON }).expect(409)).body,
    ).toMatchObject({
      code: 'BILLING_EXTENSION_LIMIT',
    });
    await extend(b, { days: 11, reason: REASON }).expect(200);
    expect(
      (await extend(b, { days: 1, reason: REASON }).expect(409)).body,
    ).toMatchObject({
      code: 'BILLING_EXTENSION_LIMIT',
    });
    expect(
      (
        await prisma.billingGraceExtension.aggregate({
          where: { subscriptionId: b.subscriptionId },
          _sum: { days: true },
        })
      )._sum.days,
    ).toBe(60);
    // Append-only.
    await expect(
      prisma.billingGraceExtension.deleteMany({
        where: { subscriptionId: b.subscriptionId },
      }),
    ).rejects.toThrow();
  });

  it('concurrent extensions never exceed the episode limit', async () => {
    const b = await business('race', pastDue(5), 'past_due');
    for (let i = 0; i < 3; i++)
      await extend(b, { days: 14, reason: REASON }).expect(200);
    await extend(b, { days: 7, reason: REASON }).expect(200); // 49 used
    const results = await Promise.all([
      extend(b, { days: 7, reason: REASON }),
      extend(b, { days: 7, reason: REASON }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      (
        await prisma.billingGraceExtension.aggregate({
          where: { subscriptionId: b.subscriptionId },
          _sum: { days: true },
        })
      )._sum.days,
    ).toBe(56);
  });

  it('refuses businesses that are not unpaid, and a subscription the provider has ended — changing nothing', async () => {
    const active = await business('ok', { status: 'ACTIVE' }, 'active');
    expect(
      (await extend(active, { days: 7, reason: REASON }).expect(409)).body,
    ).toMatchObject({
      code: 'BILLING_NOT_EXTENDABLE',
    });
    const ended = await business('ended', pastDue(5), 'canceled');
    const before = await subscriptionOf(ended);
    expect(
      (await extend(ended, { days: 7, reason: REASON }).expect(409)).body,
    ).toMatchObject({
      code: 'BILLING_NOT_RECOVERABLE',
    });
    fake.subscriptions.delete(ended.sub);
    expect(
      (await extend(ended, { days: 7, reason: REASON }).expect(409)).body,
    ).toMatchObject({
      code: 'BILLING_NOT_RECOVERABLE',
    });
    expect(await subscriptionOf(ended)).toMatchObject({
      graceEndsAt: before.graceEndsAt,
      billingStateVersion: before.billingStateVersion,
    });
    expect(
      await prisma.billingGraceExtension.count({
        where: { subscriptionId: ended.subscriptionId },
      }),
    ).toBe(0);
    await platform('post', `/tenants/${randomUUID()}/billing/grace-extension`, {
      days: 7,
      reason: REASON,
    }).expect(404);
  });

  it('an UNPAID grace exception lifts only the BILLING suspension, never marks anything paid, and expires automatically', async () => {
    const b = await business('exception', unpaid(), 'unpaid');
    await billingSuspended(b);

    const view = (await extend(b, { days: 5, reason: REASON }).expect(200))
      .body as PlatformTenantBillingResponse;
    expect(view.billing).toMatchObject({
      state: 'UNPAID',
      suspendedForBilling: false,
      premiumPaused: false,
    });
    const granted = await subscriptionOf(b);
    expect(granted.status).toBe('UNPAID');
    expect(granted.graceExceptionEndsAt!.getTime()).toBeGreaterThan(
      Date.now() + 4 * DAY,
    );
    expect(await tenantOf(b)).toEqual({
      status: 'ACTIVE',
      suspensionReason: null,
    });
    const modules = (
      (await me(b.key, b.tenantId).expect(200)).body as InternalMeResponse
    ).entitlements.modules;
    expect(modules).toContain('crm');
    expect(await historyOf(b)).toEqual([
      'BILLING_SUSPENDED',
      'GRACE_EXCEPTION_GRANTED',
      'BILLING_SUSPENSION_LIFTED',
    ]);
    // Nothing recorded as a payment.
    expect(await historyOf(b)).not.toContain('PAYMENT_SUCCEEDED');

    // Before the end: the sweep leaves it.
    await enforcement.sweep(new Date(Date.now() + 1 * DAY));
    expect((await tenantOf(b)).status).toBe('ACTIVE');
    // After the end: suspended for billing again, still UNPAID.
    await enforcement.sweep(new Date(Date.now() + 6 * DAY));
    expect(await tenantOf(b)).toEqual({
      status: 'SUSPENDED',
      suspensionReason: 'BILLING',
    });
    expect(await subscriptionOf(b)).toMatchObject({
      status: 'UNPAID',
      graceExceptionEndsAt: null,
    });
    expect((await historyOf(b)).slice(-2)).toEqual([
      'GRACE_EXCEPTION_EXPIRED',
      'BILLING_SUSPENDED',
    ]);
    expect(await noticesOf(b)).toEqual([
      'ACCESS_RESTORED',
      'BILLING_SUSPENDED',
    ]);
    const restored = await prisma.billingNotification.findFirstOrThrow({
      where: { subscriptionId: b.subscriptionId, kind: 'ACCESS_RESTORED' },
    });
    expect(restored.payload).toMatchObject({ temporary: true, enforced: true });
  });

  it('never lifts a SECURITY suspension', async () => {
    const b = await business('security', unpaid(), 'unpaid');
    await prisma.tenant.update({
      where: { id: b.tenantId },
      data: { status: 'SUSPENDED', suspensionReason: 'SECURITY' },
    });
    await extend(b, { days: 5, reason: REASON }).expect(200);
    expect(await tenantOf(b)).toEqual({
      status: 'SUSPENDED',
      suspensionReason: 'SECURITY',
    });
    expect(await historyOf(b)).toEqual(['GRACE_EXCEPTION_GRANTED']);
  });

  it('when the provider ends a subscription during a grace exception, the access ends, nothing is paid and a review case is opened', async () => {
    const b = await business('terminated', unpaid(), 'unpaid');
    await billingSuspended(b);
    await extend(b, { days: 10, reason: REASON }).expect(200);
    expect((await tenantOf(b)).status).toBe('ACTIVE');

    fake.subscriptions.get(b.sub)!.status = 'canceled';
    const outcome = await deliver(b, 'subscription.ended');
    expect(outcome.status).toBe('APPLIED');
    expect(await subscriptionOf(b)).toMatchObject({
      status: 'CANCELED',
      graceExceptionEndsAt: null,
    });
    expect(await tenantOf(b)).toEqual({
      status: 'SUSPENDED',
      suspensionReason: 'BILLING',
    });
    expect(await casesOf(b)).toContain('EXTENSION_ENDED_BY_PROVIDER');
    expect(await historyOf(b)).not.toContain('PAYMENT_SUCCEEDED');
    // No further extension of an ended subscription.
    expect(
      (await extend(b, { days: 1, reason: REASON }).expect(409)).body,
    ).toMatchObject({
      code: 'BILLING_NOT_EXTENDABLE',
    });
  });

  // --- Notices ---------------------------------------------------------------------------

  it('queues each notice once per billing event or episode', async () => {
    const b = await business('notice', { status: 'ACTIVE' }, 'active');
    const invoice = `in_${run}_n1`;
    fake.setInvoice(invoice, 'open', b.sub, b.customer);
    await deliver(b, 'invoice.payment_failed', { reference: invoice });
    // A retry of the payment failing again is the same episode.
    await deliver(b, 'invoice.payment_failed', { reference: invoice });
    expect(await noticesOf(b)).toEqual(['PAYMENT_FAILED']);

    // A reminder within 3 days of the grace end, once however often the
    // sweep runs.
    await prisma.tenantSubscription.update({
      where: { id: b.subscriptionId },
      data: { graceEndsAt: new Date(Date.now() + 2 * DAY) },
    });
    await lifecycle.queueReminders(new Date(), 100);
    await lifecycle.queueReminders(new Date(), 100);
    expect(await noticesOf(b)).toEqual(['PAYMENT_FAILED', 'GRACE_ENDING']);
    // An extension moves the deadline: a new reminder for the new one.
    fake.subscriptions.get(b.sub)!.status = 'past_due';
    await extend(b, { days: 1, reason: REASON }).expect(200);
    await lifecycle.queueReminders(new Date(), 100);
    expect(await noticesOf(b)).toEqual([
      'PAYMENT_FAILED',
      'GRACE_ENDING',
      'GRACE_ENDING',
    ]);

    // A notice is never deleted, and a finished one never changes again.
    const row = await prisma.billingNotification.findFirstOrThrow({
      where: { subscriptionId: b.subscriptionId },
    });
    await expect(
      prisma.billingNotification.delete({ where: { id: row.id } }),
    ).rejects.toThrow();
    await prisma.billingNotification.update({
      where: { id: row.id },
      data: { status: 'SKIPPED', finishedAt: new Date() },
    });
    await expect(
      prisma.billingNotification.update({
        where: { id: row.id },
        data: { status: 'PENDING', finishedAt: null },
      }),
    ).rejects.toThrow();
  });

  it('queues nothing while billing notifications are off', async () => {
    process.env.BILLING_NOTIFICATIONS_ENABLED = '0';
    try {
      const b = await business('quiet', pastDue(2), 'past_due');
      await lifecycle.queueReminders(new Date(), 100);
      await extend(b, { days: 2, reason: REASON }).expect(200);
      expect(await noticesOf(b)).toEqual([]);
    } finally {
      process.env.BILLING_NOTIFICATIONS_ENABLED = '1';
    }
  });

  // --- Console overview ---------------------------------------------------------------------

  it('the console overview counts what needs attention', async () => {
    const overview = (await platform('get', '/billing/overview').expect(200))
      .body as PlatformBillingOverview;
    expect(overview.inGrace).toBeGreaterThanOrEqual(3);
    expect(overview.unpaid).toBeGreaterThanOrEqual(2);
    expect(overview.billingSuspended).toBeGreaterThanOrEqual(2);
    expect(overview.openCases).toEqual(
      expect.arrayContaining([
        { kind: 'EXTENSION_ENDED_BY_PROVIDER', count: 1 },
      ]),
    );
    expect(Object.keys(overview).sort()).toEqual([
      'billingSuspended',
      'complimentary',
      'failedNotifications',
      'graceExceptions',
      'inGrace',
      'missingContacts',
      'openCases',
      'trialRecoveryWindows',
      'unpaid',
    ]);
  });
});
