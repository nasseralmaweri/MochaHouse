import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@mocha-house/database';
import {
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  tenantContextFor,
  type ScratchDatabase,
} from '@mocha-house/testing';
import type {
  CreateOrderRefundRequest,
  OrderRefundItemInput,
} from '@mocha-house/contracts';
import type { PrismaService } from '../prisma/prisma.service';
import { InternalAuditService } from '../audit/internal-audit.service';
import { AuthorizationContext } from '../internal-auth/authorization/authorization-context';
import { OrderRefundsService } from '../orders/application/order-refunds.service';
import { OrderClosureService } from '../orders/application/order-closure.service';
import { SalesTaxReportService } from '../reports/sales-tax-report.service';
import { salesTaxCsvRows } from '../reports/report-csv-rows';
import { fakeStripePayments } from '../../test/fake-stripe-intents';
import { calculateSalesTax } from './domain/tax-calculation';
import { orderTaxDetail, type FrozenTax } from './application/checkout-tax';

// V1 Sales Tax PR 3 — item refunds, cancellations and the sales tax report,
// on a scratch database with the offline Stripe stand-in. Orders are written
// exactly as checkout writes a taxed order: lines with their positions, the
// order's tax and its immutable snapshot (made by the real calculation).

jest.setTimeout(300_000);

const migrations = listMigrations(
  join(__dirname, '../../../../packages/database/prisma/migrations'),
);
const A = '01a0db02-f800-7000-8000-00000000703a';
const B = '01a0db02-f800-7000-8000-00000000703b';
const ACCT_A = 'acct_1Pr3TenantA';
const ACCT_B = 'acct_1Pr3TenantB';
const STATE = 60_000; // 6% on food and grocery
const CITY = 12_500; // 1.25% on food only

