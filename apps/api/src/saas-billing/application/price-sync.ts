import type { PrismaService } from '../../prisma/prisma.service';
import type { SaasBillingProvider } from '../provider/saas-billing-provider';

// SC3b (shared since SC3d-1) — the provider product of a plan and the
// provider price of one of its list prices, created once and recorded
// (deterministic at the provider: retries and concurrent requests yield the
// same objects). Amount, currency and interval come from OUR price row. This
// creates catalog objects only — it never touches a subscription or charges.
export async function syncProviderPrice(
  prisma: PrismaService,
  provider: SaasBillingProvider,
  plan: { id: string; name: string; externalProductId: string | null },
  price: {
    id: string;
    amountMinorUnits: number;
    currency: string;
    interval: 'MONTH' | 'YEAR';
    externalPriceId: string | null;
  },
): Promise<string> {
  let externalProductId = plan.externalProductId;
  if (externalProductId === null) {
    ({ externalProductId } = await provider.ensureProduct({
      planId: plan.id,
      planName: plan.name,
    }));
    await prisma.subscriptionPlan.updateMany({
      where: { id: plan.id, externalProductId: null },
      data: { externalProductId },
    });
    externalProductId = (
      await prisma.subscriptionPlan.findUniqueOrThrow({
        where: { id: plan.id },
        select: { externalProductId: true },
      })
    ).externalProductId!;
  }
  if (price.externalPriceId !== null) return price.externalPriceId;
  const { externalPriceId } = await provider.ensurePrice({
    priceId: price.id,
    externalProductId,
    amountMinorUnits: price.amountMinorUnits,
    currency: price.currency,
    interval: price.interval,
  });
  await prisma.subscriptionPlanPrice.updateMany({
    where: { id: price.id, externalPriceId: null },
    data: { externalPriceId },
  });
  const stored = await prisma.subscriptionPlanPrice.findUniqueOrThrow({
    where: { id: price.id },
    select: { externalPriceId: true },
  });
  return stored.externalPriceId!;
}
