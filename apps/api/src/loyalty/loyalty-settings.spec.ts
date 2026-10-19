import 'dotenv/config';
import {
  tenantContextFor,
  enrollTestCustomer,
  removePaymentRecoveryRecordsForTest,
} from '@mocha-house/testing';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  InternalMeResponse,
  LoyaltyPointsLabelSettings,
  LoyaltySettings,
} from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { LocationsModule } from '../locations/locations.module';
import { CustomersModule } from '../customers/customers.module';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { CheckoutService } from '../orders/application/checkout.service';
import { PaymentModule } from '../payment/payment.module';
import type { CustomerIdentity } from '../customer-auth/infrastructure/customer-identity';
import { LoyaltyModule } from './loyalty.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { GiftCardsModule } from '../gift-cards/gift-cards.module';
import {
  checkoutAttemptsOfThisSuite,
  submitCheckout,
  type LabelledCheckoutRequest,
} from '../../test/checkout-session';

type Scope = { scopeType: 'CORPORATE' | 'LOCATION'; scopeId: string | null };

// Milestone 7B — HQ configuration of the standard company-wide Mocha Bean
// earning rate, over real HTTP + the real checkout transaction. The
// LoyaltyConfiguration singleton is a SHARED row, so every test restores it
// to the default (1) afterwards.
describe('HQ loyalty settings — earning rate (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let checkoutService: CheckoutService;
  const originalEnv = { ...process.env };
  const internalSecret = 'loyalty-settings-spec-internal-secret';
  const suffix = randomUUID();

  const userIds: string[] = [];
  const roleIds: string[] = [];
  let locId: string;
  let locationId: string;
  let productId: string;
  let sizeGroupId: string;
  let mediumOptionId: string;

  let originalPointsLabel: string | null = null;

  const KEY_PREFIX = 'test_settings_';
  const SUBJECT_PREFIX = 'test-settings-';

  const token = (key: string) =>
    signInternalDevJwt(
      { sub: `internal-dev:${key}`, email: `${key}@example.com`, name: null },
      internalSecret,
      3600,
    );

  async function makeUserWithRole(
    key: string,
    permissionKeys: string[],
    scope: Scope,
  ): Promise<void> {
    const role = await prisma.internalRole.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        key: `settings-spec-${suffix}-${randomUUID()}`,
        displayName: 'Settings Spec Role',
        permissions: {
          create: permissionKeys.map((permissionKey) => ({ permissionKey })),
        },
      },
    });
    roleIds.push(role.id);
    const user = await prisma.internalUser.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:${key}-${suffix}`,
        email: `${key}-${suffix}@example.com`,
        displayName: key,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    userIds.push(user.id);
    await prisma.internalUserRoleAssignment.create({
      data: { tenantId: TENANT_1_MOCHA_HOUSE_ID, internalUserId: user.id, roleId: role.id, ...scope },
    });
  }

  const getSettings = (key: string) =>
    request(app.getHttpServer())
      .get('/api/v1/admin/loyalty/settings')
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`);

  const putSettings = (key: string, body: unknown) =>
    request(app.getHttpServer())
      .put('/api/v1/admin/loyalty/settings')
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`)
      .send(body as object);

  async function setRate(rate: number): Promise<void> {
    await prisma.loyaltyConfiguration.upsert({
      where: {
        tenantId_key: { tenantId: TENANT_1_MOCHA_HOUSE_ID, key: 'company' },
      },
      update: { earningRatePerDollar: rate },
      create: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        key: 'company',
        earningRatePerDollar: rate,
      },
    });
  }

  function checkoutRequest(): LabelledCheckoutRequest {
    return {
      clientRef: `${KEY_PREFIX}${randomUUID()}`,
      locationId,
      guest: { name: 'Settings Guest', phone: '5551234567' },
      lines: [
        {
          productId,
          quantity: 3, // 3 x $4.00 medium drip = $12.00 -> 12 whole dollars
          selections: [{ groupId: sizeGroupId, optionIds: [mediumOptionId] }],
        },
      ],
    };
  }

  async function identity(s: string): Promise<CustomerIdentity> {
    const enrolled: CustomerIdentity = {
      provider: 'test',
      subject: `${SUBJECT_PREFIX}${s}`,
      email: `${s}@example.com`,
      name: null,
      emailVerified: null,
    };
    await enrollTestCustomer(prisma, TENANT_1_MOCHA_HOUSE_ID, enrolled);
    return enrolled;
  }

  async function earnedBeansFor(customerId: string): Promise<number> {
    const account = await prisma.customerLoyaltyAccount.findUnique({
      where: { customerId },
      select: { balance: true },
    });
    return account?.balance ?? 0;
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = 'loyalty-settings-spec-customer-secret';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        PrismaModule,
        LocationsModule,
        CustomersModule,
        CustomerAuthModule,
        InternalAuthModule,
        LoyaltyModule,
        PromotionsModule,
        GiftCardsModule,
        PaymentModule,
      ],
      providers: [CheckoutService],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);
    checkoutService = moduleFixture.get(CheckoutService);

    locId = (
      await prisma.location.create({
        data: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          name: `Settings Spec Loc ${suffix}`,
          slug: `settings-spec-${suffix}`,
          isActive: true,
          isDigitalOrderingEnabled: true,
        },
      })
    ).id;

    const location = await prisma.location.findUniqueOrThrow({
      where: {
        tenantId_slug: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          slug: 'dearborn-heights',
        },
      },
    });
    const product = await prisma.product.findUniqueOrThrow({
      where: {
        tenantId_slug: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          slug: 'drip-coffee',
        },
      },
      include: {
        modifierGroups: {
          include: { modifierGroup: { include: { options: true } } },
        },
      },
    });
    locationId = location.id;
    productId = product.id;
    const sizeGroup = product.modifierGroups[0].modifierGroup;
    sizeGroupId = sizeGroup.id;
    mediumOptionId = sizeGroup.options.find((o) => o.name === 'Medium')!.id;

    await makeUserWithRole('hq', ['loyalty.configure'], {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    await makeUserWithRole('locationScoped', ['loyalty.configure'], {
      scopeType: 'LOCATION',
      scopeId: locId,
    });
    const storeManager = await prisma.internalRole.findUniqueOrThrow({
      where: { tenantId_key: { tenantId: TENANT_1_MOCHA_HOUSE_ID, key: 'store-manager' } },
    });
    const mgr = await prisma.internalUser.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:storeMgr-${suffix}`,
        email: `storeMgr-${suffix}@example.com`,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    userIds.push(mgr.id);
    await prisma.internalUserRoleAssignment.create({
      data: {
        internalUserId: mgr.id,
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        roleId: storeManager.id,
        scopeType: 'LOCATION',
        scopeId: locId,
      },
    });

    await makeUserWithRole('viewer', ['loyalty.view'], {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    const config = await prisma.loyaltyConfiguration.findUnique({
      where: {
        tenantId_key: { tenantId: TENANT_1_MOCHA_HOUSE_ID, key: 'company' },
      },
      select: { pointsLabel: true },
    });
    originalPointsLabel = config?.pointsLabel ?? null;

    await setRate(1);
  }, 45_000);

  afterEach(async () => {
    await setRate(1);
    await prisma.loyaltyConfiguration.updateMany({
      where: { tenantId: TENANT_1_MOCHA_HOUSE_ID, key: 'company' },
      data: { pointsLabel: originalPointsLabel },
    });
    await prisma.internalAuditEvent.deleteMany({
      where: {
        actorInternalUserId: { in: userIds },
        action: 'loyalty.points_label_changed',
      },
    });
    await prisma.internalAuditEvent.deleteMany({
      where: {
        actorInternalUserId: { in: userIds },
        action: 'loyalty.earning_rate_changed',
      },
    });
  });

  afterAll(async () => {
    await setRate(1);
    const attempts = await prisma.paymentAttempt.findMany({
      where: checkoutAttemptsOfThisSuite(),
      select: { id: true },
    });
    const attemptIds = attempts.map((a) => a.id);
    await prisma.customer.deleteMany({
      where: {
        externalProvider: 'test',
        externalSubject: { startsWith: SUBJECT_PREFIX },
      },
    });
    if (attemptIds.length > 0) {
      const orders = await prisma.order.findMany({
        where: { paymentAttemptId: { in: attemptIds } },
        select: { id: true },
      });
      const orderIds = orders.map((o) => o.id);
      await prisma.mochaBeanLedgerEntry.deleteMany({
        where: { orderId: { in: orderIds } },
      });
      await prisma.orderLine.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderStatusHistory.deleteMany({
        where: { orderId: { in: orderIds } },
      });
      await prisma.outboxEvent.deleteMany({
        where: { aggregateType: 'Order', aggregateId: { in: orderIds } },
      });
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      // ESP-03 PR 4 — a payment's saved checkout and reconciliation records
      // (append-only) go first, through the disposable-only test helper.
      await removePaymentRecoveryRecordsForTest(
        (
          await prisma.paymentAttempt.findMany({
            where: { id: { in: attemptIds } },
            select: { id: true },
          })
        ).map((a) => a.id),
      );
      await prisma.paymentAttempt.deleteMany({
        where: { id: { in: attemptIds } },
      });
    }
    await prisma.internalAuditEvent.deleteMany({
      where: { actorInternalUserId: { in: userIds } },
    });
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: { in: userIds } },
    });
    for (const id of roleIds) {
      await prisma.internalRolePermission.deleteMany({ where: { roleId: id } });
      await prisma.internalRole.deleteMany({ where: { id } });
    }
    await prisma.internalUser.deleteMany({ where: { id: { in: userIds } } });
    // ESP-03 PR 6 — this suite's checkout sessions reference the location.
    await prisma.checkoutSession.deleteMany({ where: { locationId: locId } });
    await prisma.location.deleteMany({ where: { id: locId } });
    await app.close();
    process.env = { ...originalEnv };
  });

  it('the default earning rate is 1 Bean per $1', async () => {
    const body = (await getSettings('hq').expect(200)).body as LoyaltySettings;
    expect(body.earningRatePerDollar).toBe(1);
  });

  it('an HQ user with loyalty.configure can update the rate; it is audited', async () => {
    const body = (
      await putSettings('hq', { earningRatePerDollar: 3 }).expect(200)
    ).body as LoyaltySettings;
    expect(body.earningRatePerDollar).toBe(3);

    const persisted = await prisma.loyaltyConfiguration.findUniqueOrThrow({
      where: {
        tenantId_key: { tenantId: TENANT_1_MOCHA_HOUSE_ID, key: 'company' },
      },
    });
    expect(persisted.earningRatePerDollar).toBe(3);

    const events = await prisma.internalAuditEvent.findMany({
      where: { action: 'loyalty.earning_rate_changed' },
    });
    expect(events).toHaveLength(1);
    expect(events[0].targetType).toBe('loyalty_configuration');
    expect(events[0].beforeData).toEqual({ earningRatePerDollar: 1 });
    expect(events[0].afterData).toEqual({ earningRatePerDollar: 3 });
  });

  it('a Store Manager cannot read or update the rate', async () => {
    await getSettings('storeMgr').expect(403);
    await putSettings('storeMgr', { earningRatePerDollar: 2 }).expect(403);
  });

  it('loyalty.configure held only at LOCATION scope cannot update the rate', async () => {
    await getSettings('locationScoped').expect(403);
    await putSettings('locationScoped', { earningRatePerDollar: 2 }).expect(403);
  });

  // SC4f-3b — the business's name for its loyalty points, over real HTTP.
  describe('points name', () => {
    const path = '/api/v1/admin/loyalty/settings/points-label';
    const getLabel = (key: string) =>
      request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`);
    const putLabel = (key: string, body: unknown) =>
      request(app.getHttpServer())
        .put(path)
        .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`)
        .send(body as object);
    const storedLabel = async () =>
      (
        await prisma.loyaltyConfiguration.findUniqueOrThrow({
          where: {
            tenantId_key: { tenantId: TENANT_1_MOCHA_HOUSE_ID, key: 'company' },
          },
          select: { pointsLabel: true },
        })
      ).pointsLabel;
    const labelAudits = () =>
      prisma.internalAuditEvent.count({
        where: {
          actorInternalUserId: { in: userIds },
          action: 'loyalty.points_label_changed',
        },
      });

    it('requires a signed-in staff member', async () => {
      await request(app.getHttpServer()).get(path).expect(401);
      await request(app.getHttpServer())
        .put(path)
        .send({ pointsLabel: 'Stars' })
        .expect(401);
    });

    it('refuses view-only, store manager and location-scoped staff, with no change or audit', async () => {
      const before = await storedLabel();
      for (const key of ['viewer', 'storeMgr', 'locationScoped']) {
        await getLabel(key).expect(403);
        await putLabel(key, { pointsLabel: 'Stars' }).expect(403);
      }
      expect(await storedLabel()).toBe(before);
      expect(await labelAudits()).toBe(0);
    });

    it('HQ can set the name (audited, shown in /internal/me); null restores the default', async () => {
      const set = (
        await putLabel('hq', { pointsLabel: '  Gold  Stars ' }).expect(200)
      ).body as LoyaltyPointsLabelSettings;
      expect(set).toEqual({
        pointsLabel: 'Gold Stars',
        effectivePointsLabel: 'Gold Stars',
      });
      expect(await storedLabel()).toBe('Gold Stars');
      expect(await labelAudits()).toBe(1);

      const me = await request(app.getHttpServer())
        .get('/api/v1/internal/me')
        .set('Authorization', `Bearer ${token(`hq-${suffix}`)}`)
        .expect(200);
      expect((me.body as InternalMeResponse).loyaltyPointsLabel).toBe(
        'Gold Stars',
      );

      const cleared = (await putLabel('hq', { pointsLabel: null }).expect(200))
        .body as LoyaltyPointsLabelSettings;
      expect(cleared.pointsLabel).toBeNull();
      expect(await storedLabel()).toBeNull();
      expect((await getLabel('hq').expect(200)).body).toEqual(cleared);
      expect(await labelAudits()).toBe(2);
    });

    it('rejects an invalid name without changing anything', async () => {
      const before = await storedLabel();
      for (const bad of ['x'.repeat(33), '<b>', 7]) {
        await putLabel('hq', { pointsLabel: bad }).expect(400);
      }
      expect(await storedLabel()).toBe(before);
      expect(await labelAudits()).toBe(0);
    });
  });

  it('rejects an invalid rate', async () => {
    for (const bad of [0, -1, 1.5, 101, 'two', null]) {
      await putSettings('hq', { earningRatePerDollar: bad }).expect(400);
    }
    const persisted = await prisma.loyaltyConfiguration.findUniqueOrThrow({
      where: {
        tenantId_key: { tenantId: TENANT_1_MOCHA_HOUSE_ID, key: 'company' },
      },
    });
    expect(persisted.earningRatePerDollar).toBe(1);
  });

  it('a rate change affects FUTURE authenticated order earning, not past entries', async () => {
    const id = await identity(randomUUID());

    // Earn at rate 1: $12.00 -> 12 Beans.
    const first = await submitCheckout(
      checkoutService,
      checkoutRequest(),
      id,
      tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
    );
    expect(first.subtotal).toBe(1200);
    const customer = await prisma.customer.findUniqueOrThrow({
      where: {
        tenantId_externalProvider_externalSubject: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          externalProvider: id.provider,
          externalSubject: id.subject,
        },
      },
    });
    expect(await earnedBeansFor(customer.id)).toBe(12);

    // HQ raises the rate to 3.
    await putSettings('hq', { earningRatePerDollar: 3 }).expect(200);

    // A NEW order earns at the new rate: $12.00 -> 36 Beans.
    await submitCheckout(
      checkoutService,
      checkoutRequest(),
      id,
      tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
    );

    const entries = await prisma.mochaBeanLedgerEntry.findMany({
      where: { loyaltyAccount: { customerId: customer.id }, type: 'EARN' },
      orderBy: { createdAt: 'asc' },
    });
    expect(entries.map((e) => e.amount)).toEqual([12, 36]);
    // Historical entry unchanged; balance is the sum of both.
    expect(await earnedBeansFor(customer.id)).toBe(48);
  });
});
