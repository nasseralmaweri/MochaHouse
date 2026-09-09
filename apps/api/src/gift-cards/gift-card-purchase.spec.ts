import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  type ExecutionContext,
} from '@nestjs/common';
import { FakePaymentProvider } from '@mocha-house/integrations';
import type { CustomerIdentity } from '../customer-auth/infrastructure/customer-identity';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomersModule } from '../customers/customers.module';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { RedisModule } from '../redis/redis.module';
import { RedisService } from '../redis/redis.service';
import { PaymentModule } from '../payment/payment.module';
import { PAYMENT_PROVIDER } from '../payment/payment-provider.token';
import { GiftCardsModule } from './gift-cards.module';
import { GiftCardPurchaseService } from './application/gift-card-purchase.service';
import { GiftCardBalanceService } from './application/gift-card-balance.service';
import { GiftCardConfigurationService } from './application/gift-card-configuration.service';
import { GiftCardPublicThrottleGuard } from './infrastructure/gift-card-public-throttle.guard';
import {
  canonicalizeGiftCardCode,
  hashGiftCardCode,
} from './infrastructure/gift-card-code';
import { GIFT_CARD_CONFIGURATION_KEY } from './application/gift-card-configuration.service';

// Milestone 7H — customer digital gift-card purchase + public balance lookup,
// exercised through the real services against the real local Postgres (like
// gift-card-redemption.spec.ts). No HTTP layer: the purchase/replay/recovery
// logic, the financial invariants, the encryption-at-rest recovery window,
// the balance lookup and the endpoint throttle are all tested directly.
//
// The KEK and code secret are set per-suite (the helpers read process.env at
// call time). Everything created is tracked by idempotencyKey for cleanup.
describe('Customer gift-card purchase (integration)', () => {
  let prisma: PrismaService;
  let purchases: GiftCardPurchaseService;
  let balance: GiftCardBalanceService;
  let configuration: GiftCardConfigurationService;
  let throttleGuard: GiftCardPublicThrottleGuard;
  let redis: RedisService;
  let paymentProvider: FakePaymentProvider;
  let moduleRef: TestingModule;

  const originalEnv = { ...process.env };
  const KEK_A =
    'c4097ecec7942a636761a7c4acc30277edaa900a9ee56f4974c8993a344e963e';
  const KEK_B =
    '9f2b1c0d5e6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f7a8b9c0d1e2f3a4b';

  const idempotencyKeys = new Set<string>();
  const customerSubjects = new Set<string>();
  const trackedOrderIds: string[] = [];

  function key(): string {
    const k = randomUUID();
    idempotencyKeys.add(k);
    return k;
  }

  function buildRequest(
    overrides: Partial<{
      idempotencyKey: string;
      amountMinorUnits: number;
      purchaserEmail: string;
      purchaserName: string | null;
    }> = {},
  ) {
    return {
      idempotencyKey: overrides.idempotencyKey ?? key(),
      amountMinorUnits: overrides.amountMinorUnits ?? 2500,
      purchaserEmail: overrides.purchaserEmail ?? 'gcp-buyer@example.com',
      purchaserName:
        overrides.purchaserName === undefined
          ? 'GCP Buyer'
          : overrides.purchaserName,
    };
  }

  function signedIn(): CustomerIdentity {
    const subject = `internal-dev:gcp-${randomUUID()}`;
    customerSubjects.add(subject);
    return {
      provider: 'internal-dev',
      subject,
      email: `${subject}@example.com`,
      name: 'GCP Customer',
      emailVerified: true,
    };
  }

  function throttleContext(ip: string): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ headers: { 'x-forwarded-for': ip }, ip }),
      }),
    } as unknown as ExecutionContext;
  }

  async function setConfig(patch: {
    presetAmountsMinorUnits?: number[];
    customAmountEnabled?: boolean;
  }): Promise<void> {
    await prisma.giftCardConfiguration.upsert({
      where: { key: GIFT_CARD_CONFIGURATION_KEY },
      create: {
        key: GIFT_CARD_CONFIGURATION_KEY,
        presetAmountsMinorUnits: patch.presetAmountsMinorUnits ?? [
          1000, 2500, 5000, 10000,
        ],
        customAmountEnabled: patch.customAmountEnabled ?? true,
      },
      update: patch,
    });
  }

  beforeAll(async () => {
    process.env.GIFT_CARD_CODE_SECRET = 'gift-card-purchase-spec-secret';
    process.env.GIFT_CARD_PURCHASE_CODE_KEK = KEK_A;

    moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule,
        CustomersModule,
        CustomerAuthModule,
        InternalAuthModule,
        RedisModule,
        PaymentModule,
        GiftCardsModule,
      ],
    }).compile();

    await moduleRef.init();

    prisma = moduleRef.get(PrismaService);
    purchases = moduleRef.get(GiftCardPurchaseService);
    balance = moduleRef.get(GiftCardBalanceService);
    configuration = moduleRef.get(GiftCardConfigurationService);
    throttleGuard = moduleRef.get(GiftCardPublicThrottleGuard);
    redis = moduleRef.get(RedisService);
    paymentProvider = moduleRef.get(PAYMENT_PROVIDER);
    await prisma.$connect();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    process.env.GIFT_CARD_PURCHASE_CODE_KEK = KEK_A;
    await setConfig({
      presetAmountsMinorUnits: [1000, 2500, 5000, 10000],
      customAmountEnabled: true,
    });
  });

  afterAll(async () => {
    process.env = { ...originalEnv };
    const keys = [...idempotencyKeys];
    const attempts = await prisma.paymentAttempt.findMany({
      where: { idempotencyKey: { in: keys } },
      select: { id: true },
    });
    const attemptIds = attempts.map((a) => a.id);
    const gcPurchases = await prisma.giftCardPurchase.findMany({
      where: { paymentAttemptId: { in: attemptIds } },
      select: { id: true, giftCardId: true },
    });
    const purchaseIds = gcPurchases.map((p) => p.id);
    const giftCardIds = gcPurchases
      .map((p) => p.giftCardId)
      .filter((v): v is string => v !== null);

    await prisma.giftCardTransaction.deleteMany({
      where: {
        OR: [
          { giftCardPurchaseId: { in: purchaseIds } },
          { giftCardId: { in: giftCardIds } },
        ],
      },
    });
    await prisma.giftCardPurchase.deleteMany({ where: { id: { in: purchaseIds } } });
    await prisma.giftCard.deleteMany({ where: { id: { in: giftCardIds } } });
    await prisma.order.deleteMany({ where: { id: { in: trackedOrderIds } } });
    await prisma.paymentAttempt.deleteMany({ where: { id: { in: attemptIds } } });
    await prisma.customer.deleteMany({
      where: { externalSubject: { in: [...customerSubjects] } },
    });
    await moduleRef.close();
  });

  // --- purchase options ------------------------------------------

  it('exposes only the amount rules a buyer needs (no internal metadata)', async () => {
    const options = await configuration.getPublicOptions();
    expect(options.presetAmountsMinorUnits).toEqual([1000, 2500, 5000, 10000]);
    expect(options.customAmountEnabled).toBe(true);
    expect(options.customAmountMinMinorUnits).toBe(500);
    expect(options.customAmountMaxMinorUnits).toBe(50_000);
    expect(options.currency).toBe('USD');
    expect(Object.keys(options).sort()).toEqual(
      [
        'currency',
        'customAmountEnabled',
        'customAmountMaxMinorUnits',
        'customAmountMinMinorUnits',
        'presetAmountsMinorUnits',
      ].sort(),
    );
  });

  // --- happy path ----------------------------------------------

  it('a guest preset purchase: issues a card, returns the full code once, stores it encrypted', async () => {
    const chargeSpy = jest.spyOn(paymentProvider, 'charge');
    const req = buildRequest({ amountMinorUnits: 2500 });
    const res = await purchases.purchase(req);

    expect(chargeSpy).toHaveBeenCalledTimes(1);
    expect(chargeSpy.mock.calls[0][0].amount).toBe(2500);
    expect(res.status).toBe('ISSUED');
    expect(res.amountMinorUnits).toBe(2500);
    expect(res.currency).toBe('USD');
    expect(res.code).toMatch(/^[0-9A-Z]{4}( [0-9A-Z]{4}){3}$/);
    expect(res.codeRetrievable).toBe(true);
    expect(res.maskedCode).toBe(`•••• •••• •••• ${res.last4}`);
    const until = new Date(res.codeRetrievableUntil!).getTime();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(until - Date.now()).toBeGreaterThan(sevenDays - 60_000);
    expect(until - Date.now()).toBeLessThan(sevenDays + 60_000);

    // The card exists with the full balance and the code resolves to it.
    const canonical = canonicalizeGiftCardCode(res.code)!;
    const card = await prisma.giftCard.findUniqueOrThrow({
      where: { codeHash: hashGiftCardCode(canonical) },
    });
    expect(card.balanceMinorUnits).toBe(2500);
    expect(card.originalValueMinorUnits).toBe(2500);
    expect(card.currency).toBe('USD');
    expect(card.status).toBe('ACTIVE');

    // Exactly one ISSUANCE ledger entry, linked to the purchase, HQ actor null.
    const txns = await prisma.giftCardTransaction.findMany({
      where: { giftCardId: card.id },
    });
    expect(txns).toHaveLength(1);
    expect(txns[0].type).toBe('ISSUANCE');
    expect(txns[0].amountMinorUnits).toBe(2500);
    expect(txns[0].actorInternalUserId).toBeNull();
    expect(txns[0].giftCardPurchaseId).toBe(res.purchaseId);

    // Ledger SUM == materialized balance.
    const sum = txns.reduce((acc, t) => acc + t.amountMinorUnits, 0);
    expect(sum).toBe(card.balanceMinorUnits);

    // PaymentAttempt: SUCCEEDED, no location, 1:1 with the purchase, no Order.
    const purchase = await prisma.giftCardPurchase.findUniqueOrThrow({
      where: { id: res.purchaseId },
      include: { paymentAttempt: { include: { order: true } } },
    });
    expect(purchase.customerId).toBeNull();
    expect(purchase.purchaserEmail).toBe('gcp-buyer@example.com');
    expect(purchase.paymentAttempt.status).toBe('SUCCEEDED');
    expect(purchase.paymentAttempt.locationId).toBeNull();
    expect(purchase.paymentAttempt.order).toBeNull();
    expect(purchase.paymentAttempt.reconciliationRequired).toBe(false);
  });

  it('a signed-in purchase links the customer; the code is not stored in plaintext anywhere', async () => {
    const identity = signedIn();
    const res = await purchases.purchase(buildRequest(), identity);

    const purchase = await prisma.giftCardPurchase.findUniqueOrThrow({
      where: { id: res.purchaseId },
    });
    expect(purchase.customerId).not.toBeNull();

    const canonical = canonicalizeGiftCardCode(res.code)!;

    // Encrypted material is present and reveals nothing.
    expect(purchase.codeCiphertext).not.toBeNull();
    expect(purchase.codeIv).not.toBeNull();
    expect(purchase.codeAuthTag).not.toBeNull();
    const cipherText = Buffer.from(purchase.codeCiphertext!).toString('latin1');
    expect(cipherText).not.toContain(canonical);
    expect(Buffer.from(purchase.codeIv!)).toHaveLength(12);
    expect(Buffer.from(purchase.codeAuthTag!)).toHaveLength(16);

    // No column of any related row contains the plaintext / canonical code.
    const txns = await prisma.giftCardTransaction.findMany({
      where: { giftCardPurchaseId: res.purchaseId },
    });
    expect(JSON.stringify(txns)).not.toContain(canonical);
    const attempt = await prisma.paymentAttempt.findFirstOrThrow({
      where: { idempotencyKey: { in: [...idempotencyKeys] }, giftCardPurchase: { id: res.purchaseId } },
    });
    expect(JSON.stringify(attempt)).not.toContain(canonical);

    // No outbox event and no internal-audit event carry it (or exist for it).
    const outbox = await prisma.outboxEvent.findMany({
      where: { createdAt: { gte: new Date(Date.now() - 60_000) } },
    });
    expect(JSON.stringify(outbox)).not.toContain(canonical);
    const audit = await prisma.internalAuditEvent.findMany({
      where: { createdAt: { gte: new Date(Date.now() - 60_000) } },
    });
    expect(JSON.stringify(audit)).not.toContain(canonical);
    expect(JSON.stringify(audit)).not.toContain(res.purchaseId);
  });

  it('does NOT write an InternalAuditEvent for a routine customer purchase', async () => {
    const before = await prisma.internalAuditEvent.count();
    await purchases.purchase(buildRequest());
    const after = await prisma.internalAuditEvent.count();
    expect(after).toBe(before);
  });

  it('the database forbids one PaymentAttempt from backing both an Order and a gift-card purchase', async () => {
    const location = await prisma.location.findUniqueOrThrow({
      where: { slug: 'dearborn-heights' },
    });
    const idempotencyKey = key();
    const attempt = await prisma.paymentAttempt.create({
      data: {
        idempotencyKey,
        provider: 'fake',
        locationId: location.id,
        amount: 100,
        currency: 'USD',
        status: 'SUCCEEDED',
      },
    });
    const order = await prisma.order.create({
      data: {
        orderNumber: `GCP-TRIG-${Date.now()}`,
        accessToken: randomUUID(),
        locationId: location.id,
        paymentAttemptId: attempt.id,
        guestName: 'Trigger Spec',
        guestPhone: '5550000000',
        currency: 'USD',
        subtotal: 100,
      },
    });
    trackedOrderIds.push(order.id);

    // The BEFORE INSERT trigger on GiftCardPurchase rejects reusing this
    // attempt.
    await expect(
      prisma.giftCardPurchase.create({
        data: {
          paymentAttemptId: attempt.id,
          amountMinorUnits: 100,
          currency: 'USD',
          purchaserEmail: 'trigger@example.com',
        },
      }),
    ).rejects.toThrow();
  });

  // --- amount rules -------------------------------------------

  it('accepts the minimum ($5.00) and maximum ($500.00) custom amounts', async () => {
    const lo = await purchases.purchase(buildRequest({ amountMinorUnits: 500 }));
    expect(lo.amountMinorUnits).toBe(500);
    const hi = await purchases.purchase(
      buildRequest({ amountMinorUnits: 50_000 }),
    );
    expect(hi.amountMinorUnits).toBe(50_000);
  });

  it('rejects a custom amount below $5.00 or above $500.00 before charging', async () => {
    const chargeSpy = jest.spyOn(paymentProvider, 'charge');
    await expect(
      purchases.purchase(buildRequest({ amountMinorUnits: 499 })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      purchases.purchase(buildRequest({ amountMinorUnits: 50_001 })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(chargeSpy).not.toHaveBeenCalled();
  });

  it('a preset above the custom max is still purchasable', async () => {
    await setConfig({ presetAmountsMinorUnits: [2500, 120_000] });
    const res = await purchases.purchase(
      buildRequest({ amountMinorUnits: 120_000 }),
    );
    expect(res.status).toBe('ISSUED');
    expect(res.amountMinorUnits).toBe(120_000);
  });

  it('when custom amounts are disabled, only presets are accepted', async () => {
    await setConfig({
      presetAmountsMinorUnits: [1000, 2500],
      customAmountEnabled: false,
    });
    const ok = await purchases.purchase(
      buildRequest({ amountMinorUnits: 1000 }),
    );
    expect(ok.status).toBe('ISSUED');
    await expect(
      purchases.purchase(buildRequest({ amountMinorUnits: 700 })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an amount over the absolute ceiling, a non-integer, and zero', async () => {
    for (const amt of [200_001, 12.5, 0, -100]) {
      await expect(
        purchases.purchase(buildRequest({ amountMinorUnits: amt })),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('rejects a missing email and a non-UUID idempotency key', async () => {
    await expect(
      purchases.purchase(buildRequest({ purchaserEmail: '   ' })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      purchases.purchase({
        idempotencyKey: 'not-a-uuid',
        amountMinorUnits: 2500,
        purchaserEmail: 'x@example.com',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // --- payment failure ---------------------------------------

  it('a declined payment: 402, no card issued, replay stays 402', async () => {
    jest
      .spyOn(paymentProvider, 'charge')
      .mockResolvedValue({ outcome: 'declined', reason: 'Card declined' });
    const req = buildRequest();
    await expect(purchases.purchase(req)).rejects.toBeInstanceOf(HttpException);

    const attempt = await prisma.paymentAttempt.findUniqueOrThrow({
      where: { idempotencyKey: req.idempotencyKey },
      include: { giftCardPurchase: { include: { giftCard: true } } },
    });
    expect(attempt.status).toBe('DECLINED');
    expect(attempt.giftCardPurchase?.giftCardId).toBeNull();

    // Replay resolves the same terminal state without a second charge.
    const chargeSpy = jest.spyOn(paymentProvider, 'charge');
    chargeSpy.mockClear();
    await expect(purchases.purchase(req)).rejects.toMatchObject({
      status: 402,
    });
    expect(chargeSpy).not.toHaveBeenCalled();
  });

  it('a failed payment: 402', async () => {
    jest
      .spyOn(paymentProvider, 'charge')
      .mockResolvedValue({ outcome: 'failed', reason: 'Gateway timeout' });
    await expect(
      purchases.purchase(buildRequest()),
    ).rejects.toMatchObject({ status: 402 });
  });

  // --- payment ok but issuance fails -> reconciliation --------

  it('payment succeeds but issuance fails: reconciliation recorded, no card, retry does not re-charge', async () => {
    const chargeSpy = jest.spyOn(paymentProvider, 'charge');
    const txSpy = jest
      .spyOn(prisma, '$transaction')
      .mockRejectedValueOnce(new Error('issuance boom'));

    const req = buildRequest();
    await expect(purchases.purchase(req)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(chargeSpy).toHaveBeenCalledTimes(1);
    txSpy.mockRestore();

    const attempt = await prisma.paymentAttempt.findUniqueOrThrow({
      where: { idempotencyKey: req.idempotencyKey },
      include: { giftCardPurchase: true },
    });
    expect(attempt.status).toBe('SUCCEEDED');
    expect(attempt.reconciliationRequired).toBe(true);
    expect(attempt.giftCardPurchase?.status).toBe('RECONCILIATION_REQUIRED');
    expect(attempt.giftCardPurchase?.giftCardId).toBeNull();

    // Retry: no second charge, still surfaced as a conflict.
    await expect(purchases.purchase(req)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(chargeSpy).toHaveBeenCalledTimes(1);
  });

  // --- idempotency / concurrency ----------------------------

  it('a duplicate sequential request with the same key returns the same card + code', async () => {
    const req = buildRequest();
    const first = await purchases.purchase(req);
    const chargeSpy = jest.spyOn(paymentProvider, 'charge');
    const second = await purchases.purchase(req);

    expect(chargeSpy).not.toHaveBeenCalled();
    expect(second.purchaseId).toBe(first.purchaseId);
    expect(second.last4).toBe(first.last4);
    expect(second.code).toBe(first.code);
  });

  it('concurrent requests with the same key issue exactly one card and charge once', async () => {
    const req = buildRequest();
    const chargeSpy = jest.spyOn(paymentProvider, 'charge');

    const results = await Promise.allSettled([
      purchases.purchase(req),
      purchases.purchase(req),
      purchases.purchase(req),
    ]);

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof purchases.purchase>>> =>
        r.status === 'fulfilled',
    );
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(chargeSpy).toHaveBeenCalledTimes(1);

    const attempt = await prisma.paymentAttempt.findUniqueOrThrow({
      where: { idempotencyKey: req.idempotencyKey },
      include: { giftCardPurchase: true },
    });
    const cardCount = await prisma.giftCard.count({
      where: { purchase: { id: attempt.giftCardPurchase!.id } },
    });
    expect(cardCount).toBe(1);
    const issuanceCount = await prisma.giftCardTransaction.count({
      where: { giftCardPurchaseId: attempt.giftCardPurchase!.id, type: 'ISSUANCE' },
    });
    expect(issuanceCount).toBe(1);
  });

  // --- lost-response recovery -------------------------------

  it('a guest can recover the full code via the same key within the window', async () => {
    const req = buildRequest();
    const first = await purchases.purchase(req);
    const replay = await purchases.purchase(req);
    expect(replay.code).toBe(first.code);
    expect(replay.codeRetrievable).toBe(true);
  });

  it('a signed-in buyer recovers the code with their identity; a different customer does not', async () => {
    const owner = signedIn();
    const req = buildRequest();
    const first = await purchases.purchase(req, owner);

    const sameOwner = await purchases.purchase(req, owner);
    expect(sameOwner.code).toBe(first.code);

    const stranger = signedIn();
    const strangerView = await purchases.purchase(req, stranger);
    expect(strangerView.code).toBeNull();
    expect(strangerView.codeRetrievable).toBe(false);
    // ...but the confirmation (masked) is still returned.
    expect(strangerView.purchaseId).toBe(first.purchaseId);
    expect(strangerView.last4).toBe(first.last4);
  });

  it('after the retrieval deadline the code is gone but the confirmation remains', async () => {
    const req = buildRequest();
    const first = await purchases.purchase(req);
    const purchase = await prisma.giftCardPurchase.findFirstOrThrow({
      where: { paymentAttempt: { idempotencyKey: req.idempotencyKey } },
    });
    await prisma.giftCardPurchase.update({
      where: { id: purchase.id },
      data: { codeRetrievableUntil: new Date(Date.now() - 1000) },
    });

    const replay = await purchases.purchase(req);
    expect(replay.code).toBeNull();
    expect(replay.codeRetrievable).toBe(false);
    expect(replay.last4).toBe(first.last4);
    expect(replay.maskedCode).toBe(first.maskedCode);
  });

  it('a rotated KEK makes the code unrecoverable but does not throw or re-charge', async () => {
    const req = buildRequest();
    await purchases.purchase(req);

    process.env.GIFT_CARD_PURCHASE_CODE_KEK = KEK_B;
    const chargeSpy = jest.spyOn(paymentProvider, 'charge');
    const replay = await purchases.purchase(req);
    expect(replay.code).toBeNull();
    expect(replay.codeRetrievable).toBe(false);
    expect(chargeSpy).not.toHaveBeenCalled();
  });

  // --- balance lookup --------------------------------------

  it('balance lookup: active card returns masked identity + balance + status only', async () => {
    const res = await purchases.purchase(buildRequest({ amountMinorUnits: 5000 }));
    const lookup = await balance.lookup(res.code);
    expect(lookup).toEqual({
      found: true,
      maskedCode: res.maskedCode,
      last4: res.last4,
      balanceMinorUnits: 5000,
      currency: 'USD',
      status: 'active',
    });
  });

  it('balance lookup: a zero-balance card reads as depleted, an inactive card as inactive', async () => {
    const depleted = await purchases.purchase(buildRequest());
    const dCanon = canonicalizeGiftCardCode(depleted.code)!;
    await prisma.giftCard.update({
      where: { codeHash: hashGiftCardCode(dCanon) },
      data: { balanceMinorUnits: 0 },
    });
    expect((await balance.lookup(depleted.code)).status).toBe('depleted');

    const inactive = await purchases.purchase(buildRequest());
    const iCanon = canonicalizeGiftCardCode(inactive.code)!;
    await prisma.giftCard.update({
      where: { codeHash: hashGiftCardCode(iCanon) },
      data: { status: 'INACTIVE' },
    });
    expect((await balance.lookup(inactive.code)).status).toBe('inactive');
  });

  it('balance lookup: a malformed code and an unknown code return the identical not-found shape', async () => {
    expect(await balance.lookup('nope')).toEqual({ found: false });
    expect(await balance.lookup(undefined)).toEqual({ found: false });
    expect(await balance.lookup('2345 6789 ABCD EFGH')).toEqual({
      found: false,
    });
  });

  // --- throttle -------------------------------------------

  it('the public throttle allows 20 requests per IP per minute then rejects', async () => {
    const ip = `10.0.0.${Math.floor(Math.random() * 240) + 1}`;
    for (let i = 0; i < 20; i++) {
      await expect(
        throttleGuard.canActivate(throttleContext(ip)),
      ).resolves.toBe(true);
    }
    await expect(
      throttleGuard.canActivate(throttleContext(ip)),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('the throttle fails OPEN when Redis is unavailable', async () => {
    jest.spyOn(redis, 'getClient').mockImplementation(() => {
      throw new Error('redis down');
    });
    for (let i = 0; i < 25; i++) {
      await expect(
        throttleGuard.canActivate(throttleContext('10.9.9.9')),
      ).resolves.toBe(true);
    }
  });

  it('purchase idempotency still prevents a double charge even if the throttle is bypassed', async () => {
    // The throttle is a guard; the service does not depend on it. Two calls
    // with one key charge once regardless.
    const req = buildRequest();
    const chargeSpy = jest.spyOn(paymentProvider, 'charge');
    await purchases.purchase(req);
    await purchases.purchase(req);
    expect(chargeSpy).toHaveBeenCalledTimes(1);
  });
});
