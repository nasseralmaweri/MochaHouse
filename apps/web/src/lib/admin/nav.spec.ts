import { adminNavItems, isNavItemActive } from "./nav";
import type { AdminCapabilities } from "./capabilities";

describe("adminNavItems (permission-aware navigation)", () => {
  it("always includes Dashboard, even with no capabilities", () => {
    const items = adminNavItems({});
    expect(items.map((i) => i.key)).toEqual(["dashboard"]);
    expect(items[0].href).toBe("/admin");
  });

  it("shows Orders when the user holds orders.view (any scope)", () => {
    const items = adminNavItems({
      "orders.view": { corporate: false, locationIds: ["loc-a"] },
    });
    expect(items.map((i) => i.key)).toEqual(["dashboard", "orders"]);
    expect(items.find((i) => i.key === "orders")?.href).toBe("/admin/orders");
  });

  it("hides Orders without orders.view even if the user holds other permissions", () => {
    const caps: AdminCapabilities = {
      "orders.manage_status": { corporate: false, locationIds: ["loc-a"] },
      "catalog.products.edit": { corporate: true, locationIds: [] },
      "locations.manage_digital_ordering": {
        corporate: false,
        locationIds: ["loc-a"],
      },
    };
    expect(adminNavItems(caps).map((i) => i.key)).toEqual(["dashboard"]);
  });

  it("shows Locations when the user holds locations.view (any scope)", () => {
    const items = adminNavItems({
      "locations.view": { corporate: false, locationIds: ["loc-a"] },
    });
    expect(items.map((i) => i.key)).toEqual(["dashboard", "locations"]);
    expect(items.find((i) => i.key === "locations")?.href).toBe(
      "/admin/locations",
    );
  });

  it("hides Locations without locations.view even with adjacent location permissions", () => {
    const caps: AdminCapabilities = {
      "locations.manage_digital_ordering": {
        corporate: false,
        locationIds: ["loc-a"],
      },
      "locations.edit": { corporate: true, locationIds: [] },
    };
    expect(adminNavItems(caps).map((i) => i.key)).toEqual(["dashboard"]);
  });

  it("shows Menu & Products when the user holds catalog.view", () => {
    const items = adminNavItems({
      "catalog.view": { corporate: true, locationIds: [] },
    });
    expect(items.map((i) => i.key)).toEqual(["dashboard", "menu"]);
    expect(items.find((i) => i.key === "menu")?.href).toBe("/admin/menu");
    expect(items.find((i) => i.key === "menu")?.label).toBe("Menu & Products");
  });

  it("hides Menu & Products for catalog.products.edit without catalog.view", () => {
    const caps: AdminCapabilities = {
      "catalog.products.edit": { corporate: true, locationIds: [] },
      "catalog.menu.manage": { corporate: true, locationIds: [] },
    };
    expect(adminNavItems(caps).map((i) => i.key)).toEqual(["dashboard"]);
  });

  it("does not add Categories / Modifiers / Users / anything without a shipped page", () => {
    const caps: AdminCapabilities = {
      "orders.view": { corporate: true, locationIds: [] },
      "orders.manage_status": { corporate: true, locationIds: [] },
      "catalog.products.edit": { corporate: true, locationIds: [] },
      "catalog.menu.manage": { corporate: true, locationIds: [] },
      "catalog.overrides.manage": { corporate: true, locationIds: [] },
      "catalog.view": { corporate: true, locationIds: [] },
      "locations.view": { corporate: true, locationIds: [] },
      "locations.edit": { corporate: true, locationIds: [] },
      "locations.manage_digital_ordering": { corporate: true, locationIds: [] },
    };
    expect(adminNavItems(caps).map((i) => i.key).sort()).toEqual([
      "dashboard",
      "locations",
      "menu",
      "orders",
    ]);
  });

  it("is driven only by capabilities — there is no role-name input", () => {
    expect(
      adminNavItems({
        "orders.view": { corporate: false, locationIds: ["loc-a"] },
      }),
    ).toEqual(
      adminNavItems({
        "orders.view": { corporate: false, locationIds: ["loc-a"] },
      }),
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

  it("Locations is active on the list and any detail route", () => {
    const locations = {
      key: "locations",
      label: "Locations",
      href: "/admin/locations",
    };
    expect(isNavItemActive(locations, "/admin/locations")).toBe(true);
    expect(isNavItemActive(locations, "/admin/locations/loc-123")).toBe(true);
    expect(isNavItemActive(locations, "/admin")).toBe(false);
    expect(isNavItemActive(locations, "/admin/orders")).toBe(false);
  });

  it("Menu & Products is active across every product sub-route", () => {
    const menu = { key: "menu", label: "Menu & Products", href: "/admin/menu" };
    expect(isNavItemActive(menu, "/admin/menu")).toBe(true);
    expect(isNavItemActive(menu, "/admin/menu/products")).toBe(true);
    expect(isNavItemActive(menu, "/admin/menu/products/p-1/edit")).toBe(true);
    expect(isNavItemActive(menu, "/admin")).toBe(false);
  });
});
