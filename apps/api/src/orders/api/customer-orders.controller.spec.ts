import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { FakePaymentProvider } from '@mocha-house/integrations';
import type {
  CheckoutRequest,
  CustomerOrderDetail,
  CustomerOrderSummary,
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

// Full HTTP integration test for the authenticated customer order-history
// surface (Milestone 4B): CustomerAuthGuard + CustomerOrdersController +
// CustomerOrdersService wired exactly as OrdersModule wires them. Fixture
// orders are created by calling CheckoutService directly (not over HTTP —
// OrdersController/OptionalCustomerAuthGuard are already covered by their
// own tests) so each test controls exactly which identity, if any, an
// order is associated with.
describe('CustomerOrdersController (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let checkoutService: CheckoutService;
  let locationId: string;
  let productId: string;
  let sizeGroupId: string;
  let mediumOptionId: string;
  const devSecret = 'customer-orders-controller-spec-secret';
  const originalEnv = { ...process.env };

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
  });

  afterAll(async () => {
    const attempts = await prisma.paymentAttempt.findMany({
      where: { idempotencyKey: { startsWith: 'test_' } },
      select: { id: true },
    });
    const attemptIds = attempts.map((a) => a.id);
    if (attemptIds.length > 0) {
      const orders = await prisma.order.findMany({
        where: { paymentAttemptId: { in: attemptIds } },
        select: { id: true },
      });
      const orderIds = orders.map((o) => o.id);

      await prisma.orderLine.deleteMany({
        where: { orderId: { in: orderIds } },
      });
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
    await prisma.customer.deleteMany({
      where: {
        externalProvider: 'dev',
        externalSubject: { startsWith: 'dev:test-' },
      },
    });

    await app.close();
    await prisma.$disconnect();
    process.env = { ...originalEnv };
  });

  function buildCheckoutRequest(
    overrides: Partial<CheckoutRequest> = {},
  ): CheckoutRequest {
    return {
      idempotencyKey: `test_${randomUUID()}`,
      locationId,
      guest: { name: 'Test Guest', phone: '5551234567' },
      lines: [
        {
          productId,
          quantity: 1,
          selections: [{ groupId: sizeGroupId, optionIds: [mediumOptionId] }],
        },
      ],
      ...overrides,
    };
  }

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

  it('rejects an unauthenticated order-history request with 401', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/customers/me/orders')
      .expect(401);
  });

  it('rejects an unauthenticated order-detail request with 401', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/customers/me/orders/anything')
      .expect(401);
  });

  it("lists only the authenticated customer's own orders, excluding another customer's and a guest order", async () => {
    const identifierA = `test-${randomUUID()}@example.com`;
    const identifierB = `test-${randomUUID()}@example.com`;

    const orderA = await checkoutService.checkout(
      buildCheckoutRequest(),
      identityFor(identifierA),
    );
    const orderB = await checkoutService.checkout(
      buildCheckoutRequest(),
      identityFor(identifierB),
    );
    const guestOrder = await checkoutService.checkout(buildCheckoutRequest());

    const response = await request(app.getHttpServer())
      .get('/api/v1/customers/me/orders')
      .set('Authorization', `Bearer ${tokenFor(identifierA)}`)
      .expect(200);

    const orderIds = (response.body as CustomerOrderSummary[]).map(
      (o) => o.orderId,
    );
    expect(orderIds).toContain(orderA.orderId);
    expect(orderIds).not.toContain(orderB.orderId);
    expect(orderIds).not.toContain(guestOrder.orderId);
  });

  it('returns the historical order snapshot (items, prices, status) for the owning customer', async () => {
    const identifier = `test-${randomUUID()}@example.com`;
    const confirmation = await checkoutService.checkout(
      buildCheckoutRequest(),
      identityFor(identifier),
    );

    const response = await request(app.getHttpServer())
      .get(`/api/v1/customers/me/orders/${confirmation.orderId}`)
      .set('Authorization', `Bearer ${tokenFor(identifier)}`)
      .expect(200);

    const detail = response.body as CustomerOrderDetail;
    expect(detail.orderId).toBe(confirmation.orderId);
    expect(detail.orderNumber).toBe(confirmation.orderNumber);
    expect(detail.status).toBe('RECEIVED');
    expect(detail.subtotal).toBe(confirmation.subtotal);
    expect(detail.lines).toHaveLength(1);
    expect(detail.lines[0].unitPrice).toBe(confirmation.subtotal);
  });

  it("returns 404 (never another customer's order) when the order belongs to someone else", async () => {
    const identifierOwner = `test-${randomUUID()}@example.com`;
    const identifierIntruder = `test-${randomUUID()}@example.com`;
    const ownerOrder = await checkoutService.checkout(
      buildCheckoutRequest(),
      identityFor(identifierOwner),
    );

    await request(app.getHttpServer())
      .get(`/api/v1/customers/me/orders/${ownerOrder.orderId}`)
      .set('Authorization', `Bearer ${tokenFor(identifierIntruder)}`)
      .expect(404);
  });

  it('returns 404 for a guest order requested through the authenticated history endpoint', async () => {
    const identifier = `test-${randomUUID()}@example.com`;
    const guestOrder = await checkoutService.checkout(buildCheckoutRequest());

    await request(app.getHttpServer())
      .get(`/api/v1/customers/me/orders/${guestOrder.orderId}`)
      .set('Authorization', `Bearer ${tokenFor(identifier)}`)
      .expect(404);
  });

  it('returns an empty list for a customer with no orders', async () => {
    const identifier = `test-${randomUUID()}@example.com`;

    const response = await request(app.getHttpServer())
      .get('/api/v1/customers/me/orders')
      .set('Authorization', `Bearer ${tokenFor(identifier)}`)
      .expect(200);

    expect(response.body).toEqual([]);
  });
});
