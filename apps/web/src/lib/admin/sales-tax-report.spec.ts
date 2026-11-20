import type { OrderItemRefundLine } from "@mocha-house/contracts";
import {
  EMPTY_DRAFT,
  itemsCanBeRefunded,
  itemsOfDraft,
  taxAttributionLabel,
  validateDraft,
} from "./order-refunds";
import {
  netTaxLabel,
  taxRefundKindLabel,
  taxRefundStatusView,
} from "./sales-tax-report";

// V1 Sales Tax PR 3 — item refunds and the sales tax report, as staff see them.
const LINES: OrderItemRefundLine[] = [
  {
    lineIndex: 0,
    productName: "Latte",
    quantity: 3,
    refundedQuantity: 1,
    remainingQuantity: 2,
    merchandiseMinorUnits: 1000,
    taxMinorUnits: 73,
  },
  {
    lineIndex: 1,
    productName: "Beans",
    quantity: 1,
    refundedQuantity: 1,
    remainingQuantity: 0,
    merchandiseMinorUnits: 1299,
    taxMinorUnits: 0,
  },
];

describe("item refunds in the refund panel", () => {
  it("reads the chosen items, within what is left", () => {
    const draft = { ...EMPTY_DRAFT, mode: "items" as const };
    expect(itemsOfDraft({ ...draft, itemQuantities: { 0: "2" } }, LINES)).toEqual({
      ok: true,
      items: [{ lineIndex: 0, quantity: 2 }],
    });
    expect(itemsOfDraft({ ...draft, itemQuantities: {} }, LINES)).toEqual({
      ok: false,
      error: "Choose at least one item to refund.",
    });
    expect(itemsOfDraft({ ...draft, itemQuantities: { 0: "3" } }, LINES)).toEqual({
      ok: false,
      error: "Only 2 of Latte can still be refunded.",
    });
    expect(itemsOfDraft({ ...draft, itemQuantities: { 0: "1.5" } }, LINES).ok).toBe(
      false,
    );
  });

  it("an items draft needs only a reason (the amount comes from the server)", () => {
    const checked = validateDraft(
      { ...EMPTY_DRAFT, mode: "items", reasonCode: "MISSING_ITEM" },
      500,
      "USD",
    );
    expect(checked.ok).toBe(true);
  });

  it("offers items only while some are left", () => {
    expect(itemsCanBeRefunded(LINES)).toBe(true);
    expect(itemsCanBeRefunded([LINES[1]])).toBe(false);
    expect(itemsCanBeRefunded(null)).toBe(false);
  });

  it("labels each refund's tax attribution", () => {
    const base = {
      id: "r",
      origin: "CENTERIVO" as const,
      status: "SUCCEEDED" as const,
      amountMinorUnits: 500,
      currency: "USD",
      reasonCode: null,
      reasonLabel: null,
      note: null,
      requestedBy: null,
      createdAt: "2026-11-20T00:00:00.000Z",
      succeededAt: null,
      failedAfterSuccessAt: null,
      lateFailureReviewedAt: null,
      lateFailureReviewNote: null,
      notCreatedEvidence: null,
      taxMinorUnits: null,
      items: [],
    };
    expect(taxAttributionLabel({ ...base, taxAttribution: "UNATTRIBUTED" })).toEqual({
      label: "Tax not attributed",
      tone: "warning",
    });
    expect(taxAttributionLabel({ ...base, taxAttribution: "ITEMS" })?.tone).toBe(
      "neutral",
    );
    expect(taxAttributionLabel({ ...base, taxAttribution: "NOT_TAXED" })).toBeNull();
  });
});

describe("the sales tax report", () => {
  it("never shows a withheld net as a number", () => {
    expect(netTaxLabel(null, "USD")).toBe("Not final");
    expect(netTaxLabel(1234, "USD")).toBe("$12.34");
  });

  it("names refund kinds and statuses plainly", () => {
    expect(taxRefundKindLabel("UNATTRIBUTED")).toMatch(/not attributed/);
    expect(taxRefundStatusView("CONFIRMED").label).toBe("Counted");
    expect(taxRefundStatusView("PENDING").label).toMatch(/not counted/);
    expect(taxRefundStatusView("UNRESOLVED").tone).toBe("warning");
  });
});