describe('V1 Sales Tax PR 3: tax refunds and reporting', () => {
  let scratch: ScratchDatabase;
  let db: PrismaClient;
  let refunds: OrderRefundsService;
  let closure: OrderClosureService;
  let report: SalesTaxReportService;
  const fake = fakeStripePayments(new Set([A, B]));
  const { intents, provider } = fake;
  const tA = tenantContextFor(A);
  const tB = tenantContextFor(B);
  const env = { ...process.env };
  const base = {
    locA: '',
    locA2: '',
    locB: '',
    owner: { id: '', tenantId: A },
    ownerB: { id: '', tenantId: B },
    productA: '',
    productB: '',
    food: '',
    grocery: '',
    exempt: '',
    versionA: { id: '', version: 1 },
    versionA2: { id: '', version: 1 },
    versionB: { id: '', version: 1 },
    foodB: '',
  };
  const owner = () =>
    AuthorizationContext.of({
      'orders.view': [{ scopeType: 'CORPORATE', scopeId: null }],
      'orders.refund': [{ scopeType: 'CORPORATE', scopeId: null }],
      'orders.cancel': [{ scopeType: 'CORPORATE', scopeId: null }],
      'reports.view': [{ scopeType: 'CORPORATE', scopeId: null }],
    });
  const refundManagerAt = (locationId: string) =>
    AuthorizationContext.of({
      'orders.view': [{ scopeType: 'LOCATION', scopeId: locationId }],
      'orders.refund': [{ scopeType: 'LOCATION', scopeId: locationId }],
    });

  async function confirmedVersion(
    tenantId: string,
    locationId: string,
    by: string,
    components: { name: string; ratePpm: number; classIds: string[] }[],
  ) {
    const draft = await db.locationTaxVersion.create({
      data: { tenantId, locationId, version: 1, status: 'DRAFT' },
    });
    for (const [i, c] of components.entries()) {
      const row = await db.locationTaxComponent.create({
        data: {
          tenantId,
          versionId: draft.id,
          name: c.name,
          jurisdiction: i === 0 ? 'STATE' : 'CITY',
          ratePpm: c.ratePpm,
          displayOrder: i,
        },
      });
      await db.locationTaxComponentClass.createMany({
        data: c.classIds.map((taxClassId) => ({
          tenantId,
          componentId: row.id,
          taxClassId,
        })),
      });
    }
    await db.locationTaxVersion.update({
      where: { id: draft.id },
      data: {
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        confirmedByInternalUserId: by,
      },
    });
    return { id: draft.id, version: 1 };
  }

  beforeAll(async () => {
    process.env.RESTAURANT_REFUNDS_ENABLED = '1';
    process.env.ORDER_CLOSURE_ENABLED = '1';
    scratch = await createScratchDatabase(process.env.DATABASE_URL!, 'tax_pr3');
    await applyMigrations(scratch.url, migrations);
    db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: scratch.url }),
    });
    await db.$connect();
    const prisma = db as unknown as PrismaService;
    refunds = new OrderRefundsService(
      prisma,
      new InternalAuditService(),
      provider,
    );
    closure = new OrderClosureService(prisma, new InternalAuditService());
    report = new SalesTaxReportService(prisma);

    await db.tenant.createMany({
      data: [
        { id: A, slug: 'pr3-a', name: 'Tenant A', status: 'ACTIVE' },
        { id: B, slug: 'pr3-b', name: 'Tenant B', status: 'ACTIVE' },
      ],
    });
    const location = (tenantId: string, slug: string) =>
      db.location.create({ data: { tenantId, name: slug, slug } });
    base.locA = (await location(A, 'pr3-a-main')).id;
    base.locA2 = (await location(A, 'pr3-a-second')).id;
    base.locB = (await location(B, 'pr3-b-main')).id;
    const user = (tenantId: string, email: string) =>
      db.internalUser.create({
        data: {
          tenantId,
          externalProvider: 'internal-dev',
          externalSubject: `internal-dev:${email}`,
          email,
          displayName: email,
          status: 'ACTIVE',
        },
        select: { id: true, tenantId: true },
      });
    base.owner = await user(A, 'owner@pr3-a.test');
    base.ownerB = await user(B, 'owner@pr3-b.test');
    for (const [tenantId, account, by] of [
      [A, ACCT_A, base.owner.id],
      [B, ACCT_B, base.ownerB.id],
    ] as const) {
      await db.tenantPaymentAccount.create({
        data: {
          tenantId,
          provider: 'stripe',
          livemode: false,
          externalAccountId: account,
          dashboard: 'full',
          feesCollector: 'stripe',
          lossesCollector: 'stripe',
          cardPaymentsStatus: 'active',
          requirementsDue: 0,
          lastSyncedAt: new Date(),
          connectedByInternalUserId: by,
        },
      });
    }
    const product = async (tenantId: string) => {
      const category = await db.category.create({
        data: { tenantId, name: 'Coffee', slug: `c-${randomUUID()}` },
      });
      return (
        await db.product.create({
          data: {
            tenantId,
            name: 'Latte',
            slug: `p-${randomUUID()}`,
            categoryId: category.id,
          },
        })
      ).id;
    };
    base.productA = await product(A);
    base.productB = await product(B);
    base.food = (
      await db.taxClass.create({
        data: {
          tenantId: A,
          name: 'Prepared Food',
          systemKey: 'PREPARED_FOOD',
        },
      })
    ).id;
    base.grocery = (
      await db.taxClass.create({ data: { tenantId: A, name: 'Grocery' } })
    ).id;
    base.exempt = (
      await db.taxClass.create({ data: { tenantId: A, name: 'Not taxed' } })
    ).id;
    base.foodB = (
      await db.taxClass.create({
        data: {
          tenantId: B,
          name: 'Prepared Food',
          systemKey: 'PREPARED_FOOD',
        },
      })
    ).id;
    const standard = [
      { name: 'State', ratePpm: STATE, classIds: [base.food, base.grocery] },
      { name: 'City', ratePpm: CITY, classIds: [base.food] },
    ];
    base.versionA = await confirmedVersion(
      A,
      base.locA,
      base.owner.id,
      standard,
    );
    base.versionA2 = await confirmedVersion(
      A,
      base.locA2,
      base.owner.id,
      standard,
    );
    base.versionB = await confirmedVersion(B, base.locB, base.ownerB.id, [
      { name: 'State', ratePpm: STATE, classIds: [base.foodB] },
    ]);
  });

  afterAll(async () => {
    process.env = env;
    await db?.$disconnect();
    await scratch?.drop();
  });

  beforeEach(() => {
    process.env.RESTAURANT_REFUNDS_ENABLED = '1';
    process.env.ORDER_CLOSURE_ENABLED = '1';
    intents.nextRefundStatus = null;
  });

  // --- fixtures ---------------------------------------------------------------

  interface Paid {
    orderId: string;
    attemptId: string;
    tenantId: string;
    locationId: string;
    tax: number;
    total: number;
    charged: number;
  }

  interface LineSpec {
    quantity: number;
    lineTotal: number;
    taxClassId: string;
  }

  // A Stripe-paid taxed order, exactly as checkout writes it.
  async function taxedOrder(
    o: {
      tenantId?: string;
      locationId?: string;
      lines?: LineSpec[];
      giftCard?: { id: string; tender: number };
      status?: 'COMPLETED' | 'ACCEPTED';
      untaxed?: boolean;
    } = {},
  ): Promise<Paid> {
    const tenantId = o.tenantId ?? A;
    const locationId = o.locationId ?? (tenantId === A ? base.locA : base.locB);
    const lines: LineSpec[] = o.lines ?? [
      { quantity: 3, lineTotal: 1000, taxClassId: base.food },
      { quantity: 1, lineTotal: 1299, taxClassId: base.exempt },
    ];
    const productId = tenantId === A ? base.productA : base.productB;
    const version =
      tenantId === B
        ? base.versionB
        : locationId === base.locA2
          ? base.versionA2
          : base.versionA;
    const components =
      tenantId === B
        ? [
            {
              componentId: 'b-state',
              name: 'State',
              jurisdiction: 'STATE',
              ratePpm: STATE,
              taxClassIds: [base.foodB],
            },
          ]
        : [
            {
              componentId: `${version.id}-state`,
              name: 'State',
              jurisdiction: 'STATE',
              ratePpm: STATE,
              taxClassIds: [base.food, base.grocery],
            },
            {
              componentId: `${version.id}-city`,
              name: 'City',
              jurisdiction: 'CITY',
              ratePpm: CITY,
              taxClassIds: [base.food],
            },
          ];
    const result = calculateSalesTax({
      currency: 'USD',
      lines: lines.map((l, i) => ({
        lineIndex: i,
        productId,
        lineTotal: l.lineTotal,
        taxClassId: l.taxClassId,
      })),
      discounts: [],
      components,
    });
    const subtotal = result.merchandiseSubtotal;
    const tax = o.untaxed ? 0 : result.taxMinorUnits;
    const total = subtotal + tax;
    const tender = o.giftCard?.tender ?? 0;
    const charged = total - tender;
    const account = tenantId === A ? ACCT_A : ACCT_B;
    const intent = await intents.create(
      {
        amount: charged,
        currency: 'usd',
        payment_method_types: ['card'],
        metadata: { centerivo_tenant_id: tenantId },
      },
      { stripeAccount: account, idempotencyKey: `pr3-${randomUUID()}` },
    );
    intents.succeed(intent.id);
    intents.withCharge(intent.id);
    const frozen: FrozenTax = {
      taxVersionId: version.id,
      taxVersion: version.version,
      source: 'BUILT_IN',
      classes: [
        { id: base.food, name: 'Prepared Food' },
        { id: base.grocery, name: 'Grocery' },
        { id: base.exempt, name: 'Not taxed' },
      ],
      components,
      lineTaxClassIds: lines.map((l) => l.taxClassId),
      result,
    };
    return db.$transaction(async (tx) => {
      const attempt = await tx.paymentAttempt.create({
        data: {
          tenantId,
          idempotencyKey: `pr3-${randomUUID()}`,
          provider: 'stripe',
          locationId,
          amount: charged,
          currency: 'USD',
          status: 'SUCCEEDED',
          paymentState: 'SUCCEEDED',
          providerReference: intent.id,
          providerAccountId: account,
        },
      });
      const order = await tx.order.create({
        data: {
          tenantId,
          orderNumber: `PR3-${randomUUID().slice(0, 12)}`,
          accessToken: randomUUID(),
          locationId,
          paymentAttemptId: attempt.id,
          guestName: 'Guest',
          guestPhone: '5550000',
          currency: 'USD',
          subtotal,
          giftCardTenderMinorUnits: tender,
          taxMinorUnits: tax,
          status: o.status ?? 'COMPLETED',
          lines: {
            create: lines.map((l, i) => ({
              lineIndex: i,
              productId,
              productName: `Item ${i}`,
              unitPrice: l.lineTotal / l.quantity,
              quantity: l.quantity,
              lineTotal: l.lineTotal,
              currency: 'USD',
              selections: [],
            })),
          },
        },
      });
      if (o.giftCard) {
        await tx.giftCard.update({
          where: { id: o.giftCard.id },
          data: { balanceMinorUnits: { decrement: tender } },
        });
        const card = await tx.giftCard.findUniqueOrThrow({
          where: { id: o.giftCard.id },
        });
        await tx.giftCardTransaction.create({
          data: {
            tenantId,
            giftCardId: card.id,
            orderId: order.id,
            type: 'REDEMPTION',
            amountMinorUnits: -tender,
            balanceAfterMinorUnits: card.balanceMinorUnits,
          },
        });
        await tx.orderGiftCardRedemption.create({
          data: {
            tenantId,
            orderId: order.id,
            sourceGiftCardId: card.id,
            last4: '0000',
            amountMinorUnits: tender,
            currency: 'USD',
          },
        });
      }
      if (!o.untaxed) {
        await tx.orderTaxSnapshot.create({
          data: {
            tenantId,
            orderId: order.id,
            locationTaxVersionId: version.id,
            taxVersion: version.version,
            source: 'BUILT_IN',
            currency: 'USD',
            merchandiseSubtotal: subtotal,
            discountMinorUnits: 0,
            taxableMinorUnits: result.taxableMinorUnits,
            taxMinorUnits: tax,
            totalMinorUnits: total,
            giftCardTenderMinorUnits: tender,
            chargedMinorUnits: charged,
            detail: orderTaxDetail(
              frozen,
              lines.map((_, i) => `Item ${i}`),
            ),
          },
        });
      }
      return {
        orderId: order.id,
        attemptId: attempt.id,
        tenantId,
        locationId,
        tax,
        total,
        charged,
      };
    });
  }

  async function giftCard(tenantId: string, balance: number) {
    return db.giftCard.create({
      data: {
        tenantId,
        codeHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
        last4: '0000',
        status: 'ACTIVE',
        originalValueMinorUnits: balance,
        balanceMinorUnits: balance,
        currency: 'USD',
        transactions: {
          create: {
            type: 'ISSUANCE',
            amountMinorUnits: balance,
            balanceAfterMinorUnits: balance,
          },
        },
      },
    });
  }

  const reservedNow = async (paid: Paid) =>
    (
      await db.paymentRefund.findMany({
        where: {
          paymentAttemptId: paid.attemptId,
          status: { in: ['REQUESTED', 'PENDING', 'UNKNOWN', 'SUCCEEDED'] },
        },
        select: { amountMinorUnits: true },
      })
    ).reduce((sum, r) => sum + r.amountMinorUnits, 0);

  const tenantOf = (paid: Paid) => (paid.tenantId === A ? tA : tB);
  const actorOf = (paid: Paid) =>
    paid.tenantId === A ? base.owner : base.ownerB;

  const preview = (paid: Paid, items: OrderRefundItemInput[]) =>
    refunds.previewItems(
      paid.orderId,
      { locationId: paid.locationId, items },
      actorOf(paid),
      owner(),
      tenantOf(paid),
    );

  const refundItems = async (
    paid: Paid,
    items: OrderRefundItemInput[],
    over: Partial<CreateOrderRefundRequest> = {},
  ) => {
    const p = await preview(paid, items);
    return refunds.request(
      paid.orderId,
      {
        locationId: paid.locationId,
        requestId: randomUUID(),
        amountMinorUnits: p.totalMinorUnits,
        currency: 'USD',
        reasonCode: 'CUSTOMER_REQUEST',
        expectedReservedMinorUnits: await reservedNow(paid),
        items,
        ...over,
      },
      actorOf(paid),
      owner(),
      tenantOf(paid),
    );
  };

  const refundAmount = async (paid: Paid, amount: number) =>
    refunds.request(
      paid.orderId,
      {
        locationId: paid.locationId,
        requestId: randomUUID(),
        amountMinorUnits: amount,
        currency: 'USD',
        reasonCode: 'CUSTOMER_REQUEST',
        expectedReservedMinorUnits: await reservedNow(paid),
      },
      actorOf(paid),
      owner(),
      tenantOf(paid),
    );

  const taxRecordsOf = (orderId: string) =>
    db.orderTaxRefund.findMany({
      where: { orderId },
      include: { lines: true, components: true, paymentRefund: true },
      orderBy: { createdAt: 'asc' },
    });

  const today = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Detroit',
  });
  const reportFor = (tenant = tA, locationId?: string) =>
    report.getReport(
      { startDate: today, endDate: today, locationId },
      owner(),
      tenant,
    );

  // --- item refunds -----------------------------------------------------------

  it('refunds whole items from the original snapshot: net price plus each tax component', async () => {
    const paid = await taxedOrder();
    // Line 0: 3 food items, $10.00, tax 60 + 13; line 1: exempt, $12.99.
    const p = await preview(paid, [{ lineIndex: 0, quantity: 3 }]);
    expect(p).toMatchObject({
      merchandiseMinorUnits: 1000,
      taxMinorUnits: 73,
      totalMinorUnits: 1073,
    });
    expect(p.components.map((c) => [c.name, c.taxMinorUnits])).toEqual([
      ['State', 60],
      ['City', 13],
    ]);
    const done = await refundItems(paid, [{ lineIndex: 0, quantity: 3 }]);
    expect(done.refund).toMatchObject({
      status: 'SUCCEEDED',
      amountMinorUnits: 1073,
      taxAttribution: 'ITEMS',
      taxMinorUnits: 73,
      items: [{ lineIndex: 0, productName: 'Item 0', quantity: 3 }],
    });
    const [record] = await taxRecordsOf(paid.orderId);
    expect(record).toMatchObject({
      kind: 'ITEM',
      locationId: paid.locationId,
      merchandiseMinorUnits: 1000,
      taxMinorUnits: 73,
    });
    expect(
      record.components
        .map((c) => [
          c.lineIndex,
          c.name,
          c.jurisdiction,
          c.ratePpm,
          c.taxMinorUnits,
        ])
        .sort(),
    ).toEqual(
      [
        [0, 'City', 'CITY', CITY, 13],
        [0, 'State', 'STATE', STATE, 60],
      ].sort(),
    );
  });

  it('partial quantities add up to exactly the line, never more; then nothing is left', async () => {
    const paid = await taxedOrder();
    const amounts: number[] = [];
    for (let i = 0; i < 3; i++) {
      const done = await refundItems(paid, [{ lineIndex: 0, quantity: 1 }]);
      amounts.push(done.refund.amountMinorUnits);
    }
    // 333 + 20 + 4, 333 + 20 + 4, 334 + 20 + 5.
    expect(amounts).toEqual([357, 357, 359]);
    const records = await taxRecordsOf(paid.orderId);
    expect(records.reduce((s, r) => s + r.taxMinorUnits, 0)).toBe(73);
    expect(records.reduce((s, r) => s + r.merchandiseMinorUnits, 0)).toBe(1000);
    await expect(
      preview(paid, [{ lineIndex: 0, quantity: 1 }]),
    ).rejects.toThrow('Every unit of that item has already been refunded.');
  });

  it('an exempt item returns no tax; a mixed refund returns tax for the taxable item only', async () => {
    const paid = await taxedOrder();
    const done = await refundItems(paid, [
      { lineIndex: 1, quantity: 1 },
      { lineIndex: 0, quantity: 1 },
    ]);
    expect(done.refund.amountMinorUnits).toBe(1299 + 333 + 24);
    const [record] = await taxRecordsOf(paid.orderId);
    expect(
      record.lines
        .map((l) => [l.lineIndex, l.merchandiseMinorUnits, l.taxMinorUnits])
        .sort(),
    ).toEqual([
      [0, 333, 24],
      [1, 1299, 0],
    ]);
  });

  it('a repeated request returns the same refund (no second tax record); another amount is refused', async () => {
    const paid = await taxedOrder();
    const items = [{ lineIndex: 0, quantity: 1 }];
    const p = await preview(paid, items);
    const body = {
      locationId: paid.locationId,
      requestId: randomUUID(),
      amountMinorUnits: p.totalMinorUnits,
      currency: 'USD',
      reasonCode: 'CUSTOMER_REQUEST' as const,
      expectedReservedMinorUnits: 0,
      items,
    };
    const first = await refunds.request(
      paid.orderId,
      body,
      base.owner,
      owner(),
      tA,
    );
    const again = await refunds.request(
      paid.orderId,
      body,
      base.owner,
      owner(),
      tA,
    );
    expect(again).toMatchObject({
      replayed: true,
      refund: { id: first.refund.id },
    });
    expect(await taxRecordsOf(paid.orderId)).toHaveLength(1);
    // The same request id with other items is a different request.
    await expect(
      refunds.request(
        paid.orderId,
        { ...body, items: [{ lineIndex: 0, quantity: 2 }] },
        base.owner,
        owner(),
        tA,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    // An amount that is not what the items return (a stale preview).
    await expect(
      refunds.request(
        paid.orderId,
        {
          ...body,
          requestId: randomUUID(),
          amountMinorUnits: p.totalMinorUnits + 1,
          expectedReservedMinorUnits: await reservedNow(paid),
        },
        base.owner,
        owner(),
        tA,
      ),
    ).rejects.toThrow('changed since you looked');
  });

  it('a failed card refund returns no tax and frees its items to refund again', async () => {
    const paid = await taxedOrder();
    intents.nextRefundStatus = 'failed';
    const failed = await refundItems(paid, [{ lineIndex: 0, quantity: 3 }]);
    expect(failed.refund.status).toBe('FAILED');
    const lines = (
      await refunds.listForOrder(
        paid.orderId,
        paid.locationId,
        base.owner,
        owner(),
        tA,
      )
    ).itemRefundLines!;
    expect(lines[0]).toMatchObject({
      refundedQuantity: 0,
      remainingQuantity: 3,
    });
    const again = await refundItems(paid, [{ lineIndex: 0, quantity: 3 }]);
    expect(again.refund).toMatchObject({
      status: 'SUCCEEDED',
      taxMinorUnits: 73,
    });
    // The report counts the succeeded one only; the failed one apart.
    const r = await reportFor();
    const row = r.refunds.filter((x) => x.orderId === paid.orderId);
    expect(row.map((x) => x.status).sort()).toEqual(['CONFIRMED', 'FAILED']);
  });

  it('a pending card refund is not counted as refunded tax', async () => {
    const paid = await taxedOrder({ locationId: base.locA2 });
    intents.nextRefundStatus = 'pending';
    await refundItems(paid, [{ lineIndex: 0, quantity: 3 }]);
    const r = await reportFor(tA, base.locA2);
    expect(r.refunds.find((x) => x.orderId === paid.orderId)?.status).toBe(
      'PENDING',
    );
    expect(r.pendingTaxRefundMinorUnits).toBeGreaterThanOrEqual(73);
  });

  it('split gift card and card: items refund to the card only, within what the card paid', async () => {
    const card = await giftCard(A, 2000);
    const paid = await taxedOrder({ giftCard: { id: card.id, tender: 1500 } });
    // Total 2372 (2299 + 73): the card paid 872.
    expect(paid.charged).toBe(2372 - 1500);
    await expect(
      refundItems(paid, [{ lineIndex: 1, quantity: 1 }]), // 1299 > 872
    ).rejects.toThrow('more than is left to refund');
    const done = await refundItems(paid, [{ lineIndex: 0, quantity: 2 }]); // 714
    expect(done.refund.amountMinorUnits).toBe(666 + 48);
    // The gift card is never touched by a card refund.
    expect(
      (await db.giftCard.findUniqueOrThrow({ where: { id: card.id } }))
        .balanceMinorUnits,
    ).toBe(500);
  });

  it('an amount-only refund keeps working, and its tax is reported unattributed (net tax withheld)', async () => {
    const paid = await taxedOrder({ locationId: base.locA2 });
    const done = await refundAmount(paid, 500);
    expect(done.refund).toMatchObject({
      status: 'SUCCEEDED',
      taxAttribution: 'UNATTRIBUTED',
      taxMinorUnits: null,
      items: [],
    });
    expect(await taxRecordsOf(paid.orderId)).toHaveLength(0);
    const r = await reportFor(tA, base.locA2);
    expect(r.unattributedRefunds).toBeGreaterThanOrEqual(1);
    expect(r.totals.netTaxMinorUnits).toBeNull();
    expect(r.locations[0].netTaxMinorUnits).toBeNull();
    expect(r.components.every((c) => c.netTaxMinorUnits === null)).toBe(true);
    expect(r.refunds.find((x) => x.orderId === paid.orderId)).toMatchObject({
      kind: 'UNATTRIBUTED',
      status: 'UNRESOLVED',
      taxMinorUnits: null,
    });
    // The CSV says so too, never a number.
    const csv = salesTaxCsvRows(r).map((row) => row.join(','));
    expect(csv.some((line) => line.startsWith('Warning,'))).toBe(true);
    expect(csv.some((line) => line.includes('NOT FINAL'))).toBe(true);
  });

  it('a cancellation returns the whole tax; it counts once the card money is refunded', async () => {
    const card = await giftCard(A, 1000);
    const paid = await taxedOrder({
      status: 'ACCEPTED',
      giftCard: { id: card.id, tender: 1000 },
    });
    await closure.close(
      {
        kind: 'CANCELLED',
        orderId: paid.orderId,
        locationId: paid.locationId,
        expectedStatus: 'ACCEPTED',
        reasonCode: 'CUSTOMER_REQUEST',
      },
      base.owner,
      owner(),
      tA,
    );
    const [record] = await taxRecordsOf(paid.orderId);
    expect(record).toMatchObject({
      kind: 'CLOSURE',
      merchandiseMinorUnits: 2299,
      taxMinorUnits: 73,
    });
    // Gift card restored at once; the card part is owed: pending.
    let row = (await reportFor()).refunds.find(
      (x) => x.orderId === paid.orderId,
    )!;
    expect(row).toMatchObject({
      kind: 'CANCELLATION',
      status: 'PENDING',
      taxMinorUnits: 73,
    });
    // Refund what the card paid (the obligation): then it counts.
    const owed = await refundAmount(paid, paid.charged);
    expect(owed.refund).toMatchObject({
      status: 'SUCCEEDED',
      taxAttribution: 'CANCELLATION',
    });
    row = (await reportFor()).refunds.find((x) => x.orderId === paid.orderId)!;
    expect(row.status).toBe('CONFIRMED');
    // Items cannot be refunded on a cancelled order (it is refunded whole).
    await expect(
      preview(paid, [{ lineIndex: 0, quantity: 1 }]),
    ).rejects.toThrow('completed order');
  });

  it('a cancellation paid entirely by gift card counts at once', async () => {
    const card = await giftCard(A, 5000);
    const paid = await taxedOrder({
      status: 'ACCEPTED',
      locationId: base.locA2,
      giftCard: { id: card.id, tender: 2372 },
    });
    await closure.close(
      {
        kind: 'CANCELLED',
        orderId: paid.orderId,
        locationId: paid.locationId,
        expectedStatus: 'ACCEPTED',
        reasonCode: 'CUSTOMER_REQUEST',
      },
      base.owner,
      owner(),
      tA,
    );
    const row = (await reportFor(tA, base.locA2)).refunds.find(
      (x) => x.orderId === paid.orderId,
    )!;
    expect(row).toMatchObject({ kind: 'CANCELLATION', status: 'CONFIRMED' });
  });

  it('historical untaxed orders: items are not refunded one by one, amounts still are, and the report ignores them', async () => {
    const paid = await taxedOrder({ untaxed: true });
    await expect(
      preview(paid, [{ lineIndex: 0, quantity: 1 }]),
    ).rejects.toThrow('no sales tax record');
    const done = await refundAmount(paid, 100);
    expect(done.refund.taxAttribution).toBe('NOT_TAXED');
    const view = await refunds.listForOrder(
      paid.orderId,
      paid.locationId,
      base.owner,
      owner(),
      tA,
    );
    expect(view.itemRefundLines).toBeNull();
    const r = await reportFor();
    expect(r.refunds.some((x) => x.orderId === paid.orderId)).toBe(false);
  });

  it('isolation: another business never reaches the order, and reports only its own tax', async () => {
    const paid = await taxedOrder();
    await expect(
      refunds.previewItems(
        paid.orderId,
        { locationId: paid.locationId, items: [{ lineIndex: 0, quantity: 1 }] },
        base.ownerB,
        owner(),
        tB,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    // A Refund Manager at another location cannot refund here.
    await expect(
      refunds.previewItems(
        paid.orderId,
        { locationId: paid.locationId, items: [{ lineIndex: 0, quantity: 1 }] },
        base.owner,
        refundManagerAt(base.locA2),
        tA,
      ),
    ).rejects.toThrow();
    const bOrder = await taxedOrder({
      tenantId: B,
      lines: [{ quantity: 1, lineTotal: 1000, taxClassId: base.foodB }],
    });
    const rB = await reportFor(tB);
    expect(rB.locations.map((l) => l.locationId)).toEqual([base.locB]);
    expect(rB.totals).toMatchObject({
      orders: 1,
      taxCollectedMinorUnits: bOrder.tax,
    });
    // Business B cannot filter by Business A's location.
    await expect(reportFor(tB, base.locA)).rejects.toThrow('Unknown location');
  });

  it('reports collected, confirmed refunded and net by location and component, and the CSV agrees', async () => {
    const r = await reportFor(tA, base.locA);
    const totals = r.totals;
    expect(totals.exemptSalesMinorUnits).toBe(
      totals.netSalesMinorUnits - totals.taxableSalesMinorUnits,
    );
    // Net is withheld only if refunds in the period are unattributed.
    if (r.unattributedRefunds === 0) {
      expect(totals.netTaxMinorUnits).toBe(
        totals.taxCollectedMinorUnits - totals.taxRefundedMinorUnits,
      );
    }
    const collectedByComponent = r.components.reduce(
      (s, c) => s + c.taxCollectedMinorUnits,
      0,
    );
    expect(collectedByComponent).toBe(totals.taxCollectedMinorUnits);
    const refundedByComponent = r.components.reduce(
      (s, c) => s + c.taxRefundedMinorUnits,
      0,
    );
    expect(refundedByComponent).toBe(totals.taxRefundedMinorUnits);
    const csv = salesTaxCsvRows(r).map((row) => row.join(','));
    const dollars = (v: number) =>
      `${Math.floor(v / 100)}.${String(v % 100).padStart(2, '0')}`;
    expect(csv.find((line) => line.startsWith('All locations,'))).toContain(
      dollars(totals.taxCollectedMinorUnits),
    );
  });

  it('the database keeps tax refunds immutable and tied to their own card refund', async () => {
    const paid = await taxedOrder();
    await refundItems(paid, [{ lineIndex: 0, quantity: 1 }]);
    const [record] = await taxRecordsOf(paid.orderId);
    await expect(
      db.orderTaxRefund.update({
        where: { id: record.id },
        data: { taxMinorUnits: 0 },
      }),
    ).rejects.toThrow();
    await expect(
      db.orderTaxRefund.delete({ where: { id: record.id } }),
    ).rejects.toThrow();
    // A tax record that does not add up to its card refund is refused.
    const other = await taxedOrder();
    const done = await refundAmount(other, 400);
    const snapshot = await db.orderTaxSnapshot.findUniqueOrThrow({
      where: { orderId: other.orderId },
    });
    await expect(
      db.orderTaxRefund.create({
        data: {
          tenantId: A,
          orderId: other.orderId,
          locationId: other.locationId,
          orderTaxSnapshotId: snapshot.id,
          kind: 'ITEM',
          paymentRefundId: done.refund.id,
          currency: 'USD',
          merchandiseMinorUnits: 300,
          taxMinorUnits: 50,
          createdByInternalUserId: base.owner.id,
        },
      }),
    ).rejects.toThrow();
  });
});
