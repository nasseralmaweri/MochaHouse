import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import type {
  CreateGiftCardPurchaseIntentRequest,
  GiftCardPurchaseIntentResponse,
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
import {
  generateRecoveryCredential,
  hashRecoveryCredential,
  recoveryCredentialMatches,
} from '../infrastructure/gift-card-recovery-credential';
import { GiftCardConfigurationService } from './gift-card-configuration.service';
import { GiftCardIssuanceService } from './gift-card-issuance.service';

// Milestone 7H — customer digital gift-card purchase, a bounded TWO-STEP
// protocol over ONE persisted aggregate (GiftCardPurchase):
//
//   STEP 1  createIntent()  POST /gift-cards/purchase-intents
//     Establishes (or replays) a PENDING GiftCardPurchase + PaymentAttempt.
//     DOES NOT CHARGE, DOES NOT ISSUE. For a GUEST it mints a 256-bit CSPRNG
//     recovery credential, stores only its HMAC verifier, and returns the
//     credential exactly once — so the client holds it BEFORE step 2.
//
//   STEP 2  purchase()      POST /gift-cards/purchase
//     Charges the PaymentProvider once (concurrency-claimed) and issues the
//     card via the shared issuance core; on every later call it replays the
//     confirmation, returning the full plaintext code only to an authorised
//     caller within the 7-day window.
//
// SEPARATION OF CONCERNS: PaymentAttempt.idempotencyKey is PAYMENT
// IDEMPOTENCY ONLY. Guest full-code recovery needs BOTH that key (to find
// the purchase) AND the server-generated recoveryCredential (to authorise
// disclosure) — the key alone never yields the code. A signed-in purchase
// carries no credential; customer ownership is the authorisation.
//
// The plaintext code is (a) returned once on issuance, (b) returned on an
// authorised in-window replay, and otherwise never — never persisted in
// plaintext, never audited, never in the outbox or payment metadata.

const RECOVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const EMAIL_MAX_LENGTH = 320;
const NAME_MAX_LENGTH = 120;

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

type AttemptWithPurchase = Prisma.PaymentAttemptGetPayload<{
  include: {
    giftCardPurchase: { include: { giftCard: { select: { last4: true } } } };
  };
}>;

type PurchaseRow = NonNullable<AttemptWithPurchase['giftCardPurchase']>;

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

  // Fail fast at boot if either purpose-specific secret is missing / unusable.
  onModuleInit(): void {
    try {
      encryptGiftCardCode('kek-startup-probe');
      hashRecoveryCredential('recovery-secret-startup-probe');
    } catch (error) {
      this.logger.error(
        `gift-card purchase secrets are not usable: ${
          error instanceof Error ? error.message : 'unknown'
        }`,
      );
      throw error;
    }
  }

  // --- STEP 1: establish the purchase intent (no charge, no issue) -----

  async createIntent(
    request: CreateGiftCardPurchaseIntentRequest,
    customerIdentity?: CustomerIdentity,
  ): Promise<GiftCardPurchaseIntentResponse> {
    const idempotencyKey = this.validateIdempotencyKey(request?.idempotencyKey);

    // An intent already exists for this key → return it AS PERSISTED. Its
    // amount / contact / ownership are immutable now, and current
    // configuration must not be able to reject it (correction E). The
    // credential is not re-derivable, so a replay returns null: the client
    // kept it, or restarts with a fresh key (nothing was charged).
    const existing = await this.prisma.paymentAttempt.findUnique({
      where: { idempotencyKey },
      include: { giftCardPurchase: true },
    });
    if (existing?.giftCardPurchase) {
      return this.intentResponse(existing.giftCardPurchase, null);
    }

    // A brand-new intent — validate everything against CURRENT config.
    const purchaserEmail = this.validateEmail(request?.purchaserEmail);
    const purchaserName = this.validateName(request?.purchaserName);
    const amountMinorUnits = await this.validateAmount(request?.amountMinorUnits);
    const currency = 'USD';
    const customerId = await this.resolveCustomerId(customerIdentity);

    // Guest → mint the recovery credential now, BEFORE any charge, and
    // persist only its verifier.
    const credential =
      customerId === null ? generateRecoveryCredential() : null;

    let attempt: { id: string };
    try {
      attempt = await this.prisma.paymentAttempt.create({
        data: {
          idempotencyKey,
          provider: 'fake',
          locationId: null,
          amount: amountMinorUnits,
          currency,
        },
        select: { id: true },
      });
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) {
        throw error;
      }
      const raced = await this.prisma.paymentAttempt.findUniqueOrThrow({
        where: { idempotencyKey },
        include: { giftCardPurchase: true },
      });
      if (raced.giftCardPurchase) {
        return this.intentResponse(raced.giftCardPurchase, null);
      }
      attempt = { id: raced.id };
    }

    try {
      const purchase = await this.prisma.giftCardPurchase.create({
        data: {
          paymentAttemptId: attempt.id,
          amountMinorUnits,
          currency,
          customerId,
          purchaserEmail,
          purchaserName,
          recoveryCredentialHash: credential
            ? hashRecoveryCredential(credential)
            : null,
        },
      });
      return this.intentResponse(purchase, credential);
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) {
        throw error;
      }
      // A concurrent step-1 for the same key won — return its intent; the
      // losing caller gets no credential (its client should use the winning
      // response, or restart with a fresh key).
      const raced = await this.prisma.giftCardPurchase.findUniqueOrThrow({
        where: { paymentAttemptId: attempt.id },
      });
      return this.intentResponse(raced, null);
    }
  }

  private intentResponse(
    purchase: {
      id: string;
      status: 'PENDING' | 'ISSUED' | 'RECONCILIATION_REQUIRED';
      amountMinorUnits: number;
      currency: string;
      customerId: string | null;
    },
    recoveryCredential: string | null,
  ): GiftCardPurchaseIntentResponse {
    return {
      purchaseId: purchase.id,
      status: purchase.status,
      amountMinorUnits: purchase.amountMinorUnits,
      currency: purchase.currency,
      customerOwned: purchase.customerId !== null,
      recoveryCredential,
    };
  }

  // --- STEP 2: charge + issue, or replay -------------------------------

  async purchase(
    request: PurchaseGiftCardRequest,
    customerIdentity?: CustomerIdentity,
  ): Promise<PurchaseGiftCardResponse> {
    const idempotencyKey = this.validateIdempotencyKey(request?.idempotencyKey);
    const suppliedCredential =
      typeof request?.recoveryCredential === 'string'
        ? request.recoveryCredential
        : null;

    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { idempotencyKey },
      include: {
        giftCardPurchase: {
          include: { giftCard: { select: { last4: true } } },
        },
      },
    });
    if (!attempt || !attempt.giftCardPurchase) {
      throw new ConflictException(
        'No gift-card purchase was started for this key. Start a new purchase.',
      );
    }
    const purchase = attempt.giftCardPurchase;

    // Decide, once, whether this caller may see the full code for THIS
    // purchase (guest: valid recovery credential; signed-in: the owning
    // customer). Read-only — never JIT-creates a customer for a probe.
    const authorised = await this.isAuthorisedForCode(
      purchase,
      suppliedCredential,
      customerIdentity,
    );

    // Terminal / in-flight states → replay.
    if (attempt.status === 'DECLINED' || attempt.status === 'FAILED') {
      throw new HttpException(
        {
          outcome: attempt.status === 'DECLINED' ? 'declined' : 'failed',
          message: attempt.failureReason ?? 'Payment was not successful.',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    if (
      attempt.reconciliationRequired ||
      purchase.status === 'RECONCILIATION_REQUIRED'
    ) {
      throw new ConflictException(
        `Your payment succeeded but the gift card could not be issued ` +
          `automatically. Do not pay again — reference ${purchase.id} for support.`,
      );
    }
    if (attempt.status === 'SUCCEEDED') {
      if (purchase.status !== 'ISSUED' || !purchase.giftCard) {
        throw new ConflictException(
          'A gift-card purchase with this key is already being processed.',
        );
      }
      const code = authorised ? await this.recoverCode(purchase) : null;
      return this.confirmation(purchase, purchase.giftCard.last4, code);
    }

    // attempt.status === 'PENDING' → the first (charging) call. Enforce the
    // two-step protocol: the caller must prove they established this intent.
    if (!authorised) {
      throw new ForbiddenException(
        purchase.customerId === null
          ? 'A valid recovery credential from the first step is required to complete this purchase.'
          : 'Only the signed-in buyer can complete this purchase.',
      );
    }

    // Concurrency claim — exactly one request charges.
    const claim = await this.prisma.giftCardPurchase.updateMany({
      where: { id: purchase.id, status: 'PENDING', chargeClaimedAt: null },
      data: { chargeClaimedAt: new Date() },
    });
    if (claim.count === 0) {
      throw new ConflictException(
        'A gift-card purchase with this key is already being processed.',
      );
    }

    const chargeResult = await this.paymentProvider.charge({
      idempotencyKey,
      amount: purchase.amountMinorUnits,
      currency: purchase.currency,
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
          originalValueMinorUnits: purchase.amountMinorUnits,
          currency: purchase.currency,
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
      amountMinorUnits: purchase.amountMinorUnits,
      currency: purchase.currency,
      maskedCode: maskGiftCardCode(last4),
      last4,
      code: displayCode,
      codeRetrievable: true,
      codeRetrievableUntil: codeRetrievableUntil!.toISOString(),
    };
  }

  private confirmation(
    purchase: PurchaseRow,
    last4: string,
    code: string | null,
  ): PurchaseGiftCardResponse {
    return {
      purchaseId: purchase.id,
      status: 'ISSUED',
      amountMinorUnits: purchase.amountMinorUnits,
      currency: purchase.currency,
      maskedCode: maskGiftCardCode(last4),
      last4,
      code,
      codeRetrievable: code !== null,
      codeRetrievableUntil:
        purchase.codeRetrievableUntil?.toISOString() ?? null,
    };
  }

  // Guest: possession of the server-issued recovery credential (verified in
  // constant time against the stored HMAC). Signed-in: the caller resolves
  // to the owning customer. Read-only — a wrong / anonymous caller never
  // creates a customer row here.
  private async isAuthorisedForCode(
    purchase: PurchaseRow,
    suppliedCredential: string | null,
    customerIdentity: CustomerIdentity | undefined,
  ): Promise<boolean> {
    if (purchase.customerId !== null) {
      if (!customerIdentity) {
        return false;
      }
      const customer = await this.prisma.customer.findUnique({
        where: {
          externalProvider_externalSubject: {
            externalProvider: customerIdentity.provider,
            externalSubject: customerIdentity.subject,
          },
        },
        select: { id: true },
      });
      return customer?.id === purchase.customerId;
    }
    return recoveryCredentialMatches(
      suppliedCredential,
      purchase.recoveryCredentialHash,
    );
  }

  // Deadline + decrypt only — authorisation is already decided by the caller.
  private async recoverCode(purchase: PurchaseRow): Promise<string | null> {
    if (
      !purchase.codeRetrievableUntil ||
      purchase.codeRetrievableUntil.getTime() <= Date.now()
    ) {
      return null;
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
  // custom amounts are enabled and it is within [MIN, MAX]. The absolute
  // ceiling always applies. Governs NEW intents only (correction E).
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
