import {
  PAYMENT_CASE_CATEGORIES,
  PAYMENT_RECOVERY_IN_PROGRESS,
  PAYMENT_RECOVERY_NOT_CONFIRMED,
  PAYMENT_RECOVERY_NOTHING_TO_RECOVER,
} from "@mocha-house/contracts";
import {
  CATEGORY_LABEL,
  PAYMENT_CASE_MESSAGES,
  interpretPaymentCaseChange,
  paymentCaseApiQuery,
  paymentCaseFilters,
  paymentCaseHref,
  validCaseId,
  validNote,
  validRecoveryReason,
} from "./payment-cases";

// ESP-03 PR 5 — the Platform Console's payment reconciliation wording and
// answer handling. The API decides; this only presents.
describe("platform payment cases", () => {
  it("names the four support states plainly, plus closed", () => {
    expect(PAYMENT_CASE_CATEGORIES.map((c) => CATEGORY_LABEL[c])).toEqual([
      "Needs attention",
      "Recovery in progress",
      "Recovered",
      "Awaiting verified payment outcome",
      "Closed",
    ]);
  });

  it("defaults to cases needing attention and keeps only well-formed filters", () => {
    expect(paymentCaseFilters({})).toEqual({
      category: "NEEDS_ATTENTION",
      tenantId: "",
      from: "",
      to: "",
    });
    expect(
      paymentCaseFilters({
        category: "RECOVERED",
        tenantId: "abc-123",
        from: "2026-10-01",
        to: "2026-10-31",
      }),
    ).toEqual({ category: "RECOVERED", tenantId: "abc-123", from: "2026-10-01", to: "2026-10-31" });
    expect(
      paymentCaseFilters({ category: "bogus", tenantId: "a b'; --", from: "01/10/2026", to: ["2026-10-02"] }),
    ).toEqual({ category: "NEEDS_ATTENTION", tenantId: "", from: "", to: "2026-10-02" });
  });

  it("sends only the filters that are set; 'all' sends no category", () => {
    expect(
      paymentCaseApiQuery({ category: "all", tenantId: "", from: "", to: "" }),
    ).toBe("");
    expect(
      paymentCaseApiQuery({ category: "NEEDS_ATTENTION", tenantId: "t1", from: "2026-10-01", to: "" }),
    ).toBe("category=NEEDS_ATTENTION&tenantId=t1&from=2026-10-01");
    expect(paymentCaseHref({ category: "all", tenantId: "", from: "", to: "" })).toBe(
      "/platform/payments?category=all",
    );
  });

  it("validates a recovery reason (10–500) and a note (1–1000) after trimming", () => {
    expect(validRecoveryReason("too short")).toBe(false);
    expect(validRecoveryReason("   customer called about it   ")).toBe(true);
    expect(validRecoveryReason("x".repeat(501))).toBe(false);
    expect(validNote("   ")).toBe(false);
    expect(validNote("checked the provider dashboard")).toBe(true);
    expect(validNote("x".repeat(1001))).toBe(false);
    expect(validCaseId("0199e2a4-1111-7000-8000-000000000001")).toBe(true);
    expect(validCaseId("../etc")).toBe(false);
  });

  it("explains each refusal without inventing an outcome", () => {
    const refused = (code: string) => interpretPaymentCaseChange("recover", 409, { code });
    expect(refused(PAYMENT_RECOVERY_NOT_CONFIRMED)).toEqual({
      kind: "error",
      message: expect.stringContaining("not confirmed"),
    });
    expect(refused(PAYMENT_RECOVERY_NOTHING_TO_RECOVER)).toEqual({
      kind: "error",
      message: expect.stringContaining("manual investigation"),
    });
    expect(refused(PAYMENT_RECOVERY_IN_PROGRESS)).toEqual({
      kind: "error",
      message: expect.stringContaining("already running"),
    });
    expect(interpretPaymentCaseChange("recover", 401, { code: "REAUTHENTICATION_REQUIRED" })).toEqual({
      kind: "reauth",
    });
    expect(interpretPaymentCaseChange("note", 403, null)).toEqual({
      kind: "error",
      message: PAYMENT_CASE_MESSAGES.denied,
    });
    expect(interpretPaymentCaseChange("note", null, null)).toEqual({
      kind: "error",
      message: PAYMENT_CASE_MESSAGES.unavailable,
    });
  });

  it("reports a recovery result, and that nothing was charged", () => {
    const detail = { case: {}, events: [], notes: [], automaticRecoveryEnabled: false };
    const ok = interpretPaymentCaseChange("recover", 200, { result: "RECOVERED", failure: null, detail });
    expect(ok).toMatchObject({ kind: "ok", message: expect.stringContaining("not charged again") });
    const failed = interpretPaymentCaseChange("recover", 200, {
      result: "FAILED",
      failure: "FULFILMENT_REJECTED",
      detail,
    });
    expect(failed).toMatchObject({
      kind: "ok",
      message: expect.stringMatching(/stays open.*Nothing was charged.*changed/),
    });
  });
});
