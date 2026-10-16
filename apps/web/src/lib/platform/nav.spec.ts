import { PLATFORM_NAV_ITEMS, isAvailable, isCurrentNavItem } from "./nav";

// SC1b — the platform console's navigation: the seven planned modules, of
// which Overview and (SC1c) Tenants are built. Unbuilt modules are listed but not
// navigable — no placeholder screens.
describe("platform console navigation", () => {
  it("lists the seven platform modules in order", () => {
    expect(PLATFORM_NAV_ITEMS.map((item) => item.label)).toEqual([
      "Overview",
      "Tenants",
      "Plans",
      "Subscriptions",
      "Billing",
      "Support",
      "Settings",
    ]);
  });

  it("only Overview, Tenants and (SC2a) Plans are links; everything else is marked as not available", () => {
    expect(
      PLATFORM_NAV_ITEMS.filter(isAvailable).map((item) => item.href),
    ).toEqual(["/platform", "/platform/tenants", "/platform/plans"]);
  });

  it("SC1c: Tenants stays current on a tenant's page; Overview only on /platform", () => {
    const [overview, tenants, plans] = PLATFORM_NAV_ITEMS;
    expect(isCurrentNavItem(overview, "/platform")).toBe(true);
    expect(isCurrentNavItem(overview, "/platform/tenants")).toBe(false);
    expect(isCurrentNavItem(tenants, "/platform/tenants")).toBe(true);
    expect(isCurrentNavItem(tenants, "/platform/tenants/abc")).toBe(true);
    expect(isCurrentNavItem(tenants, "/platform/tenantsx")).toBe(false);
    expect(isCurrentNavItem(plans, "/platform")).toBe(false);
    expect(isCurrentNavItem(tenants, null)).toBe(false);
  });

  it("never links into the tenant administration or another business area", () => {
    for (const item of PLATFORM_NAV_ITEMS.filter(isAvailable)) {
      expect(item.href).toMatch(/^\/platform(\/|$)/);
    }
  });
});
