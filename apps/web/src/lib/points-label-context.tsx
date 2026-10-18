"use client";

import { createContext, useContext } from "react";
import { DEFAULT_LOYALTY_POINTS_LABEL } from "@mocha-house/contracts";

// SC4f-3b — the business's loyalty points name for client components. Set
// by the server layouts (the admin shell from /internal/me, the storefront
// from its profile) — always the current business's own value.
const PointsLabelContext = createContext<string>(DEFAULT_LOYALTY_POINTS_LABEL);

export function PointsLabelProvider({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return <PointsLabelContext.Provider value={label}>{children}</PointsLabelContext.Provider>;
}

export function usePointsLabel(): string {
  return useContext(PointsLabelContext);
}
