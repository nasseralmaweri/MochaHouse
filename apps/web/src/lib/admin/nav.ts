import { can, type AdminCapabilities } from "./capabilities";

export interface AdminNavItem {
  key: string;
  label: string;
  href: string;
}

// The Admin sidebar. Destinations that exist as real pages:
//   - Dashboard: any authenticated ACTIVE internal user (even one with no
//     role assignments) can reach it.
//   - Orders: shown only if the user effectively holds `orders.view`
//     somewhere.
//   - Locations: shown only if the user effectively holds `locations.view`
//     somewhere (Milestone 5D-1 — list + detail only).
// Driven by the capability map, never a role name. No "coming soon" items,
// no fake routes — future modules (Catalog, Menu, Users, …) are added here
// only when their pages ship.
export function adminNavItems(
  capabilities: AdminCapabilities,
): AdminNavItem[] {
  const items: AdminNavItem[] = [
    { key: "dashboard", label: "Dashboard", href: "/admin" },
  ];

  if (can(capabilities, "orders.view")) {
    items.push({ key: "orders", label: "Orders", href: "/admin/orders" });
  }

  if (can(capabilities, "locations.view")) {
    items.push({
      key: "locations",
      label: "Locations",
      href: "/admin/locations",
    });
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
