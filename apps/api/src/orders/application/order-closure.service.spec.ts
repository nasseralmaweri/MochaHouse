import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@mocha-house/database';
import {
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  tenantContextFor,
  withScratchClient,
  type ScratchDatabase,
} from '@mocha-house/testing';
import { GIFT_CARD_MAX_VALUE_MINOR_UNITS } from '@mocha-house/contracts';
import type { PrismaService } from '../../prisma/prisma.service';
import { InternalAuditService } from '../../audit/internal-audit.service';
import { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import { AdminOrdersService } from './admin-orders.service';
import { CustomerOrdersService } from './customer-orders.service';
import {
  OrderClosureService,
  type CloseOrderInput,
} from './order-closure.service';
import { isOrderClosureEnabled } from './order-closure.config';

// R1 / S5b — the order closure writer against a REAL PostgreSQL schema (every
// migration, including S5a's closure foundation and S5b's guards), on a scratch
// database: closures, reversals and refund obligations are append-only
// financial history that cannot be removed from a shared test database.
// Orders are written exactly as checkout writes them (payment attempt, order,
// promotion / gift-card / loyalty redemption snapshots and ledger entries,
// counters), then rejected or cancelled through OrderClosureService.

jest.setTimeout(300_000);

const migrations = listMigrations(
  join(__dirname, '../../../../../packages/database/prisma/migrations'),
);

const A = '01a0db02-f800-7000-8000-5b0000000a01';
const B = '01a0db02-f800-7000-8000-5b0000000b02';

type Db = PrismaClient;

interface Base {
  locationA: string;
  locationA2: string;
  locationB: string;
  productA: string;
  productB: string;
  closerA: { id: string; tenantId: string };
  secondA: { id: string; tenantId: string };
  actorB: { id: string; tenantId: string };
}

interface PlaceOptions {
  tenantId?: string;
  locationId?: string;
  status?: 'RECEIVED' | 'ACCEPTED' | 'PREPARING' | 'READY' | 'COMPLETED';
  subtotal?: number;
  customerId?: string | null;
  promotion?: { id: string; discount: number; perCustomer: boolean };
  reward?: { beanCost: number; discount: number };
  giftCard?: { id: string; tender: number };
  earn?: number;
  bonus?: number;
  payment?: Partial<{
    status: 'PENDING' | 'SUCCEEDED' | 'DECLINED' | 'FAILED';
    paymentState: string | null;
    providerReference: string | null;
    reconciliationRequired: boolean;
    amountOverride: number;
  }>;
}

describe('R1 / S5b: order closure engine', () => {
  let scratch: ScratchDatabase;
  let db: Db;
  let closure: OrderClosureService;
  let admin: AdminOrdersService;
  let customerOrders: CustomerOrdersService;
  let base: Base;
  const previousFlag = process.env.ORDER_CLOSURE_ENABLED;
  const tA = tenantContextFor(A);
  const tB = tenantContextFor(B);

  const corporate = AuthorizationContext.of({
    'orders.view': [{ scopeType: 'CORPORATE', scopeId: null }],
    'orders.manage_status': [{ scopeType: 'CORPORATE', scopeId: null }],
    'orders.cancel': [{ scopeType: 'CORPORATE', scopeId: null }],
  });

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      's5b_closure',
    );
    await applyMigrations(scratch.url, migrations);
    db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: scratch.url }),
    });
    await db.$connect();
    const prisma = db as unknown as PrismaService;
    closure = new OrderClosureService(prisma, new InternalAuditService());
    admin = new AdminOrdersService(prisma);
    customerOrders = new CustomerOrdersService(prisma);

    await db.tenant.createMany({
      data: [
        { id: A, slug: 's5b-tenant-a', name: 'Tenant A', status: 'ACTIVE' },
        { id: B, slug: 's5b-tenant-b', name: 'Tenant B', status: 'ACTIVE' },
      ],
    });
    const location = (tenantId: string, slug: string) =>
      db.location.create({ data: { tenantId, name: slug, slug } });
    const user = (tenantId: string, email: string) =>
      db.internalUser.create({
        data: {
          tenantId,
          externalProvider: 'internal-dev',
          externalSubject: `internal-dev:${email}`,
          email,
          status: 'ACTIVE',
        },
        select: { id: true, tenantId: true },
      });
    // OrderLine.productId must name a product of the order's own business.
    const product = async (tenantId: string) => {
      const category = await db.category.create({
        data: { tenantId, name: 'Coffee', slug: 'coffee' },
      });
      const created = await db.product.create({
        data: {
          tenantId,
          name: 'Latte',
          slug: 'latte',
          categoryId: category.id,
        },
      });
      return created.id;
    };
    base = {
      productA: await product(A),
      productB: await product(B),
      locationA: (await location(A, 'la')).id,
      locationA2: (await location(A, 'la2')).id,
      locationB: (await location(B, 'lb')).id,
      closerA: await user(A, 'closer-a@example.test'),
      secondA: await user(A, 'second-a@example.test'),
      actorB: await user(B, 'actor-b@example.test'),
    };
  });

  beforeEach(() => {
    process.env.ORDER_CLOSURE_ENABLED = '1';
  });

  afterAll(async () => {
    if (previousFlag === undefined) delete process.env.ORDER_CLOSURE_ENABLED;
    else process.env.ORDER_CLOSURE_ENABLED = previousFlag;
    await db?.$disconnect();
    await scratch?.drop();
  });

  // --- fixtures -------------------------------------------------------------

  async function newCustomer(tenantId = A, balance = 0) {
    const customer = await db.customer.create({
      data: {
        tenantId,
        externalProvider: 'dev',
        externalSubject: `dev:${randomUUID()}`,
        email: `${randomUUID()}@example.test`,
      },
    });
    const account = await db.customerLoyaltyAccount.create({
      data: { tenantId, customerId: customer.id, balance },
    });
    return { customerId: customer.id, accountId: account.id };
  }

  async function newPromotion(
    tenantId = A,
    opts: { redemptionCount?: number; perCustomer?: number | null } = {},
  ) {
    return db.promotion.create({
      data: {
        tenantId,
        name: `Promo ${randomUUID().slice(0, 8)}`,
        kind: 'AUTOMATIC',
        discountType: 'FIXED_AMOUNT',
        discountValue: 200,
        appliesToAllLocations: true,
        totalRedemptionLimit: 100,
        perCustomerRedemptionLimit: opts.perCustomer ?? null,
        redemptionCount: opts.redemptionCount ?? 0,
      },
    });
  }

  async function newGiftCard(
    balance: number,
    opts: { tenantId?: string; status?: 'ACTIVE' | 'INACTIVE' } = {},
  ) {
    return db.giftCard.create({
      data: {
        tenantId: opts.tenantId ?? A,
        codeHash: `hash-${randomUUID()}`,
        last4: '4821',
        status: opts.status ?? 'ACTIVE',
        originalValueMinorUnits: Math.max(balance, 1),
        balanceMinorUnits: balance,
      },
    });
  }

  // Writes an order exactly as CheckoutService.createOrderTransactionally does.
  async function placeOrder(o: PlaceOptions = {}): Promise<string> {
    const tenantId = o.tenantId ?? A;
    const locationId =
      o.locationId ?? (tenantId === A ? base.locationA : base.locationB);
    const subtotal = o.subtotal ?? 1500;
    const promo = o.promotion?.discount ?? 0;
    const reward = o.reward?.discount ?? 0;
    const tender = o.giftCard?.tender ?? 0;
    const external = subtotal - promo - reward - tender;
    const customerId = o.customerId ?? null;

    return db.$transaction(async (tx) => {
      const attempt = await tx.paymentAttempt.create({
        data: {
          tenantId,
          idempotencyKey: `s5b-${randomUUID()}`,
          provider: 'fake',
          locationId,
          amount: o.payment?.amountOverride ?? external,
          currency: 'USD',
          status: o.payment?.status ?? 'SUCCEEDED',
          paymentState:
            o.payment?.paymentState !== undefined
              ? o.payment.paymentState
              : 'SUCCEEDED',
          providerReference:
            o.payment?.providerReference !== undefined
              ? o.payment.providerReference
              : external === 0
                ? 'no-charge'
                : `fake_${randomUUID()}`,
          reconciliationRequired: o.payment?.reconciliationRequired ?? false,
        },
      });
      const order = await tx.order.create({
        data: {
          tenantId,
          orderNumber: `S5B-${randomUUID().slice(0, 12)}`,
          accessToken: randomUUID(),
          locationId,
          customerId,
          paymentAttemptId: attempt.id,
          guestName: 'Guest',
          guestPhone: '5550000',
          guestEmail: 'guest@example.test',
          currency: 'USD',
          subtotal,
          promotionDiscountMinorUnits: promo,
          rewardDiscountMinorUnits: reward,
          giftCardTenderMinorUnits: tender,
          status: o.status ?? 'RECEIVED',
          lines: {
            create: {
              productId: tenantId === A ? base.productA : base.productB,
              productName: 'Latte',
              unitPrice: subtotal,
              quantity: 1,
              lineTotal: subtotal,
              currency: 'USD',
              selections: [],
            },
          },
          statusHistory: { create: { status: 'RECEIVED' } },
        },
      });

      if (o.promotion) {
        await tx.promotion.update({
          where: { id: o.promotion.id },
          data: { redemptionCount: { increment: 1 } },
        });
        const counts = o.promotion.perCustomer && customerId !== null;
        if (counts) {
          await tx.promotionCustomerUsage.upsert({
            where: {
              promotionId_customerId: {
                promotionId: o.promotion.id,
                customerId: customerId,
              },
            },
            create: {
              tenantId,
              promotionId: o.promotion.id,
              customerId: customerId,
              usedCount: 1,
            },
            update: { usedCount: { increment: 1 } },
          });
        }
        await tx.orderPromotionRedemption.create({
          data: {
            tenantId,
            orderId: order.id,
            sourcePromotionId: o.promotion.id,
            promotionName: 'Promo',
            promotionKind: 'AUTOMATIC',
            discountType: 'FIXED_AMOUNT',
            discountValue: 200,
            discountMinorUnits: promo,
            customerId: counts ? customerId : null,
          },
        });
      }

      if (o.giftCard) {
        const card = await tx.giftCard.findUniqueOrThrow({
          where: { id: o.giftCard.id },
        });
        await tx.orderGiftCardRedemption.create({
          data: {
            tenantId,
            orderId: order.id,
            sourceGiftCardId: card.id,
            last4: card.last4,
            amountMinorUnits: tender,
            currency: 'USD',
          },
        });
        await tx.giftCardTransaction.create({
          data: {
            tenantId,
            giftCardId: card.id,
            type: 'REDEMPTION',
            amountMinorUnits: -tender,
            balanceAfterMinorUnits: card.balanceMinorUnits - tender,
            orderId: order.id,
          },
        });
        await tx.giftCard.update({
          where: { id: card.id },
          data: { balanceMinorUnits: { decrement: tender } },
        });
      }

      if (customerId !== null) {
        const account = await tx.customerLoyaltyAccount.findUniqueOrThrow({
          where: { customerId },
        });
        let delta = 0;
        if (o.reward) {
          await tx.orderLoyaltyRewardRedemption.create({
            data: {
              tenantId,
              orderId: order.id,
              rewardName: 'Free pastry',
              rewardType: 'FIXED_AMOUNT',
              beanCost: o.reward.beanCost,
              discountMinorUnits: reward,
            },
          });
          await tx.mochaBeanLedgerEntry.create({
            data: {
              tenantId,
              loyaltyAccountId: account.id,
              type: 'REDEEM',
              amount: -o.reward.beanCost,
              orderId: order.id,
            },
          });
          delta -= o.reward.beanCost;
        }
        if (o.earn) {
          await tx.mochaBeanLedgerEntry.create({
            data: {
              tenantId,
              loyaltyAccountId: account.id,
              type: 'EARN',
              amount: o.earn,
              orderId: order.id,
            },
          });
          delta += o.earn;
        }
        if (o.bonus) {
          await tx.orderLoyaltyBonus.create({
            data: { tenantId, orderId: order.id, totalBonusBeans: o.bonus },
          });
          await tx.mochaBeanLedgerEntry.create({
            data: {
              tenantId,
              loyaltyAccountId: account.id,
              type: 'BONUS_EARN',
              amount: o.bonus,
              orderId: order.id,
            },
          });
          delta += o.bonus;
        }
        await tx.customerLoyaltyAccount.update({
          where: { id: account.id },
          data: { balance: { increment: delta } },
        });
      }
      return order.id;
    });
  }

  const reject = (
    orderId: string,
    over: Partial<CloseOrderInput> = {},
    ctx = corporate,
    actor = base.closerA,
    tenant = tA,
  ) =>
    closure.close(
      {
        kind: 'REJECTED',
        orderId,
        locationId: base.locationA,
        reasonCode: 'ITEM_UNAVAILABLE',
        ...over,
      },
      actor,
      ctx,
      tenant,
    );

  const cancel = (
    orderId: string,
    expectedStatus: string,
    over: Partial<CloseOrderInput> = {},
    ctx = corporate,
    actor = base.closerA,
    tenant = tA,
  ) =>
    closure.close(
      {
        kind: 'CANCELLED',
        orderId,
        locationId: base.locationA,
        expectedStatus,
        reasonCode: 'CUSTOMER_REQUEST',
        ...over,
      },
      actor,
      ctx,
      tenant,
    );

  async function snapshot(orderId: string) {
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    return {
      status: order.status,
      closures: await db.orderClosure.count({ where: { orderId } }),
      obligations: await db.orderRefundObligation.findMany({
        where: { orderId },
      }),
      history: await db.orderStatusHistory.findMany({
        where: { orderId },
        orderBy: { createdAt: 'asc' },
      }),
      giftCardReversals: await db.giftCardTransaction.findMany({
        where: { orderId, type: 'REDEMPTION_REVERSAL' },
      }),
      beanReversals: await db.mochaBeanLedgerEntry.findMany({
        where: {
          orderId,
          type: {
            in: ['REDEEM_REVERSAL', 'EARN_REVERSAL', 'BONUS_EARN_REVERSAL'],
          },
        },
      }),
      audits: await db.internalAuditEvent.findMany({
        where: { targetType: 'order', targetId: orderId },
      }),
    };
  }

  async function expectUntouched(orderId: string, status: string) {
    const s = await snapshot(orderId);
    expect(s.status).toBe(status);
    expect(s.closures).toBe(0);
    expect(s.obligations).toHaveLength(0);
    expect(s.giftCardReversals).toHaveLength(0);
    expect(s.beanReversals).toHaveLength(0);
    expect(s.audits).toHaveLength(0);
  }

  // --- the feature flag -----------------------------------------------------

  describe('feature flag', () => {
    it('is off unless ORDER_CLOSURE_ENABLED is exactly "1"', () => {
      expect(isOrderClosureEnabled({})).toBe(false);
      expect(isOrderClosureEnabled({ ORDER_CLOSURE_ENABLED: '0' })).toBe(false);
      expect(isOrderClosureEnabled({ ORDER_CLOSURE_ENABLED: 'true' })).toBe(
        false,
      );
      expect(isOrderClosureEnabled({ ORDER_CLOSURE_ENABLED: 'yes' })).toBe(
        false,
      );
      expect(isOrderClosureEnabled({ ORDER_CLOSURE_ENABLED: ' 1 ' })).toBe(
        true,
      );
    });

    it.each([undefined, '0', 'true'])(
      'refuses with 404 and writes nothing when the flag is %p',
      async (value) => {
        if (value === undefined) delete process.env.ORDER_CLOSURE_ENABLED;
        else process.env.ORDER_CLOSURE_ENABLED = value;
        const orderId = await placeOrder();
        await expect(reject(orderId)).rejects.toBeInstanceOf(NotFoundException);
        await expectUntouched(orderId, 'RECEIVED');
      },
    );
  });

  // --- transitions ----------------------------------------------------------

  describe('transitions', () => {
    it('rejects a RECEIVED order: status, closure, history and audit in one go', async () => {
      const orderId = await placeOrder();
      const result = await reject(orderId, {
        reasonCode: 'STORE_TOO_BUSY',
        note: '  Rush hour, kitchen backed up  ',
      });

      expect(result).toMatchObject({
        orderId,
        status: 'REJECTED',
        closed: true,
        closure: {
          kind: 'REJECTED',
          fromStatus: 'RECEIVED',
          reasonCode: 'STORE_TOO_BUSY',
          reasonLabel: 'The store is too busy',
          note: 'Rush hour, kitchen backed up',
          refundDueMinorUnits: 1500,
          refundStatus: 'DUE',
          giftCardRestoredMinorUnits: 0,
          loyaltyShortfallBeans: 0,
        },
      });
      const s = await snapshot(orderId);
      expect(s.status).toBe('REJECTED');
      expect(s.closures).toBe(1);
      expect(s.history.map((h) => h.status)).toEqual(['RECEIVED', 'REJECTED']);
      expect(s.history.every((h) => h.note === null)).toBe(true);
      expect(s.audits).toHaveLength(1);
      expect(s.audits[0]).toMatchObject({
        action: 'order.rejected',
        actorInternalUserId: base.closerA.id,
        tenantId: A,
        reason: 'The store is too busy',
        beforeData: { status: 'RECEIVED' },
      });
    });

    it.each(['ACCEPTED', 'PREPARING', 'READY'] as const)(
      'cancels an order that is %s',
      async (status) => {
        const orderId = await placeOrder({ status });
        const result = await cancel(orderId, status);
        expect(result).toMatchObject({
          status: 'CANCELLED',
          closed: true,
          closure: { kind: 'CANCELLED', fromStatus: status },
        });
        const s = await snapshot(orderId);
        expect(s.status).toBe('CANCELLED');
        expect(s.audits[0].action).toBe('order.cancelled');
      },
    );

    it.each(['ACCEPTED', 'PREPARING', 'READY', 'COMPLETED'] as const)(
      'refuses to reject an order that is %s',
      async (status) => {
        const orderId = await placeOrder({ status });
        await expect(reject(orderId)).rejects.toBeInstanceOf(ConflictException);
        await expectUntouched(orderId, status);
      },
    );

    it('refuses to cancel a RECEIVED order (it must be rejected)', async () => {
      const orderId = await placeOrder();
      await expect(cancel(orderId, 'ACCEPTED')).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expectUntouched(orderId, 'RECEIVED');
    });

    it('refuses to cancel a COMPLETED order', async () => {
      const orderId = await placeOrder({ status: 'COMPLETED' });
      await expect(cancel(orderId, 'READY')).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expectUntouched(orderId, 'COMPLETED');
    });

    it('refuses a cancellation whose expectedStatus is stale (the order moved)', async () => {
      const orderId = await placeOrder({ status: 'PREPARING' });
      await expect(cancel(orderId, 'ACCEPTED')).rejects.toThrow(
        /changed since this action was requested \(now PREPARING\)/,
      );
      await expectUntouched(orderId, 'PREPARING');
    });

    it('a repeated rejection is an idempotent replay: same closure, nothing reversed twice', async () => {
      const card = await newGiftCard(5000);
      const { customerId } = await newCustomer(A, 0);
      const orderId = await placeOrder({
        customerId,
        giftCard: { id: card.id, tender: 500 },
        earn: 10,
      });
      const first = await reject(orderId);
      const again = await reject(orderId, { reasonCode: 'OTHER', note: 'x' });
      expect(again.closed).toBe(false);
      expect(again.closure).toEqual(first.closure);
      const s = await snapshot(orderId);
      expect(s.closures).toBe(1);
      expect(s.giftCardReversals).toHaveLength(1);
      expect(s.beanReversals).toHaveLength(1);
      expect(s.obligations).toHaveLength(1);
      expect(s.audits).toHaveLength(1);
      expect(s.history.map((h) => h.status)).toEqual(['RECEIVED', 'REJECTED']);
      expect(
        (await db.giftCard.findUniqueOrThrow({ where: { id: card.id } }))
          .balanceMinorUnits,
      ).toBe(5000);
    });

    it('a repeated cancellation is an idempotent replay', async () => {
      const orderId = await placeOrder({ status: 'READY' });
      await cancel(orderId, 'READY');
      const again = await cancel(orderId, 'READY');
      expect(again).toMatchObject({ status: 'CANCELLED', closed: false });
      expect((await snapshot(orderId)).closures).toBe(1);
    });

    it('a closed order cannot be closed the other way', async () => {
      const rejected = await placeOrder();
      await reject(rejected);
      await expect(cancel(rejected, 'ACCEPTED')).rejects.toThrow(
        /already rejected/,
      );
      const cancelled = await placeOrder({ status: 'ACCEPTED' });
      await cancel(cancelled, 'ACCEPTED');
      await expect(reject(cancelled)).rejects.toThrow(/already cancelled/);
    });

    it('a closed order never advances again', async () => {
      const orderId = await placeOrder({ status: 'READY' });
      await cancel(orderId, 'READY');
      await expect(
        admin.advance(orderId, base.locationA, 'READY', corporate, tA),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        admin.advance(orderId, base.locationA, 'CANCELLED', corporate, tA),
      ).rejects.toBeInstanceOf(ConflictException);
      expect((await snapshot(orderId)).status).toBe('CANCELLED');
    });
  });

  // --- request validation ---------------------------------------------------

  describe('validation', () => {
    it.each<[string, Partial<CloseOrderInput>]>([
      ['a missing locationId', { locationId: '' }],
      ['an unknown reason code', { reasonCode: 'BECAUSE' }],
      [
        'a cancellation-only reason on a rejection',
        { reasonCode: 'CUSTOMER_REQUEST' },
      ],
      ['OTHER without a note', { reasonCode: 'OTHER' }],
      ['OTHER with a blank note', { reasonCode: 'OTHER', note: '   ' }],
      ['a note over 500 characters', { note: 'x'.repeat(501) }],
      ['a note with control characters', { note: 'bad\u0007bell' }],
      ['a note with a bidi override', { note: 'refund \u202Edenied' }],
      ['a note with a zero-width character', { note: 'ok\u200Bay' }],
      ['a note with a line separator', { note: 'one\u2028two' }],
      ['a non-text note', { note: 42 }],
    ])('rejects %s with 400 and writes nothing', async (_label, over) => {
      const orderId = await placeOrder();
      await expect(reject(orderId, over)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expectUntouched(orderId, 'RECEIVED');
    });

    it.each([undefined, 'RECEIVED', 'COMPLETED', 'CANCELLED', 'nonsense'])(
      'a cancellation needs a cancellable expectedStatus (got %p)',
      async (expected) => {
        const orderId = await placeOrder({ status: 'ACCEPTED' });
        await expect(
          cancel(orderId, expected as string),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expectUntouched(orderId, 'ACCEPTED');
      },
    );

    it('accepts a 500-character note and keeps newlines', async () => {
      const orderId = await placeOrder();
      const note = `line one\n${'y'.repeat(491)}`;
      expect(note).toHaveLength(500);
      const result = await reject(orderId, { note });
      expect(result.closure.note).toBe(note);
    });
  });

  // --- authorization and tenant isolation -----------------------------------

  describe('authorization and isolation', () => {
    it('refuses a caller without orders.cancel (manage_status is not enough)', async () => {
      const orderId = await placeOrder();
      const statusOnly = AuthorizationContext.of({
        'orders.view': [{ scopeType: 'CORPORATE', scopeId: null }],
        'orders.manage_status': [{ scopeType: 'CORPORATE', scopeId: null }],
      });
      await expect(reject(orderId, {}, statusOnly)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      // ...even with an invalid body: the permission is checked first.
      await expect(
        reject(orderId, { reasonCode: 'BECAUSE' }, statusOnly),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expectUntouched(orderId, 'RECEIVED');
    });

    it('a LOCATION grant works at its own location only', async () => {
      const own = AuthorizationContext.of({
        'orders.cancel': [{ scopeType: 'LOCATION', scopeId: base.locationA }],
      });
      const orderId = await placeOrder();
      await expect(reject(orderId, {}, own)).resolves.toMatchObject({
        status: 'REJECTED',
      });

      const elsewhere = AuthorizationContext.of({
        'orders.cancel': [{ scopeType: 'LOCATION', scopeId: base.locationA2 }],
      });
      const other = await placeOrder();
      await expect(reject(other, {}, elsewhere)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expectUntouched(other, 'RECEIVED');
    });

    it('an order of another location reads as not found', async () => {
      const orderId = await placeOrder({ locationId: base.locationA2 });
      await expect(reject(orderId)).rejects.toBeInstanceOf(NotFoundException);
      await expectUntouched(orderId, 'RECEIVED');
    });

    it("another business's order reads as not found, even naming its location", async () => {
      const orderB = await placeOrder({ tenantId: B });
      await expect(reject(orderB)).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        reject(orderB, { locationId: base.locationB }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expectUntouched(orderB, 'RECEIVED');
    });

    it('an actor from another business cannot act in this one', async () => {
      const orderId = await placeOrder();
      await expect(
        reject(orderId, {}, corporate, base.actorB, tA),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expectUntouched(orderId, 'RECEIVED');
    });

    it('a business closes its own orders, and every row it writes is its own', async () => {
      const card = await newGiftCard(1000, { tenantId: B });
      const { customerId } = await newCustomer(B, 0);
      const orderB = await placeOrder({
        tenantId: B,
        customerId,
        giftCard: { id: card.id, tender: 300 },
        earn: 12,
      });
      await expect(
        reject(
          orderB,
          { locationId: base.locationB },
          corporate,
          base.actorB,
          tB,
        ),
      ).resolves.toMatchObject({ status: 'REJECTED' });
      const s = await snapshot(orderB);
      const rows = [
        ...s.obligations,
        ...s.history,
        ...s.giftCardReversals,
        ...s.beanReversals,
        ...s.audits,
      ];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.tenantId === B)).toBe(true);
      expect(
        (
          await db.orderClosure.findUniqueOrThrow({
            where: { orderId: orderB },
          })
        ).tenantId,
      ).toBe(B);
    });
  });

  // --- money: tenders and refund obligations ---------------------------------

  describe('tenders and refund obligations', () => {
    it('card only: the whole external charge is owed back, DUE, never settled', async () => {
      const orderId = await placeOrder({ subtotal: 2350, status: 'ACCEPTED' });
      const result = await cancel(orderId, 'ACCEPTED');
      expect(result.closure).toMatchObject({
        refundDueMinorUnits: 2350,
        refundStatus: 'DUE',
        giftCardRestoredMinorUnits: 0,
      });
      const [obligation] = (await snapshot(orderId)).obligations;
      const order = await db.order.findUniqueOrThrow({
        where: { id: orderId },
      });
      expect(obligation).toMatchObject({
        amountMinorUnits: 2350,
        currency: 'USD',
        status: 'DUE',
        paymentAttemptId: order.paymentAttemptId,
        settlementMethod: null,
        settledAt: null,
        settledByInternalUserId: null,
        processorRefundId: null,
      });
    });

    it('gift card only: the tender is restored to the card and nothing is owed', async () => {
      const card = await newGiftCard(3000);
      const orderId = await placeOrder({
        subtotal: 1200,
        giftCard: { id: card.id, tender: 1200 },
      });
      const result = await reject(orderId);
      expect(result.closure).toMatchObject({
        refundDueMinorUnits: 0,
        refundStatus: null,
        giftCardRestoredMinorUnits: 1200,
      });
      const s = await snapshot(orderId);
      expect(s.obligations).toHaveLength(0);
      expect(s.giftCardReversals).toHaveLength(1);
      expect(s.giftCardReversals[0]).toMatchObject({
        giftCardId: card.id,
        amountMinorUnits: 1200,
        balanceAfterMinorUnits: 3000,
        actorInternalUserId: base.closerA.id,
      });
      expect(
        (await db.giftCard.findUniqueOrThrow({ where: { id: card.id } }))
          .balanceMinorUnits,
      ).toBe(3000);
    });

    it('mixed tender: only the card-paid part is owed; the gift-card part is restored', async () => {
      const card = await newGiftCard(800);
      const promotion = await newPromotion();
      const { customerId } = await newCustomer(A, 500);
      const orderId = await placeOrder({
        subtotal: 2000,
        customerId,
        promotion: { id: promotion.id, discount: 200, perCustomer: false },
        reward: { beanCost: 100, discount: 300 },
        giftCard: { id: card.id, tender: 800 },
        status: 'PREPARING',
      });
      // 2000 - 200 (promotion) - 300 (reward) - 800 (gift card) = 700 on the card
      const result = await cancel(orderId, 'PREPARING');
      expect(result.closure).toMatchObject({
        refundDueMinorUnits: 700,
        giftCardRestoredMinorUnits: 800,
      });
      const ledger = await db.giftCardTransaction.findMany({
        where: { giftCardId: card.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(ledger.reduce((sum, t) => sum + t.amountMinorUnits, 0)).toBe(0);
      expect(
        (await db.giftCard.findUniqueOrThrow({ where: { id: card.id } }))
          .balanceMinorUnits,
      ).toBe(800);
    });

    it('a deactivated gift card still gets its value back', async () => {
      const card = await newGiftCard(1000);
      const orderId = await placeOrder({
        giftCard: { id: card.id, tender: 400 },
      });
      await db.giftCard.update({
        where: { id: card.id },
        data: { status: 'INACTIVE' },
      });
      await reject(orderId);
      expect(
        (await db.giftCard.findUniqueOrThrow({ where: { id: card.id } }))
          .balanceMinorUnits,
      ).toBe(1000);
    });

    it('refuses a restoration that would exceed the maximum card balance, changing nothing', async () => {
      const card = await newGiftCard(GIFT_CARD_MAX_VALUE_MINOR_UNITS);
      const orderId = await placeOrder({
        giftCard: { id: card.id, tender: 500 },
      });
      // HQ topped the card back up to the ceiling after the order.
      await db.giftCard.update({
        where: { id: card.id },
        data: { balanceMinorUnits: GIFT_CARD_MAX_VALUE_MINOR_UNITS },
      });
      await expect(reject(orderId)).rejects.toThrow(/maximum balance/);
      await expectUntouched(orderId, 'RECEIVED');
    });

    it('a simulated (fake provider) charge is still owed back: the obligation records it', async () => {
      const orderId = await placeOrder({ subtotal: 900 });
      const attempt = await db.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { paymentAttempt: true },
      });
      expect(attempt.paymentAttempt.provider).toBe('fake');
      await expect(reject(orderId)).resolves.toMatchObject({
        closure: { refundDueMinorUnits: 900 },
      });
    });

    it.each<[string, PlaceOptions['payment']]>([
      ['still PENDING', { status: 'PENDING', paymentState: 'CHARGING' }],
      ['of UNKNOWN outcome', { status: 'PENDING', paymentState: 'UNKNOWN' }],
      [
        'awaiting confirmation',
        { status: 'PENDING', paymentState: 'AWAITING_CONFIRMATION' },
      ],
      ['flagged for reconciliation', { reconciliationRequired: true }],
      ['missing a provider reference', { providerReference: null }],
      ['recorded as no-charge', { providerReference: 'no-charge' }],
    ])(
      'refuses to close an order whose card payment is %s (no obligation for money not taken)',
      async (_label, payment) => {
        const orderId = await placeOrder({ payment });
        await expect(reject(orderId)).rejects.toThrow(/not confirmed/);
        await expectUntouched(orderId, 'RECEIVED');
      },
    );

    it('refuses to close an order whose payment amount disagrees with its figures', async () => {
      const orderId = await placeOrder({
        subtotal: 1500,
        payment: { amountOverride: 1400 },
      });
      await expect(reject(orderId)).rejects.toThrow(
        /payment records do not agree/,
      );
      await expectUntouched(orderId, 'RECEIVED');
    });

    it('refuses to close an order whose gift-card ledger disagrees with its snapshot', async () => {
      const card = await newGiftCard(1000);
      const orderId = await placeOrder({
        giftCard: { id: card.id, tender: 400 },
      });
      await withScratchClient(scratch.url, (c) =>
        c.query(
          `UPDATE "Order" SET "giftCardTenderMinorUnits" = 300, subtotal = 1400 WHERE id = $1`,
          [orderId],
        ),
      );
      await expect(reject(orderId)).rejects.toThrow(
        /gift-card records do not agree/,
      );
      await expectUntouched(orderId, 'RECEIVED');
    });
  });

  // --- Mocha Beans ----------------------------------------------------------

  describe('Mocha Beans', () => {
    it('returns redeemed Beans and recovers earned and bonus Beans in full when the balance covers them', async () => {
      const { customerId, accountId } = await newCustomer(A, 200);
      const orderId = await placeOrder({
        customerId,
        reward: { beanCost: 150, discount: 300 },
        earn: 12,
        bonus: 6,
      });
      // 200 - 150 + 12 + 6 = 68
      expect(
        (
          await db.customerLoyaltyAccount.findUniqueOrThrow({
            where: { id: accountId },
          })
        ).balance,
      ).toBe(68);

      const result = await reject(orderId);
      expect(result.closure.loyaltyShortfallBeans).toBe(0);
      const reversals = (await snapshot(orderId)).beanReversals;
      expect(
        Object.fromEntries(reversals.map((r) => [r.type, r.amount])),
      ).toEqual({
        REDEEM_REVERSAL: 150,
        EARN_REVERSAL: -12,
        BONUS_EARN_REVERSAL: -6,
      });
      expect(
        reversals.every((r) => r.actorInternalUserId === base.closerA.id),
      ).toBe(true);
      const account = await db.customerLoyaltyAccount.findUniqueOrThrow({
        where: { id: accountId },
      });
      expect(account.balance).toBe(200);
      const ledger = await db.mochaBeanLedgerEntry.aggregate({
        where: { loyaltyAccountId: accountId },
        _sum: { amount: true },
      });
      // The opening 200 was set directly on the fixture account.
      expect((ledger._sum.amount ?? 0) + 200).toBe(account.balance);
    });

    it('records a shortfall for earned Beans the customer already spent, never going negative', async () => {
      const { customerId, accountId } = await newCustomer(A, 0);
      const orderId = await placeOrder({
        customerId,
        status: 'READY',
        earn: 40,
        bonus: 20,
      });
      // The customer spent 50 of the 60 Beans before the cancellation.
      await db.customerLoyaltyAccount.update({
        where: { id: accountId },
        data: { balance: 10 },
      });

      const result = await cancel(orderId, 'READY');
      // 10 recoverable: all of it from EARN; BONUS_EARN recovers nothing.
      expect(result.closure.loyaltyShortfallBeans).toBe(50);
      const reversals = (await snapshot(orderId)).beanReversals;
      expect(reversals).toHaveLength(1);
      expect(reversals[0]).toMatchObject({
        type: 'EARN_REVERSAL',
        amount: -10,
      });
      expect(
        (
          await db.customerLoyaltyAccount.findUniqueOrThrow({
            where: { id: accountId },
          })
        ).balance,
      ).toBe(0);
      // earned - recovered = shortfall
      expect(60 - 10).toBe(result.closure.loyaltyShortfallBeans);
    });

    it('returned reward Beans are available to cover the recovery of earned Beans', async () => {
      const { customerId, accountId } = await newCustomer(A, 100);
      const orderId = await placeOrder({
        customerId,
        reward: { beanCost: 100, discount: 200 },
        earn: 13,
      });
      // The customer spent the 13 they earned: balance 0.
      await db.customerLoyaltyAccount.update({
        where: { id: accountId },
        data: { balance: 0 },
      });
      const result = await reject(orderId);
      expect(result.closure.loyaltyShortfallBeans).toBe(0);
      expect(
        (
          await db.customerLoyaltyAccount.findUniqueOrThrow({
            where: { id: accountId },
          })
        ).balance,
      ).toBe(87);
    });

    it('a guest order touches no loyalty account', async () => {
      const orderId = await placeOrder();
      await reject(orderId);
      expect((await snapshot(orderId)).beanReversals).toHaveLength(0);
    });
  });

  // --- promotions -----------------------------------------------------------

  describe('promotion usage', () => {
    it('releases one total use and one per-customer use, exactly once', async () => {
      const promotion = await newPromotion(A, { perCustomer: 2 });
      const { customerId } = await newCustomer();
      const orderId = await placeOrder({
        customerId,
        promotion: { id: promotion.id, discount: 200, perCustomer: true },
      });
      const usage = () =>
        db.promotionCustomerUsage.findUniqueOrThrow({
          where: {
            promotionId_customerId: { promotionId: promotion.id, customerId },
          },
        });
      expect((await usage()).usedCount).toBe(1);

      await reject(orderId);
      await reject(orderId);
      expect(
        (await db.promotion.findUniqueOrThrow({ where: { id: promotion.id } }))
          .redemptionCount,
      ).toBe(0);
      expect((await usage()).usedCount).toBe(0);
      expect((await snapshot(orderId)).audits[0].afterData).toMatchObject({
        promotionUsageReleased: true,
        customerPromotionUsageReleased: true,
      });
    });

    it('a guest promotion releases the total use only', async () => {
      const promotion = await newPromotion(A, { redemptionCount: 5 });
      const orderId = await placeOrder({
        promotion: { id: promotion.id, discount: 200, perCustomer: false },
      });
      await reject(orderId);
      expect(
        (await db.promotion.findUniqueOrThrow({ where: { id: promotion.id } }))
          .redemptionCount,
      ).toBe(5);
    });

    it('never drives a counter below zero', async () => {
      const promotion = await newPromotion();
      const orderId = await placeOrder({
        promotion: { id: promotion.id, discount: 200, perCustomer: false },
      });
      await db.promotion.update({
        where: { id: promotion.id },
        data: { redemptionCount: 0 },
      });
      await reject(orderId);
      expect(
        (await db.promotion.findUniqueOrThrow({ where: { id: promotion.id } }))
          .redemptionCount,
      ).toBe(0);
    });
  });

  // --- concurrency ----------------------------------------------------------

  describe('concurrency', () => {
    it('concurrent cancellations of one order close it exactly once', async () => {
      const card = await newGiftCard(5000);
      const promotion = await newPromotion();
      const { customerId, accountId } = await newCustomer(A, 0);
      const orderId = await placeOrder({
        status: 'ACCEPTED',
        customerId,
        promotion: { id: promotion.id, discount: 200, perCustomer: false },
        giftCard: { id: card.id, tender: 600 },
        earn: 7,
      });

      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () => cancel(orderId, 'ACCEPTED')),
      );
      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof cancel>>> =>
          r.status === 'fulfilled',
      );
      expect(fulfilled).toHaveLength(6);
      expect(fulfilled.filter((r) => r.value.closed)).toHaveLength(1);

      const s = await snapshot(orderId);
      expect(s.closures).toBe(1);
      expect(s.obligations).toHaveLength(1);
      expect(s.giftCardReversals).toHaveLength(1);
      expect(s.beanReversals).toHaveLength(1);
      expect(s.audits).toHaveLength(1);
      expect(
        (await db.giftCard.findUniqueOrThrow({ where: { id: card.id } }))
          .balanceMinorUnits,
      ).toBe(5000);
      expect(
        (await db.promotion.findUniqueOrThrow({ where: { id: promotion.id } }))
          .redemptionCount,
      ).toBe(0);
      expect(
        (
          await db.customerLoyaltyAccount.findUniqueOrThrow({
            where: { id: accountId },
          })
        ).balance,
      ).toBe(0);
    });

    it('cancellation racing an ordinary advance: exactly one wins and the loser is told so', async () => {
      for (let i = 0; i < 8; i++) {
        const orderId = await placeOrder({ status: 'ACCEPTED' });
        const [adv, can] = await Promise.allSettled([
          admin.advance(orderId, base.locationA, 'ACCEPTED', corporate, tA),
          cancel(orderId, 'ACCEPTED'),
        ]);
        const s = await snapshot(orderId);
        if (s.status === 'CANCELLED') {
          expect(can.status).toBe('fulfilled');
          expect(adv.status).toBe('rejected');
          expect((adv as PromiseRejectedResult).reason).toBeInstanceOf(
            ConflictException,
          );
          expect(s.closures).toBe(1);
          expect(s.history.map((h) => h.status)).toEqual([
            'RECEIVED',
            'CANCELLED',
          ]);
        } else {
          expect(s.status).toBe('PREPARING');
          expect(adv).toMatchObject({
            status: 'fulfilled',
            value: { status: 'PREPARING', advanced: true },
          });
          expect(can.status).toBe('rejected');
          expect((can as PromiseRejectedResult).reason).toBeInstanceOf(
            ConflictException,
          );
          expect(s.closures).toBe(0);
        }
      }
    });

    it('an advance that loses its conditional update to another change is a conflict, not a success', async () => {
      const orderId = await placeOrder({ status: 'ACCEPTED' });
      // Hold the row so advance() reads ACCEPTED, then waits on its update;
      // meanwhile the order moves elsewhere (as a cancellation would move it).
      await withScratchClient(scratch.url, async (c) => {
        await c.query('BEGIN');
        await c.query(`SELECT 1 FROM "Order" WHERE id = $1 FOR UPDATE`, [
          orderId,
        ]);
        const pending = admin.advance(
          orderId,
          base.locationA,
          'ACCEPTED',
          corporate,
          tA,
        );
        const outcome = pending.then(
          () => 'resolved',
          (e: unknown) => e,
        );
        await new Promise((r) => setTimeout(r, 300));
        await c.query(`UPDATE "Order" SET status = 'READY' WHERE id = $1`, [
          orderId,
        ]);
        await c.query('COMMIT');
        const result = await outcome;
        expect(result).toBeInstanceOf(ConflictException);
        expect((result as Error).message).toMatch(/now READY/);
      });
      const s = await snapshot(orderId);
      expect(s.status).toBe('READY');
      expect(s.history.map((h) => h.status)).toEqual(['RECEIVED']);
    });

    it('a duplicate advance that loses the race to the same transition is still an idempotent no-op', async () => {
      const orderId = await placeOrder({ status: 'ACCEPTED' });
      await withScratchClient(scratch.url, async (c) => {
        await c.query('BEGIN');
        await c.query(`SELECT 1 FROM "Order" WHERE id = $1 FOR UPDATE`, [
          orderId,
        ]);
        const pending = admin.advance(
          orderId,
          base.locationA,
          'ACCEPTED',
          corporate,
          tA,
        );
        await new Promise((r) => setTimeout(r, 300));
        await c.query(`UPDATE "Order" SET status = 'PREPARING' WHERE id = $1`, [
          orderId,
        ]);
        await c.query('COMMIT');
        await expect(pending).resolves.toMatchObject({
          status: 'PREPARING',
          advanced: false,
        });
      });
    });
  });

  // --- what the database itself refuses --------------------------------------

  describe('database guards under the writer', () => {
    it('an order can never be created already closed (Invariant 2)', async () => {
      await expect(
        db.$transaction(async (tx) => {
          const attempt = await tx.paymentAttempt.create({
            data: {
              tenantId: A,
              idempotencyKey: `s5b-${randomUUID()}`,
              provider: 'fake',
              locationId: base.locationA,
              amount: 100,
              currency: 'USD',
              status: 'SUCCEEDED',
            },
          });
          await tx.order.create({
            data: {
              tenantId: A,
              orderNumber: `S5B-${randomUUID().slice(0, 12)}`,
              accessToken: randomUUID(),
              locationId: base.locationA,
              paymentAttemptId: attempt.id,
              guestName: 'G',
              guestPhone: '1',
              currency: 'USD',
              subtotal: 100,
              status: 'CANCELLED',
            },
          });
        }),
      ).rejects.toThrow(/cannot be created CANCELLED/);
    });
  });

  // --- what customers and staff see ------------------------------------------

  describe('visibility of the internal note', () => {
    it('staff see the closure (with the note); the customer view never carries it', async () => {
      const { customerId } = await newCustomer();
      const orderId = await placeOrder({ customerId, status: 'READY' });
      const note = 'Customer was rude on the phone — internal only';
      await cancel(orderId, 'READY', { note });

      const detail = await admin.getDetail(
        orderId,
        base.locationA,
        corporate,
        tA,
      );
      expect(detail.closure).toMatchObject({ kind: 'CANCELLED', note });

      const customerView = await customerOrders.getDetail(customerId, orderId);
      expect(customerView.status).toBe('CANCELLED');
      expect(JSON.stringify(customerView)).not.toContain('rude');

      const s = await snapshot(orderId);
      expect(JSON.stringify(s.audits)).not.toContain('rude');
      expect(s.audits[0].afterData).toMatchObject({ hasNote: true });
      expect(JSON.stringify(s.history)).not.toContain('rude');
    });

    it('staff who may only view orders see the closure but not the note', async () => {
      const orderId = await placeOrder({ status: 'ACCEPTED' });
      await cancel(orderId, 'ACCEPTED', { note: 'manager-only detail' });
      const viewer = AuthorizationContext.of({
        'orders.view': [{ scopeType: 'LOCATION', scopeId: base.locationA }],
      });
      const detail = await admin.getDetail(orderId, base.locationA, viewer, tA);
      expect(detail.closure).toMatchObject({ kind: 'CANCELLED', note: null });
      expect(JSON.stringify(detail)).not.toContain('manager-only');
    });

    it("another business's closed order is never returned on the staff detail", async () => {
      const orderB = await placeOrder({ tenantId: B, status: 'ACCEPTED' });
      await cancel(
        orderB,
        'ACCEPTED',
        { locationId: base.locationB, note: 'tenant b secret' },
        corporate,
        base.actorB,
        tB,
      );
      await expect(
        admin.getDetail(orderB, base.locationB, corporate, tA),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('an open order has no closure on the staff detail', async () => {
      const orderId = await placeOrder();
      const detail = await admin.getDetail(
        orderId,
        base.locationA,
        corporate,
        tA,
      );
      expect(detail.closure).toBeNull();
    });
  });
});
