"use client";

import { createContext, useContext, useMemo } from "react";
import type {
  InternalPermissionKey,
  InternalUserProfile,
  LocationSummary,
} from "@mocha-house/contracts";
import {
  can as capCan,
  canAtLocation as capCanAtLocation,
  isCorporateFor as capIsCorporateFor,
  type AdminCapabilities,
} from "@/lib/admin/capabilities";
import type { AdminLocationContext } from "@/lib/admin/location-context";

export interface AdminContextValue {
  user: InternalUserProfile;
  // Per-permission effective scope. Components ask questions via the helpers
  // below, not by reading this directly.
  capabilities: AdminCapabilities;
  // True when the user has ANY corporate grant — drives the "Corporate /
  // All locations" context option. For a per-permission signal use
  // isCorporateFor(key).
  isCorporate: boolean;
  // The general authorization-aware location set (from GET /internal/me) —
  // never the public /locations list. NOT a per-permission scope.
  locations: LocationSummary[];
  // The resolved context for the current URL/cookie/scope.
  locationContext: AdminLocationContext;
  // Does the user hold `key` anywhere? (nav / show-a-control checks)
  can: (key: InternalPermissionKey) => boolean;
  // Is `key` effective for this specific location? (corporate OR that
  // location is one of its explicit scopes)
  canAtLocation: (key: InternalPermissionKey, locationId: string) => boolean;
  // Is `key` held at corporate scope specifically?
  isCorporateFor: (key: InternalPermissionKey) => boolean;
}

const AdminCtx = createContext<AdminContextValue | null>(null);

export function AdminContextProvider({
  user,
  capabilities,
  isCorporate,
  locations,
  locationContext,
  children,
}: {
  user: InternalUserProfile;
  capabilities: AdminCapabilities;
  isCorporate: boolean;
  locations: LocationSummary[];
  locationContext: AdminLocationContext;
  children: React.ReactNode;
}) {
  const value = useMemo<AdminContextValue>(
    () => ({
      user,
      capabilities,
      isCorporate,
      locations,
      locationContext,
      can: (key) => capCan(capabilities, key),
      canAtLocation: (key, locationId) =>
        capCanAtLocation(capabilities, key, locationId),
      isCorporateFor: (key) => capIsCorporateFor(capabilities, key),
    }),
    [user, capabilities, isCorporate, locations, locationContext],
  );

  return <AdminCtx.Provider value={value}>{children}</AdminCtx.Provider>;
}

export function useAdminContext(): AdminContextValue {
  const value = useContext(AdminCtx);
  if (!value) {
    throw new Error("useAdminContext must be used within the Admin shell.");
  }
  return value;
}
