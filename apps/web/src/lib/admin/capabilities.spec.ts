import type { InternalPermissionKey } from "@mocha-house/contracts";
import {
  can,
  canAtLocation,
  capabilityLocationIds,
  isCorporateFor,
  type AdminCapabilities,
} from "./capabilities";

describe("admin capability helpers", () => {
  // orders.view @ Location A + Location B; digital ordering @ Location A only
  const mixed: AdminCapabilities = {
    "orders.view": { corporate: false, locationIds: ["loc-a", "loc-b"] },
    "locations.manage_digital_ordering": {
      corporate: false,
      locationIds: ["loc-a"],
    },
  };

  it("can() — held anywhere", () => {
    expect(can(mixed, "orders.view")).toBe(true);
    expect(can(mixed, "locations.manage_digital_ordering")).toBe(true);
    expect(can(mixed, "orders.manage_status")).toBe(false);
    expect(can({}, "orders.view")).toBe(false);
  });

  it("canAtLocation() — one permission at Location A and another at Location B stay distinct", () => {
    // orders.view is effective at both
    expect(canAtLocation(mixed, "orders.view", "loc-a")).toBe(true);
    expect(canAtLocation(mixed, "orders.view", "loc-b")).toBe(true);
    // digital ordering is effective ONLY at Location A — Location B must not
    // be inferred from the union
    expect(
      canAtLocation(mixed, "locations.manage_digital_ordering", "loc-a"),
    ).toBe(true);
    expect(
      canAtLocation(mixed, "locations.manage_digital_ordering", "loc-b"),
    ).toBe(false);
  });

  it("canAtLocation() — unauthorized location is false; not-held permission is false", () => {
    expect(canAtLocation(mixed, "orders.view", "loc-x")).toBe(false);
    expect(canAtLocation(mixed, "orders.manage_status", "loc-a")).toBe(false);
    expect(canAtLocation({}, "orders.view", "loc-a")).toBe(false);
  });

  it("CORPORATE capability is effective at every location", () => {
    const corp: AdminCapabilities = {
      "catalog.products.edit": { corporate: true, locationIds: [] },
    };
    expect(can(corp, "catalog.products.edit")).toBe(true);
    expect(isCorporateFor(corp, "catalog.products.edit")).toBe(true);
    expect(canAtLocation(corp, "catalog.products.edit", "any-location")).toBe(
      true,
    );
  });

  it("isCorporateFor() is per-permission, not global", () => {
    const perPerm: AdminCapabilities = {
      "catalog.products.edit": { corporate: true, locationIds: [] },
      "orders.view": { corporate: false, locationIds: ["loc-a"] },
    };
    expect(isCorporateFor(perPerm, "catalog.products.edit")).toBe(true);
    expect(isCorporateFor(perPerm, "orders.view")).toBe(false);
    expect(isCorporateFor(perPerm, "orders.manage_status")).toBe(false);
  });

  it("a CORPORATE-only permission that never appears in the map is not held (5B behaviour preserved)", () => {
    // The backend's summarize() drops catalog.products.edit when it is only
    // held via LOCATION scope, so it simply isn't a key here.
    const locationOnly: AdminCapabilities = {
      "orders.view": { corporate: false, locationIds: ["loc-a"] },
    };
    expect(can(locationOnly, "catalog.products.edit")).toBe(false);
    expect(canAtLocation(locationOnly, "catalog.products.edit", "loc-a")).toBe(
      false,
    );
    expect(isCorporateFor(locationOnly, "catalog.products.edit")).toBe(false);
  });

  it("capabilityLocationIds()", () => {
    expect(capabilityLocationIds(mixed, "orders.view")).toEqual([
      "loc-a",
      "loc-b",
    ]);
    expect(
      capabilityLocationIds(mixed, "locations.manage_digital_ordering"),
    ).toEqual(["loc-a"]);
    expect(
      capabilityLocationIds({}, "orders.view" as InternalPermissionKey),
    ).toEqual([]);
  });
});
