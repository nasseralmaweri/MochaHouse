import 'dotenv/config';
import {
  tenantContextFor,
  removePaymentRecoveryRecordsForTest,
} from '@mocha-house/testing';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { LocationsModule } from '../../locations/locations.module';
import { CustomersModule } from '../../customers/customers.module';
import { LoyaltyModule } from '../../loyalty/loyalty.module';
import { PromotionsModule } from '../../promotions/promotions.module';
import { GiftCardsModule } from '../../gift-cards/gift-cards.module';
import { CustomerAuthModule } from '../../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../../internal-auth/internal-auth.module';
import { CheckoutService } from './checkout.service';
import { AdminOrdersService } from './admin-orders.service';
import { PaymentModule } from '../../payment/payment.module';
import { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import {
  submitCheckout,
  type LabelledCheckoutRequest,
} from '../../../test/checkout-session';

// This suite exercises AdminOrdersService's own logic (store-queue
// visibility, location cross-checks, status advancement, concurrency). The
// permission/scope gate is covered separately (permission.guard.spec.ts,
// internal-authorization.spec.ts); here every call is made with a corporate
// context so the service runs its non-authorization behaviour unchanged.
// The dedicated cross-location authorization denial is asserted below.
const corporate = AuthorizationContext.of({
  'orders.view': [{ scopeType: 'CORPORATE', scopeId: null }],
  'orders.manage_status': [{ scopeType: 'CORPORATE', scopeId: null }],
});

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
  // Milestone S0D-2C-1 — advance() takes the request's explicit TenantContext.
  const t1 = tenantContextFor(TENANT_1_MOCHA_HOUSE_ID);
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
      providers: [CheckoutService, AdminOrdersService],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    checkoutService = moduleRef.get(CheckoutService);
    adminOrdersService = moduleRef.get(AdminOrdersService);
    await prisma.$connect();

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
    smallOptionId = sizeGroup.options.find((o) => o.name === 'Small')!.id;

    // A second, real location so "wrong location can't see it" tests
    // against genuine data rather than a made-up id. Removed in afterAll.
    const otherLocation = await prisma.location.upsert({
      where: {
        tenantId_slug: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          slug: 'admin-orders-spec-other-location',
        },
      },
      update: {},
      create: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
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
      // ESP-03 PR 4 — a payment's saved checkout and reconciliation records
      // (append-only) go first, through the disposable-only test helper.
      await removePaymentRecoveryRecordsForTest(
        (
          await prisma.paymentAttempt.findMany({
            where: { id: { in: paymentAttemptIds } },
            select: { id: true },
          })
        ).map((a) => a.id),
      );
      await prisma.paymentAttempt.deleteMany({
        where: { id: { in: paymentAttemptIds } },
      });
    }

    await prisma.location.delete({ where: { id: otherLocationId } });

    await moduleRef.close();
    await prisma.$disconnect();
  });

  function buildCheckoutRequest(
    overrides: Partial<LabelledCheckoutRequest> = {},
  ): LabelledCheckoutRequest {
    return {
      clientRef: `admin_orders_spec_${randomUUID()}`,
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

  async function createOrder() {
    const confirmation = await submitCheckout(
      checkoutService,
      buildCheckoutRequest(),
      undefined,
      tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
    );
    createdOrderIds.push(confirmation.orderId);
    return confirmation;
  }

  it('appears in the store queue immediately, without any processed outbox event', async () => {
    const confirmation = await submitCheckout(
      checkoutService,
      buildCheckoutRequest(),
      undefined,
      tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
    );
    createdOrderIds.push(confirmation.orderId);

    // The worker is not running in this suite and nothing has processed the
    // checkout's outbox event: it is still PENDING.
    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateType: 'Order', aggregateId: confirmation.orderId },
    });
    expect(event.status).toBe('PENDING');

    const list = await adminOrdersService.listActive(locationId, corporate, t1);
    expect(list.some((o) => o.orderId === confirmation.orderId)).toBe(true);
  });

  it('does not expose guest access token or email in the store list/detail', async () => {
    const confirmation = await createOrder();

    const list = await adminOrdersService.listActive(locationId, corporate, t1);
    const summary = list.find((o) => o.orderId === confirmation.orderId)!;
    expect(summary).not.toHaveProperty('accessToken');
    expect(summary).not.toHaveProperty('guestEmail');

    const detail = await adminOrdersService.getDetail(
      confirmation.orderId,
      locationId,
      corporate,
      t1,
    );
    expect(detail).not.toHaveProperty('accessToken');
    expect(detail.guestPhone).toBe('5556660000');
  });

  it('is not visible from a different location', async () => {
    const confirmation = await createOrder();

    const otherLocationOrders = await adminOrdersService.listActive(
      otherLocationId,
      corporate,
      t1,
    );
    expect(
      otherLocationOrders.some((o) => o.orderId === confirmation.orderId),
    ).toBe(false);

    await expect(
      adminOrdersService.getDetail(
        confirmation.orderId,
        otherLocationId,
        corporate,
        t1,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('denies a LOCATION-scoped caller acting on a location they are not assigned to (403, before any data)', async () => {
    const confirmation = await createOrder();
    // Scoped to `otherLocationId` only — must not touch `locationId`.
    const scopedElsewhere = AuthorizationContext.of({
      'orders.view': [{ scopeType: 'LOCATION', scopeId: otherLocationId }],
      'orders.manage_status': [
        { scopeType: 'LOCATION', scopeId: otherLocationId },
      ],
    });

    await expect(
      adminOrdersService.listActive(locationId, scopedElsewhere, t1),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      adminOrdersService.getDetail(
        confirmation.orderId,
        locationId,
        scopedElsewhere,
        t1,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      adminOrdersService.advance(
        confirmation.orderId,
        locationId,
        'RECEIVED',
        scopedElsewhere,
        t1,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a LOCATION-scoped caller CAN act on their own assigned location', async () => {
    const confirmation = await createOrder();
    const scopedHere = AuthorizationContext.of({
      'orders.view': [{ scopeType: 'LOCATION', scopeId: locationId }],
      'orders.manage_status': [{ scopeType: 'LOCATION', scopeId: locationId }],
    });

    const list = await adminOrdersService.listActive(
      locationId,
      scopedHere,
      t1,
    );
    expect(list.some((o) => o.orderId === confirmation.orderId)).toBe(true);

    const advanced = await adminOrdersService.advance(
      confirmation.orderId,
      locationId,
      'RECEIVED',
      scopedHere,
      t1,
    );
    expect(advanced.advanced).toBe(true);
  });

  it('advances through the full lifecycle, one immutable history row per step, payment status untouched', async () => {
    const confirmation = await createOrder();

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
        corporate,
        t1,
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

  it('writes an order.status.ready OutboxEvent only on the transition into READY (Milestone 8H)', async () => {
    const confirmation = await createOrder();

    await adminOrdersService.advance(
      confirmation.orderId,
      locationId,
      'RECEIVED',
      corporate,
      t1,
    );
    expect(
      await prisma.outboxEvent.count({
        where: {
          aggregateType: 'Order',
          aggregateId: confirmation.orderId,
          eventType: 'order.status.ready',
        },
      }),
    ).toBe(0);

    await adminOrdersService.advance(
      confirmation.orderId,
      locationId,
      'ACCEPTED',
      corporate,
      t1,
    );
    expect(
      await prisma.outboxEvent.count({
        where: {
          aggregateType: 'Order',
          aggregateId: confirmation.orderId,
          eventType: 'order.status.ready',
        },
      }),
    ).toBe(0);

    await adminOrdersService.advance(
      confirmation.orderId,
      locationId,
      'PREPARING',
      corporate,
      t1,
    );
    const event = await prisma.outboxEvent.findFirst({
      where: {
        aggregateType: 'Order',
        aggregateId: confirmation.orderId,
        eventType: 'order.status.ready',
      },
    });
    expect(event).not.toBeNull();
    expect(event!.status).toBe('PENDING');
    expect(event!.payload).toMatchObject({
      orderId: confirmation.orderId,
      locationId,
      status: 'READY',
    });

    await adminOrdersService.advance(
      confirmation.orderId,
      locationId,
      'READY',
      corporate,
      t1,
    );
    // COMPLETED must not create a second READY event or any event of its own.
    expect(
      await prisma.outboxEvent.count({
        where: {
          aggregateType: 'Order',
          aggregateId: confirmation.orderId,
          eventType: 'order.status.ready',
        },
      }),
    ).toBe(1);
  });

  it('rejects advancing an order that is already completed', async () => {
    const confirmation = await createOrder();
    for (const expected of ['RECEIVED', 'ACCEPTED', 'PREPARING', 'READY']) {
      await adminOrdersService.advance(
        confirmation.orderId,
        locationId,
        expected,
        corporate,
        t1,
      );
    }

    await expect(
      adminOrdersService.advance(
        confirmation.orderId,
        locationId,
        'COMPLETED',
        corporate,
        t1,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // R1 / S5a: nothing writes REJECTED / CANCELLED yet, so an order is moved
  // there directly (as the S5b writer will) to prove the existing paths treat
  // it as terminal: no advance, no queue, and the customer can still read it.
  it.each(['REJECTED', 'CANCELLED'] as const)(
    'never advances a %s order, hides it from the queue, and still reports it to the customer',
    async (closed) => {
      const confirmation = await createOrder();
      // Nothing writes a closed status yet (S5b), and a real closure is
      // append-only (it would pin this fixture order forever). So the status
      // is set with the database's own closure/freeze triggers bypassed for
      // this one transaction, exactly the state the S5b writer will produce.
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL session_replication_role = replica`,
        );
        await tx.order.update({
          where: { id: confirmation.orderId },
          data: { status: closed },
        });
      });
      const historyBefore = await prisma.orderStatusHistory.count({
        where: { orderId: confirmation.orderId },
      });

      // The caller names the closed status it saw: still no step to take.
      await expect(
        adminOrdersService.advance(
          confirmation.orderId,
          locationId,
          closed,
          corporate,
          t1,
        ),
      ).rejects.toThrow(new RegExp(`already ${closed.toLowerCase()}`));
      // A stale caller naming any pipeline status is a plain conflict.
      for (const stale of ['RECEIVED', 'ACCEPTED', 'PREPARING', 'READY']) {
        await expect(
          adminOrdersService.advance(
            confirmation.orderId,
            locationId,
            stale,
            corporate,
            t1,
          ),
        ).rejects.toBeInstanceOf(ConflictException);
      }

      const after = await prisma.order.findUniqueOrThrow({
        where: { id: confirmation.orderId },
      });
      expect(after.status).toBe(closed);
      expect(
        await prisma.orderStatusHistory.count({
          where: { orderId: confirmation.orderId },
        }),
      ).toBe(historyBefore);

      const activeOrders = await adminOrdersService.listActive(
        locationId,
        corporate,
        t1,
      );
      expect(activeOrders.some((o) => o.orderId === confirmation.orderId)).toBe(
        false,
      );

      const status = await checkoutService.getStatus(
        confirmation.orderId,
        confirmation.accessToken,
        tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
      );
      expect(status.status).toBe(closed);
      expect(status.paymentStatus).toBe('SUCCEEDED');
    },
  );

  it('a client can never name REJECTED or CANCELLED as a target: advance only ever steps the pipeline', async () => {
    const confirmation = await createOrder();
    const result = await adminOrdersService.advance(
      confirmation.orderId,
      locationId,
      'RECEIVED',
      corporate,
      t1,
    );
    expect(result.status).toBe('ACCEPTED');
  });

  it('a retried advance call with the same expectedStatus does not duplicate history', async () => {
    const confirmation = await createOrder();

    const first = await adminOrdersService.advance(
      confirmation.orderId,
      locationId,
      'RECEIVED',
      corporate,
      t1,
    );
    expect(first.advanced).toBe(true);

    // Simulates a lost-response-style retry: caller still believes the
    // order was RECEIVED and resends the same request.
    const retry = await adminOrdersService.advance(
      confirmation.orderId,
      locationId,
      'RECEIVED',
      corporate,
      t1,
    );
    expect(retry.advanced).toBe(false);
    expect(retry.status).toBe('ACCEPTED');

    const history = await prisma.orderStatusHistory.findMany({
      where: { orderId: confirmation.orderId },
    });
    expect(history).toHaveLength(2); // RECEIVED (initial) + ACCEPTED — not 3.
  });

  it('rejects a genuinely stale expectedStatus as a conflict, not a silent no-op', async () => {
    const confirmation = await createOrder();
    await adminOrdersService.advance(
      confirmation.orderId,
      locationId,
      'RECEIVED',
      corporate,
      t1,
    );
    await adminOrdersService.advance(
      confirmation.orderId,
      locationId,
      'ACCEPTED',
      corporate,
      t1,
    );
    // Order is now PREPARING. A caller still expecting RECEIVED (two steps
    // behind) is a real conflict, not a retry of the immediately-prior step.
    await expect(
      adminOrdersService.advance(
        confirmation.orderId,
        locationId,
        'RECEIVED',
        corporate,
        t1,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('concurrent advance calls for the same order never produce two history rows', async () => {
    const confirmation = await createOrder();

    const results = await Promise.allSettled([
      adminOrdersService.advance(
        confirmation.orderId,
        locationId,
        'RECEIVED',
        corporate,
        t1,
      ),
      adminOrdersService.advance(
        confirmation.orderId,
        locationId,
        'RECEIVED',
        corporate,
        t1,
      ),
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
    const confirmation = await createOrder();
    for (const expected of ['RECEIVED', 'ACCEPTED', 'PREPARING', 'READY']) {
      await adminOrdersService.advance(
        confirmation.orderId,
        locationId,
        expected,
        corporate,
        t1,
      );
    }

    const activeOrders = await adminOrdersService.listActive(
      locationId,
      corporate,
      t1,
    );
    expect(activeOrders.some((o) => o.orderId === confirmation.orderId)).toBe(
      false,
    );
  });

  it('customer-facing status reflects store-side transitions', async () => {
    const confirmation = await createOrder();

    let status = await checkoutService.getStatus(
      confirmation.orderId,
      confirmation.accessToken,
      tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
    );
    expect(status.status).toBe('RECEIVED');

    await adminOrdersService.advance(
      confirmation.orderId,
      locationId,
      'RECEIVED',
      corporate,
      t1,
    );

    status = await checkoutService.getStatus(
      confirmation.orderId,
      confirmation.accessToken,
      tenantContextFor(TENANT_1_MOCHA_HOUSE_ID),
    );
    expect(status.status).toBe('ACCEPTED');
    // Payment status is reported separately and is unaffected.
    expect(status.paymentStatus).toBe('SUCCEEDED');
  });
});
