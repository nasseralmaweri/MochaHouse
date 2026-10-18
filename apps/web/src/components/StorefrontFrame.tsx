import Link from "next/link";
import type { StorefrontProfileResponse } from "@mocha-house/contracts";
import { CartLink } from "@/components/CartLink";
import { requireStorefrontProfile } from "@/lib/storefront-profile";
import { StorefrontProfileProvider } from "@/lib/storefront-profile-context";

// SC4f-3b (owner decision J4) — the frame around storefront pages: the
// business's profile for client components, and a compact header naming the
// business with Menu, Account and (only while it can take orders) Cart.
// The legacy business (Mocha House) keeps its established appearance: no
// new header, the order pages' own cart link as before.
export async function StorefrontFrame({
  children,
  legacyCartBar = false,
}: {
  children: React.ReactNode;
  // The order pages' existing cart bar, kept for the legacy presentation.
  legacyCartBar?: boolean;
}) {
  const profile = await requireStorefrontProfile();
  return (
    <StorefrontProfileProvider profile={profile}>
      {profile.presentation === "legacy" ? (
        legacyCartBar ? (
          <div className="mx-auto flex w-full max-w-md items-center justify-end px-4 pt-4">
            <CartLink />
          </div>
        ) : null
      ) : (
        <StorefrontHeader profile={profile} />
      )}
      {children}
    </StorefrontProfileProvider>
  );
}

const NAV_LINK =
  "inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-text-secondary hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export function StorefrontHeader({ profile }: { profile: StorefrontProfileResponse }) {
  return (
    <header className="border-b border-border-default bg-surface-card">
      <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-2 px-4 py-2">
        <Link
          href="/"
          className="inline-flex min-h-11 items-center text-base font-semibold text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {profile.businessName || "Home"}
        </Link>
        <nav aria-label="Main" className="flex flex-wrap items-center gap-1">
          <Link href="/order/location" className={NAV_LINK}>
            Menu
          </Link>
          <Link href="/account" className={NAV_LINK}>
            Account
          </Link>
          {profile.orderingAvailable ? <CartLink /> : null}
        </nav>
      </div>
    </header>
  );
}
