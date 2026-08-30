"use client";

import { createContext, useContext, useMemo } from "react";
import type {
  InternalPermissionKey,
  InternalUserProfile,
  LocationSummary,
} from "@mocha-house/contracts";
import { can as canPermission } from "@/lib/admin/permissions";
import type { AdminLocationContext } from "@/lib/admin/location-context";

export interface AdminContextValue {
  user: InternalUserProfile;
  permissions: InternalPermissionKey[];
  isCorporate: boolean;
  // The authorization-aware location set (from GET /internal/me) — never the
  // public /locations list.
  locations: LocationSummary[];
  // The resolved context for the current URL/cookie/scope.
  locationContext: AdminLocationContext;
  can: (key: InternalPermissionKey) => boolean;
}

const AdminCtx = createContext<AdminContextValue | null>(null);

export function AdminContextProvider({
  user,
  permissions,
  isCorporate,
  locations,
  locationContext,
  children,
}: {
  user: InternalUserProfile;
  permissions: InternalPermissionKey[];
  isCorporate: boolean;
  locations: LocationSummary[];
  locationContext: AdminLocationContext;
  children: React.ReactNode;
}) {
  const value = useMemo<AdminContextValue>(
    () => ({
      user,
      permissions,
      isCorporate,
      locations,
      locationContext,
      can: (key) => canPermission(permissions, key),
    }),
    [user, permissions, isCorporate, locations, locationContext],
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
