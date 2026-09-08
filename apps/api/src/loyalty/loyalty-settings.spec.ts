import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { FakePaymentProvider } from '@mocha-house/integrations';
import type {
  CheckoutRequest,
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
import { PAYMENT_PROVIDER } from '../orders/infrastructure/payment-provider.token';
import type { CustomerIdentity } from '../customer-auth/infrastructure/customer-identity';
import { LoyaltyModule } from './loyalty.module';
import { PromotionsModule } from '../promotions/promotions.module';

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
      data: { internalUserId: user.id, roleId: role.id, ...scope },
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
      where: { key: 'company' },
      update: { earningRatePerDollar: rate },
      create: { key: 'company', earningRatePerDollar: rate },
    });
  }

  function checkoutRequest(): CheckoutRequest {
    return {
      idempotencyKey: `${KEY_PREFIX}${randomUUID()}`,
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

  function identity(s: string): CustomerIdentity {
    return {
      provider: 'test',
      subject: `${SUBJECT_PREFIX}${s}`,
      email: `${s}@example.com`,
      name: null,
      emailVerified: null,
    };
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
      ],
      providers: [
        CheckoutService,
        { provide: PAYMENT_PROVIDER, useClass: FakePaymentProvider },
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);
    checkoutService = moduleFixture.get(CheckoutService);

    locId = (
      await prisma.location.create({
        data: {
          name: `Settings Spec Loc ${suffix}`,
          slug: `settings-spec-${suffix}`,
          isActive: true,
          isDigitalOrderingEnabled: true,
        },
      })
    ).id;

    const location = await prisma.location.findUniqueOrThrow({
      where: { slug: 'dearborn-heights' },
    });
    const product = await prisma.product.findUniqueOrThrow({
      where: { slug: 'drip-coffee' },
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
      where: { key: 'store-manager' },
    });
    const mgr = await prisma.internalUser.create({
      data: {
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
        roleId: storeManager.id,
        scopeType: 'LOCATION',
        scopeId: locId,
      },
    });

    await setRate(1);
  }, 45_000);

  afterEach(async () => {
    await setRate(1);
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
      where: { idempotencyKey: { startsWith: KEY_PREFIX } },
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
      where: { key: 'company' },
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

  it('rejects an invalid rate', async () => {
    for (const bad of [0, -1, 1.5, 101, 'two', null]) {
      await putSettings('hq', { earningRatePerDollar: bad }).expect(400);
    }
    const persisted = await prisma.loyaltyConfiguration.findUniqueOrThrow({
      where: { key: 'company' },
    });
    expect(persisted.earningRatePerDollar).toBe(1);
  });

  it('a rate change affects FUTURE authenticated order earning, not past entries', async () => {
    const id = identity(randomUUID());

    // Earn at rate 1: $12.00 -> 12 Beans.
    const first = await checkoutService.checkout(checkoutRequest(), id);
    expect(first.subtotal).toBe(1200);
    const customer = await prisma.customer.findUniqueOrThrow({
      where: {
        externalProvider_externalSubject: {
          externalProvider: id.provider,
          externalSubject: id.subject,
        },
      },
    });
    expect(await earnedBeansFor(customer.id)).toBe(12);

    // HQ raises the rate to 3.
    await putSettings('hq', { earningRatePerDollar: 3 }).expect(200);

    // A NEW order earns at the new rate: $12.00 -> 36 Beans.
    await checkoutService.checkout(checkoutRequest(), id);

    const entries = await prisma.mochaBeanLedgerEntry.findMany({
      where: { loyaltyAccount: { customerId: customer.id }, type: 'EARN' },
      orderBy: { createdAt: 'asc' },
    });
    expect(entries.map((e) => e.amount)).toEqual([12, 36]);
    // Historical entry unchanged; balance is the sum of both.
    expect(await earnedBeansFor(customer.id)).toBe(48);
  });
});
