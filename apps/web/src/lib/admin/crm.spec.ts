import type {
  AdminCustomerActivityItem,
  AdminCustomerSummary,
} from "@mocha-house/contracts";
import {
  activityLine,
  CRM_DETAIL_SECTIONS,
  customerDisplayName,
  customerStatusLabel,
  customerStatusTone,
  emailVerifiedLabel,
  formatBeans,
  formatCrmDate,
  formatMinorUnits,
  marketingOptInLabel,
} from "./crm";

const base: AdminCustomerSummary = {
  id: "01a00000-0000-7000-8000-000000000abc",
  email: "sam@example.com",
  displayName: "Sam Rivera",
  status: "ACTIVE",
  emailVerified: true,
  marketingEmailOptIn: false,
  createdAt: "2026-01-05T12:00:00.000Z",
};

describe("customer status", () => {
  it("labels and tones each status", () => {
    expect(customerStatusLabel("ACTIVE")).toBe("Active");
    expect(customerStatusLabel("RESTRICTED")).toBe("Restricted");
    expect(customerStatusLabel("DEACTIVATED")).toBe("Deactivated");
    expect(customerStatusTone("ACTIVE")).toBe("positive");
    expect(customerStatusTone("RESTRICTED")).toBe("warning");
    expect(customerStatusTone("DEACTIVATED")).toBe("neutral");
  });
});

describe("verification / marketing labels", () => {
  it("renders booleans as plain language", () => {
    expect(emailVerifiedLabel(true)).toBe("Email verified");
    expect(emailVerifiedLabel(false)).toBe("Email not verified");
    expect(marketingOptInLabel(true)).toBe("Opted in to marketing email");
    expect(marketingOptInLabel(false)).toBe("Not opted in to marketing email");
  });
});

describe("customerDisplayName", () => {
  it("prefers displayName, falls back to email, then a short id", () => {
    expect(customerDisplayName(base)).toBe("Sam Rivera");
    expect(customerDisplayName({ ...base, displayName: null })).toBe(
      "sam@example.com",
    );
    expect(
      customerDisplayName({ ...base, displayName: "  ", email: null }),
    ).toBe("Customer 01a00000");
  });
});

describe("formatters", () => {
  it("formats minor units as currency", () => {
    expect(formatMinorUnits(2500, "USD")).toBe("$25.00");
    expect(formatMinorUnits(0, "USD")).toBe("$0.00");
  });

  it("formats bean counts with pluralisation and grouping", () => {
    expect(formatBeans(1)).toBe("1 Mocha Bean");
    expect(formatBeans(0)).toBe("0 Mocha Beans");
    expect(formatBeans(1234)).toBe("1,234 Mocha Beans");
  });

  it("formats an ISO date", () => {
    expect(formatCrmDate("2026-01-05T12:00:00.000Z")).toBe("Jan 5, 2026");
  });
});

describe("activityLine", () => {
  it("renders summary + actor + date, and omits the actor when unknown", () => {
    const withActor: AdminCustomerActivityItem = {
      id: "1",
      summary: "Internal CRM note added",
      reason: "Called about a refund",
      actorLabel: "Dana HQ",
      createdAt: "2026-01-05T12:00:00.000Z",
    };
    expect(activityLine(withActor)).toBe(
      "Internal CRM note added by Dana HQ · Jan 5, 2026",
    );
    expect(activityLine({ ...withActor, actorLabel: null })).toBe(
      "Internal CRM note added · Jan 5, 2026",
    );
  });
});

describe("CRM_DETAIL_SECTIONS", () => {
  it("is the stable, complete section order", () => {
    expect(CRM_DETAIL_SECTIONS).toEqual([
      "profile",
      "orders",
      "mochaBeans",
      "affordableRewards",
      "giftCards",
      "preferredLocations",
      "communicationPreferences",
      "notes",
      "activity",
    ]);
  });
});
