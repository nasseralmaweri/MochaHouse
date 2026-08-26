import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  HttpException,
} from '@nestjs/common';
import { FakePaymentProvider } from '@mocha-house/integrations';
import type { CheckoutRequest } from '@mocha-house/contracts';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { LocationsModule } from '../../locations/locations.module';
import { CheckoutService } from './checkout.service';
import { PAYMENT_PROVIDER } from '../infrastructure/payment-provider.token';

// Integration test against the real local Postgres instance (see
// infrastructure/local/compose.yml + apps/api/.env), exercising the full
// checkout orchestration exactly as CheckoutController would call it, but
// without going over HTTP. Requires `pnpm exec tsx prisma/seed.ts` to have
// been run — it uses the seeded "dearborn-heights" / "drip-coffee" fixture.
describe('CheckoutService (integration)', () => {
  let prisma: PrismaService;
  let checkoutService: CheckoutService;
  let paymentProvider: FakePaymentProvider;
  let locationId: string;
  let productId: string;
  let sizeGroupId: string;
  let mediumOptionId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, LocationsModule],
      providers: [
        CheckoutService,
        { provide: PAYMENT_PROVIDER, useClass: FakePaymentProvider },
      ],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    checkoutService = moduleRef.get(CheckoutService);
    paymentProvider = moduleRef.get(PAYMENT_PROVIDER);
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
    await prisma.$disconnect();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function buildRequest(
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

  it('creates a durable order, history row, and outbox event on a successful payment', async () => {
    const request = buildRequest();

    const confirmation = await checkoutService.checkout(request);

    expect(confirmation.status).toBe('RECEIVED');
    expect(confirmation.subtotal).toBe(400); // 350 base + 50 medium adjustment
    expect(confirmation.orderNumber).toMatch(/^[A-Z0-9]{6}$/);
    expect(confirmation.accessToken).toHaveLength(32);

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: confirmation.orderId },
      include: { statusHistory: true, paymentAttempt: true, lines: true },
    });
    expect(order.paymentAttempt.status).toBe('SUCCEEDED');
    expect(order.paymentAttempt.idempotencyKey).toBe(request.idempotencyKey);
    expect(order.statusHistory).toHaveLength(1);
    expect(order.statusHistory[0].status).toBe('RECEIVED');
    expect(order.lines).toHaveLength(1);
    expect(order.lines[0].unitPrice).toBe(400);

    const outboxEvents = await prisma.outboxEvent.findMany({
      where: { aggregateType: 'Order', aggregateId: order.id },
    });
    expect(outboxEvents).toHaveLength(1);
    expect(outboxEvents[0].status).toBe('PENDING');
  });

  it('ignores a client-submitted price and always uses the authoritative server price', async () => {
    const request = buildRequest();
    // CheckoutLineInput has no price field at all, but prove the point at
    // the wire boundary too: even if a client smuggled one in past the
    // TS contract (e.g. a hand-crafted HTTP request), it's never read.
    (request.lines[0] as unknown as Record<string, unknown>).unitPrice = 1;

    const confirmation = await checkoutService.checkout(request);
    expect(confirmation.subtotal).toBe(400);
  });

  it('declines the fake payment and creates no order', async () => {
    const request = buildRequest({
      guest: {
        name: 'Decline Guest',
        phone: FakePaymentProvider.DECLINE_TEST_PHONE,
      },
    });

    await expect(checkoutService.checkout(request)).rejects.toBeInstanceOf(
      HttpException,
    );

    const attempt = await prisma.paymentAttempt.findUniqueOrThrow({
      where: { idempotencyKey: request.idempotencyKey },
    });
    expect(attempt.status).toBe('DECLINED');

    const order = await prisma.order.findUnique({
      where: { paymentAttemptId: attempt.id },
    });
    expect(order).toBeNull();
  });

  it('does not create a payment attempt or charge for an invalid cart', async () => {
    const request = buildRequest({
      lines: [{ productId: 'not-a-real-product', quantity: 1, selections: [] }],
    });

    await expect(checkoutService.checkout(request)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    const attempt = await prisma.paymentAttempt.findUnique({
      where: { idempotencyKey: request.idempotencyKey },
    });
    expect(attempt).toBeNull();
  });

  it('is idempotent: resubmitting the same idempotency key never charges or creates a second order', async () => {
    const request = buildRequest();

    const first = await checkoutService.checkout(request);
    const second = await checkoutService.checkout(request);

    expect(second.orderId).toBe(first.orderId);
    expect(second.accessToken).toBe(first.accessToken);

    const attempts = await prisma.paymentAttempt.count({
      where: { idempotencyKey: request.idempotencyKey },
    });
    expect(attempts).toBe(1);

    const orders = await prisma.order.count({
      where: { paymentAttempt: { idempotencyKey: request.idempotencyKey } },
    });
    expect(orders).toBe(1);
  });

  it('a retry with the same key after a simulated lost response returns the existing result without a second charge', async () => {
    // Mirrors the corrected frontend lifecycle: a network failure/timeout
    // means the client never saw the first response, so it retries with
    // the *same* idempotencyKey rather than minting a new one. The server
    // must recognize this as the same attempt, not a new checkout.
    const request = buildRequest();
    const chargeSpy = jest.spyOn(paymentProvider, 'charge');

    const first = await checkoutService.checkout(request);
    // The "lost response" retry — identical request, identical key.
    const retryAfterSimulatedLostResponse =
      await checkoutService.checkout(request);

    expect(retryAfterSimulatedLostResponse.orderId).toBe(first.orderId);
    expect(retryAfterSimulatedLostResponse.accessToken).toBe(first.accessToken);
    expect(chargeSpy).toHaveBeenCalledTimes(1);

    const attempts = await prisma.paymentAttempt.count({
      where: { idempotencyKey: request.idempotencyKey },
    });
    expect(attempts).toBe(1);

    const orders = await prisma.order.count({
      where: { paymentAttempt: { idempotencyKey: request.idempotencyKey } },
    });
    expect(orders).toBe(1);
  });

  it('replays the same declined result on a resubmitted key instead of charging again', async () => {
    const request = buildRequest({
      guest: {
        name: 'Decline Guest',
        phone: FakePaymentProvider.DECLINE_TEST_PHONE,
      },
    });

    await expect(checkoutService.checkout(request)).rejects.toBeInstanceOf(
      HttpException,
    );
    await expect(checkoutService.checkout(request)).rejects.toBeInstanceOf(
      HttpException,
    );

    const attempts = await prisma.paymentAttempt.count({
      where: { idempotencyKey: request.idempotencyKey },
    });
    expect(attempts).toBe(1);
  });

  it('rejects concurrent duplicate submissions under the same idempotency key without double-charging', async () => {
    const request = buildRequest();

    const results = await Promise.allSettled([
      checkoutService.checkout(request),
      checkoutService.checkout(request),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // One wins outright; the other either replays the same order or hits
    // the in-flight ConflictException — either way, never two orders.
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(ConflictException);
    }

    const orders = await prisma.order.count({
      where: { paymentAttempt: { idempotencyKey: request.idempotencyKey } },
    });
    expect(orders).toBe(1);
  });

  it('marks reconciliation-required when payment succeeds but the order transaction fails, and never charges again on retry', async () => {
    const request = buildRequest();
    const chargeSpy = jest.spyOn(paymentProvider, 'charge');
    // Deliberately force the protected post-payment transaction to fail —
    // simulates a DB error, a constraint violation, anything that aborts
    // the transaction after FakePaymentProvider has already succeeded.
    jest
      .spyOn(prisma, '$transaction')
      .mockRejectedValueOnce(new Error('Simulated Order transaction failure'));

    await expect(checkoutService.checkout(request)).rejects.toThrow(
      'Simulated Order transaction failure',
    );

    const attempt = await prisma.paymentAttempt.findUniqueOrThrow({
      where: { idempotencyKey: request.idempotencyKey },
    });
    // The payment truthfully succeeded — this must never be relabeled
    // DECLINED/FAILED just because the order couldn't be created.
    expect(attempt.status).toBe('SUCCEEDED');
    expect(attempt.reconciliationRequired).toBe(true);
    expect(attempt.reconciliationReason).toContain(
      'Simulated Order transaction failure',
    );
    expect(attempt.reconciliationDetectedAt).not.toBeNull();

    const order = await prisma.order.findUnique({
      where: { paymentAttemptId: attempt.id },
    });
    expect(order).toBeNull();

    expect(chargeSpy).toHaveBeenCalledTimes(1);

    // Retrying with the same key must recognize the reconciliation
    // condition — not charge again, not silently succeed, not replay a
    // stale "successful" order that was never actually created.
    await expect(checkoutService.checkout(request)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(chargeSpy).toHaveBeenCalledTimes(1);

    const stillNoOrder = await prisma.order.findUnique({
      where: { paymentAttemptId: attempt.id },
    });
    expect(stillNoOrder).toBeNull();
  });

  it('exposes order status only to the holder of the correct access token', async () => {
    const request = buildRequest();
    const confirmation = await checkoutService.checkout(request);

    const status = await checkoutService.getStatus(
      confirmation.orderId,
      confirmation.accessToken,
    );
    expect(status.orderNumber).toBe(confirmation.orderNumber);

    await expect(
      checkoutService.getStatus(confirmation.orderId, 'wrong-token'),
    ).rejects.toThrow('Order not found.');
  });
});
