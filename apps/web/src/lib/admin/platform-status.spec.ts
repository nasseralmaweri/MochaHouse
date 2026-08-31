import type { AdminPlatformStatus } from "@mocha-house/contracts";
import {
  activeLocationsLabel,
  digitalOrderingLabel,
  inactiveLocationsLabel,
  platformStatusSections,
} from "./platform-status";

const base: AdminPlatformStatus = {
  environmentLabel: "Development",
  isProduction: false,
  authentication: {
    adminLabel: "Local development authentication",
    customerLabel: "Amazon Cognito",
  },
  payments: {
    providerLabel: "Development payment provider",
    isDevelopmentStandIn: true,
  },
  locations: {
    activeCount: 3,
    inactiveCount: 1,
    digitalOrderingEnabledCount: 2,
    digitalOrderingDisabledCount: 1,
  },
};

describe("location count labels", () => {
  it("pluralises around 1", () => {
    expect(activeLocationsLabel(0)).toBe("0 active locations");
    expect(activeLocationsLabel(1)).toBe("1 active location");
    expect(activeLocationsLabel(4)).toBe("4 active locations");
    expect(inactiveLocationsLabel(1)).toBe("1 inactive location");
    expect(inactiveLocationsLabel(2)).toBe("2 inactive locations");
  });
});

describe("digitalOrderingLabel", () => {
  it("handles no active locations", () => {
    expect(
      digitalOrderingLabel({
        activeCount: 0,
        inactiveCount: 2,
        digitalOrderingEnabledCount: 0,
        digitalOrderingDisabledCount: 0,
      }),
    ).toBe("No active locations yet");
  });
  it("handles all-on and all-off", () => {
    expect(
      digitalOrderingLabel({
        activeCount: 3,
        inactiveCount: 0,
        digitalOrderingEnabledCount: 3,
        digitalOrderingDisabledCount: 0,
      }),
    ).toBe("On at every active location");
    expect(
      digitalOrderingLabel({
        activeCount: 3,
        inactiveCount: 0,
        digitalOrderingEnabledCount: 0,
        digitalOrderingDisabledCount: 3,
      }),
    ).toBe("Off at every active location");
  });
  it("handles a partial split", () => {
    expect(digitalOrderingLabel(base.locations)).toBe(
      "On at 2 of 3 active locations",
    );
  });
});

describe("platformStatusSections", () => {
  it("produces the four sections in order with the API labels", () => {
    const sections = platformStatusSections(base);
    expect(sections.map((s) => s.title)).toEqual([
      "Platform",
      "Authentication",
      "Payments",
      "Locations & digital ordering",
    ]);
    expect(sections[0].rows).toEqual([
      { label: "Environment", value: "Development" },
    ]);
    expect(sections[1].rows).toEqual([
      { label: "Admin sign-in", value: "Local development authentication" },
      { label: "Customer sign-in", value: "Amazon Cognito" },
    ]);
    expect(sections[2].rows).toEqual([
      { label: "Payment integration", value: "Development payment provider" },
    ]);
    expect(sections[3].rows.map((r) => r.label)).toEqual([
      "Active locations",
      "Inactive locations",
      "Digital ordering",
    ]);
    expect(sections[3].rows[2].value).toBe("On at 2 of 3 active locations");
  });

  it("never surfaces a raw boolean or an implementation term", () => {
    const raw = JSON.stringify(platformStatusSections(base));
    for (const forbidden of [
      "isProduction",
      "isDevelopmentStandIn",
      "true",
      "false",
      "fake",
      "process.env",
      "NODE_ENV",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });
});
