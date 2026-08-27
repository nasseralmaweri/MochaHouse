import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { FakePaymentProvider } from '@mocha-house/integrations';
import type { CheckoutRequest } from '@mocha-house/contracts';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { LocationsModule } from '../../locations/locations.module';
import { CustomersModule } from '../../customers/customers.module';
import { CheckoutService } from './checkout.service';
import { AdminOrdersService } from './admin-orders.service';
import { PAYMENT_PROVIDER } from '../infrastructure/payment-provider.token';

// Integration test against the real local Postgres instance, exercising
// the store queue exactly as AdminOrdersController would: checkout creates
// an order, and AdminOrdersService is what the /admin/orders API is a thin
// wrapper over. Outbox *processing* is apps/worker's responsibility now
// (see apps/worker/src/outbox) — apps/api only ever reads OutboxEvent
// status to decide store-queue visibility, never claims/advances it, so
// "the worker published this order" is simulated here with the same
// conditional Prisma update the real processor uses, not by importing
// worker code into an apps/api test.
describe('AdminOrdersService (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let checkoutService: CheckoutService;
  let adminOrdersService: AdminOrdersService;
  let locationId: string;
  let otherLocationId: string;
  let productId: string;
  let sizeGroupId: string;
  let smallOptionId: string;

  // Every order/payment-attempt this file creates, so afterAll can remove
  // exactly what this run added and nothing else — the seeded catalog
  // fixture (dearborn-heights / drip-coffee) is never touched.
  const createdOrderIds: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, LocationsModule, CustomersModule],
      providers: [
        CheckoutService,
        AdminOrdersService,
        { provide: PAYMENT_PROVIDER, useClass: FakePaymentProvider },
      ],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    checkoutService = moduleRef.get(CheckoutService);
    adminOrdersService = moduleRef.get(AdminOrdersService);
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
    smallOptionId = sizeGroup.options.find((o) => o.name === 'Small')!.id;

    // A second, real location so "wrong location can't see it" tests
    // against genuine data rather than a made-up id. Removed in afterAll.
    const otherLocation = await prisma.location.upsert({
      where: { slug: 'admin-orders-spec-other-location' },
      update: {},
      create: {
        name: 'Admin Orders Spec — Other Location',
        slug: 'admin-orders-spec-other-location',
        isActive: true,
        isDigitalOrderingEnabled: true,
      },
    });
    otherLocationId = otherLocation.id;
  });

  afterAll(async () => {
    if (createdOrderIds.length > 0) {
      const orders = await prisma.order.findMany({
        where: { id: { in: createdOrderIds } },
        select: { id: true, paymentAttemptId: true },
      });
      const orderIds = orders.map((o) => o.id);
      const paymentAttemptIds = orders.map((o) => o.paymentAttemptId);

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
        where: { id: { in: paymentAttemptIds } },
      });
    }

    await prisma.location.delete({ where: { id: otherLocationId } });

    await moduleRef.close();
    await prisma.$disconnect();
  });

  function buildCheckoutRequest(
    overrides: Partial<CheckoutRequest> = {},
  ): CheckoutRequest {
    return {
      idempotencyKey: `admin_orders_spec_${randomUUID()}`,
      locationId,
      guest: { name: 'Store Test Guest', phone: '5556660000' },
      lines: [
        {
          productId,
          quantity: 1,
          selections: [{ groupId: sizeGroupId, optionIds: [smallOptionId] }],
        },
      ],
      ...overrides,
    };
  }

  // Simulates apps/worker's OutboxProcessorService for exactly this
  // order's event, using the identical conditional-update shape (WHERE
  // status = PENDING) so the test still proves the real gating condition
  // — "published" means PROCESSED — without depending on worker code.
  async function publishOrder(orderId: string): Promise<void> {
    const result = await prisma.outboxEvent.updateMany({
      where: {
        aggregateType: 'Order',
        aggregateId: orderId,
        status: 'PENDING',
      },
      data: { status: 'PROCESSED', processedAt: new Date() },
    });
    if (result.count !== 1) {
      throw new Error(
        `Expected exactly one PENDING outbox event for order ${orderId}, claimed ${result.count}.`,
      );
    }
  }

  async function createPublishedOrder() {
    const confirmation = await checkoutService.checkout(buildCheckoutRequest());
    createdOrderIds.push(confirmation.orderId);
    await publishOrder(confirmation.orderId);
    return confirmation;
  }

  it('does not appear in the store queue until its outbox event is processed', async () => {
    const confirmation = await checkoutService.checkout(buildCheckoutRequest());
    createdOrderIds.push(confirmation.orderId);

    const beforeProcessing = await adminOrdersService.listActive(locationId);
    expect(
      beforeProcessing.some((o) => o.orderId === confirmation.orderId),
    ).toBe(false);

    await publishOrder(confirmation.orderId);

    const afterProcessing = await adminOrdersService.listActive(locationId);
    expect(
      afterProcessing.some((o) => o.orderId === confirmation.orderId),
    ).toBe(true);
  });

  it('does not expose guest access token or email in the store list/detail', async () => {
    const confirmation = await createPublishedOrder();

    const list = await adminOrdersService.listActive(locationId);
    const summary = list.find((o) => o.orderId === confirmation.orderId)!;
    expect(summary).not.toHaveProperty('accessToken');
    expect(summary).not.toHaveProperty('guestEmail');

    const detail = await adminOrdersService.getDetail(
      confirmation.orderId,
      locationId,
    );
    expect(detail).not.toHaveProperty('accessToken');
    expect(detail.guestPhone).toBe('5556660000');
  });

  it('is not visible from a different location', async () => {
    const confirmation = await createPublishedOrder();

    const otherLocationOrders =
      await adminOrdersService.listActive(otherLocationId);
    expect(
      otherLocationOrders.some((o) => o.orderId === confirmation.orderId),
    ).toBe(false);

    await expect(
      adminOrdersService.getDetail(confirmation.orderId, otherLocationId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('advances through the full lifecycle, one immutable history row per step, payment status untouched', async () => {
    const confirmation = await createPublishedOrder();

    const steps: Array<[string, string]> = [
      ['RECEIVED', 'ACCEPTED'],
      ['ACCEPTED', 'PREPARING'],
      ['PREPARING', 'READY'],
      ['READY', 'COMPLETED'],
    ];

    for (const [expected, expectedNext] of steps) {
      const result = await adminOrdersService.advance(
        confirmation.orderId,
        locationId,
        expected,
      );
      expect(result.advanced).toBe(true);
      expect(result.status).toBe(expectedNext);
    }

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: confirmation.orderId },
      include: {
        statusHistory: { orderBy: { createdAt: 'asc' } },
        paymentAttempt: true,
      },
    });
    expect(order.status).toBe('COMPLETED');
    expect(order.statusHistory.map((h) => h.status)).toEqual([
      'RECEIVED',
      'ACCEPTED',
      'PREPARING',
      'READY',
      'COMPLETED',
    ]);
    // Payment status is a completely separate concern from operational
    // status and must be untouched by any of the four transitions above.
    expect(order.paymentAttempt.status).toBe('SUCCEEDED');
  });

  it('rejects advancing an order that is already completed', async () => {
    const confirmation = await createPublishedOrder();
    for (const expected of ['RECEIVED', 'ACCEPTED', 'PREPARING', 'READY']) {
      await adminOrdersService.advance(
        confirmation.orderId,
        locationId,
        expected,
      );
    }

    await expect(
      adminOrdersService.advance(confirmation.orderId, locationId, 'COMPLETED'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('a retried advance call with the same expectedStatus does not duplicate history', async () => {
    const confirmation = await createPublishedOrder();

    const first = await adminOrdersService.advance(
      confirmation.orderId,
      locationId,
      'RECEIVED',
    );
    expect(first.advanced).toBe(true);

    // Simulates a lost-response-style retry: caller still believes the
    // order was RECEIVED and resends the same request.
    const retry = await adminOrdersService.advance(
      confirmation.orderId,
      locationId,
      'RECEIVED',
    );
    expect(retry.advanced).toBe(false);
    expect(retry.status).toBe('ACCEPTED');

    const history = await prisma.orderStatusHistory.findMany({
      where: { orderId: confirmation.orderId },
    });
    expect(history).toHaveLength(2); // RECEIVED (initial) + ACCEPTED — not 3.
  });

  it('rejects a genuinely stale expectedStatus as a conflict, not a silent no-op', async () => {
    const confirmation = await createPublishedOrder();
    await adminOrdersService.advance(
      confirmation.orderId,
      locationId,
      'RECEIVED',
    );
    await adminOrdersService.advance(
      confirmation.orderId,
      locationId,
      'ACCEPTED',
    );
    // Order is now PREPARING. A caller still expecting RECEIVED (two steps
    // behind) is a real conflict, not a retry of the immediately-prior step.
    await expect(
      adminOrdersService.advance(confirmation.orderId, locationId, 'RECEIVED'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('concurrent advance calls for the same order never produce two history rows', async () => {
    const confirmation = await createPublishedOrder();

    const results = await Promise.allSettled([
      adminOrdersService.advance(confirmation.orderId, locationId, 'RECEIVED'),
      adminOrdersService.advance(confirmation.orderId, locationId, 'RECEIVED'),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const advancedCount = results.filter(
      (r) =>
        r.status === 'fulfilled' && (r.value as { advanced: boolean }).advanced,
    ).length;
    expect(advancedCount).toBe(1);

    const history = await prisma.orderStatusHistory.findMany({
      where: { orderId: confirmation.orderId },
    });
    expect(history).toHaveLength(2);
  });

  it('a completed order disappears from the active store queue', async () => {
    const confirmation = await createPublishedOrder();
    for (const expected of ['RECEIVED', 'ACCEPTED', 'PREPARING', 'READY']) {
      await adminOrdersService.advance(
        confirmation.orderId,
        locationId,
        expected,
      );
    }

    const activeOrders = await adminOrdersService.listActive(locationId);
    expect(activeOrders.some((o) => o.orderId === confirmation.orderId)).toBe(
      false,
    );
  });

  it('customer-facing status reflects store-side transitions', async () => {
    const confirmation = await createPublishedOrder();

    let status = await checkoutService.getStatus(
      confirmation.orderId,
      confirmation.accessToken,
    );
    expect(status.status).toBe('RECEIVED');

    await adminOrdersService.advance(
      confirmation.orderId,
      locationId,
      'RECEIVED',
    );

    status = await checkoutService.getStatus(
      confirmation.orderId,
      confirmation.accessToken,
    );
    expect(status.status).toBe('ACCEPTED');
    // Payment status is reported separately and is unaffected.
    expect(status.paymentStatus).toBe('SUCCEEDED');
  });
});
