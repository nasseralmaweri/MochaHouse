import { PLATFORM_NAV_ITEMS, isAvailable } from "./nav";

// SC1b — the platform console's navigation: the seven planned modules, of
// which only Overview is built. Unbuilt modules are listed but not
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

  it("only Overview is a link; everything else is marked as not available", () => {
    expect(
      PLATFORM_NAV_ITEMS.filter(isAvailable).map((item) => item.href),
    ).toEqual(["/platform"]);
  });

  it("never links into the tenant administration or another business area", () => {
    for (const item of PLATFORM_NAV_ITEMS.filter(isAvailable)) {
      expect(item.href).toMatch(/^\/platform(\/|$)/);
    }
  });
});
