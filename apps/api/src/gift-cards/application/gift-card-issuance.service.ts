import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import {
  canonicalizeGiftCardCode,
  generateGiftCardCode,
  hashGiftCardCode,
  lastFourOfGiftCardCode,
} from '../infrastructure/gift-card-code';

// Milestone 7H — the ONE shared financial issuance core. Both HQ issuance
// (GiftCardsAdminService.issue) and customer purchase issuance
// (GiftCardPurchaseService) go through this so the code-generation,
// canonicalization, HMAC hashing, last4, collision retry, GiftCard row
// creation and the single ISSUANCE ledger entry are defined exactly once.
//
// It manages its OWN transaction and retry loop. Anything a caller needs to
// commit atomically with the issuance (an HQ audit event, or a customer
// purchase's status update + encrypted recovery material) is done in the
// `withinTransaction` callback, on the same `tx`, so it commits or rolls
// back together. A callback error that is not a unique-constraint violation
// propagates (no retry); the whole transaction rolls back.

type GiftCardRow = Prisma.GiftCardGetPayload<Record<string, never>>;

const CODE_COLLISION_RETRIES = 5;

export interface IssuedGiftCard {
  card: GiftCardRow;
  // The grouped display form ("XXXX XXXX XXXX XXXX") — the ONLY place the
  // plaintext code exists. Callers return it once and never persist it.
  displayCode: string;
  canonicalCode: string;
  last4: string;
}

export interface IssueGiftCardCoreParams {
  originalValueMinorUnits: number;
  currency: string;
  // Set for an HQ-issued card; null for a customer purchase.
  actorInternalUserId?: string | null;
  // Set for a customer-purchased card; null for HQ issuance.
  giftCardPurchaseId?: string | null;
}

@Injectable()
export class GiftCardIssuanceService {
  constructor(private readonly prisma: PrismaService) {}

  async issue(
    params: IssueGiftCardCoreParams,
    withinTransaction?: (
      tx: Prisma.TransactionClient,
      issued: IssuedGiftCard,
    ) => Promise<void>,
  ): Promise<IssuedGiftCard> {
    for (let attempt = 0; attempt < CODE_COLLISION_RETRIES; attempt++) {
      const displayCode = generateGiftCardCode();
      const canonicalCode = canonicalizeGiftCardCode(displayCode)!;
      const codeHash = hashGiftCardCode(canonicalCode);
      const last4 = lastFourOfGiftCardCode(canonicalCode);

      try {
        const issued = await this.prisma.$transaction(async (tx) => {
          const card = await tx.giftCard.create({
            data: {
              codeHash,
              last4,
              originalValueMinorUnits: params.originalValueMinorUnits,
              balanceMinorUnits: params.originalValueMinorUnits,
              currency: params.currency,
            },
          });
          await tx.giftCardTransaction.create({
            data: {
              giftCardId: card.id,
              type: 'ISSUANCE',
              amountMinorUnits: params.originalValueMinorUnits,
              balanceAfterMinorUnits: params.originalValueMinorUnits,
              actorInternalUserId: params.actorInternalUserId ?? null,
              giftCardPurchaseId: params.giftCardPurchaseId ?? null,
            },
          });
          const result: IssuedGiftCard = {
            card,
            displayCode,
            canonicalCode,
            last4,
          };
          if (withinTransaction) {
            await withinTransaction(tx, result);
          }
          return result;
        });
        return issued;
      } catch (error) {
        // Only a codeHash collision is retryable — regenerate and try again.
        // Anything else (including a callback failure) propagates.
        if (isUniqueConstraintViolation(error)) {
          continue;
        }
        throw error;
      }
    }

    throw new ConflictException(
      'Could not allocate a unique gift-card code. Please try again.',
    );
  }
}

// Checked structurally (not `instanceof Prisma.PrismaClientKnownRequestError`)
// for the same reason the other gift-card services do.
export function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
