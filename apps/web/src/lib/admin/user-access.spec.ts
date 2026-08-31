import type { AdminUserLocationAccess } from "@mocha-house/contracts";
import {
  accessLevelsLabel,
  locationAccessLabel,
  peopleCountLabel,
  userStatusLabel,
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

describe("peopleCountLabel", () => {
  it("pluralises around 1", () => {
    expect(peopleCountLabel(0)).toBe("0 people");
    expect(peopleCountLabel(1)).toBe("1 person");
    expect(peopleCountLabel(2)).toBe("2 people");
    expect(peopleCountLabel(9)).toBe("9 people");
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
