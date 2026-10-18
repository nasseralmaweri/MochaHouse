import {
  BadRequestException,
  ConflictException,
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
  GIFT_CARD_PURCHASE_NOT_FOUND,
} from '@mocha-house/contracts';
import type { PaymentProvider } from '@mocha-house/integrations';
import { Prisma, type TenantContext } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CustomersService,
  assertCustomerAccess,
} from '../../customers/application/customers.service';
import type { CustomerIdentity } from '../../customer-auth/infrastructure/customer-identity';
import { PAYMENT_PROVIDER } from '../../payment/payment-provider.token';
import {
  chargeAttempt,
  customerPaymentMessage,
  heldStateOf,
  openReconciliationCase,
  resolveCaseAsFulfilled,
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
// A charge claim older than this whose payment was never sent is stranded.
const STRANDED_CLAIM_MS = 5 * 60 * 1000;

// ESP-03 PR 4 — a second issuance for a purchase that already has its card.
class GiftCardAlreadyIssuedError extends Error {
  constructor() {
    super('This gift-card purchase already has its card.');
    this.name = 'GiftCardAlreadyIssuedError';
  }
}

function issueFailedMessage(purchaseId: string): string {
  return (
    `Your payment succeeded but the gift card could not be issued ` +
    `automatically. Do not pay again — reference ${purchaseId} for support.`
  );
}

// The one answer for a key with no purchase the caller may see — unknown,
// another business's, or (ESP-03 PR 3) not the caller's.
const NO_PURCHASE_FOR_KEY = {
  code: GIFT_CARD_PURCHASE_NOT_FOUND,
  message:
    'No gift-card purchase was started for this key. Start a new purchase.',
};
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
      // ESP-03 PR 3 (R1) — a key whose attempt is not a gift-card intent is
      // refused before anything else happens (the amount is checked again
      // once it is validated, below).
      if (!existing.giftCardPurchase) {
        this.assertAttachableAttempt(existing, null);
      }
    }
    if (existing?.giftCardPurchase) {
      this.assertSameIntent(existing.giftCardPurchase, request);
      return this.replayIntent(existing.giftCardPurchase, existing);
    }
    // SC2b — selling a NEW gift card needs the gift-card module in the
    // business's plan: refused before any intent or payment attempt exists.
    // (An intent that already exists is returned above as persisted.)
    await this.features.assertAvailableForSale(tenant.tenantId, 'giftcards');

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
        return this.replayIntent(raced.giftCardPurchase, raced);
      }
      // ESP-03 PR 3 (R1) — only a fresh, uncharged gift-card attempt for this
      // exact amount may be built upon; never a checkout's attempt.
      this.assertAttachableAttempt(raced, amountMinorUnits);
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

  // ESP-03 PR 3 (R1) — a payment attempt that has no gift-card purchase yet
  // may only become one when it is a gift-card attempt (no Location), for
  // the same amount (when known), and has never been charged (NOT_SENT, or
  // legacy NULL). A checkout's attempt, a different amount, or an attempt
  // already charging / charged is refused with the same generic conflict as
  // another business's key, and nothing is created or changed.
  private assertAttachableAttempt(
    attempt: {
      locationId: string | null;
      amount: number;
      status: string;
      paymentState: string | null;
    },
    amountMinorUnits: number | null,
  ): void {
    const attachable =
      attempt.locationId === null &&
      attempt.status === 'PENDING' &&
      (attempt.paymentState === 'NOT_SENT' || attempt.paymentState === null) &&
      (amountMinorUnits === null || attempt.amount === amountMinorUnits);
    if (!attachable) {
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

  // ESP-03 PR 3 (R3) — step 1 replays only while the purchase is still
  // waiting for its first payment (a client retrying step 1). Once payment
  // has started, been taken or needs review, a replay of step 1 answers
  // with the generic conflict, so step 1 never reveals a payment's state.
  private replayIntent(
    purchase: {
      id: string;
      status: 'PENDING' | 'ISSUED' | 'RECONCILIATION_REQUIRED';
      amountMinorUnits: number;
      currency: string;
      customerId: string | null;
      chargeClaimedAt: Date | null;
    },
    attempt: { status: string; paymentState: string | null },
  ): GiftCardPurchaseIntentResponse {
    const uncharged =
      purchase.status === 'PENDING' &&
      purchase.chargeClaimedAt === null &&
      attempt.status === 'PENDING' &&
      (attempt.paymentState === 'NOT_SENT' || attempt.paymentState === null);
    if (!uncharged) {
      throw new ConflictException(
        'This idempotency key cannot be used. Start a new purchase.',
      );
    }
    return this.intentResponse(purchase, null);
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
      throw new ConflictException(NO_PURCHASE_FOR_KEY);
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

    // ESP-03 PR 3 (R3) — every state (pending, declined, failed, held,
    // reconciliation, in progress, issued) is the buyer's business only.
    // Anyone else gets exactly the answer an unknown key gets, so nothing
    // about the payment is revealed.
    if (!authorised) {
      throw new ConflictException(NO_PURCHASE_FOR_KEY);
    }

    // An issued card replays its confirmation; the full code while the
    // recovery window is open.
    if (attempt.status === 'SUCCEEDED' && purchase.giftCard) {
      const code = await this.recoverCode(purchase);
      return this.confirmation(purchase, purchase.giftCard.last4, code);
    }

    // Terminal / in-flight states → replay.
    if (attempt.status === 'DECLINED' || attempt.status === 'FAILED') {
      const outcome = attempt.status === 'DECLINED' ? 'declined' : 'failed';
      throw new HttpException(
        { outcome, message: customerPaymentMessage(outcome) },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    // ESP-03 PR 2 — a charge whose outcome is not final is held, never
    // charged again and never reported as failed.
    if (heldStateOf(attempt) !== null) {
      throw new ConflictException(HELD_PAYMENT_MESSAGE);
    }
    // ESP-03 PR 4 — definitively charged, card not issued yet (the first
    // attempt crashed, failed to write, or is still running): the card is
    // issued now from the saved purchase, exactly once, for the buyer who
    // proved (above) they established it. Never charged again.
    if (
      attempt.status === 'SUCCEEDED' &&
      attempt.paymentState === 'SUCCEEDED'
    ) {
      return this.issueForPurchase(purchase, attempt);
    }
    // A payment from before ESP-03 (no definitive state): unchanged.
    if (
      attempt.reconciliationRequired ||
      purchase.status === 'RECONCILIATION_REQUIRED'
    ) {
      throw new ConflictException(issueFailedMessage(purchase.id));
    }
    if (attempt.status === 'SUCCEEDED') {
      throw new ConflictException(
        'A gift-card purchase with this key is already being processed.',
      );
    }

    // attempt.status === 'PENDING' → the first (charging) call, by the
    // caller who proved (above) they established this intent.

    // SC2b — checked again at the charging step, before the claim: the plan
    // may have changed since the intent was created. Nothing has been
    // charged yet, so refusing here strands no payment. Once the claim below
    // is made the purchase completes (or replays) whatever the plan says.
    await this.features.assertAvailableForSale(tenant.tenantId, 'giftcards');

    // Payment safety — checked again at the charging step, before the claim:
    // configuration may have changed since the intent was created.
    this.assertPaymentAvailable();

    // Concurrency claim — exactly one request charges.
    const claim = await this.prisma.giftCardPurchase.updateMany({
      where: { id: purchase.id, status: 'PENDING', chargeClaimedAt: null },
      data: { chargeClaimedAt: new Date() },
    });
    if (claim.count === 0) {
      // ESP-03 PR 3 — a purchase claimed long ago whose payment was never
      // sent (the process stopped between the two claims) is stranded:
      // nothing was charged, but nothing will finish it either. Make it
      // visible to people; it is never charged here.
      if (
        purchase.chargeClaimedAt !== null &&
        Date.now() - purchase.chargeClaimedAt.getTime() > STRANDED_CLAIM_MS &&
        heldStateOf(attempt) === null
      ) {
        await openReconciliationCase(
          this.prisma,
          attempt.id,
          'CHARGE_CLAIM_STRANDED',
          { outcome: 'not_sent' },
        );
      }
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
      // ESP-03 PR 3 — fixed wording; the provider's text stays internal.
      throw new HttpException(
        {
          outcome: charged.kind,
          message: customerPaymentMessage(charged.kind),
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    if (charged.kind !== 'succeeded') {
      throw new ConflictException(HELD_PAYMENT_MESSAGE);
    }

    return this.issueForPurchase(purchase, attempt);
  }

  // ESP-03 PR 4 — issues the card for a charged purchase from the saved
  // purchase row (never from a request), exactly once. Used right after the
  // charge and again by a retry of a purchase whose card was not issued.
  // Inside the issuing transaction the purchase row is locked and must not
  // have a card yet; a second, concurrent issuance therefore rolls back its
  // card entirely and answers with the card that was issued. On failure the
  // payment stays SUCCEEDED, flagged for review with an open case.
  private async issueForPurchase(
    purchase: PurchaseRow,
    attempt: { id: string; tenantId: string },
  ): Promise<PurchaseGiftCardResponse> {
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
          await tx.paymentAttempt.updateMany({
            where: { id: attempt.id, tenantId: attempt.tenantId },
            data: { reconciliationRequired: false, fulfilmentStatus: 'DONE' },
          });
          await resolveCaseAsFulfilled(tx, attempt.tenantId, attempt.id);
        },
        // Locked FIRST, before the card and its ledger row are written (they
        // reference this purchase, and a later lock would deadlock two
        // concurrent issuances): only a purchase with no card yet proceeds.
        async (tx) => {
          const locked = await tx.$queryRaw<
            { status: string; giftCardId: string | null }[]
          >`
            SELECT status::text AS status, "giftCardId"
            FROM "GiftCardPurchase"
            WHERE id = ${purchase.id} AND "tenantId" = ${purchase.tenantId}
            FOR UPDATE`;
          if (
            locked.length !== 1 ||
            locked[0].status === 'ISSUED' ||
            locked[0].giftCardId !== null
          ) {
            throw new GiftCardAlreadyIssuedError();
          }
        },
      );
      displayCode = issued.displayCode;
      last4 = issued.last4;
    } catch (error) {
      // Issued meanwhile by another request for this purchase (this
      // request's card was rolled back with its write), or this request's
      // own issuance committed although it saw an error (a lost commit
      // acknowledgement): a purchase with a card is issued — answer with it,
      // and record nothing.
      const current = await this.prisma.giftCardPurchase
        .findUnique({
          where: { id: purchase.id },
          include: { giftCard: { select: { last4: true } } },
        })
        .catch(() => null);
      if (current?.giftCard) {
        return this.confirmation(
          current,
          current.giftCard.last4,
          await this.recoverCode(current),
        );
      }
      await this.recordIssueFailure(purchase.id, attempt.id, error);
      throw new ConflictException(issueFailedMessage(purchase.id));
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

  // The payment succeeded but the card could not be issued: durably flagged
  // for review with a reconciliation case (never charged again, never marked
  // failed). Best effort — logged with the purchase id if it cannot be
  // written.
  private async recordIssueFailure(
    purchaseId: string,
    paymentAttemptId: string,
    error: unknown,
  ): Promise<void> {
    try {
      await this.markReconciliationRequired(paymentAttemptId, error);
      // Never over a purchase that has its card.
      await this.prisma.giftCardPurchase.updateMany({
        where: { id: purchaseId, giftCardId: null },
        data: { status: 'RECONCILIATION_REQUIRED' },
      });
    } catch (writeError) {
      this.logger.error(
        `gift-card purchase ${purchaseId}: the card could not be issued and the failure could not be recorded (${
          writeError instanceof Error ? writeError.name : 'unknown error'
        })`,
      );
    }
    await openReconciliationCase(
      this.prisma,
      paymentAttemptId,
      'FULFILMENT_FAILED',
      { outcome: 'succeeded' },
    );
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
      // SC4f-2 — the signed-in login's profile in the PURCHASE's business,
      // and only while that profile may act there (a restricted or
      // deactivated profile cannot retrieve a code).
      const customer = await this.prisma.customer.findUnique({
        where: {
          tenantId_externalProvider_externalSubject: {
            tenantId: purchase.tenantId,
            externalProvider: customerIdentity.provider,
            externalSubject: customerIdentity.subject,
          },
        },
        select: { id: true, status: true },
      });
      if (!customer || customer.id !== purchase.customerId) return false;
      assertCustomerAccess(customer.status, 'write');
      return true;
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
    const customer = await this.customersService.requireCustomer(
      customerIdentity,
      tenant,
      'write',
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
