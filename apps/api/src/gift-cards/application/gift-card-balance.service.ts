import { Injectable } from '@nestjs/common';
import type {
  GiftCardBalanceResponse,
  GiftCardPublicStatus,
} from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import { heldOnGiftCard } from '../../payment/financial-holds';
import type { TenantContext } from '@mocha-house/database';
import {
  canonicalizeGiftCardCode,
  hashGiftCardCode,
  maskGiftCardCode,
} from '../infrastructure/gift-card-code';

// Milestone 7H — the public gift-card balance lookup. READ-ONLY: canonicalize
// + HMAC-hash the submitted code, resolve by codeHash, and return ONLY a
// masked identity + the balance/status. A malformed code and an unknown code
// return the identical `{ found: false }` shape (no enumeration signal). The
// response never contains codeHash, the full code, the internal GiftCard id,
// the original value, any ledger entry, or any purchase / customer / HQ
// information.
@Injectable()
export class GiftCardBalanceService {
  constructor(private readonly prisma: PrismaService) {}

  // Only the storefront business's cards: another business's code returns
  // the same `{ found: false }` as an unknown one.
  async lookup(
    rawCode: unknown,
    tenant: TenantContext,
  ): Promise<GiftCardBalanceResponse> {
    const canonical = canonicalizeGiftCardCode(rawCode);
    if (canonical === null) {
      return { found: false };
    }

    const card = await this.prisma.giftCard.findFirst({
      where: {
        codeHash: hashGiftCardCode(canonical),
        tenantId: tenant.tenantId,
      },
      select: {
        id: true,
        last4: true,
        status: true,
        balanceMinorUnits: true,
        currency: true,
      },
    });
    if (!card) {
      return { found: false };
    }
    // ESP-03 PR 8 — what can be spent now: the balance minus what payments
    // in progress hold on this card.
    const available =
      card.balanceMinorUnits -
      (await heldOnGiftCard(this.prisma, tenant.tenantId, card.id));

    return {
      found: true,
      maskedCode: maskGiftCardCode(card.last4),
      last4: card.last4,
      balanceMinorUnits: available,
      currency: card.currency,
      status: publicStatus(card.status, available),
    };
  }
}

function publicStatus(
  status: 'ACTIVE' | 'INACTIVE',
  balanceMinorUnits: number,
): GiftCardPublicStatus {
  if (status === 'INACTIVE') {
    return 'inactive';
  }
  return balanceMinorUnits <= 0 ? 'depleted' : 'active';
}
