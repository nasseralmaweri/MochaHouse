import type { Metadata } from "next";
import { StorefrontFrame } from "@/components/StorefrontFrame";
import { pageTitle, requireStorefrontProfile } from "@/lib/storefront-profile";

// The order pages' title names the storefront's own business (a page with
// its own title overrides it).
export async function generateMetadata(): Promise<Metadata> {
  return { title: pageTitle(await requireStorefrontProfile(), "Order") };
}

// SC4f-3b — the storefront frame: the business's own profile and header (the
// header carries the cart while the business can take orders; the legacy
// presentation keeps the order pages' own cart link).
export default function OrderLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col">
      <StorefrontFrame legacyCartBar>{children}</StorefrontFrame>
    </div>
  );
}
