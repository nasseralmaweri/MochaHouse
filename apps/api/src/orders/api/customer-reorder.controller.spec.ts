import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { FakePaymentProvider } from '@mocha-house/integrations';
import type {
  CheckoutRequest,
  OrderConfirmation,
  ReorderPreparation,
} from '@mocha-house/contracts';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { LocationsModule } from '../../locations/locations.module';
import { CustomerAuthModule } from '../../customer-auth/customer-auth.module';
import { CustomersModule } from '../../customers/customers.module';
import { signDevJwt } from '../../customer-auth/infrastructure/dev-jwt';
import type { CustomerIdentity } from '../../customer-auth/infrastructure/customer-identity';
import { CheckoutService } from '../application/checkout.service';
import { CustomerOrdersService } from '../application/customer-orders.service';
import { CustomerReorderService } from '../application/customer-reorder.service';
import { PAYMENT_PROVIDER } from '../infrastructure/payment-provider.token';
import { CustomerOrdersController } from './customer-orders.controller';

// Full HTTP integration test for POST /customers/me/orders/:orderId/reorder
// (Milestone 4G). Uses a dedicated, isolated menu graph so prices,
// availability, modifiers, and location flags can be mutated freely and
// cleaned up. Fixture orders are created by calling CheckoutService
// directly, exactly like the order-history integration test.
describe('Customer reorder (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let checkoutService: CheckoutService;
  const devSecret = 'customer-reorder-spec-secret';
  const originalEnv = { ...process.env };

  // The isolated graph.
  let locationId: string;
  let menuId: string;
  let productId: string;
  let sizeGroupId: string;
  let mediumOptionId: string;
  const tag = randomUUID().slice(0, 8);

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = devSecret;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        PrismaModule,
        LocationsModule,
        CustomerAuthModule,
        CustomersModule,
      ],
      controllers: [CustomerOrdersController],
      providers: [
        CheckoutService,
        CustomerOrdersService,
        CustomerReorderService,
        { provide: PAYMENT_PROVIDER, useClass: FakePaymentProvider },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);
    checkoutService = moduleFixture.get(CheckoutService);
    await prisma.$connect();

    const location = await prisma.location.create({
      data: {
        name: `Reorder Loc ${tag}`,
        slug: `reorder-loc-${tag}`,
        isActive: true,
        isDigitalOrderingEnabled: true,
      },
    });
    const menu = await prisma.menu.create({
      data: {
        name: `Reorder Menu ${tag}`,
        slug: `reorder-menu-${tag}`,
        isActive: true,
      },
    });
    await prisma.locationMenu.create({
      data: { locationId: location.id, menuId: menu.id, isActive: true },
    });
    const category = await prisma.category.create({
      data: {
        name: `Reorder Cat ${tag}`,
        slug: `reorder-cat-${tag}`,
        displayOrder: 1,
        isActive: true,
      },
    });
    const product = await prisma.product.create({
      data: {
        name: `Reorder Latte ${tag}`,
        slug: `reorder-latte-${tag}`,
        basePrice: 500,
        currency: 'USD',
        isActive: true,
        categoryId: category.id,
      },
    });
    await prisma.menuProduct.create({
      data: {
        menuId: menu.id,
        productId: product.id,
        displayOrder: 1,
        isActive: true,
      },
    });
    const sizeGroup = await prisma.modifierGroup.create({
      data: {
        name: `Size ${tag}`,
        displayOrder: 1,
        isRequired: true,
        minSelections: 1,
        maxSelections: 1,
        isActive: true,
      },
    });
    await prisma.productModifierGroup.create({
      data: {
        productId: product.id,
        modifierGroupId: sizeGroup.id,
        displayOrder: 1,
      },
    });
    await prisma.modifierOption.create({
      data: {
        name: 'Small',
        priceAdjustment: 0,
        displayOrder: 1,
        isActive: true,
        modifierGroupId: sizeGroup.id,
      },
    });
    const medium = await prisma.modifierOption.create({
      data: {
        name: 'Medium',
        priceAdjustment: 50,
        displayOrder: 2,
        isActive: true,
        modifierGroupId: sizeGroup.id,
      },
    });

    locationId = location.id;
    menuId = menu.id;
    productId = product.id;
    sizeGroupId = sizeGroup.id;
    mediumOptionId = medium.id;
  });

  afterAll(async () => {
    const attempts = await prisma.paymentAttempt.findMany({
      where: { locationId },
      select: { id: true },
    });
    const attemptIds = attempts.map((a) => a.id);
    const orders = await prisma.order.findMany({
      where: { locationId },
      select: { id: true },
    });
    const orderIds = orders.map((o) => o.id);

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
    await prisma.customer.deleteMany({
      where: {
        externalProvider: 'dev',
        externalSubject: { startsWith: 'dev:test-reorder-' },
      },
    });
    await prisma.productModifierGroup.deleteMany({
      where: { modifierGroup: { name: { contains: tag } } },
    });
    await prisma.modifierOption.deleteMany({
      where: { modifierGroup: { name: { contains: tag } } },
    });
    await prisma.modifierGroup.deleteMany({
      where: { name: { contains: tag } },
    });
    await prisma.menuProduct.deleteMany({ where: { menuId } });
    await prisma.product.deleteMany({ where: { slug: { contains: tag } } });
    await prisma.category.deleteMany({ where: { slug: { contains: tag } } });
    await prisma.locationMenu.deleteMany({ where: { locationId } });
    await prisma.menu.deleteMany({ where: { id: menuId } });
    await prisma.location.deleteMany({ where: { id: locationId } });

    await app.close();
    await prisma.$disconnect();
    process.env = { ...originalEnv };
  });

  // Reset mutable graph state before each test.
  beforeEach(async () => {
    await prisma.location.update({
      where: { id: locationId },
      data: { isActive: true, isDigitalOrderingEnabled: true },
    });
    await prisma.product.update({
      where: { id: productId },
      data: { basePrice: 500, isActive: true },
    });
    await prisma.locationProductPriceOverride.deleteMany({
      where: { locationId },
    });
    await prisma.locationProductAvailabilityOverride.deleteMany({
      where: { locationId },
    });
    await prisma.modifierOption.update({
      where: { id: mediumOptionId },
      data: { priceAdjustment: 50, isActive: true },
    });
    await prisma.modifierGroup.update({
      where: { id: sizeGroupId },
      data: { isRequired: true, minSelections: 1, maxSelections: 1 },
    });
    await prisma.productModifierGroup.deleteMany({
      where: {
        productId,
        modifierGroup: { name: { contains: `Strength ${tag}` } },
      },
    });
    await prisma.modifierOption.deleteMany({
      where: { modifierGroup: { name: { contains: `Strength ${tag}` } } },
    });
    await prisma.modifierGroup.deleteMany({
      where: { name: { contains: `Strength ${tag}` } },
    });
  });

  function identityFor(identifier: string): CustomerIdentity {
    return {
      provider: 'dev',
      subject: `dev:${identifier}`,
      email: identifier,
      name: null,
      emailVerified: null,
    };
  }
  function tokenFor(identifier: string): string {
    return signDevJwt(
      { sub: `dev:${identifier}`, email: identifier, name: null },
      devSecret,
      3600,
    );
  }
  function newIdentifier(): string {
    return `test-reorder-${randomUUID()}@example.com`;
  }

  function checkoutBody(
    optionId: string = mediumOptionId,
    overrides: Partial<CheckoutRequest> = {},
  ): CheckoutRequest {
    return {
      idempotencyKey: `test_reorder_${randomUUID()}`,
      locationId,
      guest: { name: 'Reorder Guest', phone: '5551234567' },
      lines: [
        {
          productId,
          quantity: 2,
          selections: [{ groupId: sizeGroupId, optionIds: [optionId] }],
        },
      ],
      ...overrides,
    };
  }

  async function placeOrder(
    identifier: string,
    optionId?: string,
  ): Promise<OrderConfirmation> {
    return checkoutService.checkout(
      checkoutBody(optionId),
      identityFor(identifier),
    );
  }

  const reorderUrl = (orderId: string) =>
    `/api/v1/customers/me/orders/${orderId}/reorder`;

  it('rejects an unauthenticated reorder with 401', async () => {
    await request(app.getHttpServer()).post(reorderUrl('anything')).expect(401);
  });

  it('rejects a malformed / expired bearer token with 401', async () => {
    await request(app.getHttpServer())
      .post(reorderUrl('anything'))
      .set('Authorization', 'Bearer nope')
      .expect(401);

    const expired = signDevJwt(
      { sub: 'dev:x', email: 'x@example.com', name: null },
      devSecret,
      -10,
    );
    await request(app.getHttpServer())
      .post(reorderUrl('anything'))
      .set('Authorization', `Bearer ${expired}`)
      .expect(401);
  });

  it("returns 404 for another customer's order and for a nonexistent order, indistinguishably", async () => {
    const owner = newIdentifier();
    const intruder = newIdentifier();
    const order = await placeOrder(owner);

    await request(app.getHttpServer())
      .post(reorderUrl(order.orderId))
      .set('Authorization', `Bearer ${tokenFor(intruder)}`)
      .expect(404);

    await request(app.getHttpServer())
      .post(reorderUrl(`00000000-0000-0000-0000-000000000000`))
      .set('Authorization', `Bearer ${tokenFor(intruder)}`)
      .expect(404);
  });

  it('creates no Order and no PaymentAttempt', async () => {
    const id = newIdentifier();
    const order = await placeOrder(id);
    const ordersBefore = await prisma.order.count({ where: { locationId } });
    const attemptsBefore = await prisma.paymentAttempt.count({
      where: { locationId },
    });

    await request(app.getHttpServer())
      .post(reorderUrl(order.orderId))
      .set('Authorization', `Bearer ${tokenFor(id)}`)
      .expect(200);

    expect(await prisma.order.count({ where: { locationId } })).toBe(
      ordersBefore,
    );
    expect(await prisma.paymentAttempt.count({ where: { locationId } })).toBe(
      attemptsBefore,
    );
  });

  it('a fully unchanged order resolves READY with quantity, current price and current ids', async () => {
    const id = newIdentifier();
    const order = await placeOrder(id, mediumOptionId);

    const res = await request(app.getHttpServer())
      .post(reorderUrl(order.orderId))
      .set('Authorization', `Bearer ${tokenFor(id)}`)
      .expect(200);
    const prep = res.body as ReorderPreparation;

    expect(prep.status).toBe('READY');
    expect(prep.items).toHaveLength(1);
    const item = prep.items[0];
    expect(item.status).toBe('VALID');
    expect(item.productId).toBe(productId);
    expect(item.quantity).toBe(2);
    expect(item.currentUnitPrice).toBe(550); // 500 base + 50 medium
    expect(item.currentLineSubtotal).toBe(1100);
    expect(item.selections[0].groupId).toBe(sizeGroupId);
    expect(item.selections[0].optionIds).toEqual([mediumOptionId]);
    expect(prep.currentEstimatedSubtotal).toBe(1100);
  });

  it('uses the CURRENT price when the base price changed, and reports PRICE_CHANGED', async () => {
    const id = newIdentifier();
    const order = await placeOrder(id, mediumOptionId);
    await prisma.product.update({
      where: { id: productId },
      data: { basePrice: 700 },
    });

    const res = await request(app.getHttpServer())
      .post(reorderUrl(order.orderId))
      .set('Authorization', `Bearer ${tokenFor(id)}`)
      .expect(200);
    const prep = res.body as ReorderPreparation;

    expect(prep.status).toBe('NEEDS_REVIEW');
    expect(prep.items[0].status).toBe('CHANGED');
    expect(prep.items[0].currentUnitPrice).toBe(750); // 700 + 50
    expect(prep.items[0].historicalUnitPrice).toBe(550);
    expect(prep.items[0].issues.map((i) => i.code)).toContain('PRICE_CHANGED');
  });

  it('uses the current modifier price delta', async () => {
    const id = newIdentifier();
    const order = await placeOrder(id, mediumOptionId);
    await prisma.modifierOption.update({
      where: { id: mediumOptionId },
      data: { priceAdjustment: 130 },
    });

    const res = await request(app.getHttpServer())
      .post(reorderUrl(order.orderId))
      .set('Authorization', `Bearer ${tokenFor(id)}`)
      .expect(200);
    expect((res.body as ReorderPreparation).items[0].currentUnitPrice).toBe(
      630,
    );
  });

  it('surfaces an unavailable product and never substitutes', async () => {
    const id = newIdentifier();
    const order = await placeOrder(id, mediumOptionId);
    await prisma.locationProductAvailabilityOverride.create({
      data: {
        locationId,
        menuId,
        productId,
        isAvailable: false,
      },
    });

    const res = await request(app.getHttpServer())
      .post(reorderUrl(order.orderId))
      .set('Authorization', `Bearer ${tokenFor(id)}`)
      .expect(200);
    const prep = res.body as ReorderPreparation;
    expect(prep.status).toBe('UNAVAILABLE');
    expect(prep.items[0].status).toBe('UNAVAILABLE');
    expect(prep.items[0].issues[0].code).toBe('PRODUCT_UNAVAILABLE');
  });

  it('surfaces a product removed from the location menu', async () => {
    const id = newIdentifier();
    const order = await placeOrder(id, mediumOptionId);
    await prisma.menuProduct.updateMany({
      where: { menuId, productId },
      data: { isActive: false },
    });

    const res = await request(app.getHttpServer())
      .post(reorderUrl(order.orderId))
      .set('Authorization', `Bearer ${tokenFor(id)}`)
      .expect(200);
    expect((res.body as ReorderPreparation).items[0].issues[0].code).toBe(
      'PRODUCT_NOT_ON_MENU',
    );

    await prisma.menuProduct.updateMany({
      where: { menuId, productId },
      data: { isActive: true },
    });
  });

  it('surfaces a removed historical modifier option and requires review (no substitute)', async () => {
    const id = newIdentifier();
    const order = await placeOrder(id, mediumOptionId);
    await prisma.modifierOption.update({
      where: { id: mediumOptionId },
      data: { isActive: false },
    });

    const res = await request(app.getHttpServer())
      .post(reorderUrl(order.orderId))
      .set('Authorization', `Bearer ${tokenFor(id)}`)
      .expect(200);
    const item = (res.body as ReorderPreparation).items[0];
    expect(item.status).toBe('CHANGED');
    expect(item.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining([
        'MODIFIER_OPTION_REMOVED',
        'MODIFIER_REQUIRED_SELECTION_MISSING',
      ]),
    );
    expect(item.needsCustomization).toBe(true);
    expect(item.selections).toEqual([]);
  });

  it('flags a newly-added required modifier group as needing review, without inventing a default', async () => {
    const id = newIdentifier();
    const order = await placeOrder(id, mediumOptionId);

    const strength = await prisma.modifierGroup.create({
      data: {
        name: `Strength ${tag}`,
        displayOrder: 2,
        isRequired: true,
        minSelections: 1,
        maxSelections: 1,
        isActive: true,
        options: {
          create: [
            {
              name: 'Regular',
              priceAdjustment: 0,
              displayOrder: 1,
              isActive: true,
            },
          ],
        },
      },
    });
    await prisma.productModifierGroup.create({
      data: { productId, modifierGroupId: strength.id, displayOrder: 2 },
    });

    const res = await request(app.getHttpServer())
      .post(reorderUrl(order.orderId))
      .set('Authorization', `Bearer ${tokenFor(id)}`)
      .expect(200);
    const item = (res.body as ReorderPreparation).items[0];
    expect(item.status).toBe('CHANGED');
    expect(item.needsCustomization).toBe(true);
    expect(item.issues.map((i) => i.code)).toContain(
      'MODIFIER_REQUIRED_SELECTION_MISSING',
    );
    expect(item.selections.map((s) => s.groupId)).not.toContain(strength.id);
  });

  it('blocks reorder when the original location is inactive — no auto-switch', async () => {
    const id = newIdentifier();
    const order = await placeOrder(id, mediumOptionId);
    await prisma.location.update({
      where: { id: locationId },
      data: { isActive: false },
    });

    const res = await request(app.getHttpServer())
      .post(reorderUrl(order.orderId))
      .set('Authorization', `Bearer ${tokenFor(id)}`)
      .expect(200);
    const prep = res.body as ReorderPreparation;
    expect(prep.status).toBe('UNAVAILABLE');
    expect(prep.items).toEqual([]);
    expect(prep.issues[0].code).toBe('LOCATION_INACTIVE');
  });

  it('blocks reorder when digital ordering is disabled at the original location', async () => {
    const id = newIdentifier();
    const order = await placeOrder(id, mediumOptionId);
    await prisma.location.update({
      where: { id: locationId },
      data: { isDigitalOrderingEnabled: false },
    });

    const res = await request(app.getHttpServer())
      .post(reorderUrl(order.orderId))
      .set('Authorization', `Bearer ${tokenFor(id)}`)
      .expect(200);
    const prep = res.body as ReorderPreparation;
    expect(prep.status).toBe('UNAVAILABLE');
    expect(prep.issues[0].code).toBe('LOCATION_DIGITAL_ORDERING_DISABLED');
    expect(prep.location.isDigitalOrderingEnabled).toBe(false);
  });
});
