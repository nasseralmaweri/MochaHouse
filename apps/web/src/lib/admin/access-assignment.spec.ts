import {
  accessLevelNeedsLocations,
  buildAssignRoleRequest,
} from "./access-assignment";

describe("accessLevelNeedsLocations", () => {
  it("is true only for a location-only access level", () => {
    expect(accessLevelNeedsLocations("location-only")).toBe(true);
    expect(accessLevelNeedsLocations("corporate-only")).toBe(false);
    expect(accessLevelNeedsLocations(null)).toBe(false);
  });
});

describe("buildAssignRoleRequest", () => {
  it("requires an access level", () => {
    expect(
      buildAssignRoleRequest({
        roleId: null,
        shape: null,
        locationIds: [],
        reason: "x",
      }),
    ).toEqual({ ok: false, error: "Choose an access level." });
  });

  it("requires a reason", () => {
    const result = buildAssignRoleRequest({
      roleId: "r1",
      shape: "corporate-only",
      locationIds: [],
      reason: "   ",
    });
    expect(result.ok).toBe(false);
  });

  it("builds a corporate request for a corporate-only level, ignoring any locations", () => {
    expect(
      buildAssignRoleRequest({
        roleId: "r1",
        shape: "corporate-only",
        locationIds: ["l1"],
        reason: "  promoted  ",
      }),
    ).toEqual({
      ok: true,
      request: {
        roleId: "r1",
        scope: { kind: "corporate" },
        reason: "promoted",
      },
    });
  });

  it("requires at least one location for a location-only level", () => {
    expect(
      buildAssignRoleRequest({
        roleId: "r2",
        shape: "location-only",
        locationIds: [],
        reason: "x",
      }),
    ).toEqual({ ok: false, error: "Choose at least one location." });
  });

  it("builds a de-duplicated locations request for a location-only level", () => {
    expect(
      buildAssignRoleRequest({
        roleId: "r2",
        shape: "location-only",
        locationIds: ["l1", "l1", "l2"],
        reason: "covers two stores",
      }),
    ).toEqual({
      ok: true,
      request: {
        roleId: "r2",
        scope: { kind: "locations", locationIds: ["l1", "l2"] },
        reason: "covers two stores",
      },
    });
  });
});
