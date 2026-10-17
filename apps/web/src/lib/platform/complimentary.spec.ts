import type { PlatformComplimentaryGrantView } from "@mocha-house/contracts";
import { grantAttention, grantEnd, holds, parseEndDate, validReason } from "./complimentary";
import { interpretChange } from "./subscriptions";

// SC3e-2 — console wording and input checks for complimentary arrangements
// and review cases (the API re-checks everything).
const grant = (over: Partial<PlatformComplimentaryGrantView> = {}): PlatformComplimentaryGrantView => ({
  id: "g1",
  status: "ACTIVE",
  plan: { planName: "Growth", versionId: "v1", version: 1, moduleKeys: ["crm"] },
  endsAt: null,
  reason: "Partner programme.",
  grantedBy: { id: "o1", email: "ops@example.test" },
  createdAt: "2026-10-01T00:00:00.000Z",
  previousStatus: "ACTIVE",
  previousPlanName: "Pro",
  previousPrice: { amountMinorUnits: 9900, currency: "USD", interval: "MONTH" },
  effectiveAt: null,
  cancellationVerified: false,
  startedAt: "2026-10-01T00:00:00.000Z",
  finishedAt: null,
  finishCode: null,
  finishReason: null,
  finishedBy: null,
  attention: null,
  ...over,
});

describe("SC3e-2 complimentary console helpers", () => {
  it("offers actions only for held permissions", () => {
    expect(holds(["billing.cases.manage"], "billing.cases.manage")).toBe(true);
    expect(holds(["billing.cases.manage"], "billing.schedules.release")).toBe(false);
    expect(holds([], "billing.complimentary.manage")).toBe(false);
  });

  it("an end date: tomorrow to three years, end of that day UTC; empty means indefinite", () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    expect(parseEndDate("", now)).toEqual({ ok: true, endsAt: null });
    expect(parseEndDate("2026-12-31", now)).toEqual({ ok: true, endsAt: "2026-12-31T23:59:00.000Z" });
    expect(parseEndDate("2026-10-16", now).ok).toBe(false);
    expect(parseEndDate("2030-01-01", now).ok).toBe(false);
    expect(parseEndDate("31/12/2026", now).ok).toBe(false);
  });

  it("a reason of 10 to 500 characters on one line", () => {
    expect(validReason("  Partner deal approved.  ")).toBe("Partner deal approved.");
    expect(validReason("short")).toBeNull();
    expect(validReason("line one\nline two is here")).toBeNull();
    expect(validReason("x".repeat(501))).toBeNull();
  });

  it("says what needs attention and when it ends", () => {
    expect(grantEnd(grant())).toBe("Indefinite");
    expect(grantEnd(grant({ endsAt: "2027-03-01T23:59:00.000Z" }))).toBe("Until March 1, 2027");
    expect(grantAttention(grant({ status: "SCHEDULED", attention: "CANCELLATION_UNVERIFIED" }))).toMatch(
      /hasn't confirmed the cancellation/,
    );
    expect(grantAttention(grant({ attention: "ENDS_SOON" }))).toMatch(/no automatic charge/);
    expect(grantAttention(grant())).toBeNull();
  });

  it("explains a missing permission and the new refusals in plain words", () => {
    expect(interpretChange(403, { code: "PLATFORM_PERMISSION_REQUIRED" })).toEqual({
      kind: "error",
      message: expect.stringMatching(/doesn't have permission/),
    });
    expect(interpretChange(409, { code: "BILLING_COMPLIMENTARY_UNPAID_INVOICES" })).toEqual({
      kind: "error",
      message: expect.stringMatching(/unpaid invoices.*never waived/),
    });
    expect(interpretChange(409, { code: "BILLING_CASE_SCHEDULE_MISMATCH" })).toEqual({
      kind: "error",
      message: expect.stringMatching(/Nothing was released/),
    });
  });
});
