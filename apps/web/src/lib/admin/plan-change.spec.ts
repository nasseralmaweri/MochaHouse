import type { AdminPlanChangeView, BillingPlanChangePreview } from "@mocha-house/contracts";
import {
  PLAN_CHANGE_MESSAGES,
  canCancelScheduled,
  canConfirm,
  chargeLines,
  moduleChangeSentences,
  nextChargeSentence,
  planChangeRefusalMessage,
  planChangeStatusMessage,
  scheduledTerms,
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
  modules: { lost: [], gained: [] },
  nextRecurring: { amountMinorUnits: 9900, currency: "USD", interval: "MONTH", startsAt: null },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...over,
});
const view = (
  status: AdminPlanChangeView["status"],
  over: Partial<AdminPlanChangeView> = {},
): AdminPlanChangeView => ({
  id: "c1",
  status,
  timing: "IMMEDIATE",
  effectiveAt: null,
  target: { planName: "Pro", price: { amountMinorUnits: 9900, currency: "USD", interval: "MONTH" } },
  amountDueMinorUnits: 3333,
  currency: "USD",
  confirmedAt: null,
  finishedAt: null,
  ...over,
});

describe("SC3d-2 plan change wording", () => {
  it("only an unexpired immediate change with a charge can be confirmed", () => {
    expect(canConfirm(preview())).toBe(true);
    expect(canConfirm(preview({ expiresAt: new Date(Date.now() - 1).toISOString() }))).toBe(false);
    // SC3d-3 — a scheduled change: nothing charged now, with its date.
    const at = { amountMinorUnits: 4900, currency: "USD", interval: "MONTH" as const, startsAt: "2026-11-05T00:00:00Z" };
    expect(canConfirm(preview({ timing: "PERIOD_END", chargeNow: null, nextRecurring: at }))).toBe(true);
    expect(canConfirm(preview({ timing: "TRIAL_END", chargeNow: null, nextRecurring: at }))).toBe(true);
    expect(canConfirm(preview({ timing: "PERIOD_END", chargeNow: null }))).toBe(false);
    expect(canConfirm(preview({ timing: "PERIOD_END", nextRecurring: at }))).toBe(false);
    expect(
      canConfirm(
        preview({
          timing: "PERIOD_END",
          chargeNow: null,
          nextRecurring: at,
          expiresAt: new Date(Date.now() - 1).toISOString(),
        }),
      ),
    ).toBe(false);
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

describe("SC3d-3 scheduled changes", () => {
  const at = { amountMinorUnits: 4900, currency: "USD", interval: "MONTH" as const, startsAt: "2026-11-05T00:00:00Z" };
  const down = preview({
    timing: "PERIOD_END",
    chargeNow: null,
    target: { planName: "Growth", price: { amountMinorUnits: 4900, currency: "USD", interval: "MONTH" } },
    nextRecurring: at,
    modules: { lost: [{ key: "marketing", label: "Marketing" }], gained: [] },
  });

  it("says nothing is charged now, when it starts, and that it can be cancelled", () => {
    expect(scheduledTerms(down)).toMatch(/^Nothing is charged now\./);
    expect(scheduledTerms(down)).toMatch(/until November 5, 2026/);
    expect(scheduledTerms(down)).toMatch(/cancel this until an hour before/);
    const trial = scheduledTerms({ ...down, timing: "TRIAL_END" });
    expect(trial).toMatch(/trial continues on your current plan/);
    expect(trial).toMatch(/charged \$49\.00 per month/);
  });

  it("lists the features removed (data kept) and added", () => {
    expect(moduleChangeSentences(down)).toEqual([
      expect.stringMatching(/no longer have from November 5, 2026.*: Marketing\. Your data in them is kept/),
    ]);
    expect(
      moduleChangeSentences(preview({ modules: { lost: [], gained: [{ key: "marketing", label: "Marketing" }] } })),
    ).toEqual(["You'll get: Marketing."]);
    expect(moduleChangeSentences(preview())).toEqual([]);
  });

  it("explains the new refusals", () => {
    expect(planChangeRefusalMessage(409, { code: "BILLING_PLAN_CHANGE_TOO_LATE" })).toBe(PLAN_CHANGE_MESSAGES.tooLate);
    expect(planChangeRefusalMessage(409, { code: "BILLING_PLAN_CHANGE_PAYMENT_METHOD_REQUIRED" })).toBe(
      PLAN_CHANGE_MESSAGES.paymentMethodRequired,
    );
    expect(planChangeRefusalMessage(409, { code: "BILLING_PLAN_CHANGE_NOT_CANCELABLE" })).toBe(
      PLAN_CHANGE_MESSAGES.notCancelable,
    );
  });

  it("a scheduled change keeps the current plan until its date; cancelling is offered until an hour before", () => {
    const effectiveAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const scheduled = view("SCHEDULED", { timing: "PERIOD_END", effectiveAt });
    expect(planChangeStatusMessage(scheduled)).toMatch(/keep your current plan/);
    expect(planChangeStatusMessage(scheduled)).toMatch(/nothing has been charged/);
    expect(planChangeStatusMessage(scheduled)).not.toMatch(/is now/);
    expect(planChangeStatusMessage(view("SCHEDULED", { timing: "TRIAL_END", effectiveAt }))).toMatch(
      /When your trial ends/,
    );
    expect(canCancelScheduled(scheduled)).toBe(true);
    expect(canCancelScheduled(scheduled, Date.now() + 61 * 60 * 1000)).toBe(false);
    expect(canCancelScheduled(view("APPLIED", { timing: "PERIOD_END", effectiveAt }))).toBe(false);
    expect(planChangeStatusMessage(view("CANCELED", { timing: "PERIOD_END", effectiveAt }))).toMatch(
      /plan stays as it is/,
    );
    // Applied at the switch: never claims a payment was confirmed.
    const applied = planChangeStatusMessage(view("APPLIED", { timing: "PERIOD_END", effectiveAt }));
    expect(applied).toMatch(/now Pro/);
    expect(applied).not.toMatch(/payment/);
  });
});
