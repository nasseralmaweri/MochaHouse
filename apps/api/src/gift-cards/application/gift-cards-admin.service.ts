import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  GIFT_CARD_MAX_VALUE_MINOR_UNITS,
  type AdjustGiftCardBalanceRequest,
  type AdminGiftCard,
  type AdminGiftCardDetail,
  type AdminGiftCardSearchResponse,
  type AdminGiftCardTransaction,
  type GiftCardSearchRequest,
  type GiftCardStatusChangeRequest,
  type IssueGiftCardRequest,
  type IssueGiftCardResponse,
} from '@mocha-house/contracts';
import { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { InternalAuditService } from '../../audit/internal-audit.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import {
  canonicalizeGiftCardCode,
  hashGiftCardCode,
  maskGiftCardCode,
} from '../infrastructure/gift-card-code';
import { GiftCardIssuanceService } from './gift-card-issuance.service';

// The HQ gift-card surface (Milestone 7F): issue a card for a legitimate
// administrative reason, look one up by its secure code or internal id,
// read its balance + the immutable transaction ledger, deactivate /
// reactivate it, and make an authorized manual balance correction.
//
// `giftcards.view` / `giftcards.manage` are CORPORATE-only in the permission
// catalog (PermissionGuard already rejects a LOCATION grant); every method
// also calls `assertCorporate` as the matching service-layer defence.
//
// FINANCIAL INVARIANTS (enforced here, before every write):
//   - SUM(transaction.amountMinorUnits) === GiftCard.balanceMinorUnits
//   - 0 <= balanceMinorUnits <= GIFT_CARD_MAX_VALUE_MINOR_UNITS ($2,000.00)
//   - originalValueMinorUnits is immutable after issuance
//   - exactly one ISSUANCE transaction per card
// Every balance-changing write inserts one ledger row AND updates the
// materialized balance inside ONE transaction, serialized by a
// `SELECT ... FOR UPDATE` on the GiftCard row (the loyalty-ledger pattern).
// The full plaintext code is returned exactly once, from `issue`.

const REASON_MAX_LENGTH = 1000;
const OPERATION_KEY_MIN_LENGTH = 8;
const OPERATION_KEY_MAX_LENGTH = 200;
const LEDGER_PAGE_SIZE = 100;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type GiftCardRow = Prisma.GiftCardGetPayload<Record<string, never>>;
type GiftCardTransactionRow = Prisma.GiftCardTransactionGetPayload<{
  include: {
    actorInternalUser: { select: { displayName: true; email: true } };
    order: { select: { orderNumber: true } };
  };
}>;

