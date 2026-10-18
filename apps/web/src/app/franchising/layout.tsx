import { StorefrontFrame } from "@/components/StorefrontFrame";

// SC4f-3b — the storefront frame: the business's own profile and header.
export default function FranchisingLayout({ children }: { children: React.ReactNode }) {
  return <StorefrontFrame>{children}</StorefrontFrame>;
}
