import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  type ExecutionContext,
} from '@nestjs/common';
import { FakePaymentProvider } from '@mocha-house/integrations';
import type {
  CreateGiftCardPurchaseIntentRequest,
  PurchaseGiftCardResponse,
} from '@mocha-house/contracts';
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
import {
  GiftCardConfigurationService,
  GIFT_CARD_CONFIGURATION_KEY,
} from './application/gift-card-configuration.service';
import { GiftCardPublicThrottleGuard } from './infrastructure/gift-card-public-throttle.guard';
import {
  canonicalizeGiftCardCode,
  hashGiftCardCode,
} from './infrastructure/gift-card-code';
import { hashRecoveryCredential } from './infrastructure/gift-card-recovery-credential';

// Milestone 7H (post-review) — the customer digital gift-card purchase is a
// bounded TWO-STEP protocol (createIntent → purchase) with a
// server-generated guest recovery credential. Exercised through the real
// services against the real local Postgres (like gift-card-redemption.spec).
// Requires the seeded dearborn-heights / drip-coffee fixture only for the
// XOR-trigger test.
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
  const RECOVERY_SECRET = 'gift-card-purchase-spec-recovery-secret';

  const idempotencyKeys = new Set<string>();
  const customerSubjects = new Set<string>();
  const trackedOrderIds: string[] = [];

  function key(): string {
    const k = randomUUID();
    idempotencyKeys.add(k);
    return k;
  }

  function intentRequest(
    overrides: Partial<CreateGiftCardPurchaseIntentRequest> = {},
  ): CreateGiftCardPurchaseIntentRequest {
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

  // Full happy-path purchase: step 1 then step 2. Returns the step-2
  // response plus the credential and key so a test can replay.
  async function buy(
    overrides: Partial<CreateGiftCardPurchaseIntentRequest> = {},
    identity?: CustomerIdentity,
  ): Promise<{
    response: PurchaseGiftCardResponse;
    idempotencyKey: string;
    recoveryCredential: string | null;
  }> {
    const req = intentRequest(overrides);
    const intent = await purchases.createIntent(req, identity);
    const response = await purchases.purchase(
      {
        idempotencyKey: req.idempotencyKey,
        recoveryCredential: intent.recoveryCredential,
      },
      identity,
    );
    return {
      response,
      idempotencyKey: req.idempotencyKey,
      recoveryCredential: intent.recoveryCredential,
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

  function throttleContext(ip: string, forwardedFor?: string): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          ip,
          headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
          socket: { remoteAddress: ip },
        }),
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
    process.env.GIFT_CARD_PURCHASE_RECOVERY_SECRET = RECOVERY_SECRET;

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
    process.env.GIFT_CARD_PURCHASE_RECOVERY_SECRET = RECOVERY_SECRET;
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
    await prisma.giftCardPurchase.deleteMany({
      where: { id: { in: purchaseIds } },
    });
    await prisma.giftCard.deleteMany({ where: { id: { in: giftCardIds } } });
    await prisma.order.deleteMany({ where: { id: { in: trackedOrderIds } } });
    await prisma.paymentAttempt.deleteMany({ where: { id: { in: attemptIds } } });
    await prisma.customer.deleteMany({
      where: { externalSubject: { in: [...customerSubjects] } },
    });
    await moduleRef.close();
  });

  // --- purchase options (correction D) --------------------------

  it('purchase-options is read-only: with no configuration row it returns defaults and writes nothing', async () => {
    await prisma.giftCardConfiguration.deleteMany({
      where: { key: GIFT_CARD_CONFIGURATION_KEY },
    });
    const before = await prisma.giftCardConfiguration.count();

    const options = await configuration.getPublicOptions();

    expect(options).toEqual({
      presetAmountsMinorUnits: [1000, 2500, 5000, 10000],
      customAmountEnabled: true,
      customAmountMinMinorUnits: 500,
      customAmountMaxMinorUnits: 50_000,
      currency: 'USD',
    });
    expect(await prisma.giftCardConfiguration.count()).toBe(before);
  });

  // --- step 1 -------------------------------------------------

  it('step 1 establishes a PENDING purchase, mints a guest recovery credential, and does NOT charge or issue', async () => {
    const chargeSpy = jest.spyOn(paymentProvider, 'charge');
    const req = intentRequest();
    const intent = await purchases.createIntent(req);

    expect(chargeSpy).not.toHaveBeenCalled();
    expect(intent.status).toBe('PENDING');
    expect(intent.customerOwned).toBe(false);
    expect(intent.recoveryCredential).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const purchase = await prisma.giftCardPurchase.findUniqueOrThrow({
      where: { id: intent.purchaseId },
      include: { paymentAttempt: true },
    });
    expect(purchase.status).toBe('PENDING');
    expect(purchase.giftCardId).toBeNull();
    expect(purchase.chargeClaimedAt).toBeNull();
    expect(purchase.paymentAttempt.status).toBe('PENDING');
    expect(purchase.paymentAttempt.locationId).toBeNull();

    // Stored value is the verifier only — never the plaintext credential.
    expect(purchase.recoveryCredentialHash).toBe(
      hashRecoveryCredential(intent.recoveryCredential!),
    );
    expect(purchase.recoveryCredentialHash).not.toBe(intent.recoveryCredential);

    const cards = await prisma.giftCard.count({
      where: { purchase: { id: intent.purchaseId } },
    });
    expect(cards).toBe(0);
  });

  it('step 1 for a signed-in buyer links the customer and returns no credential', async () => {
    const identity = signedIn();
    const intent = await purchases.createIntent(intentRequest(), identity);
    expect(intent.customerOwned).toBe(true);
    expect(intent.recoveryCredential).toBeNull();

    const purchase = await prisma.giftCardPurchase.findUniqueOrThrow({
      where: { id: intent.purchaseId },
    });
    expect(purchase.customerId).not.toBeNull();
    expect(purchase.recoveryCredentialHash).toBeNull();
  });

  it('step 1 replayed for an established intent returns it as persisted (no new credential)', async () => {
    const req = intentRequest({ amountMinorUnits: 5000 });
    const first = await purchases.createIntent(req);
    const replay = await purchases.createIntent(req);
    expect(replay.purchaseId).toBe(first.purchaseId);
    expect(replay.amountMinorUnits).toBe(5000);
    expect(replay.recoveryCredential).toBeNull();
  });

  it('step 1 replay is NOT re-validated against current configuration (correction E)', async () => {
    const req = intentRequest({ amountMinorUnits: 2500 });
    await purchases.createIntent(req);
    await setConfig({ presetAmountsMinorUnits: [1000], customAmountEnabled: false });
    // A brand-new intent for 2500 would now fail; the replay must not.
    const replay = await purchases.createIntent(req);
    expect(replay.amountMinorUnits).toBe(2500);
    await expect(
      purchases.createIntent(intentRequest({ amountMinorUnits: 2500 })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // --- step 2: happy path ------------------------------------

  it('a full guest purchase: one charge, one card, one ISSUANCE linked to the purchase, SUM==balance', async () => {
    const chargeSpy = jest.spyOn(paymentProvider, 'charge');
    const { response, idempotencyKey } = await buy({ amountMinorUnits: 2500 });

    expect(chargeSpy).toHaveBeenCalledTimes(1);
    expect(response.status).toBe('ISSUED');
    expect(response.amountMinorUnits).toBe(2500);
    expect(response.code).toMatch(/^[0-9A-Z]{4}( [0-9A-Z]{4}){3}$/);
    expect(response.codeRetrievable).toBe(true);
    expect(response.maskedCode).toBe(`•••• •••• •••• ${response.last4}`);
    const until = new Date(response.codeRetrievableUntil!).getTime();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(until - Date.now()).toBeGreaterThan(sevenDays - 60_000);
    expect(until - Date.now()).toBeLessThan(sevenDays + 60_000);

    const canonical = canonicalizeGiftCardCode(response.code)!;
    const card = await prisma.giftCard.findUniqueOrThrow({
      where: { codeHash: hashGiftCardCode(canonical) },
    });
    expect(card.balanceMinorUnits).toBe(2500);
    expect(card.originalValueMinorUnits).toBe(2500);

    const txns = await prisma.giftCardTransaction.findMany({
      where: { giftCardId: card.id },
    });
    expect(txns).toHaveLength(1);
    expect(txns[0].type).toBe('ISSUANCE');
    expect(txns[0].amountMinorUnits).toBe(2500);
    expect(txns[0].balanceAfterMinorUnits).toBe(2500);
    expect(txns[0].actorInternalUserId).toBeNull();
    expect(txns[0].giftCardPurchaseId).toBe(response.purchaseId);
    expect(txns.reduce((a, t) => a + t.amountMinorUnits, 0)).toBe(
      card.balanceMinorUnits,
    );

    const attempt = await prisma.paymentAttempt.findUniqueOrThrow({
      where: { idempotencyKey },
      include: { order: true },
    });
    expect(attempt.status).toBe('SUCCEEDED');
    expect(attempt.locationId).toBeNull();
    expect(attempt.order).toBeNull();
    expect(attempt.reconciliationRequired).toBe(false);
  });

  it('a signed-in purchase does not require a recovery credential', async () => {
    const identity = signedIn();
    const req = intentRequest();
    await purchases.createIntent(req, identity);
    const res = await purchases.purchase(
      { idempotencyKey: req.idempotencyKey },
      identity,
    );
    expect(res.status).toBe('ISSUED');
    expect(res.code).not.toBeNull();
  });

  it('does NOT write an InternalAuditEvent for a routine customer purchase', async () => {
    const before = await prisma.internalAuditEvent.count();
    await buy();
    expect(await prisma.internalAuditEvent.count()).toBe(before);
  });

  it('the full code never lands in persistence, the outbox, or the audit log', async () => {
    const { response } = await buy();
    const canonical = canonicalizeGiftCardCode(response.code)!;

    const purchase = await prisma.giftCardPurchase.findUniqueOrThrow({
      where: { id: response.purchaseId },
    });
    expect(Buffer.from(purchase.codeCiphertext!).toString('latin1')).not.toContain(
      canonical,
    );
    expect(Buffer.from(purchase.codeIv!)).toHaveLength(12);
    expect(Buffer.from(purchase.codeAuthTag!)).toHaveLength(16);
    expect(JSON.stringify(purchase)).not.toContain(canonical);

    const txns = await prisma.giftCardTransaction.findMany({
      where: { giftCardPurchaseId: response.purchaseId },
    });
    expect(JSON.stringify(txns)).not.toContain(canonical);

    const recent = { createdAt: { gte: new Date(Date.now() - 60_000) } };
    const outbox = await prisma.outboxEvent.findMany({ where: recent });
    const audit = await prisma.internalAuditEvent.findMany({ where: recent });
    expect(JSON.stringify(outbox)).not.toContain(canonical);
    expect(JSON.stringify(audit)).not.toContain(canonical);
  });

  // --- step 2: authorization matrix -------------------------

  it('guest recovery: idempotencyKey + correct credential returns the code; key alone does not', async () => {
    const { response, idempotencyKey, recoveryCredential } = await buy();

    const authorised = await purchases.purchase({
      idempotencyKey,
      recoveryCredential,
    });
    expect(authorised.code).toBe(response.code);
    expect(authorised.codeRetrievable).toBe(true);

    const keyOnly = await purchases.purchase({ idempotencyKey });
    expect(keyOnly.code).toBeNull();
    expect(keyOnly.codeRetrievable).toBe(false);
    // ...but the masked confirmation is still returned.
    expect(keyOnly.purchaseId).toBe(response.purchaseId);
    expect(keyOnly.last4).toBe(response.last4);
  });

  it('guest recovery: a wrong / low-entropy credential never returns the code', async () => {
    const { idempotencyKey } = await buy();
    for (const bad of [
      'wrong-credential',
      '',
      'A'.repeat(43),
      hashRecoveryCredential('anything'),
    ]) {
      const res = await purchases.purchase({
        idempotencyKey,
        recoveryCredential: bad,
      });
      expect(res.code).toBeNull();
    }
  });

  it('a low-entropy UUID idempotency key does not weaken code confidentiality', async () => {
    // Even a trivially-guessable key only reaches the purchase; the code
    // still needs the server-generated credential.
    const weakKey = '00000000-0000-4000-8000-000000000001';
    idempotencyKeys.add(weakKey);
    const intent = await purchases.createIntent(
      intentRequest({ idempotencyKey: weakKey }),
    );
    await purchases.purchase({
      idempotencyKey: weakKey,
      recoveryCredential: intent.recoveryCredential,
    });

    // An attacker who guessed the weak key but not the credential gets nothing.
    const attacker = await purchases.purchase({ idempotencyKey: weakKey });
    expect(attacker.code).toBeNull();
  });

  it('a different guest purchase credential cannot recover another purchase', async () => {
    const a = await buy();
    const b = await buy();
    const cross = await purchases.purchase({
      idempotencyKey: a.idempotencyKey,
      recoveryCredential: b.recoveryCredential,
    });
    expect(cross.code).toBeNull();
  });

  it('signed-in purchase: owner recovers without a credential; anonymous and other customers cannot', async () => {
    const owner = signedIn();
    const req = intentRequest();
    await purchases.createIntent(req, owner);
    const first = await purchases.purchase(
      { idempotencyKey: req.idempotencyKey },
      owner,
    );
    expect(first.code).not.toBeNull();

    const sameOwner = await purchases.purchase(
      { idempotencyKey: req.idempotencyKey },
      owner,
    );
    expect(sameOwner.code).toBe(first.code);

    const anon = await purchases.purchase({ idempotencyKey: req.idempotencyKey });
    expect(anon.code).toBeNull();
    expect(anon.purchaseId).toBe(first.purchaseId);

    const stranger = signedIn();
    const strangerView = await purchases.purchase(
      { idempotencyKey: req.idempotencyKey },
      stranger,
    );
    expect(strangerView.code).toBeNull();
    // The unauthorised probe must not JIT-create a Customer row.
    const strangerRow = await prisma.customer.findUnique({
      where: {
        externalProvider_externalSubject: {
          externalProvider: stranger.provider,
          externalSubject: stranger.subject,
        },
      },
    });
    expect(strangerRow).toBeNull();
  });

  it('an authenticated caller may complete/recover a GUEST purchase with the guest credential (no ownership transfer)', async () => {
    const req = intentRequest();
    const intent = await purchases.createIntent(req); // guest intent
    const somebody = signedIn();
    const res = await purchases.purchase(
      {
        idempotencyKey: req.idempotencyKey,
        recoveryCredential: intent.recoveryCredential,
      },
      somebody,
    );
    expect(res.code).not.toBeNull();

    const purchase = await prisma.giftCardPurchase.findUniqueOrThrow({
      where: { id: res.purchaseId },
    });
    expect(purchase.customerId).toBeNull(); // still a guest purchase
  });

  it('step 2 without an established intent is rejected', async () => {
    await expect(
      purchases.purchase({ idempotencyKey: key(), recoveryCredential: 'x' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('step 2 charge is refused when a guest supplies no / wrong credential', async () => {
    const req = intentRequest();
    await purchases.createIntent(req);
    const chargeSpy = jest.spyOn(paymentProvider, 'charge');
    await expect(
      purchases.purchase({ idempotencyKey: req.idempotencyKey }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(chargeSpy).not.toHaveBeenCalled();
  });

  // --- amount rules ----------------------------------------

  it('accepts min ($5.00), max ($500.00), a preset above the custom max, and rejects out-of-range', async () => {
    expect((await buy({ amountMinorUnits: 500 })).response.amountMinorUnits).toBe(
      500,
    );
    expect(
      (await buy({ amountMinorUnits: 50_000 })).response.amountMinorUnits,
    ).toBe(50_000);

    await setConfig({ presetAmountsMinorUnits: [2500, 120_000] });
    expect(
      (await buy({ amountMinorUnits: 120_000 })).response.amountMinorUnits,
    ).toBe(120_000);

    await setConfig({ presetAmountsMinorUnits: [1000, 2500, 5000, 10000] });
    for (const amt of [499, 50_001, 200_001, 12.5, 0]) {
      await expect(
        purchases.createIntent(intentRequest({ amountMinorUnits: amt })),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('custom amounts disabled: only presets accepted', async () => {
    await setConfig({
      presetAmountsMinorUnits: [1000, 2500],
      customAmountEnabled: false,
    });
    expect((await buy({ amountMinorUnits: 1000 })).response.status).toBe('ISSUED');
    await expect(
      purchases.createIntent(intentRequest({ amountMinorUnits: 700 })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a missing email and a non-UUID idempotency key at step 1', async () => {
    await expect(
      purchases.createIntent(intentRequest({ purchaserEmail: '   ' })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      purchases.createIntent({
        idempotencyKey: 'not-a-uuid',
        amountMinorUnits: 2500,
        purchaserEmail: 'x@example.com',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // --- payment failure / reconciliation --------------------

  it('a declined payment: 402, no card, replay stays 402, no second charge', async () => {
    jest
      .spyOn(paymentProvider, 'charge')
      .mockResolvedValue({ outcome: 'declined', reason: 'Card declined' });
    const req = intentRequest();
    const intent = await purchases.createIntent(req);
    await expect(
      purchases.purchase({
        idempotencyKey: req.idempotencyKey,
        recoveryCredential: intent.recoveryCredential,
      }),
    ).rejects.toMatchObject({ status: 402 });

    const attempt = await prisma.paymentAttempt.findUniqueOrThrow({
      where: { idempotencyKey: req.idempotencyKey },
      include: { giftCardPurchase: true },
    });
    expect(attempt.status).toBe('DECLINED');
    expect(attempt.giftCardPurchase?.giftCardId).toBeNull();

    const chargeSpy = jest.spyOn(paymentProvider, 'charge');
    chargeSpy.mockClear();
    await expect(
      purchases.purchase({
        idempotencyKey: req.idempotencyKey,
        recoveryCredential: intent.recoveryCredential,
      }),
    ).rejects.toMatchObject({ status: 402 });
    expect(chargeSpy).not.toHaveBeenCalled();
  });

  it('payment succeeds but issuance fails: reconciliation recorded, no card, retry does not re-charge', async () => {
    const chargeSpy = jest.spyOn(paymentProvider, 'charge');
    const txSpy = jest
      .spyOn(prisma, '$transaction')
      .mockRejectedValueOnce(new Error('issuance boom'));

    const req = intentRequest();
    const intent = await purchases.createIntent(req);
    await expect(
      purchases.purchase({
        idempotencyKey: req.idempotencyKey,
        recoveryCredential: intent.recoveryCredential,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
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

    await expect(
      purchases.purchase({
        idempotencyKey: req.idempotencyKey,
        recoveryCredential: intent.recoveryCredential,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(chargeSpy).toHaveBeenCalledTimes(1);
  });

  // --- idempotency / concurrency ---------------------------

  it('a duplicate step 2 with the same key + credential returns the same card + code, no second charge', async () => {
    const { response, idempotencyKey, recoveryCredential } = await buy();
    const chargeSpy = jest.spyOn(paymentProvider, 'charge');
    const again = await purchases.purchase({
      idempotencyKey,
      recoveryCredential,
    });
    expect(chargeSpy).not.toHaveBeenCalled();
    expect(again.purchaseId).toBe(response.purchaseId);
    expect(again.code).toBe(response.code);
  });

  it('concurrent step 2 requests charge exactly once and issue exactly one card', async () => {
    const req = intentRequest();
    const intent = await purchases.createIntent(req);
    const chargeSpy = jest.spyOn(paymentProvider, 'charge');
    const body = {
      idempotencyKey: req.idempotencyKey,
      recoveryCredential: intent.recoveryCredential,
    };

    const results = await Promise.allSettled([
      purchases.purchase(body),
      purchases.purchase(body),
      purchases.purchase(body),
    ]);
    expect(
      results.filter((r) => r.status === 'fulfilled').length,
    ).toBeGreaterThanOrEqual(1);
    expect(chargeSpy).toHaveBeenCalledTimes(1);

    const purchase = await prisma.giftCardPurchase.findFirstOrThrow({
      where: { paymentAttempt: { idempotencyKey: req.idempotencyKey } },
    });
    expect(
      await prisma.giftCard.count({ where: { purchase: { id: purchase.id } } }),
    ).toBe(1);
    expect(
      await prisma.giftCardTransaction.count({
        where: { giftCardPurchaseId: purchase.id, type: 'ISSUANCE' },
      }),
    ).toBe(1);
  });

  it('concurrent step 1 for the same key creates exactly one purchase + attempt', async () => {
    const k = key();
    const results = await Promise.allSettled([
      purchases.createIntent(intentRequest({ idempotencyKey: k })),
      purchases.createIntent(intentRequest({ idempotencyKey: k })),
      purchases.createIntent(intentRequest({ idempotencyKey: k })),
    ]);
    const ok = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof purchases.createIntent>>> =>
        r.status === 'fulfilled',
    );
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const ids = new Set(ok.map((r) => r.value.purchaseId));
    expect(ids.size).toBe(1);
    expect(
      await prisma.paymentAttempt.count({ where: { idempotencyKey: k } }),
    ).toBe(1);
  });

  // --- lost-response recovery -----------------------------

  it('a lost step-2 response is recovered by replaying key + credential within the window', async () => {
    const { response, idempotencyKey, recoveryCredential } = await buy();
    const replay = await purchases.purchase({
      idempotencyKey,
      recoveryCredential,
    });
    expect(replay.code).toBe(response.code);
  });

  it('after the retrieval deadline the code is gone but the confirmation remains', async () => {
    const { response, idempotencyKey, recoveryCredential } = await buy();
    await prisma.giftCardPurchase.update({
      where: { id: response.purchaseId },
      data: { codeRetrievableUntil: new Date(Date.now() - 1000) },
    });
    const replay = await purchases.purchase({
      idempotencyKey,
      recoveryCredential,
    });
    expect(replay.code).toBeNull();
    expect(replay.codeRetrievable).toBe(false);
    expect(replay.last4).toBe(response.last4);
  });

  it('a rotated KEK makes the code unrecoverable but does not throw or re-charge', async () => {
    const { idempotencyKey, recoveryCredential } = await buy();
    process.env.GIFT_CARD_PURCHASE_CODE_KEK = KEK_B;
    const chargeSpy = jest.spyOn(paymentProvider, 'charge');
    const replay = await purchases.purchase({
      idempotencyKey,
      recoveryCredential,
    });
    expect(replay.code).toBeNull();
    expect(chargeSpy).not.toHaveBeenCalled();
  });

  it('a rotated recovery secret invalidates the guest credential but does not throw or re-charge', async () => {
    const { idempotencyKey, recoveryCredential } = await buy();
    process.env.GIFT_CARD_PURCHASE_RECOVERY_SECRET = 'rotated-recovery-secret';
    const chargeSpy = jest.spyOn(paymentProvider, 'charge');
    const replay = await purchases.purchase({
      idempotencyKey,
      recoveryCredential,
    });
    expect(replay.code).toBeNull();
    expect(chargeSpy).not.toHaveBeenCalled();
  });

  it('the recovery credential / verifier never appears in the outbox or audit log', async () => {
    const { response, recoveryCredential } = await buy();
    const purchase = await prisma.giftCardPurchase.findUniqueOrThrow({
      where: { id: response.purchaseId },
    });
    const recent = { createdAt: { gte: new Date(Date.now() - 60_000) } };
    const outbox = JSON.stringify(
      await prisma.outboxEvent.findMany({ where: recent }),
    );
    const audit = JSON.stringify(
      await prisma.internalAuditEvent.findMany({ where: recent }),
    );
    expect(outbox).not.toContain(recoveryCredential);
    expect(outbox).not.toContain(purchase.recoveryCredentialHash);
    expect(audit).not.toContain(recoveryCredential);
    expect(audit).not.toContain(purchase.recoveryCredentialHash);
  });

  // --- balance lookup ------------------------------------

  it('balance lookup: active / depleted / inactive / malformed / unknown', async () => {
    const { response } = await buy({ amountMinorUnits: 5000 });
    expect(await balance.lookup(response.code)).toEqual({
      found: true,
      maskedCode: response.maskedCode,
      last4: response.last4,
      balanceMinorUnits: 5000,
      currency: 'USD',
      status: 'active',
    });

    const depleted = await buy();
    await prisma.giftCard.update({
      where: {
        codeHash: hashGiftCardCode(
          canonicalizeGiftCardCode(depleted.response.code)!,
        ),
      },
      data: { balanceMinorUnits: 0 },
    });
    expect((await balance.lookup(depleted.response.code)).status).toBe(
      'depleted',
    );

    const inactive = await buy();
    await prisma.giftCard.update({
      where: {
        codeHash: hashGiftCardCode(
          canonicalizeGiftCardCode(inactive.response.code)!,
        ),
      },
      data: { status: 'INACTIVE' },
    });
    expect((await balance.lookup(inactive.response.code)).status).toBe(
      'inactive',
    );

    expect(await balance.lookup('nope')).toEqual({ found: false });
    expect(await balance.lookup('2345 6789 ABCD EFGH')).toEqual({
      found: false,
    });
  });

  // --- XOR trigger (correction A) ------------------------

  it('the database forbids one PaymentAttempt from backing both an Order and a gift-card purchase (INSERT and UPDATE, both directions)', async () => {
    const location = await prisma.location.findUniqueOrThrow({
      where: { slug: 'dearborn-heights' },
    });
    const makeAttempt = async (withLocation: boolean) =>
      prisma.paymentAttempt.create({
        data: {
          idempotencyKey: key(),
          provider: 'fake',
          locationId: withLocation ? location.id : null,
          amount: 100,
          currency: 'USD',
          status: 'SUCCEEDED',
        },
      });

    const orderAttempt = await makeAttempt(true);
    const gcAttempt = await makeAttempt(false);
    const freeAttempt = await makeAttempt(false);

    const order = await prisma.order.create({
      data: {
        orderNumber: `GCP-TRIG-${Date.now()}`,
        accessToken: randomUUID(),
        locationId: location.id,
        paymentAttemptId: orderAttempt.id,
        guestName: 'Trigger Spec',
        guestPhone: '5550000000',
        currency: 'USD',
        subtotal: 100,
      },
    });
    trackedOrderIds.push(order.id);
    const gcPurchase = await prisma.giftCardPurchase.create({
      data: {
        paymentAttemptId: gcAttempt.id,
        amountMinorUnits: 100,
        currency: 'USD',
        purchaserEmail: 'trigger@example.com',
      },
    });

    // 1. INSERT GiftCardPurchase on the Order's attempt
    await expect(
      prisma.giftCardPurchase.create({
        data: {
          paymentAttemptId: orderAttempt.id,
          amountMinorUnits: 100,
          currency: 'USD',
          purchaserEmail: 't@example.com',
        },
      }),
    ).rejects.toThrow();

    // 2. INSERT Order on the GiftCardPurchase's attempt
    await expect(
      prisma.order.create({
        data: {
          orderNumber: `GCP-TRIG2-${Date.now()}`,
          accessToken: randomUUID(),
          locationId: location.id,
          paymentAttemptId: gcAttempt.id,
          guestName: 'x',
          guestPhone: 'x',
          currency: 'USD',
          subtotal: 100,
        },
      }),
    ).rejects.toThrow();

    // 3. UPDATE GiftCardPurchase.paymentAttemptId -> the Order's attempt
    await expect(
      prisma.giftCardPurchase.update({
        where: { id: gcPurchase.id },
        data: { paymentAttemptId: orderAttempt.id },
      }),
    ).rejects.toThrow();

    // 4. UPDATE Order.paymentAttemptId -> the GiftCardPurchase's attempt
    await expect(
      prisma.order.update({
        where: { id: order.id },
        data: { paymentAttemptId: gcAttempt.id },
      }),
    ).rejects.toThrow();

    // 5. A legitimate, non-conflicting reassignment is still allowed.
    const moved = await prisma.giftCardPurchase.update({
      where: { id: gcPurchase.id },
      data: { paymentAttemptId: freeAttempt.id },
    });
    expect(moved.paymentAttemptId).toBe(freeAttempt.id);
    // ...and the issuance-time update (which does not touch paymentAttemptId)
    // is unaffected by the trigger.
    const touched = await prisma.giftCardPurchase.update({
      where: { id: gcPurchase.id },
      data: { purchaserName: 'still fine' },
    });
    expect(touched.purchaserName).toBe('still fine');
  });

  // --- throttle (correction C) --------------------------

  it('the throttle keys on request.ip and ignores a spoofed X-Forwarded-For', async () => {
    const ip = `10.0.0.${Math.floor(Math.random() * 240) + 1}`;
    for (let i = 0; i < 20; i++) {
      await expect(
        throttleGuard.canActivate(
          throttleContext(ip, `9.9.9.${i}`), // varying spoofed header
        ),
      ).resolves.toBe(true);
    }
    // 21st from the same real ip is throttled despite a fresh spoofed header.
    await expect(
      throttleGuard.canActivate(throttleContext(ip, '1.2.3.4')),
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

  it('purchase idempotency still prevents a double charge if the throttle is bypassed', async () => {
    const { idempotencyKey, recoveryCredential } = await buy();
    const chargeSpy = jest.spyOn(paymentProvider, 'charge');
    await purchases.purchase({ idempotencyKey, recoveryCredential });
    await purchases.purchase({ idempotencyKey, recoveryCredential });
    expect(chargeSpy).not.toHaveBeenCalled();
  });
});
