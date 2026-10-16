import type { Metadata } from "next";
import { PageHeader } from "@/components/PageHeader";
import { GiftCardsClient } from "./GiftCardsClient";
import { getStorefrontFeatures } from "@/lib/api";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Gift Cards · Mocha House",
  description:
    "Buy a digital Mocha House gift card or check the balance on one you already have.",
};

// Milestone 7H — the public customer gift-card page: buy a digital gift
// card (guest or signed-in) and check a card's balance. All the work runs
// in the client panel against the same-origin proxy routes under
// /api/gift-cards/*, which forward to GiftCardPurchaseService /
// GiftCardBalanceService. No account required.
export default async function GiftCardsPage() {
  // SC2b — without the gift-card module nothing can be bought, but anyone
  // holding a card can still check its balance (and spend it at checkout).
  const features = await getStorefrontFeatures();
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <PageHeader
        title="Gift Cards"
        subtitle="Buy a digital gift card, or check a balance."
      />
      <GiftCardsClient purchaseAvailable={features?.giftcards !== false} />
    </main>
  );
}
