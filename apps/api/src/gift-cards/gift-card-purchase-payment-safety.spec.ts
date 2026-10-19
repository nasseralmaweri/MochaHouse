import 'dotenv/config';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  tenantContextFor,
  removePaymentRecoveryRecordsForTest,
} from '@mocha-house/testing';
import { Test, type TestingModule } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
import type { CreateGiftCardPurchaseIntentRequest } from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomersModule } from '../customers/customers.module';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { RedisModule } from '../redis/redis.module';
import { PaymentModule } from '../payment/payment.module';
import { GiftCardsModule } from './gift-cards.module';
import { GiftCardPurchaseService } from './application/gift-card-purchase.service';
import { GIFT_CARD_CONFIGURATION_KEY } from './application/gift-card-configuration.service';

// Payment safety — gift-card value must never be issued without a real
// payment. With no provider configured, or with the simulated provider
// bound in a process running as production, a purchase is refused (503)
// before an intent, a charge claim or a gift card is written.
describe('gift-card purchase payment safety (integration)', () => {
  let prisma: PrismaService;
  let fakeModule: TestingModule;
  let disabledModule: TestingModule;
  let fakePurchases: GiftCardPurchaseService;
  let disabledPurchases: GiftCardPurchaseService;
  const t1 = tenantContextFor(TENANT_1_MOCHA_HOUSE_ID);
  const originalEnv = { ...process.env };
  // ESP-03 PR 6 — purchases this file established (keys are server-generated).
  const establishedPurchaseIds = new Set<string>();

  function intentRequest(): CreateGiftCardPurchaseIntentRequest {
    return {
      amountMinorUnits: 2500,
      purchaserEmail: 'gcp-safety@example.com',
      purchaserName: 'GCP Safety',
    };
  }

  async function compile(
    paymentProvider: string | undefined,
  ): Promise<TestingModule> {
    if (paymentProvider === undefined) delete process.env.PAYMENT_PROVIDER;
    else process.env.PAYMENT_PROVIDER = paymentProvider;
    const moduleRef = await Test.createTestingModule({
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
    return moduleRef;
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.GIFT_CARD_CODE_SECRET = 'gift-card-safety-spec-secret';
    process.env.GIFT_CARD_PURCHASE_CODE_KEK =
      'c4097ecec7942a636761a7c4acc30277edaa900a9ee56f4974c8993a344e963e';
    process.env.GIFT_CARD_PURCHASE_RECOVERY_SECRET =
      'gift-card-safety-spec-recovery-secret';

    fakeModule = await compile('fake');
    disabledModule = await compile(undefined);
    prisma = fakeModule.get(PrismaService);
    fakePurchases = fakeModule.get(GiftCardPurchaseService);
    disabledPurchases = disabledModule.get(GiftCardPurchaseService);

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
      update: {
        presetAmountsMinorUnits: [1000, 2500, 5000, 10000],
        customAmountEnabled: true,
      },
    });
  });

  afterAll(async () => {
    process.env.NODE_ENV = 'development';
    const attempts = await prisma.paymentAttempt.findMany({
      where: { giftCardPurchase: { id: { in: [...establishedPurchaseIds] } } },
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
    // ESP-03 PR 4 — a payment's saved checkout and reconciliation records
    // (append-only) go first, through the disposable-only test helper.
    await removePaymentRecoveryRecordsForTest(
      (
        await prisma.paymentAttempt.findMany({
          where: { id: { in: attemptIds } },
          select: { id: true },
        })
      ).map((a) => a.id),
    );
    await prisma.paymentAttempt.deleteMany({
      where: { id: { in: attemptIds } },
    });
    await disabledModule.close();
    await fakeModule.close();
    process.env = { ...originalEnv };
  });

  it('with no provider configured, createIntent is refused and records nothing', async () => {
    const request = intentRequest();
    const purchasesBefore = await prisma.giftCardPurchase.count();
    const attemptsBefore = await prisma.paymentAttempt.count();

    await expect(
      disabledPurchases.createIntent(request, undefined, t1),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(await prisma.paymentAttempt.count()).toBe(attemptsBefore);
    expect(await prisma.giftCardPurchase.count()).toBe(purchasesBefore);
  });

  it('an intent made while payment was available cannot be completed once it is not — no claim, no card', async () => {
    const request = intentRequest();
    const intent = await fakePurchases.createIntent(request, undefined, t1);
    establishedPurchaseIds.add(intent.purchaseId);
    const cardsBefore = await prisma.giftCard.count();

    await expect(
      disabledPurchases.purchase(
        {
          purchaseId: intent.purchaseId,
          recoveryCredential: intent.recoveryCredential,
        },
        undefined,
        t1,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    const attempt = await prisma.paymentAttempt.findFirstOrThrow({
      where: { giftCardPurchase: { id: intent.purchaseId } },
      include: { giftCardPurchase: true },
    });
    expect(attempt.status).toBe('PENDING');
    expect(attempt.giftCardPurchase?.chargeClaimedAt).toBeNull();
    expect(attempt.giftCardPurchase?.giftCardId).toBeNull();
    expect(await prisma.giftCard.count()).toBe(cardsBefore);
  });

  it('simulated provider bound in production: createIntent and purchase are both refused, no card issued', async () => {
    const pending = intentRequest();
    const intent = await fakePurchases.createIntent(pending, undefined, t1);
    establishedPurchaseIds.add(intent.purchaseId);
    const fresh = intentRequest();
    const cardsBefore = await prisma.giftCard.count();
    const purchasesBefore = await prisma.giftCardPurchase.count();

    process.env.NODE_ENV = 'production';
    try {
      await expect(
        fakePurchases.createIntent(fresh, undefined, t1),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(
        fakePurchases.purchase(
          {
            purchaseId: intent.purchaseId,
            recoveryCredential: intent.recoveryCredential,
          },
          undefined,
          t1,
        ),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    } finally {
      process.env.NODE_ENV = 'development';
    }

    // The refused fresh intent recorded nothing.
    expect(await prisma.giftCardPurchase.count()).toBe(purchasesBefore);
    const attempt = await prisma.paymentAttempt.findFirstOrThrow({
      where: { giftCardPurchase: { id: intent.purchaseId } },
      include: { giftCardPurchase: true },
    });
    expect(attempt.status).toBe('PENDING');
    expect(attempt.giftCardPurchase?.chargeClaimedAt).toBeNull();
    expect(await prisma.giftCard.count()).toBe(cardsBefore);
  });

  it('development with the simulated provider still issues a card, recording the provider honestly', async () => {
    const request = intentRequest();
    const intent = await fakePurchases.createIntent(request, undefined, t1);
    establishedPurchaseIds.add(intent.purchaseId);
    const response = await fakePurchases.purchase(
      {
        purchaseId: intent.purchaseId,
        recoveryCredential: intent.recoveryCredential,
      },
      undefined,
      t1,
    );
    expect(response.last4).toHaveLength(4);
    const attempt = await prisma.paymentAttempt.findFirstOrThrow({
      where: { giftCardPurchase: { id: intent.purchaseId } },
    });
    expect(attempt.status).toBe('SUCCEEDED');
    expect(attempt.provider).toBe('fake');
  });
});
