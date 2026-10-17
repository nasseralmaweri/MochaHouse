import type { PlatformAdjustmentView } from "@mocha-house/contracts";
import { adjustmentActions, approvalsLabel, parseAmount, validNote } from "./adjustments";
import { interpretChange } from "./subscriptions";

// SC3e-3 — console wording and input checks for refunds and credits (the API
// re-checks every permission, approver and amount).
const view = (over: Partial<PlatformAdjustmentView> = {}): PlatformAdjustmentView => ({
  id: "a1",
  tenantId: "t1",
  businessName: "Cafe",
  invoiceId: "i1",
  invoiceNumber: "ABC-0001",
  origin: "CENTERIVO",
  kind: "REFUND",
  scope: "FULL",
  status: "PENDING_APPROVAL",
  currency: "USD",
  totalMinorUnits: 4900,
  taxMinorUnits: 0,
  annualFullRefund: false,
  requiredApprovals: 2,
  reason: "Outage credit approved by support.",
  requestedBy: { id: "requester", email: "r@example.test" },
  createdAt: "2026-10-01T00:00:00.000Z",
  expiresAt: "2026-10-04T00:00:00.000Z",
  finishedAt: null,
  failureCode: null,
  decisions: [],
  events: [],
  ...over,
});

describe("SC3e-3 refund and credit console helpers", () => {
  it("never offers the requester a decision; offers it to an approver once", () => {
    expect(adjustmentActions(view(), "requester", ["billing.adjustments.request", "billing.adjustments.approve"])).toEqual({
      decide: false,
      cancel: true,
      resolve: false,
      reason: "You requested this, so another operator must approve it.",
    });
    expect(adjustmentActions(view(), "other", ["billing.adjustments.approve"]).decide).toBe(true);
    expect(adjustmentActions(view(), "other", []).decide).toBe(false);
    const decided = view({
      decisions: [
        { decision: "APPROVED", note: "Checked.", operator: { id: "other", email: "o@example.test" }, at: "2026-10-01T01:00:00.000Z" },
      ],
    });
    expect(adjustmentActions(decided, "other", ["billing.adjustments.approve"]).decide).toBe(false);
    expect(approvalsLabel(decided)).toBe("1 of 2 approvals");
  });

  it("offers nothing on an external adjustment; resolving a reviewed one needs approve", () => {
    expect(adjustmentActions(view({ origin: "EXTERNAL", status: "RECORDED" }), "other", ["billing.adjustments.approve"])).toEqual({
      decide: false,
      cancel: false,
      resolve: false,
      reason: null,
    });
    expect(adjustmentActions(view({ status: "REVIEW" }), "other", ["billing.adjustments.approve"]).resolve).toBe(true);
    expect(adjustmentActions(view({ status: "REVIEW" }), "other", []).resolve).toBe(false);
  });

  it("reads amounts in major units, at most two decimals, positive", () => {
    expect(parseAmount("25")).toBe(2500);
    expect(parseAmount("25.5")).toBe(2550);
    expect(parseAmount(" 0.01 ")).toBe(1);
    for (const bad of ["0", "-5", "1,000", "12.345", "", "abc", "1e3"]) {
      expect(parseAmount(bad)).toBeNull();
    }
  });

  it("requires a one-line note of 10 to 500 characters", () => {
    expect(validNote("  Checked the outage.  ")).toBe("Checked the outage.");
    expect(validNote("short")).toBeNull();
    expect(validNote("line one\nline two!")).toBeNull();
  });

  it("explains adjustment refusals in plain words", () => {
    expect(interpretChange(409, { code: "BILLING_ADJUSTMENT_OWN_REQUEST" })).toEqual({
      kind: "error",
      message: "You requested this, so another operator must decide.",
    });
    expect(interpretChange(409, { code: "BILLING_ADJUSTMENT_EXCEEDS_REMAINING" })).toMatchObject({
      kind: "error",
      message: expect.stringContaining("more than remains"),
    });
  });
});
