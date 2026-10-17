import type { AdminPlanChangeView, BillingPlanChangePreview } from "@mocha-house/contracts";
import {
  PLAN_CHANGE_MESSAGES,
  canConfirm,
  chargeLines,
  nextChargeSentence,
  planChangeRefusalMessage,
  planChangeStatusMessage,
} from "./plan-change";

// SC3d-2 — the business's plan change wording: refusals in plain words (never
// server detail), only an unexpired immediate change can be confirmed, and an
// upgrade is described as done ONLY when the API reports it applied.
const preview = (over: Partial<BillingPlanChangePreview> = {}): BillingPlanChangePreview => ({
  previewId: "p1",
  timing: "IMMEDIATE",
  current: { planName: "Growth", price: { amountMinorUnits: 4900, currency: "USD", interval: "MONTH" } },
  target: { planName: "Pro", price: { amountMinorUnits: 9900, currency: "USD", interval: "MONTH" } },
  chargeNow: {
    amountDueMinorUnits: 3333,
    totalMinorUnits: 3333,
    taxMinorUnits: 0,
    discountMinorUnits: 0,
    prorationMinorUnits: 3333,
    currency: "USD",
  },
  nextRecurring: { amountMinorUnits: 9900, currency: "USD", interval: "MONTH", startsAt: null },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...over,
});
const view = (status: AdminPlanChangeView["status"]): AdminPlanChangeView => ({
  id: "c1",
  status,
  target: { planName: "Pro", price: { amountMinorUnits: 9900, currency: "USD", interval: "MONTH" } },
  amountDueMinorUnits: 3333,
  currency: "USD",
  confirmedAt: null,
  finishedAt: null,
});

describe("SC3d-2 plan change wording", () => {
  it("only an unexpired immediate change with a charge can be confirmed", () => {
    expect(canConfirm(preview())).toBe(true);
    expect(canConfirm(preview({ expiresAt: new Date(Date.now() - 1).toISOString() }))).toBe(false);
    expect(canConfirm(preview({ timing: "PERIOD_END", chargeNow: null }))).toBe(false);
    expect(canConfirm(preview({ timing: "TRIAL_END", chargeNow: null }))).toBe(false);
  });

  it("explains refusals in plain words", () => {
    expect(planChangeRefusalMessage(409, { code: "BILLING_PLAN_CHANGE_PREVIEW_CHANGED", message: "x" })).toBe(
      PLAN_CHANGE_MESSAGES.changed,
    );
    expect(planChangeRefusalMessage(409, { code: "BILLING_PLAN_CHANGE_PREVIEW_EXPIRED" })).toBe(
      PLAN_CHANGE_MESSAGES.expired,
    );
    expect(planChangeRefusalMessage(409, { code: "SOMETHING_ELSE" })).toBe(PLAN_CHANGE_MESSAGES.unavailable);
    expect(planChangeRefusalMessage(403, null)).toBe(PLAN_CHANGE_MESSAGES.forbidden);
    expect(planChangeRefusalMessage(429, null)).toBe(PLAN_CHANGE_MESSAGES.tooMany);
  });

  it("never says the plan changed unless applied; payment-needed keeps the current plan", () => {
    expect(planChangeStatusMessage(view("APPLIED"))).toMatch(/now Pro/);
    for (const status of ["PROCESSING", "PAYMENT_NEEDED", "REVIEW", "EXPIRED", "FAILED"] as const) {
      expect(planChangeStatusMessage(view(status))).not.toMatch(/is now/);
    }
    expect(planChangeStatusMessage(view("PAYMENT_NEEDED"))).toMatch(/current plan stays active/);
    expect(planChangeStatusMessage(view("EXPIRED"))).toMatch(/weren't charged/);
  });
});

describe("SC3d-2 itemized charge", () => {
  it("lines add up to what is charged now, credits and discounts shown as reductions, zero lines omitted", () => {
    const lines = chargeLines(
      preview({
        chargeNow: {
          amountDueMinorUnits: 3083,
          totalMinorUnits: 3083,
          taxMinorUnits: 250,
          discountMinorUnits: 500,
          prorationMinorUnits: 3333,
          currency: "USD",
        },
      }),
    );
    expect(lines).toEqual([
      { label: "New plan for the rest of this period, less unused time", amount: "$33.33" },
      { label: "Discount", amount: "−$5.00" },
      { label: "Tax", amount: "+$2.50" },
      { label: "Charged now", amount: "$30.83", total: true },
    ]);
    expect(
      chargeLines(
        preview({
          chargeNow: {
            amountDueMinorUnits: 0,
            totalMinorUnits: -500,
            taxMinorUnits: 0,
            discountMinorUnits: 0,
            prorationMinorUnits: -500,
            currency: "USD",
          },
        }),
      ).map((l) => l.label),
    ).toEqual(["Credit for unused time", "Charged now"]);
    expect(chargeLines(preview({ timing: "PERIOD_END", chargeNow: null }))).toEqual([]);
  });

  it("states when the next recurring charge happens — never a second charge today", () => {
    expect(
      nextChargeSentence(
        preview({
          nextRecurring: { amountMinorUnits: 9900, currency: "USD", interval: "MONTH", startsAt: "2026-11-05T00:00:00Z" },
        }),
      ),
    ).toMatch(/next billing date \(November 5, 2026/);
    expect(nextChargeSentence(preview())).toMatch(/charge now starts your new billing period/);
  });
});
