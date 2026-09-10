import { Injectable } from '@nestjs/common';
import type {
  AdminCustomerGiftCardPurchase,
  AdminCustomerGiftCardRedemption,
  AdminCustomerGiftCardSummary,
} from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import { maskGiftCardCode } from '../infrastructure/gift-card-code';

// Milestone 8A — the gift-card slice of the HQ CRM customer view. Read-only
// and customerId-scoped; the caller (CrmModule) authorises with
// `customers.view`. Exposes ONLY the masked identity (`last4` /
// `maskGiftCardCode`) — never a codeHash, a full code, an internal GiftCard
// id, or a ciphertext. Two projections:
//   - purchases:   GiftCardPurchase rows this signed-in customer bought.
//   - redemptions: the immutable OrderGiftCardRedemption snapshots on this
//                  customer's own orders.
@Injectable()
export class GiftCardCustomerSummaryService {
  constructor(private readonly prisma: PrismaService) {}

  async getForCustomer(
    customerId: string,
  ): Promise<AdminCustomerGiftCardSummary> {
    const [purchases, redemptions] = await Promise.all([
      this.prisma.giftCardPurchase.findMany({
        where: { customerId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          amountMinorUnits: true,
          currency: true,
          createdAt: true,
          giftCard: { select: { last4: true } },
        },
      }),
      this.prisma.orderGiftCardRedemption.findMany({
        where: { order: { customerId } },
        orderBy: { createdAt: 'desc' },
        select: {
          last4: true,
          amountMinorUnits: true,
          currency: true,
          createdAt: true,
          order: { select: { id: true, orderNumber: true } },
        },
      }),
    ]);

    return {
      purchases: purchases.map(
        (purchase): AdminCustomerGiftCardPurchase => ({
          purchaseId: purchase.id,
          status: purchase.status,
          amountMinorUnits: purchase.amountMinorUnits,
          currency: purchase.currency,
          last4: purchase.giftCard?.last4 ?? null,
          maskedCode: purchase.giftCard
            ? maskGiftCardCode(purchase.giftCard.last4)
            : null,
          createdAt: purchase.createdAt.toISOString(),
        }),
      ),
      redemptions: redemptions.map(
        (redemption): AdminCustomerGiftCardRedemption => ({
          orderId: redemption.order.id,
          orderNumber: redemption.order.orderNumber,
          last4: redemption.last4,
          amountMinorUnits: redemption.amountMinorUnits,
          currency: redemption.currency,
          createdAt: redemption.createdAt.toISOString(),
        }),
      ),
    };
  }
}
