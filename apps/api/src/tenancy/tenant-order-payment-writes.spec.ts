import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  INestApplication,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { CheckoutRequest } from '@mocha-house/contracts';
import { FakePaymentProvider } from '@mocha-house/integrations';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  createTestTenantB,
  removeTestTenantB,
  tenantContextFor,
} from '@mocha-house/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { RedisModule } from '../redis/redis.module';
import { OrdersModule } from '../orders/orders.module';
import { CheckoutService } from '../orders/application/checkout.service';
import { AdminOrdersService } from '../orders/application/admin-orders.service';
import { GiftCardPurchaseService } from '../gift-cards/application/gift-card-purchase.service';
import { GIFT_CARD_CONFIGURATION_KEY } from '../gift-cards/application/gift-card-configuration.service';
import { PAYMENT_PROVIDER } from '../payment/payment-provider.token';
import { AuthorizationContext } from '../internal-auth/authorization/authorization-context';

// Milestone S0D-2C-1 — the order & payment core takes its tenant ONLY from
// server-side sources: a checkout's Location must belong to the request's
// TenantContext (checked before any PaymentAttempt exists or any charge),
// the PaymentAttempt copies that tenant, and the Order, its lines, its
// status history and its outbox event copy the attempt's. A gift-card
// purchase attempt takes the explicit TenantContext. Idempotency keys are
// still globally unique (S0D-3), so a key naming another tenant's attempt
// is refused before anything about that attempt is revealed or acted on.
describe('S0D-2C-1 order & payment tenant ownership (integration)', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let checkout: CheckoutService;
  let adminOrders: AdminOrdersService;
  let purchases: GiftCardPurchaseService;
  let paymentProvider: FakePaymentProvider;
  const originalEnv = { ...process.env };
  const suffix = randomUUID().slice(0, 8);

  const tenantOne = tenantContextFor(TENANT_1_MOCHA_HOUSE_ID);
  const tenantB = tenantContextFor(TEST_TENANT_B_ID);
  const corporate = [{ scopeType: 'CORPORATE' as const, scopeId: null }];
  const manageStatus = AuthorizationContext.of({
    'orders.manage_status': corporate,
  });

  const KEY_PREFIX = `s0d2c1-${suffix}-`;
  const newKey = () => `${KEY_PREFIX}${randomUUID()}`;
  // Gift-card purchase keys must be plain UUIDs, so they are tracked.
  const giftCardKeys: string[] = [];
  const newGiftCardKey = () => {
    const k = randomUUID();
    giftCardKeys.push(k);
    return k;
  };

  interface CatalogFixture {
    tenantId: string;
    locationId: string;
    menuId: string;
    productId: string;
    categoryId: string;
  }
  let t1: CatalogFixture;
  let tb: CatalogFixture;

  async function makeCatalog(
    tenantId: string,
    label: string,
  ): Promise<CatalogFixture> {
    const location = await prisma.location.create({
      data: {
        tenantId,
        name: `S0D2C1 ${label} ${suffix}`,
        slug: `s0d2c1-${label}-${suffix}`,
      },
    });
    const category = await prisma.category.create({
      data: {
        tenantId,
        name: `S0D2C1 ${label}`,
        slug: `s0d2c1-cat-${label}-${suffix}`,
      },
    });
    const product = await prisma.product.create({
      data: {
        tenantId,
        name: `S0D2C1 ${label} product`,
        slug: `s0d2c1-prod-${label}-${suffix}`,
        basePrice: 400,
        categoryId: category.id,
      },
    });
    const menu = await prisma.menu.create({
      data: {
        tenantId,
        name: `S0D2C1 ${label} menu`,
        slug: `s0d2c1-menu-${label}-${suffix}`,
      },
    });
    await prisma.menuProduct.create({
      data: { tenantId, menuId: menu.id, productId: product.id },
    });
    await prisma.locationMenu.create({
      data: { tenantId, locationId: location.id, menuId: menu.id },
    });
    return {
      tenantId,
      locationId: location.id,
      menuId: menu.id,
      productId: product.id,
      categoryId: category.id,
    };
  }

  async function removeCatalog(f: CatalogFixture) {
    await prisma.locationMenu.deleteMany({
      where: { locationId: f.locationId },
    });
    await prisma.menuProduct.deleteMany({ where: { menuId: f.menuId } });
    await prisma.product.deleteMany({ where: { id: f.productId } });
    await prisma.category.deleteMany({ where: { id: f.categoryId } });
    await prisma.menu.deleteMany({ where: { id: f.menuId } });
    await prisma.location.deleteMany({ where: { id: f.locationId } });
  }

  const checkoutRequest = (
    f: CatalogFixture,
    overrides: Partial<CheckoutRequest> = {},
  ): CheckoutRequest => ({
    idempotencyKey: newKey(),
    locationId: f.locationId,
    guest: { name: 'S0D2C1 Guest', phone: '5551230000' },
    lines: [{ productId: f.productId, quantity: 2, selections: [] }],
    ...overrides,
  });

  const attemptByKey = (idempotencyKey: string) =>
    prisma.paymentAttempt.findUnique({
      where: { idempotencyKey },
      include: {
        order: { include: { lines: true, statusHistory: true } },
        giftCardPurchase: true,
      },
    });

  const orderEvents = (orderId: string) =>
    prisma.outboxEvent.findMany({
      where: { aggregateType: 'Order', aggregateId: orderId },
      orderBy: { createdAt: 'asc' },
    });

  const expectNoDisclosure = (
    body: unknown,
    secrets: (string | null | undefined)[],
  ) => {
    const text = JSON.stringify(body);
    for (const secret of secrets) {
      if (secret) {
        expect(text).not.toContain(secret);
      }
    }
    expect(text).not.toContain(TEST_TENANT_B_ID);
  };

  // A Tenant B checkout, under an explicit Tenant B context.
  async function tenantBOrder(overrides: Partial<CheckoutRequest> = {}) {
    const req = checkoutRequest(tb, overrides);
    const confirmation = await checkout.checkout(req, undefined, tenantB);
    return { req, confirmation };
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.GIFT_CARD_CODE_SECRET = 's0d2c1-gift-card-code-secret';
    process.env.GIFT_CARD_PURCHASE_CODE_KEK =
      'c4097ecec7942a636761a7c4acc30277edaa900a9ee56f4974c8993a344e963e';
    process.env.GIFT_CARD_PURCHASE_RECOVERY_SECRET =
      's0d2c1-gift-card-recovery-secret';

    moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule,
        CustomerAuthModule,
        InternalAuthModule,
        RedisModule,
        OrdersModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    checkout = moduleRef.get(CheckoutService);
    adminOrders = moduleRef.get(AdminOrdersService);
    purchases = moduleRef.get(GiftCardPurchaseService);
    paymentProvider = moduleRef.get(PAYMENT_PROVIDER);

    await createTestTenantB(prisma);
    t1 = await makeCatalog(TENANT_1_MOCHA_HOUSE_ID, 't1');
    tb = await makeCatalog(TEST_TENANT_B_ID, 'b');

    await prisma.giftCardConfiguration.upsert({
      where: {
        tenantId_key: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          key: GIFT_CARD_CONFIGURATION_KEY,
        },
      },
      create: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        key: GIFT_CARD_CONFIGURATION_KEY,
        presetAmountsMinorUnits: [1000, 2500, 5000, 10000],
        customAmountEnabled: true,
      },
      update: {},
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    const attempts = await prisma.paymentAttempt.findMany({
      where: {
        OR: [
          { idempotencyKey: { startsWith: KEY_PREFIX } },
          { idempotencyKey: { in: giftCardKeys } },
        ],
      },
      select: { id: true },
    });
    const attemptIds = attempts.map((a) => a.id);
    const orders = await prisma.order.findMany({
      where: {
        OR: [
          { paymentAttemptId: { in: attemptIds } },
          { locationId: { in: [t1.locationId, tb.locationId] } },
        ],
      },
      select: { id: true },
    });
    const orderIds = orders.map((o) => o.id);
    await prisma.orderPromotionRedemption.deleteMany({
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
    await prisma.giftCardPurchase.deleteMany({
      where: { paymentAttemptId: { in: attemptIds } },
    });
    await prisma.paymentAttempt.deleteMany({
      where: { id: { in: attemptIds } },
    });
    await removeCatalog(t1);
    await removeCatalog(tb);
    await removeTestTenantB(prisma);
    await app.close();
    process.env = { ...originalEnv };
  });

  describe('checkout', () => {
    it('persists Tenant #1 on the attempt, order, lines, history and order outbox event, whatever tenant the client claims', async () => {
      const body = {
        ...checkoutRequest(t1),
        tenantId: TEST_TENANT_B_ID,
      };

      const response = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .query({ tenantId: TEST_TENANT_B_ID })
        .set('x-tenant-id', TEST_TENANT_B_ID)
        .send(body)
        .expect(201);

      const attempt = await attemptByKey(body.idempotencyKey);
      expect(attempt?.tenantId).toBe(TENANT_1_MOCHA_HOUSE_ID);
      const order = attempt!.order!;
      expect(order.tenantId).toBe(TENANT_1_MOCHA_HOUSE_ID);
      expect(order.lines.length).toBeGreaterThan(0);
      expect(order.lines.every((l) => l.tenantId === order.tenantId)).toBe(
        true,
      );
      expect(order.statusHistory).toHaveLength(1);
      expect(order.statusHistory[0].tenantId).toBe(TENANT_1_MOCHA_HOUSE_ID);

      const events = await orderEvents(order.id);
      expect(events.map((e) => e.eventType)).toEqual([
        'order.checkout.completed',
      ]);
      expect(events[0].tenantId).toBe(TENANT_1_MOCHA_HOUSE_ID);

      // Ownership is not exposed through the checkout contract.
      expect(JSON.stringify(response.body)).not.toContain('tenantId');
    });

    it('a Tenant B Location fails closed with the same 404 as a missing one — before any attempt exists or any charge', async () => {
      const charge = jest.spyOn(paymentProvider, 'charge');

      const foreign = checkoutRequest(tb);
      const foreignRes = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .send(foreign)
        .expect(404);
      const missing = checkoutRequest(t1, { locationId: randomUUID() });
      const missingRes = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .send(missing)
        .expect(404);

      expect(foreignRes.body).toEqual(missingRes.body);
      expectNoDisclosure(foreignRes.body, [tb.locationId]);
      expect(await attemptByKey(foreign.idempotencyKey)).toBeNull();
      expect(charge).not.toHaveBeenCalled();
      expect(
        await prisma.order.count({ where: { locationId: tb.locationId } }),
      ).toBe(0);
    });

    it('Tenant B structural equivalent: a Tenant B context + Tenant B Location persists Tenant B throughout', async () => {
      const { req, confirmation } = await tenantBOrder();

      const attempt = await attemptByKey(req.idempotencyKey);
      expect(attempt?.tenantId).toBe(TEST_TENANT_B_ID);
      const order = attempt!.order!;
      expect(order.id).toBe(confirmation.orderId);
      expect(order.tenantId).toBe(TEST_TENANT_B_ID);
      expect(order.lines.every((l) => l.tenantId === TEST_TENANT_B_ID)).toBe(
        true,
      );
      expect(order.statusHistory[0].tenantId).toBe(TEST_TENANT_B_ID);
      const events = await orderEvents(order.id);
      expect(events[0].tenantId).toBe(TEST_TENANT_B_ID);
    });

    it('a Tenant B context cannot check out at a Tenant #1 Location', async () => {
      const req = checkoutRequest(t1);
      await expect(checkout.checkout(req, undefined, tenantB)).rejects.toThrow(
        new NotFoundException('Location or menu not found.'),
      );
      expect(await attemptByKey(req.idempotencyKey)).toBeNull();
    });

    it('same-tenant replay is unchanged: the same key returns the same order without a second charge', async () => {
      const req = checkoutRequest(t1);
      const first = await checkout.checkout(req, undefined, tenantOne);
      const charge = jest.spyOn(paymentProvider, 'charge');
      const again = await checkout.checkout(req, undefined, tenantOne);
      expect(again.orderId).toBe(first.orderId);
      expect(again.accessToken).toBe(first.accessToken);
      expect(charge).not.toHaveBeenCalled();
    });

    it("refuses to replay another tenant's SUCCEEDED attempt, revealing nothing (no accessToken, guest, order or lines) and charging nothing", async () => {
      const { req, confirmation } = await tenantBOrder({
        guest: { name: 'Secret B Guest', phone: '5559990000' },
      });
      const charge = jest.spyOn(paymentProvider, 'charge');

      const res = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('x-tenant-id', TEST_TENANT_B_ID)
        .send(checkoutRequest(t1, { idempotencyKey: req.idempotencyKey }))
        .expect(409);

      expectNoDisclosure(res.body, [
        confirmation.accessToken,
        confirmation.orderId,
        confirmation.orderNumber,
        'Secret B Guest',
        tb.productId,
      ]);
      expect(charge).not.toHaveBeenCalled();
      expect(
        await prisma.paymentAttempt.count({
          where: { idempotencyKey: req.idempotencyKey },
        }),
      ).toBe(1);
      expect(
        await prisma.order.count({
          where: {
            locationId: t1.locationId,
            paymentAttempt: { idempotencyKey: req.idempotencyKey },
          },
        }),
      ).toBe(0);
    });

    it("refuses another tenant's DECLINED / PENDING / reconciliation attempts with the SAME generic conflict (no failureReason, no status)", async () => {
      const make = (data: Record<string, unknown>) =>
        prisma.paymentAttempt.create({
          data: {
            tenantId: TEST_TENANT_B_ID,
            idempotencyKey: newKey(),
            provider: 'fake',
            locationId: tb.locationId,
            amount: 800,
            currency: 'USD',
            ...data,
          },
        });
      const declined = await make({
        status: 'DECLINED',
        failureReason: 'b-secret-decline-reason',
      });
      const pending = await make({ status: 'PENDING' });
      const reconcile = await make({
        status: 'SUCCEEDED',
        reconciliationRequired: true,
        reconciliationReason: 'b-secret-reconciliation',
      });

      const bodies: unknown[] = [];
      for (const attempt of [declined, pending, reconcile]) {
        const res = await request(app.getHttpServer())
          .post('/api/v1/orders')
          .send(checkoutRequest(t1, { idempotencyKey: attempt.idempotencyKey }))
          .expect(409);
        expectNoDisclosure(res.body, [
          'b-secret-decline-reason',
          'b-secret-reconciliation',
          attempt.id,
        ]);
        bodies.push(res.body);
      }
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[2]).toEqual(bodies[0]);
    });

    it('refuses the winner of a unique-key race when it belongs to another tenant (race-recovery path), charging nothing', async () => {
      const { req, confirmation } = await tenantBOrder();
      const charge = jest.spyOn(paymentProvider, 'charge');
      // The up-front lookup misses (as if it ran just before Tenant B's
      // attempt committed), so the create collides on the real unique key
      // and checkout takes the P2002 race-recovery path.
      jest
        .spyOn(prisma.paymentAttempt, 'findUnique')
        .mockResolvedValueOnce(null);

      await expect(
        checkout.checkout(
          checkoutRequest(t1, { idempotencyKey: req.idempotencyKey }),
          undefined,
          tenantOne,
        ),
      ).rejects.toThrow(
        new ConflictException(
          'This idempotency key cannot be used. Start a new checkout.',
        ),
      );
      expect(charge).not.toHaveBeenCalled();
      const attempt = await attemptByKey(req.idempotencyKey);
      expect(attempt?.tenantId).toBe(TEST_TENANT_B_ID);
      expect(attempt?.order?.id).toBe(confirmation.orderId);
    });
  });

  describe('gift-card purchase attempts', () => {
    const intent = (idempotencyKey: string) => ({
      idempotencyKey,
      amountMinorUnits: 2500,
      purchaserEmail: 's0d2c1-buyer@example.com',
      purchaserName: 'S0D2C1 Buyer',
    });

    it('an intent attempt persists the explicit TenantContext, and the GiftCardPurchase copies it from the PaymentAttempt', async () => {
      const k1 = newGiftCardKey();
      await purchases.createIntent(intent(k1), undefined, tenantOne);
      const attempt1 = await attemptByKey(k1);
      expect(attempt1?.tenantId).toBe(TENANT_1_MOCHA_HOUSE_ID);
      // Milestone S0D-2C-1B — the one authoritative chain: GiftCardPurchase
      // always equals its own PaymentAttempt's tenant, not just "Tenant #1".
      expect(attempt1?.giftCardPurchase?.tenantId).toBe(attempt1?.tenantId);

      const kb = newGiftCardKey();
      await purchases.createIntent(intent(kb), undefined, tenantB);
      const attemptB = await attemptByKey(kb);
      expect(attemptB?.tenantId).toBe(TEST_TENANT_B_ID);
      expect(attemptB?.giftCardPurchase?.tenantId).toBe(attemptB?.tenantId);
    });

    it('a client-supplied tenantId on the intent is ignored — the GiftCardPurchase still inherits the validated PaymentAttempt', async () => {
      // CreateGiftCardPurchaseIntentRequest has no tenantId field at all —
      // this proves a client-supplied one is simply ignored (TypeScript
      // can't even express smuggling it through the real contract type).
      const k1 = newGiftCardKey();
      await purchases.createIntent(
        { ...intent(k1), tenantId: TEST_TENANT_B_ID } as never,
        undefined,
        tenantOne,
      );
      const attempt = await attemptByKey(k1);
      expect(attempt?.tenantId).toBe(TENANT_1_MOCHA_HOUSE_ID);
      expect(attempt?.giftCardPurchase?.tenantId).toBe(
        TENANT_1_MOCHA_HOUSE_ID,
      );
    });

    it("refuses to replay another tenant's intent (normal and race paths), revealing and creating nothing", async () => {
      const kb = newGiftCardKey();
      const bIntent = await purchases.createIntent(
        intent(kb),
        undefined,
        tenantB,
      );
      const refusal = new ConflictException(
        'This idempotency key cannot be used. Start a new purchase.',
      );

      await expect(
        purchases.createIntent(intent(kb), undefined, tenantOne),
      ).rejects.toThrow(refusal);

      jest
        .spyOn(prisma.paymentAttempt, 'findUnique')
        .mockResolvedValueOnce(null);
      await expect(
        purchases.createIntent(intent(kb), undefined, tenantOne),
      ).rejects.toThrow(refusal);

      const attempt = await attemptByKey(kb);
      expect(attempt?.tenantId).toBe(TEST_TENANT_B_ID);
      expect(attempt?.giftCardPurchase?.id).toBe(bIntent.purchaseId);
      expect(
        await prisma.giftCardPurchase.count({
          where: { paymentAttemptId: attempt!.id },
        }),
      ).toBe(1);
    });

    it("step 2 refuses another tenant's attempt exactly like a missing one — before any charge or issuance, even with its valid credential", async () => {
      const kb = newGiftCardKey();
      const bIntent = await purchases.createIntent(
        intent(kb),
        undefined,
        tenantB,
      );
      const charge = jest.spyOn(paymentProvider, 'charge');

      const foreign = await request(app.getHttpServer())
        .post('/api/v1/gift-cards/purchase')
        .set('x-tenant-id', TEST_TENANT_B_ID)
        .send({
          idempotencyKey: kb,
          recoveryCredential: bIntent.recoveryCredential,
          tenantId: TEST_TENANT_B_ID,
        })
        .expect(409);
      const missing = await request(app.getHttpServer())
        .post('/api/v1/gift-cards/purchase')
        .send({ idempotencyKey: newGiftCardKey(), recoveryCredential: 'x' })
        .expect(409);

      expect(foreign.body).toEqual(missing.body);
      expectNoDisclosure(foreign.body, [bIntent.purchaseId]);
      expect(charge).not.toHaveBeenCalled();
      const attempt = await attemptByKey(kb);
      expect(attempt?.status).toBe('PENDING');
      expect(attempt?.giftCardPurchase?.status).toBe('PENDING');
      expect(attempt?.giftCardPurchase?.chargeClaimedAt).toBeNull();
      expect(attempt?.giftCardPurchase?.giftCardId).toBeNull();
    });
  });

  describe('admin order advancement', () => {
    it('history rows and the READY outbox event inherit the order tenant', async () => {
      const confirmation = await checkout.checkout(
        checkoutRequest(t1),
        undefined,
        tenantOne,
      );
      for (const expected of ['RECEIVED', 'ACCEPTED', 'PREPARING']) {
        await adminOrders.advance(
          confirmation.orderId,
          t1.locationId,
          expected,
          manageStatus,
          tenantOne,
        );
      }

      const history = await prisma.orderStatusHistory.findMany({
        where: { orderId: confirmation.orderId },
      });
      expect(history.map((h) => h.status).sort()).toEqual(
        ['ACCEPTED', 'PREPARING', 'READY', 'RECEIVED'].sort(),
      );
      expect(history.every((h) => h.tenantId === TENANT_1_MOCHA_HOUSE_ID)).toBe(
        true,
      );
      const events = await orderEvents(confirmation.orderId);
      expect(events.map((e) => [e.eventType, e.tenantId])).toEqual([
        ['order.checkout.completed', TENANT_1_MOCHA_HOUSE_ID],
        ['order.status.ready', TENANT_1_MOCHA_HOUSE_ID],
      ]);
    });

    it('Tenant #1 cannot advance a Tenant B order: same 404 as a missing order, no status change, no history, no event — and no status hint on a stale retry', async () => {
      const { confirmation } = await tenantBOrder();
      const expected = new NotFoundException(
        'Order not found for this location.',
      );

      await expect(
        adminOrders.advance(
          confirmation.orderId,
          tb.locationId,
          'RECEIVED',
          manageStatus,
          tenantOne,
        ),
      ).rejects.toThrow(expected);
      await expect(
        adminOrders.advance(
          randomUUID(),
          tb.locationId,
          'RECEIVED',
          manageStatus,
          tenantOne,
        ),
      ).rejects.toThrow(expected);
      // A "stale" expectedStatus would otherwise reach the idempotent
      // no-op / conflict branches, which describe the order's status.
      await expect(
        adminOrders.advance(
          confirmation.orderId,
          tb.locationId,
          'PREPARING',
          manageStatus,
          tenantOne,
        ),
      ).rejects.toThrow(expected);

      const order = await prisma.order.findUniqueOrThrow({
        where: { id: confirmation.orderId },
        include: { statusHistory: true },
      });
      expect(order.status).toBe('RECEIVED');
      expect(order.statusHistory).toHaveLength(1);
      expect(await orderEvents(order.id)).toHaveLength(1);

      // The owning tenant can still advance it.
      const ok = await adminOrders.advance(
        confirmation.orderId,
        tb.locationId,
        'RECEIVED',
        manageStatus,
        tenantB,
      );
      expect(ok.advanced).toBe(true);
      const bHistory = await prisma.orderStatusHistory.findMany({
        where: { orderId: confirmation.orderId },
      });
      expect(bHistory.every((h) => h.tenantId === TEST_TENANT_B_ID)).toBe(true);
    });
  });
});
