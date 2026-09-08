import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { FakePaymentProvider } from '@mocha-house/integrations';
import type { CheckoutRewardEligibilityResponse } from '@mocha-house/contracts';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { LocationsModule } from '../../locations/locations.module';
import { CustomersModule } from '../../customers/customers.module';
import { CustomerAuthModule } from '../../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../../internal-auth/internal-auth.module';
import { LoyaltyModule } from '../../loyalty/loyalty.module';
import { PromotionsModule } from '../../promotions/promotions.module';
import { signDevJwt } from '../../customer-auth/infrastructure/dev-jwt';
import { CheckoutService } from '../application/checkout.service';
import { PAYMENT_PROVIDER } from '../infrastructure/payment-provider.token';
import { CheckoutRewardsController } from './checkout-rewards.controller';

// Milestone 7C — POST /api/v1/orders/reward-eligibility over real HTTP.
// Proves a guest gets 401 (no rewards), and a signed-in customer gets only
// the rewards eligible for their cart, with correct discount + canAfford.
describe('POST /api/v1/orders/reward-eligibility (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const devSecret = 'checkout-rewards-spec-secret';
  const suffix = randomUUID();
  const SUBJECT_PREFIX = 'dev:checkout-rewards-';

  let locationId: string;
  let categoryId: string;
  let latteId: string;
  let pastryId: string;
  const rewardIds: string[] = [];

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = devSecret;

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
      controllers: [CheckoutRewardsController],
      providers: [
        CheckoutService,
        { provide: PAYMENT_PROVIDER, useClass: FakePaymentProvider },
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    const location = await prisma.location.create({
      data: {
        name: `CR Spec Loc ${suffix}`,
        slug: `cr-spec-${suffix}`,
        isActive: true,
        isDigitalOrderingEnabled: true,
      },
    });
    locationId = location.id;
    const category = await prisma.category.create({
      data: { name: `CR Cat ${suffix}`, slug: `cr-cat-${suffix}` },
    });
    categoryId = category.id;
    latteId = (
      await prisma.product.create({
        data: {
          name: 'CR Latte',
          slug: `cr-latte-${suffix}`,
          basePrice: 500,
          categoryId,
        },
      })
    ).id;
    pastryId = (
      await prisma.product.create({
        data: {
          name: 'CR Pastry',
          slug: `cr-pastry-${suffix}`,
          basePrice: 300,
          categoryId,
        },
      })
    ).id;
    const menu = await prisma.menu.create({
      data: { name: `CR Menu ${suffix}`, slug: `cr-menu-${suffix}` },
    });
    await prisma.menuProduct.createMany({
      data: [latteId, pastryId].map((productId, i) => ({
        menuId: menu.id,
        productId,
        displayOrder: i,
        isActive: true,
      })),
    });
    await prisma.locationMenu.create({
      data: { locationId, menuId: menu.id, isActive: true },
    });

    const fixed = await prisma.loyaltyReward.create({
      data: {
        name: `CR $5 Off ${suffix}`,
        type: 'FIXED_AMOUNT',
        beanCost: 100,
        fixedAmountMinorUnits: 500,
        sortOrder: 1,
      },
    });
    const freeLatte = await prisma.loyaltyReward.create({
      data: {
        name: `CR Free Latte ${suffix}`,
        type: 'FREE_ITEM',
        beanCost: 150,
        sortOrder: 2,
        eligibleProducts: { create: [{ productId: latteId }] },
      },
    });
    const inactive = await prisma.loyaltyReward.create({
      data: {
        name: `CR Inactive ${suffix}`,
        type: 'FIXED_AMOUNT',
        beanCost: 10,
        fixedAmountMinorUnits: 100,
        isActive: false,
        sortOrder: 3,
      },
    });
    rewardIds.push(fixed.id, freeLatte.id, inactive.id);
  });

  afterAll(async () => {
    await prisma.customer.deleteMany({
      where: {
        externalProvider: 'dev',
        externalSubject: { startsWith: SUBJECT_PREFIX },
      },
    });
    await prisma.loyaltyRewardProduct.deleteMany({
      where: { rewardId: { in: rewardIds } },
    });
    await prisma.loyaltyReward.deleteMany({ where: { id: { in: rewardIds } } });
    await prisma.menuProduct.deleteMany({
      where: { productId: { in: [latteId, pastryId] } },
    });
    await prisma.locationMenu.deleteMany({ where: { locationId } });
    await prisma.menu.deleteMany({ where: { slug: `cr-menu-${suffix}` } });
    await prisma.product.deleteMany({
      where: { id: { in: [latteId, pastryId] } },
    });
    await prisma.category.deleteMany({ where: { id: categoryId } });
    await prisma.location.deleteMany({ where: { id: locationId } });
    await app.close();
    process.env = { ...originalEnv };
  });

  function tokenFor(sub: string): string {
    return signDevJwt(
      { sub: `${SUBJECT_PREFIX}${sub}`, email: `${sub}@x.test`, name: null },
      devSecret,
      3600,
    );
  }

  async function seedCustomerBalance(sub: string, balance: number): Promise<void> {
    const customer = await prisma.customer.upsert({
      where: {
        externalProvider_externalSubject: {
          externalProvider: 'dev',
          externalSubject: `${SUBJECT_PREFIX}${sub}`,
        },
      },
      update: {},
      create: {
        externalProvider: 'dev',
        externalSubject: `${SUBJECT_PREFIX}${sub}`,
        email: `${sub}@x.test`,
      },
    });
    await prisma.customerLoyaltyAccount.upsert({
      where: { customerId: customer.id },
      update: { balance },
      create: { customerId: customer.id, balance },
    });
  }

  const body = (extra: Record<string, unknown> = {}) => ({
    locationId,
    lines: [{ productId: latteId, quantity: 1 }],
    ...extra,
  });

  it('rejects a guest (no session) with 401', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/orders/reward-eligibility')
      .send(body())
      .expect(401);
  });

  it('returns only active, cart-eligible rewards with correct discount + canAfford', async () => {
    const sub = randomUUID();
    await seedCustomerBalance(sub, 120);
    const token = tokenFor(sub);

    const res = await request(app.getHttpServer())
      .post('/api/v1/orders/reward-eligibility')
      .set('Authorization', `Bearer ${token}`)
      .send(body())
      .expect(200);

    const data = res.body as CheckoutRewardEligibilityResponse;
    expect(data.balance).toBe(120);
    const names = data.rewards.map((r) => r.name);
    expect(names).toContain(`CR $5 Off ${suffix}`);
    expect(names).toContain(`CR Free Latte ${suffix}`);
    expect(names).not.toContain(`CR Inactive ${suffix}`); // inactive hidden

    const fixed = data.rewards.find((r) => r.type === 'FIXED_AMOUNT')!;
    expect(fixed.discountMinorUnits).toBe(500);
    expect(fixed.canAfford).toBe(true); // 120 >= 100

    const free = data.rewards.find((r) => r.type === 'FREE_ITEM')!;
    expect(free.discountMinorUnits).toBe(500); // the $5 latte
    expect(free.freeItemName).toBe('CR Latte');
    expect(free.canAfford).toBe(false); // 120 < 150
  });

  it('omits a FREE_ITEM reward whose target is not in the cart', async () => {
    const sub = randomUUID();
    await seedCustomerBalance(sub, 500);
    const token = tokenFor(sub);

    // Cart has only the pastry; the free-latte reward targets the latte.
    const res = await request(app.getHttpServer())
      .post('/api/v1/orders/reward-eligibility')
      .set('Authorization', `Bearer ${token}`)
      .send(body({ lines: [{ productId: pastryId, quantity: 1 }] }))
      .expect(200);

    const data = res.body as CheckoutRewardEligibilityResponse;
    expect(data.rewards.map((r) => r.type)).not.toContain('FREE_ITEM');
    expect(data.rewards.map((r) => r.type)).toContain('FIXED_AMOUNT');
  });

  it('rejects an empty cart with 400', async () => {
    const sub = randomUUID();
    await seedCustomerBalance(sub, 100);
    await request(app.getHttpServer())
      .post('/api/v1/orders/reward-eligibility')
      .set('Authorization', `Bearer ${tokenFor(sub)}`)
      .send({ locationId, lines: [] })
      .expect(400);
  });
});