@Injectable()
export class GiftCardsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: InternalAuditService,
    private readonly issuance: GiftCardIssuanceService,
  ) {}

  // Exact lookup only: the secure code (submitted in the request BODY, then
  // hashed) OR the internal gift-card id. No fuzzy search, no listing-all,
  // and no search-by-last-4 in V1.
  async search(
    request: GiftCardSearchRequest,
    authorization: AuthorizationContext,
  ): Promise<AdminGiftCardSearchResponse> {
    authorization.assertCorporate('giftcards.view');

    const rawCode = typeof request?.code === 'string' ? request.code.trim() : '';
    const rawId =
      typeof request?.giftCardId === 'string' ? request.giftCardId.trim() : '';

    if (rawCode.length === 0 && rawId.length === 0) {
      throw new BadRequestException(
        'Provide a gift-card code or a gift-card id.',
      );
    }
    if (rawCode.length > 0 && rawId.length > 0) {
      throw new BadRequestException(
        'Search by gift-card code or by gift-card id, not both.',
      );
    }

    let card: GiftCardRow | null = null;
    if (rawCode.length > 0) {
      const canonical = canonicalizeGiftCardCode(rawCode);
      // A malformed code simply matches nothing — never echo it back.
      if (canonical) {
        card = await this.prisma.giftCard.findUnique({
          where: { codeHash: hashGiftCardCode(canonical) },
        });
      }
    } else {
      if (!UUID_PATTERN.test(rawId)) {
        throw new BadRequestException('That is not a valid gift-card id.');
      }
      card = await this.prisma.giftCard.findUnique({ where: { id: rawId } });
    }

    return { giftCards: card ? [this.toAdminGiftCard(card)] : [] };
  }

  async getDetail(
    giftCardId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminGiftCardDetail> {
    authorization.assertCorporate('giftcards.view');
    return this.buildDetail(giftCardId);
  }

  // Issue a gift card for a legitimate HQ administrative reason (comp cards,
  // customer-service recovery, testing/operations). NOT customer purchasing.
  // Uses the shared issuance core (Milestone 7H) and additionally records the
  // InternalAuditEvent in the SAME transaction. The full plaintext code is in
  // the response and is never retrievable again.
  async issue(
    request: IssueGiftCardRequest,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<IssueGiftCardResponse> {
    authorization.assertCorporate('giftcards.manage');

    const originalValueMinorUnits = this.validateOriginalValue(
      request?.originalValueMinorUnits,
    );
    const currency = this.validateCurrency(request?.currency);

    const issued = await this.issuance.issue(
      { originalValueMinorUnits, currency, actorInternalUserId },
      async (tx, { card, last4 }) => {
        await this.audit.recordGiftCardIssued(tx, {
          actorInternalUserId,
          giftCardId: card.id,
          last4,
          originalValueMinorUnits,
          currency,
        });
      },
    );

    return {
      giftCard: this.toAdminGiftCard(issued.card),
      code: issued.displayCode,
    };
  }

  async deactivate(
    giftCardId: string,
    request: GiftCardStatusChangeRequest,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminGiftCardDetail> {
    return this.changeStatus(
      giftCardId,
      'INACTIVE',
      request,
      actorInternalUserId,
      authorization,
    );
  }

  async reactivate(
    giftCardId: string,
    request: GiftCardStatusChangeRequest,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminGiftCardDetail> {
    return this.changeStatus(
      giftCardId,
      'ACTIVE',
      request,
      actorInternalUserId,
      authorization,
    );
  }

  // Authorized manual balance correction. `reason` required (trimmed,
  // non-empty). `deltaMinorUnits` a non-zero whole integer. `operationKey`
  // a caller-supplied idempotency key: a retry with the same key never
  // applies the change twice. The resulting balance may never fall below 0
  // or exceed GIFT_CARD_MAX_VALUE_MINOR_UNITS. Permitted on an INACTIVE
  // card (an accounting fix is not blocked by status). The ledger entry,
  // the materialized balance and the InternalAuditEvent are written in the
  // SAME transaction.
  async correct(
    giftCardId: string,
    request: AdjustGiftCardBalanceRequest,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminGiftCardDetail> {
    authorization.assertCorporate('giftcards.manage');

    const deltaMinorUnits = this.validateDelta(request?.deltaMinorUnits);
    const reason = this.validateReason(request?.reason);
    const operationKey = this.validateOperationKey(request?.operationKey);

    const card = await this.prisma.giftCard.findUnique({
      where: { id: giftCardId },
      select: { id: true },
    });
    if (!card) {
      throw new NotFoundException('Gift card not found.');
    }

    // Fast-path idempotent replay for the common sequential retry. The
    // authoritative re-check happens again INSIDE the row lock below.
    const preexisting = await this.findCorrectionByOperationKey(operationKey);
    if (preexisting) {
      this.assertOperationKeyOwnedBy(preexisting, giftCardId);
      return this.buildDetail(giftCardId);
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        // Serialize every balance-changing write for this card.
        await tx.$queryRaw`SELECT id FROM "GiftCard" WHERE id = ${giftCardId} FOR UPDATE`;

        // Re-check idempotency inside the lock: a concurrent request with
        // this operationKey may have committed between the fast-path check
        // and our acquiring the lock.
        const applied = await tx.giftCardTransaction.findFirst({
          where: { type: 'ADJUSTMENT', operationKey },
          select: { giftCardId: true },
        });
        if (applied) {
          if (applied.giftCardId !== giftCardId) {
            throw new ConflictException(
              'That operation key has already been used for a different gift card.',
            );
          }
          return;
        }

        const locked = await tx.giftCard.findUniqueOrThrow({
          where: { id: giftCardId },
          select: { balanceMinorUnits: true },
        });

        const balanceBefore = locked.balanceMinorUnits;
        const balanceAfter = balanceBefore + deltaMinorUnits;
        if (balanceAfter < 0) {
          throw new ConflictException(
            `That deduction would take the balance below $0.00 (current balance ${formatUsd(balanceBefore)}).`,
          );
        }
        if (balanceAfter > GIFT_CARD_MAX_VALUE_MINOR_UNITS) {
          throw new ConflictException(
            `That correction would take the balance above the ${formatUsd(GIFT_CARD_MAX_VALUE_MINOR_UNITS)} ceiling (current balance ${formatUsd(balanceBefore)}).`,
          );
        }

        await tx.giftCardTransaction.create({
          data: {
            giftCardId,
            type: 'ADJUSTMENT',
            amountMinorUnits: deltaMinorUnits,
            balanceAfterMinorUnits: balanceAfter,
            reason,
            operationKey,
            actorInternalUserId,
          },
        });

        await tx.giftCard.update({
          where: { id: giftCardId },
          data: { balanceMinorUnits: balanceAfter },
        });

        await this.audit.recordGiftCardBalanceCorrected(tx, {
          actorInternalUserId,
          giftCardId,
          deltaMinorUnits,
          balanceBeforeMinorUnits: balanceBefore,
          balanceAfterMinorUnits: balanceAfter,
          reason,
        });
      });
    } catch (error) {
      // A concurrent request with the same operationKey beat us to the
      // unique ADJUSTMENT ledger row (the partial unique index fired). By
      // the time a P2002 surfaces the winning transaction has committed, so
      // re-query and let the SAME ownership rule as the fast path decide:
      //   - same gift card  -> the idempotent replay it is; return detail.
      //   - different card  -> a genuine cross-card key clash; 409, with no
      //                        further balance/ledger/audit write on either
      //                        card (this transaction already rolled back).
      if (isUniqueConstraintViolation(error)) {
        const winner = await this.findCorrectionByOperationKey(operationKey);
        if (winner) {
          this.assertOperationKeyOwnedBy(winner, giftCardId);
        }
        return this.buildDetail(giftCardId);
      }
      throw error;
    }

    return this.buildDetail(giftCardId);
  }

  // --- internals ---------------------------------------------------

  private async changeStatus(
    giftCardId: string,
    target: 'ACTIVE' | 'INACTIVE',
    request: GiftCardStatusChangeRequest,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminGiftCardDetail> {
    authorization.assertCorporate('giftcards.manage');

    const contextReason = this.validateOptionalReason(request?.reason);

    const card = await this.prisma.giftCard.findUnique({
      where: { id: giftCardId },
      select: { id: true, status: true },
    });
    if (!card) {
      throw new NotFoundException('Gift card not found.');
    }

    if (card.status === target) {
      // Already in the target state — no change, nothing to audit.
      return this.buildDetail(giftCardId);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.giftCard.update({
        where: { id: giftCardId },
        data: { status: target },
      });
      await this.audit.recordGiftCardStatusChanged(tx, {
        actorInternalUserId,
        giftCardId,
        before: card.status,
        after: target,
        reason:
          contextReason ??
          (target === 'INACTIVE'
            ? 'Gift card deactivated by HQ.'
            : 'Gift card reactivated by HQ.'),
      });
    });

    return this.buildDetail(giftCardId);
  }

  private async buildDetail(giftCardId: string): Promise<AdminGiftCardDetail> {
    const card = await this.prisma.giftCard.findUnique({
      where: { id: giftCardId },
    });
    if (!card) {
      throw new NotFoundException('Gift card not found.');
    }

    const transactions = await this.prisma.giftCardTransaction.findMany({
      where: { giftCardId },
      orderBy: { createdAt: 'desc' },
      take: LEDGER_PAGE_SIZE,
      include: {
        actorInternalUser: { select: { displayName: true, email: true } },
        order: { select: { orderNumber: true } },
      },
    });

    return {
      giftCard: this.toAdminGiftCard(card),
      transactions: transactions.map((t) => this.toLedgerEntry(t)),
    };
  }

  private async findCorrectionByOperationKey(
    operationKey: string,
  ): Promise<{ giftCardId: string } | null> {
    return this.prisma.giftCardTransaction.findFirst({
      where: { type: 'ADJUSTMENT', operationKey },
      select: { giftCardId: true },
    });
  }

  private assertOperationKeyOwnedBy(
    entry: { giftCardId: string },
    giftCardId: string,
  ): void {
    if (entry.giftCardId !== giftCardId) {
      throw new ConflictException(
        'That operation key has already been used for a different gift card.',
      );
    }
  }

  private validateOriginalValue(raw: unknown): number {
    if (
      typeof raw !== 'number' ||
      !Number.isInteger(raw) ||
      raw <= 0 ||
      raw > GIFT_CARD_MAX_VALUE_MINOR_UNITS
    ) {
      throw new BadRequestException(
        `The gift-card value must be a whole number of minor units between 1 and ${GIFT_CARD_MAX_VALUE_MINOR_UNITS} ($2,000.00).`,
      );
    }
    return raw;
  }

  private validateCurrency(raw: unknown): string {
    if (raw === undefined || raw === null) {
      return 'USD';
    }
    if (typeof raw !== 'string' || raw.trim().toUpperCase() !== 'USD') {
      throw new BadRequestException('Only USD gift cards are supported.');
    }
    return 'USD';
  }

  private validateDelta(raw: unknown): number {
    if (
      typeof raw !== 'number' ||
      !Number.isInteger(raw) ||
      raw === 0 ||
      Math.abs(raw) > GIFT_CARD_MAX_VALUE_MINOR_UNITS
    ) {
      throw new BadRequestException(
        'The correction must be a non-zero whole number of minor units within the $2,000.00 ceiling.',
      );
    }
    return raw;
  }

  private validateReason(raw: unknown): string {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new BadRequestException('A reason is required.');
    }
    const reason = raw.trim();
    if (reason.length > REASON_MAX_LENGTH) {
      throw new BadRequestException(
        `Reason is too long (maximum ${REASON_MAX_LENGTH} characters).`,
      );
    }
    return reason;
  }

  private validateOptionalReason(raw: unknown): string | null {
    if (raw === undefined || raw === null) {
      return null;
    }
    if (typeof raw !== 'string') {
      throw new BadRequestException('Reason must be text.');
    }
    const reason = raw.trim();
    if (reason.length === 0) {
      return null;
    }
    if (reason.length > REASON_MAX_LENGTH) {
      throw new BadRequestException(
        `Reason is too long (maximum ${REASON_MAX_LENGTH} characters).`,
      );
    }
    return reason;
  }

  private validateOperationKey(raw: unknown): string {
    if (typeof raw !== 'string') {
      throw new BadRequestException('An operationKey is required.');
    }
    const key = raw.trim();
    if (
      key.length < OPERATION_KEY_MIN_LENGTH ||
      key.length > OPERATION_KEY_MAX_LENGTH
    ) {
      throw new BadRequestException(
        `A valid operationKey (${OPERATION_KEY_MIN_LENGTH}-${OPERATION_KEY_MAX_LENGTH} characters) is required.`,
      );
    }
    return key;
  }

  private toAdminGiftCard(card: GiftCardRow): AdminGiftCard {
    return {
      id: card.id,
      maskedCode: maskGiftCardCode(card.last4),
      last4: card.last4,
      status: card.status,
      originalValueMinorUnits: card.originalValueMinorUnits,
      balanceMinorUnits: card.balanceMinorUnits,
      currency: card.currency,
      createdAt: card.createdAt.toISOString(),
    };
  }

  private toLedgerEntry(
    entry: GiftCardTransactionRow,
  ): AdminGiftCardTransaction {
    return {
      id: entry.id,
      type: entry.type,
      amountMinorUnits: entry.amountMinorUnits,
      balanceAfterMinorUnits: entry.balanceAfterMinorUnits,
      reason: entry.reason,
      actorLabel: entry.actorInternalUser
        ? entry.actorInternalUser.displayName ?? entry.actorInternalUser.email
        : null,
      orderNumber: entry.order?.orderNumber ?? null,
      createdAt: entry.createdAt.toISOString(),
    };
  }
}

// Checked structurally (not `instanceof Prisma.PrismaClientKnownRequestError`)
// for the same reason LoyaltyService does: a genuinely concurrent
// unique-constraint violation can surface through a different error identity
// than this module's own Prisma import resolves to.
export function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

function formatUsd(minorUnits: number): string {
  return `$${(minorUnits / 100).toFixed(2)}`;
}
