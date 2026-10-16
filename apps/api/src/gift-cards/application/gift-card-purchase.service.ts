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
  ServiceUnavailableException,
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
import { Prisma, type TenantContext } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { CustomersService } from '../../customers/application/customers.service';
import type { CustomerIdentity } from '../../customer-auth/infrastructure/customer-identity';
import { PAYMENT_PROVIDER } from '../../payment/payment-provider.token';
import {
  chargeAttempt,
  heldStateOf,
  HELD_PAYMENT_MESSAGE,
} from '../../payment/payment-charge';
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
import { StorefrontFeaturesService } from '../../subscriptions/application/storefront-features.service';

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
    private readonly features: StorefrontFeaturesService,
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

  //
  // `tenant` is the request's server-resolved TenantContext. It JIT-resolves
  // a signed-in buyer's Customer (Milestone S0D-2B-1) and, since Milestone
  // S0D-2C-1, owns the PaymentAttempt created here (a gift-card purchase
  // has no Location, so the explicit TenantContext is its only source). An
  // attempt that already exists for this key is only ever returned — or
  // built upon — for its own tenant.
  async createIntent(
    request: CreateGiftCardPurchaseIntentRequest,
    customerIdentity: CustomerIdentity | undefined,
    tenant: TenantContext,
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
    if (existing) {
      this.assertAttemptOwned(existing, tenant);
    }
    if (existing?.giftCardPurchase) {
      this.assertSameIntent(existing.giftCardPurchase, request);
      return this.intentResponse(existing.giftCardPurchase, null);
    }
    // SC2b — selling a NEW gift card needs the gift-card module in the
    // business's plan: refused before any intent or payment attempt exists.
    // (An intent that already exists is returned above as persisted.)
    await this.features.assertAvailable(tenant.tenantId, 'giftcards');

    // Payment safety — a gift card is only ever issued against a real
    // payment: with no provider able to take one, no intent is recorded.
    this.assertPaymentAvailable();

    // A brand-new intent — validate everything against CURRENT config.
    const purchaserEmail = this.validateEmail(request?.purchaserEmail);
    const purchaserName = this.validateName(request?.purchaserName);
    const amountMinorUnits = await this.validateAmount(
      request?.amountMinorUnits,
      tenant,
    );
    const currency = 'USD';
    const customerId = await this.resolveCustomerId(customerIdentity, tenant);

    // Guest → mint the recovery credential now, BEFORE any charge, and
    // persist only its verifier.
    const credential =
      customerId === null ? generateRecoveryCredential() : null;

    let attempt: { id: string; tenantId: string };
    try {
      attempt = await this.prisma.paymentAttempt.create({
        data: {
          tenantId: tenant.tenantId,
          idempotencyKey,
          // The provider actually bound (audit).
          provider: this.paymentProvider.name,
          locationId: null,
          amount: amountMinorUnits,
          currency,
          paymentState: 'NOT_SENT',
        },
        select: { id: true, tenantId: true },
      });
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) {
        throw error;
      }
      const raced = await this.prisma.paymentAttempt.findUniqueOrThrow({
        where: { idempotencyKey },
        include: { giftCardPurchase: true },
      });
      // The race winner gets the same ownership check as an attempt found
      // up front — never returned, and never built upon, for another tenant.
      this.assertAttemptOwned(raced, tenant);
      if (raced.giftCardPurchase) {
        this.assertSameIntent(raced.giftCardPurchase, request);
        return this.intentResponse(raced.giftCardPurchase, null);
      }
      attempt = { id: raced.id, tenantId: raced.tenantId };
    }

    try {
      const purchase = await this.prisma.giftCardPurchase.create({
        data: {
          paymentAttemptId: attempt.id,
          // Milestone S0D-2C-1B — copied from the validated PaymentAttempt
          // above, the one authoritative ownership chain. Never a second,
          // independently-resolved TenantContext, and never client input.
          tenantId: attempt.tenantId,
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
      this.assertSameIntent(raced, request);
      return this.intentResponse(raced, null);
    }
  }

  // Milestone S0D-2C-1 — idempotency keys are still GLOBALLY unique
  // (tenant-scoping them is S0D-3), so a key can name another tenant's
  // attempt. It is refused before anything about it is returned, with one
  // generic conflict that says nothing about what the key belongs to.
  private assertAttemptOwned(
    attempt: { tenantId: string },
    tenant: TenantContext,
  ): void {
    if (attempt.tenantId !== tenant.tenantId) {
      throw new ConflictException(
        'This idempotency key cannot be used. Start a new purchase.',
      );
    }
  }

  // ESP-03 PR 2 — an idempotency key is bound to the intent that created it.
  // The persisted amount and purchaser contact are compared against the
  // replayed request WITHOUT consulting current configuration (so a config
  // change can never reject a legitimate replay). A different request
  // reusing the key is refused before anything about the original is shown.
  private assertSameIntent(
    purchase: {
      amountMinorUnits: number;
      purchaserEmail: string | null;
      purchaserName: string | null;
    },
    request: CreateGiftCardPurchaseIntentRequest,
  ): void {
    const same =
      request?.amountMinorUnits === purchase.amountMinorUnits &&
      this.validateEmail(request?.purchaserEmail) === purchase.purchaserEmail &&
      this.validateName(request?.purchaserName) === purchase.purchaserName;
    if (!same) {
      throw new ConflictException(
        'This idempotency key was already used for a different gift-card purchase. Start a new purchase.',
      );
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

  //
  // Milestone S0D-2C-1 — `tenant` is the request's explicit TenantContext.
  // The attempt found by the client's key must belong to it, checked before
  // anything is authorised, charged, issued or revealed; another tenant's
  // attempt is reported exactly like a key with no purchase at all.
  async purchase(
    request: PurchaseGiftCardRequest,
    customerIdentity: CustomerIdentity | undefined,
    tenant: TenantContext,
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
    if (
      !attempt ||
      !attempt.giftCardPurchase ||
      attempt.tenantId !== tenant.tenantId
    ) {
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
    // ESP-03 PR 2 — a charge whose outcome is not final is held, never
    // charged again and never reported as failed.
    if (heldStateOf(attempt) !== null) {
      throw new ConflictException(HELD_PAYMENT_MESSAGE);
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

    // SC2b — checked again at the charging step, before the claim: the plan
    // may have changed since the intent was created. Nothing has been
    // charged yet, so refusing here strands no payment. Once the claim below
    // is made the purchase completes (or replays) whatever the plan says.
    await this.features.assertAvailable(tenant.tenantId, 'giftcards');

    // Payment safety — checked again at the charging step, before the claim:
    // configuration may have changed since the intent was created.
    this.assertPaymentAvailable();

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

    // The purchase's permanent claim above already guarantees a single
    // charging request; a pre-ESP-03 intent (paymentState NULL) was never
    // charged, so it may enter CHARGING too.
    const charged = await chargeAttempt(
      this.prisma,
      this.paymentProvider,
      attempt,
      {
        amount: purchase.amountMinorUnits,
        currency: purchase.currency,
        metadata: {},
      },
      { allowLegacyNullState: true },
    );
    if (charged.kind === 'declined' || charged.kind === 'failed') {
      throw new HttpException(
        { outcome: charged.kind, message: charged.reason },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    if (charged.kind !== 'succeeded') {
      throw new ConflictException(HELD_PAYMENT_MESSAGE);
    }

    let displayCode: string;
    let last4: string;
    let codeRetrievableUntil: Date;
    try {
      const issued = await this.issuance.issue(
        {
          tenantId: purchase.tenantId,
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
  private assertPaymentAvailable(): void {
    if (!this.paymentProvider.acceptsPayments) {
      throw new ServiceUnavailableException(
        'Online payment is not available right now.',
      );
    }
  }

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
    tenant: TenantContext,
  ): Promise<string | null> {
    if (!customerIdentity) {
      return null;
    }
    const customer = await this.customersService.resolveOrCreateFromIdentity(
      customerIdentity,
      tenant,
    );
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
  private async validateAmount(
    raw: unknown,
    tenant: TenantContext,
  ): Promise<number> {
    if (
      typeof raw !== 'number' ||
      !Number.isInteger(raw) ||
      raw <= 0 ||
      raw > GIFT_CARD_MAX_VALUE_MINOR_UNITS
    ) {
      throw new BadRequestException('Choose a valid gift-card amount.');
    }

    const config = await this.configuration.getPublicOptions(tenant);
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
    throw new BadRequestException(
      'Choose one of the listed gift-card amounts.',
    );
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
