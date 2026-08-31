import type {
  AdminInternalUserAccessAssignment,
  AdminUserLocationAccess,
} from "@mocha-house/contracts";
import {
  accessLevelsLabel,
  assignmentSummary,
  assignmentWhereLabel,
  canManageAccess,
  canShowStatusActions,
  checkAccessChangeReason,
  checkStatusChangeReason,
  locationAccessLabel,
  peopleCountLabel,
  userStatusActions,
  userStatusLabel,
  userStatusSentence,
  userStatusTone,
} from "./user-access";

describe("userStatusLabel", () => {
  it("maps every status to a human word", () => {
    expect(userStatusLabel("INVITED")).toBe("Invited");
    expect(userStatusLabel("ACTIVE")).toBe("Active");
    expect(userStatusLabel("SUSPENDED")).toBe("Suspended");
    expect(userStatusLabel("DISABLED")).toBe("Disabled");
  });
});

describe("userStatusTone", () => {
  it("Active is positive, Suspended is a warning, the rest are neutral", () => {
    expect(userStatusTone("ACTIVE")).toBe("positive");
    expect(userStatusTone("SUSPENDED")).toBe("warning");
    expect(userStatusTone("INVITED")).toBe("neutral");
    expect(userStatusTone("DISABLED")).toBe("neutral");
  });
});

describe("accessLevelsLabel", () => {
  it("says 'No access assigned' when there are no roles", () => {
    expect(accessLevelsLabel([])).toBe("No access assigned");
  });
  it("joins role display names", () => {
    expect(accessLevelsLabel(["Platform Administrator"])).toBe(
      "Platform Administrator",
    );
    expect(accessLevelsLabel(["Alpha Access", "Bravo Access"])).toBe(
      "Alpha Access, Bravo Access",
    );
  });
});

describe("userStatusSentence", () => {
  it("has a plain sentence for every status and never implies invitation works", () => {
    expect(userStatusSentence("ACTIVE")).toBe(
      "Can use the Admin according to their assigned access.",
    );
    expect(userStatusSentence("SUSPENDED")).toBe("Access is temporarily paused.");
    expect(userStatusSentence("DISABLED")).toBe(
      "This account can no longer use the Admin.",
    );
    expect(userStatusSentence("INVITED")).toBe(
      "Access has not been activated yet.",
    );
  });
});

describe("userStatusActions", () => {
  it("offers Suspend + Disable for an active person", () => {
    expect(userStatusActions("ACTIVE").map((a) => a.key)).toEqual([
      "suspend",
      "disable",
    ]);
    expect(userStatusActions("ACTIVE")[0].targetStatus).toBe("SUSPENDED");
  });
  it("offers Reactivate + Disable for a suspended person", () => {
    expect(userStatusActions("SUSPENDED").map((a) => a.key)).toEqual([
      "reactivate",
      "disable",
    ]);
  });
  it("offers nothing for a disabled or invited person", () => {
    expect(userStatusActions("DISABLED")).toEqual([]);
    expect(userStatusActions("INVITED")).toEqual([]);
  });
});

describe("canShowStatusActions", () => {
  it("needs the permission, a non-self target, and an actionable status", () => {
    expect(
      canShowStatusActions({
        hasManageStatusPermission: true,
        isSelf: false,
        status: "ACTIVE",
      }),
    ).toBe(true);
  });
  it("is false without the permission", () => {
    expect(
      canShowStatusActions({
        hasManageStatusPermission: false,
        isSelf: false,
        status: "ACTIVE",
      }),
    ).toBe(false);
  });
  it("is false for your own record", () => {
    expect(
      canShowStatusActions({
        hasManageStatusPermission: true,
        isSelf: true,
        status: "ACTIVE",
      }),
    ).toBe(false);
  });
  it("is false when the target status has no actions", () => {
    expect(
      canShowStatusActions({
        hasManageStatusPermission: true,
        isSelf: false,
        status: "DISABLED",
      }),
    ).toBe(false);
    expect(
      canShowStatusActions({
        hasManageStatusPermission: true,
        isSelf: false,
        status: "INVITED",
      }),
    ).toBe(false);
  });
});

describe("checkStatusChangeReason", () => {
  it("trims and accepts a real reason", () => {
    expect(checkStatusChangeReason("  moved teams  ")).toEqual({
      ok: true,
      reason: "moved teams",
    });
  });
  it("rejects a blank reason", () => {
    expect(checkStatusChangeReason("   ").ok).toBe(false);
  });
  it("rejects an over-long reason", () => {
    expect(checkStatusChangeReason("x".repeat(1001)).ok).toBe(false);
  });
});

describe("peopleCountLabel", () => {
  it("pluralises around 1", () => {
    expect(peopleCountLabel(0)).toBe("0 people");
    expect(peopleCountLabel(1)).toBe("1 person");
    expect(peopleCountLabel(2)).toBe("2 people");
    expect(peopleCountLabel(9)).toBe("9 people");
  });
});

describe("access assignments (Milestone 5E-4)", () => {
  const corporate: AdminInternalUserAccessAssignment = {
    id: "a1",
    accessLevel: { id: "r1", displayName: "Platform Administrator", isBuiltIn: true },
    location: null,
    isCorporate: true,
  };
  const scoped: AdminInternalUserAccessAssignment = {
    id: "a2",
    accessLevel: { id: "r2", displayName: "Store Manager", isBuiltIn: true },
    location: { id: "l1", name: "Ann Arbor" },
    isCorporate: false,
  };

  it("canManageAccess needs the permission and a non-self target", () => {
    expect(
      canManageAccess({ hasManageRolesPermission: true, isSelf: false }),
    ).toBe(true);
    expect(
      canManageAccess({ hasManageRolesPermission: false, isSelf: false }),
    ).toBe(false);
    expect(
      canManageAccess({ hasManageRolesPermission: true, isSelf: true }),
    ).toBe(false);
  });

  it("assignmentWhereLabel reads 'All locations' for corporate, the name otherwise", () => {
    expect(assignmentWhereLabel(corporate)).toBe("All locations");
    expect(assignmentWhereLabel(scoped)).toBe("Ann Arbor");
  });

  it("assignmentSummary joins the access level and where", () => {
    expect(assignmentSummary(corporate)).toBe(
      "Platform Administrator · All locations",
    );
    expect(assignmentSummary(scoped)).toBe("Store Manager · Ann Arbor");
  });

  it("checkAccessChangeReason applies the same rules as a status reason", () => {
    expect(checkAccessChangeReason("  moved  ")).toEqual({
      ok: true,
      reason: "moved",
    });
    expect(checkAccessChangeReason("   ").ok).toBe(false);
  });
});

describe("locationAccessLabel", () => {
  const selected = (
    ...names: string[]
  ): AdminUserLocationAccess => ({
    kind: "selected",
    locations: names.map((name, index) => ({ id: `loc-${index}`, name })),
  });

  it("says 'All locations' for a corporate person", () => {
    expect(locationAccessLabel({ kind: "all" })).toBe("All locations");
  });
  it("says 'No location access' when there is none", () => {
    expect(locationAccessLabel({ kind: "none" })).toBe("No location access");
  });
  it("names up to two locations", () => {
    expect(locationAccessLabel(selected("Dearborn Heights"))).toBe(
      "Dearborn Heights",
    );
    expect(
      locationAccessLabel(selected("Dearborn Heights", "Ann Arbor")),
    ).toBe("Dearborn Heights, Ann Arbor");
  });
  it("uses a compact count beyond two", () => {
    expect(locationAccessLabel(selected("A", "B", "C"))).toBe("3 locations");
  });
});
