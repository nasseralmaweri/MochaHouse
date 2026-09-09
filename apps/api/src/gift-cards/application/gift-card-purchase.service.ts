import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import type {
  PurchaseGiftCardRequest,
  PurchaseGiftCardResponse,
} from '@mocha-house/contracts';
import {
  GIFT_CARD_CUSTOM_MAX_MINOR_UNITS,
  GIFT_CARD_CUSTOM_MIN_MINOR_UNITS,
  GIFT_CARD_MAX_VALUE_MINOR_UNITS,
} from '@mocha-house/contracts';
import type { PaymentProvider } from '@mocha-house/integrations';
import { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { CustomersService } from '../../customers/application/customers.service';
import type { CustomerIdentity } from '../../customer-auth/infrastructure/customer-identity';
import { PAYMENT_PROVIDER } from '../../payment/payment-provider.token';
import { maskGiftCardCode } from '../infrastructure/gift-card-code';
import {
  decryptGiftCardCode,
  encryptGiftCardCode,
} from '../infrastructure/gift-card-purchase-code-cipher';
import { GiftCardConfigurationService } from './gift-card-configuration.service';
import { GiftCardIssuanceService } from './gift-card-issuance.service';

// Milestone 7H — customer digital gift-card purchase. Reuses PaymentAttempt
// (1:1) and the PaymentProvider boundary; it is NOT an Order. On a
// successful payment the shared issuance core creates the GiftCard + its one
// ISSUANCE ledger entry, this row goes PENDING -> ISSUED, and the plaintext
// code is (a) returned once and (b) stored AES-256-GCM-encrypted for a
// 7-day recovery window — never persisted in plaintext, never audited,
// never in the outbox or payment metadata.
//
// Idempotency: PaymentAttempt.idempotencyKey is the single anchor. For a
// purchase it MUST be a UUID (the web sends crypto.randomUUID() — 122 bits
// of CSPRNG entropy) so it doubles as the unguessable recovery credential a
// signed-out buyer supplies to re-obtain the code.

const RECOVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const EMAIL_MAX_LENGTH = 320;
const NAME_MAX_LENGTH = 120;

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

type PurchaseWithGiftCard = Prisma.GiftCardPurchaseGetPayload<{
  include: { giftCard: { select: { last4: true } } };
}>;

type AttemptWithPurchase = Prisma.PaymentAttemptGetPayload<{
  include: { giftCardPurchase: { include: { giftCard: { select: { last4: true } } } } };
}>;

@Injectable()
export class GiftCardPurchaseService implements OnModuleInit {
  private readonly logger = new Logger(GiftCardPurchaseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly customersService: CustomersService,
    private readonly configuration: GiftCardConfigurationService,
    private readonly issuance: GiftCardIssuanceService,
    @Inject(PAYMENT_PROVIDER)
    private readonly paymentProvider: PaymentProvider,
  ) {}

  // Fail fast at boot if the recovery KEK is missing / wrong length, rather
  // than pushing every purchase into RECONCILIATION_REQUIRED at runtime.
  onModuleInit(): void {
    try {
      encryptGiftCardCode('kek-startup-probe');
    } catch (error) {
      this.logger.error(
        `GIFT_CARD_PURCHASE_CODE_KEK is not usable: ${
          error instanceof Error ? error.message : 'unknown'
        }`,
      );
      throw error;
    }
  }

  async purchase(
    request: PurchaseGiftCardRequest,
    customerIdentity?: CustomerIdentity,
  ): Promise<PurchaseGiftCardResponse> {
    const idempotencyKey = this.validateIdempotencyKey(request?.idempotencyKey);
    const purchaserEmail = this.validateEmail(request?.purchaserEmail);
    const purchaserName = this.validateName(request?.purchaserName);
    const amountMinorUnits = await this.validateAmount(
      request?.amountMinorUnits,
    );
    const currency = 'USD';

    const existing = await this.prisma.paymentAttempt.findUnique({
      where: { idempotencyKey },
      include: {
        giftCardPurchase: { include: { giftCard: { select: { last4: true } } } },
      },
    });
    if (existing) {
      return this.replay(existing, idempotencyKey, customerIdentity);
    }

    const customerId = await this.resolveCustomerId(customerIdentity);

    // Race-safe attempt creation (the checkout pattern).
    let attempt;
    try {
      attempt = await this.prisma.paymentAttempt.create({
        data: {
          idempotencyKey,
          provider: 'fake',
          locationId: null,
          amount: amountMinorUnits,
          currency,
        },
      });
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) {
        throw error;
      }
      const raced = await this.prisma.paymentAttempt.findUniqueOrThrow({
        where: { idempotencyKey },
        include: {
          giftCardPurchase: {
            include: { giftCard: { select: { last4: true } } },
          },
        },
      });
      return this.replay(raced, idempotencyKey, customerIdentity);
    }

    // PENDING purchase, linked 1:1 — so a replay observing "SUCCEEDED, no
    // card yet" finds this row.
    const purchase = await this.prisma.giftCardPurchase.create({
      data: {
        paymentAttemptId: attempt.id,
        amountMinorUnits,
        currency,
        customerId,
        purchaserEmail,
        purchaserName,
      },
    });

    const chargeResult = await this.paymentProvider.charge({
      idempotencyKey,
      amount: amountMinorUnits,
      currency,
      metadata: {},
    });

    if (chargeResult.outcome !== 'succeeded') {
      await this.prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          status: chargeResult.outcome === 'declined' ? 'DECLINED' : 'FAILED',
          failureReason: chargeResult.reason,
        },
      });
      throw new HttpException(
        { outcome: chargeResult.outcome, message: chargeResult.reason },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    await this.prisma.paymentAttempt.update({
      where: { id: attempt.id },
      data: {
        status: 'SUCCEEDED',
        providerReference: chargeResult.providerReference,
      },
    });

    let displayCode: string;
    let last4: string;
    let codeRetrievableUntil: Date;
    try {
      const issued = await this.issuance.issue(
        {
          originalValueMinorUnits: amountMinorUnits,
          currency,
          giftCardPurchaseId: purchase.id,
        },
        async (tx, issuedCard) => {
          const enc = encryptGiftCardCode(issuedCard.canonicalCode);
          codeRetrievableUntil = new Date(Date.now() + RECOVERY_WINDOW_MS);
          await tx.giftCardPurchase.update({
            where: { id: purchase.id },
            data: {
              status: 'ISSUED',
              giftCardId: issuedCard.card.id,
              codeCiphertext: enc.ciphertext,
              codeIv: enc.iv,
              codeAuthTag: enc.authTag,
              codeRetrievableUntil,
            },
          });
        },
      );
      displayCode = issued.displayCode;
      last4 = issued.last4;
    } catch (error) {
      // Payment already succeeded; issuance did not commit. Durably record
      // the reconciliation condition, mark the purchase, and never retry the
      // financial effect automatically.
      await this.markReconciliationRequired(attempt.id, error);
      await this.prisma.giftCardPurchase
        .update({
          where: { id: purchase.id },
          data: { status: 'RECONCILIATION_REQUIRED' },
        })
        .catch(() => undefined);
      throw new ConflictException(
        `Your payment succeeded but the gift card could not be issued ` +
          `automatically. Do not pay again — reference ${purchase.id} for support.`,
      );
    }

    return {
      purchaseId: purchase.id,
      status: 'ISSUED',
      amountMinorUnits,
      currency,
      maskedCode: maskGiftCardCode(last4),
      last4,
      code: displayCode,
      codeRetrievable: true,
      codeRetrievableUntil: codeRetrievableUntil!.toISOString(),
    };
  }

  // --- replay -----------------------------------------------------

  private async replay(
    attempt: AttemptWithPurchase,
    suppliedIdempotencyKey: string,
    customerIdentity: CustomerIdentity | undefined,
  ): Promise<PurchaseGiftCardResponse> {
    if (attempt.status === 'PENDING') {
      throw new ConflictException(
        'A gift-card purchase with this key is already being processed.',
      );
    }
    if (attempt.status === 'DECLINED' || attempt.status === 'FAILED') {
      throw new HttpException(
        {
          outcome: attempt.status === 'DECLINED' ? 'declined' : 'failed',
          message: attempt.failureReason ?? 'Payment was not successful.',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    // SUCCEEDED.
    const purchase = attempt.giftCardPurchase;
    if (attempt.reconciliationRequired || purchase?.status === 'RECONCILIATION_REQUIRED') {
      throw new ConflictException(
        `Your payment succeeded but the gift card could not be issued ` +
          `automatically. Do not pay again — reference ${
            purchase?.id ?? attempt.id
          } for support.`,
      );
    }
    if (!purchase || purchase.status !== 'ISSUED' || !purchase.giftCard) {
      // Issuance still in flight (the update above commits after the payment
      // update). A retry shortly resolves to ISSUED or reconciliation.
      throw new ConflictException(
        'A gift-card purchase with this key is already being processed.',
      );
    }

    const code = await this.recoverCode(
      attempt.idempotencyKey,
      suppliedIdempotencyKey,
      purchase,
      customerIdentity,
    );

    return {
      purchaseId: purchase.id,
      status: 'ISSUED',
      amountMinorUnits: purchase.amountMinorUnits,
      currency: purchase.currency,
      maskedCode: maskGiftCardCode(purchase.giftCard.last4),
      last4: purchase.giftCard.last4,
      code,
      codeRetrievable: code !== null,
      codeRetrievableUntil:
        purchase.codeRetrievableUntil?.toISOString() ?? null,
    };
  }

  // Decrypt + return the full code ONLY when every condition holds:
  //   - within the 7-day window (server-enforced deadline)
  //   - the caller proved ownership
  //   - decryption + auth-tag verification succeed
  // Any failure returns null (a non-disclosing "not retrievable" confirmation).
  private async recoverCode(
    storedIdempotencyKey: string,
    suppliedIdempotencyKey: string,
    purchase: PurchaseWithGiftCard,
    customerIdentity: CustomerIdentity | undefined,
  ): Promise<string | null> {
    if (
      !purchase.codeRetrievableUntil ||
      purchase.codeRetrievableUntil.getTime() <= Date.now()
    ) {
      return null;
    }

    // Ownership.
    if (purchase.customerId !== null) {
      // Signed-in purchase: only the same authenticated customer.
      if (!customerIdentity) {
        return null;
      }
      const customer =
        await this.customersService.resolveOrCreateFromIdentity(
          customerIdentity,
        );
      if (customer.id !== purchase.customerId) {
        return null;
      }
    } else {
      // Guest purchase: possession of the original high-entropy
      // idempotencyKey (supplied in the POST body) is the credential.
      if (suppliedIdempotencyKey !== storedIdempotencyKey) {
        return null;
      }
    }

    const canonical = decryptGiftCardCode({
      ciphertext: purchase.codeCiphertext,
      iv: purchase.codeIv,
      authTag: purchase.codeAuthTag,
    });
    if (canonical === null) {
      this.logger.warn(
        `gift-card purchase ${purchase.id}: recovery decryption failed`,
      );
      return null;
    }
    return groupCode(canonical);
  }

  // --- reconciliation -------------------------------------------

  private async markReconciliationRequired(
    paymentAttemptId: string,
    error: unknown,
  ): Promise<void> {
    const reason =
      error instanceof Error
        ? error.message
        : 'Unknown error issuing the gift card after a successful payment.';
    await this.prisma.paymentAttempt.update({
      where: { id: paymentAttemptId },
      data: {
        reconciliationRequired: true,
        reconciliationReason: reason.slice(0, 500),
        reconciliationDetectedAt: new Date(),
      },
    });
  }

  // --- validation ----------------------------------------------

  private async resolveCustomerId(
    customerIdentity: CustomerIdentity | undefined,
  ): Promise<string | null> {
    if (!customerIdentity) {
      return null;
    }
    const customer =
      await this.customersService.resolveOrCreateFromIdentity(customerIdentity);
    return customer.id;
  }

  private validateIdempotencyKey(raw: unknown): string {
    if (typeof raw !== 'string' || !UUID_PATTERN.test(raw.trim())) {
      throw new BadRequestException(
        'A valid idempotencyKey (a UUID) is required.',
      );
    }
    return raw.trim();
  }

  private validateEmail(raw: unknown): string {
    if (
      typeof raw !== 'string' ||
      raw.trim().length === 0 ||
      raw.trim().length > EMAIL_MAX_LENGTH ||
      !raw.includes('@')
    ) {
      throw new BadRequestException('A valid purchaser email is required.');
    }
    return raw.trim();
  }

  private validateName(raw: unknown): string | null {
    if (raw === undefined || raw === null || raw === '') {
      return null;
    }
    if (typeof raw !== 'string' || raw.trim().length > NAME_MAX_LENGTH) {
      throw new BadRequestException('Purchaser name is invalid.');
    }
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  // A purchase amount is valid when it matches an HQ-configured preset, OR
  // custom amounts are enabled and it is within [MIN, MAX]. Absolute ceiling
  // GIFT_CARD_MAX_VALUE_MINOR_UNITS always applies.
  private async validateAmount(raw: unknown): Promise<number> {
    if (
      typeof raw !== 'number' ||
      !Number.isInteger(raw) ||
      raw <= 0 ||
      raw > GIFT_CARD_MAX_VALUE_MINOR_UNITS
    ) {
      throw new BadRequestException('Choose a valid gift-card amount.');
    }

    const config = await this.configuration.getPublicOptions();
    if (config.presetAmountsMinorUnits.includes(raw)) {
      return raw;
    }
    if (
      config.customAmountEnabled &&
      raw >= GIFT_CARD_CUSTOM_MIN_MINOR_UNITS &&
      raw <= GIFT_CARD_CUSTOM_MAX_MINOR_UNITS
    ) {
      return raw;
    }
    if (config.customAmountEnabled) {
      throw new BadRequestException(
        `Choose a preset amount, or a custom amount between $5.00 and $500.00.`,
      );
    }
    throw new BadRequestException('Choose one of the listed gift-card amounts.');
  }
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

// Regroup a 16-char canonical code into the "XXXX XXXX XXXX XXXX" display
// form for the response.
function groupCode(canonical: string): string {
  return (canonical.match(/.{1,4}/g) ?? [canonical]).join(' ');
}
