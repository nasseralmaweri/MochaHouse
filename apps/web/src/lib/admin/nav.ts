import type { InternalPermissionKey } from "@mocha-house/contracts";
import { can } from "./permissions";

export interface AdminNavItem {
  key: string;
  label: string;
  href: string;
}

// The Admin sidebar for Milestone 5C. Only two destinations exist as real
// pages:
//   - Dashboard: any authenticated ACTIVE internal user (even one with no
//     role assignments) can reach it.
//   - Orders: shown only if the user effectively holds `orders.view`.
// No role-name checks. No "coming soon" items, no fake routes — future
// modules (Catalog, Locations, Users, …) are added here only when their
// pages ship.
export function adminNavItems(
  permissions: readonly InternalPermissionKey[],
): AdminNavItem[] {
  const items: AdminNavItem[] = [
    { key: "dashboard", label: "Dashboard", href: "/admin" },
  ];

  if (can(permissions, "orders.view")) {
    items.push({ key: "orders", label: "Orders", href: "/admin/orders" });
  }

  return items;
}

// Whether a nav item is the active one for the current pathname. `/admin`
// matches only itself; every other item matches its href prefix so
// `/admin/orders/123` still highlights "Orders".
export function isNavItemActive(item: AdminNavItem, pathname: string): boolean {
  if (item.href === "/admin") {
    return pathname === "/admin";
  }
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
