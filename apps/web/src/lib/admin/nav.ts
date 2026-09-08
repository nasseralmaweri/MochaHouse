import { can, type AdminCapabilities } from "./capabilities";

export interface AdminNavItem {
  key: string;
  label: string;
  href: string;
}

// The Admin sidebar. Destinations that exist as real pages:
//   - Dashboard: any authenticated ACTIVE internal user (even one with no
//     role assignments) can reach it.
//   - Operations: shown if the user effectively holds `operations.view`
//     somewhere (Milestone 6A — the Store Operations "Today" workspace) OR
//     `operations.checklists.configure` (Milestone 6B-2 — HQ checklist
//     configuration; a corporate configuration-only user reaches it without
//     any store-execution permission). Each page inside still gates on its
//     own permission.
//   - Orders: shown only if the user effectively holds `orders.view`
//     somewhere.
//   - Loyalty: shown if the user effectively holds `loyalty.view`
//     (Milestone 7A — Mocha Beans customer surface) OR `loyalty.configure`
//     (Milestone 7B — earning rate + Rewards Catalog). Both CORPORATE-only.
//     Each page inside gates on its own permission.
//   - Locations: shown only if the user effectively holds `locations.view`
//     somewhere (Milestone 5D-1 — list + detail only).
//   - Menu & Products: shown only if the user holds `catalog.view`
//     (Milestone 5D-3 — products list/detail/edit; categories, menus and
//     modifiers join this same destination in later slices).
//   - Administration: shown if the user holds `users.view` OR `roles.view`
//     OR `audit.view` OR `platform.view` (Milestone 5E — user access review
//     + access levels; Milestone 5F — the activity log; Milestone 5G —
//     platform status, all read-only). Each card inside the section gates on
//     its own permission.
// Driven by the capability map, never a role name. No "coming soon" items,
// no fake routes — future modules are added here only when their pages ship.
export function adminNavItems(
  capabilities: AdminCapabilities,
): AdminNavItem[] {
  const items: AdminNavItem[] = [
    { key: "dashboard", label: "Dashboard", href: "/admin" },
  ];

  if (
    can(capabilities, "operations.view") ||
    can(capabilities, "operations.checklists.configure")
  ) {
    items.push({
      key: "operations",
      label: "Operations",
      href: "/admin/operations",
    });
  }

  if (can(capabilities, "orders.view")) {
    items.push({ key: "orders", label: "Orders", href: "/admin/orders" });
  }

  // Loyalty (Milestone 7A — HQ Mocha Beans surface). Shown only if the user
  // effectively holds `loyalty.view` or `loyalty.configure` (both
  // CORPORATE-only). Each page inside still gates on its own permission:
  // adjusting requires `loyalty.adjust`, and settings/rewards require
  // `loyalty.configure`.
  if (
    can(capabilities, "loyalty.view") ||
    can(capabilities, "loyalty.configure")
  ) {
    items.push({ key: "loyalty", label: "Loyalty", href: "/admin/loyalty" });
  }

  // Promotions (Milestone 7E — Promotions & Coupons, the regular
  // merchandise-discount system). CORPORATE-only; the page re-checks.
  if (can(capabilities, "promotions.configure")) {
    items.push({
      key: "promotions",
      label: "Promotions",
      href: "/admin/promotions",
    });
  }

  if (can(capabilities, "locations.view")) {
    items.push({
      key: "locations",
      label: "Locations",
      href: "/admin/locations",
    });
  }

  if (can(capabilities, "catalog.view")) {
    items.push({
      key: "menu",
      label: "Menu & Products",
      href: "/admin/menu",
    });
  }

  if (
    can(capabilities, "users.view") ||
    can(capabilities, "roles.view") ||
    can(capabilities, "audit.view") ||
    can(capabilities, "platform.view")
  ) {
    items.push({
      key: "administration",
      label: "Administration",
      href: "/admin/administration",
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
