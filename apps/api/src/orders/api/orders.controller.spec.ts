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
} from '@mocha-house/contracts';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { LocationsModule } from '../../locations/locations.module';
import { CustomerAuthModule } from '../../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../../internal-auth/internal-auth.module';
import { CustomersModule } from '../../customers/customers.module';
import { signDevJwt } from '../../customer-auth/infrastructure/dev-jwt';
import { CheckoutService } from '../application/checkout.service';
import { PAYMENT_PROVIDER } from '../infrastructure/payment-provider.token';
import { OrdersController } from './orders.controller';

// Full HTTP integration test for POST /api/v1/orders' optional-auth
// behavior (Milestone 4B fix): OptionalCustomerAuthGuard +
// OrdersController + CheckoutService wired exactly as OrdersModule wires
// them. This is the only place that can prove the guard-level 401 for a
// bad token actually happens over real HTTP, before CheckoutService (and
// therefore payment) is ever reached — checkout.service.spec.ts calls the
// service directly and never exercises the guard at all.
describe('POST /api/v1/orders — optional customer authentication (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let locationId: string;
  let productId: string;
  let sizeGroupId: string;
  let mediumOptionId: string;
  const devSecret = 'orders-controller-spec-secret';
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
        InternalAuthModule,
        CustomersModule,
      ],
      controllers: [OrdersController],
      providers: [
        CheckoutService,
        { provide: PAYMENT_PROVIDER, useClass: FakePaymentProvider },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);
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

  async function paymentAttemptExists(
    idempotencyKey: string,
  ): Promise<boolean> {
    const attempt = await prisma.paymentAttempt.findUnique({
      where: { idempotencyKey },
    });
    return attempt !== null;
  }

  it('succeeds as guest with no Authorization header, and the Order has customerId null', async () => {
    const checkoutRequest = buildCheckoutRequest();

    const response = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .send(checkoutRequest)
      .expect(201);

    const confirmation = response.body as OrderConfirmation;
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: confirmation.orderId },
    });
    expect(order.customerId).toBeNull();
  });

  it('succeeds with a valid customer token and associates the correct Customer', async () => {
    const identifier = `test-${randomUUID()}@example.com`;
    const token = signDevJwt(
      { sub: `dev:${identifier}`, email: identifier, name: null },
      devSecret,
      3600,
    );
    const checkoutRequest = buildCheckoutRequest();

    const response = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send(checkoutRequest)
      .expect(201);

    const confirmation = response.body as OrderConfirmation;
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: confirmation.orderId },
    });
    expect(order.customerId).not.toBeNull();

    const customer = await prisma.customer.findUniqueOrThrow({
      where: {
        externalProvider_externalSubject: {
          externalProvider: 'dev',
          externalSubject: `dev:${identifier}`,
        },
      },
    });
    expect(order.customerId).toBe(customer.id);
  });

  it('rejects an invalid token with 401 and creates no payment attempt or order', async () => {
    const checkoutRequest = buildCheckoutRequest();

    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', 'Bearer not-a-real-token')
      .send(checkoutRequest)
      .expect(401);

    expect(await paymentAttemptExists(checkoutRequest.idempotencyKey)).toBe(
      false,
    );
  });

  it('rejects an expired token with 401 and creates no payment attempt or order', async () => {
    const expiredToken = signDevJwt(
      {
        sub: 'dev:test-expired@example.com',
        email: 'test-expired@example.com',
        name: null,
      },
      devSecret,
      -1,
    );
    const checkoutRequest = buildCheckoutRequest();

    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${expiredToken}`)
      .send(checkoutRequest)
      .expect(401);

    expect(await paymentAttemptExists(checkoutRequest.idempotencyKey)).toBe(
      false,
    );
  });

  it('rejects a token signed with the wrong secret with 401 and creates no payment attempt or order', async () => {
    const tamperedToken = signDevJwt(
      {
        sub: 'dev:test-tampered@example.com',
        email: 'test-tampered@example.com',
        name: null,
      },
      'a-completely-different-secret',
      3600,
    );
    const checkoutRequest = buildCheckoutRequest();

    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${tamperedToken}`)
      .send(checkoutRequest)
      .expect(401);

    expect(await paymentAttemptExists(checkoutRequest.idempotencyKey)).toBe(
      false,
    );
  });
});
