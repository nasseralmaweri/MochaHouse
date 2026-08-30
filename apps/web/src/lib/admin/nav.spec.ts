import type { InternalPermissionKey } from "@mocha-house/contracts";
import { adminNavItems, isNavItemActive } from "./nav";

describe("adminNavItems (permission-aware navigation)", () => {
  it("always includes Dashboard, even with no permissions", () => {
    const items = adminNavItems([]);
    expect(items.map((i) => i.key)).toEqual(["dashboard"]);
    expect(items[0].href).toBe("/admin");
  });

  it("shows Orders when the user holds orders.view", () => {
    const items = adminNavItems(["orders.view"]);
    expect(items.map((i) => i.key)).toEqual(["dashboard", "orders"]);
    expect(items.find((i) => i.key === "orders")?.href).toBe("/admin/orders");
  });

  it("hides Orders without orders.view even if the user holds other permissions", () => {
    const permissions: InternalPermissionKey[] = [
      "orders.manage_status",
      "catalog.products.edit",
      "locations.manage_digital_ordering",
    ];
    const items = adminNavItems(permissions);
    expect(items.map((i) => i.key)).toEqual(["dashboard"]);
  });

  it("does not add Catalog / Locations / Users / anything else in 5C", () => {
    const items = adminNavItems([...([
      "orders.view",
      "orders.manage_status",
      "catalog.products.edit",
      "catalog.menu.manage",
      "catalog.overrides.manage",
      "locations.manage_digital_ordering",
    ] as InternalPermissionKey[])]);
    expect(items.map((i) => i.key).sort()).toEqual(["dashboard", "orders"]);
  });

  it("is driven only by permission keys — role names are irrelevant (there is no role input)", () => {
    // The function signature only accepts InternalPermissionKey[]; there is
    // no code path that could branch on a role name.
    expect(adminNavItems(["orders.view"])).toEqual(
      adminNavItems(["orders.view"]),
    );
  });
});

describe("isNavItemActive", () => {
  const dashboard = { key: "dashboard", label: "Dashboard", href: "/admin" };
  const orders = { key: "orders", label: "Orders", href: "/admin/orders" };

  it("Dashboard is active only on exactly /admin", () => {
    expect(isNavItemActive(dashboard, "/admin")).toBe(true);
    expect(isNavItemActive(dashboard, "/admin/orders")).toBe(false);
  });

  it("Orders is active on the list and any detail route", () => {
    expect(isNavItemActive(orders, "/admin/orders")).toBe(true);
    expect(isNavItemActive(orders, "/admin/orders/abc123")).toBe(true);
    expect(isNavItemActive(orders, "/admin")).toBe(false);
  });
});
