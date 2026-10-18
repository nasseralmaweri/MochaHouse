"use client";

import { createContext, useContext } from "react";
import type { StorefrontProfileResponse } from "@mocha-house/contracts";
import { PointsLabelProvider } from "@/lib/points-label-context";

// SC4f-3b — the storefront's own business profile for client components
// (cart, checkout, confirmation, product pages), set by the server layout
// from the API's resolved business.
const StorefrontProfileContext = createContext<StorefrontProfileResponse | null>(null);

export function StorefrontProfileProvider({
  profile,
  children,
}: {
  profile: StorefrontProfileResponse;
  children: React.ReactNode;
}) {
  return (
    <StorefrontProfileContext.Provider value={profile}>
      <PointsLabelProvider label={profile.loyaltyPointsLabel}>{children}</PointsLabelProvider>
    </StorefrontProfileContext.Provider>
  );
}

// null outside a storefront layout (never the case for storefront pages).
export function useStorefrontProfile(): StorefrontProfileResponse | null {
  return useContext(StorefrontProfileContext);
}

// Client wording that names the business (see lib/storefront-profile named()).
export function useNamed(template: string, fallback: string): string {
  const name = useStorefrontProfile()?.businessName.trim() ?? "";
  return name === "" ? fallback : template.replaceAll("{name}", name);
}
