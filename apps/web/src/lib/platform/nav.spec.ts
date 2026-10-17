import { PLATFORM_NAV_ITEMS, isAvailable, isCurrentNavItem } from "./nav";

// SC1b — the platform console's navigation: the seven planned modules, of
// which Overview and (SC1c) Tenants are built. Unbuilt modules are listed but not
// navigable — no placeholder screens.
describe("platform console navigation", () => {
  it("lists the platform modules in order", () => {
    expect(PLATFORM_NAV_ITEMS.map((item) => item.label)).toEqual([
      "Overview",
      "Tenants",
      // SC4e
      "Onboarding",
      "Plans",
      "Subscriptions",
      "Billing",
      "Support",
      "Settings",
    ]);
  });

  it("only Overview, Tenants, (SC4e) Onboarding, (SC2a) Plans and (SC3b) Billing are links; everything else is marked as not available", () => {
    expect(
      PLATFORM_NAV_ITEMS.filter(isAvailable).map((item) => item.href),
    ).toEqual([
      "/platform",
      "/platform/tenants",
      "/platform/onboarding",
      "/platform/plans",
      "/platform/billing",
    ]);
  });

  it("SC1c: Tenants stays current on a tenant's page; Overview only on /platform", () => {
    const item = (key: string) => PLATFORM_NAV_ITEMS.find((nav) => nav.key === key)!;
    const [overview, tenants, plans] = [item("overview"), item("tenants"), item("plans")];
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
