import type { Metadata } from "next";
import { StorefrontFrame } from "@/components/StorefrontFrame";
import { pageTitle, requireStorefrontProfile } from "@/lib/storefront-profile";

// The account pages' title names the storefront's own business (a page with
// its own title overrides it).
export async function generateMetadata(): Promise<Metadata> {
  return { title: pageTitle(await requireStorefrontProfile(), "Account") };
}

// SC4f-3b — the storefront frame: the business's own profile and header.
export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return <StorefrontFrame>{children}</StorefrontFrame>;
}
