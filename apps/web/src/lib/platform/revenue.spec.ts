import { barWidth, monthLabel, monthOptions, periodHref, periodParams, rate } from "./revenue";

// SC3f — revenue report wording and inputs (the API computes every figure).
describe("SC3f revenue report helpers", () => {
  it("labels UTC months and periods", () => {
    expect(monthLabel("2026-01")).toBe("Jan 2026");
    expect(monthOptions(new Date("2026-03-31T23:00:00Z")).slice(0, 4)).toEqual([
      "2026-03",
      "2026-02",
      "2026-01",
      "2025-12",
    ]);
    expect(monthOptions(new Date("2026-03-01T00:00:00Z"))).toHaveLength(24);
  });

  it("passes the period on as asked (the API refuses a malformed one visibly)", () => {
    expect(periodParams({ from: "2026-01", to: "2026-06" })).toEqual({ from: "2026-01", to: "2026-06" });
    expect(periodParams({ from: "June", to: "2026-13" })).toEqual({ from: "June", to: "2026-13" });
    expect(periodParams({ from: "x".repeat(50), to: ["a", "b"] })).toEqual({});
    expect(periodHref({ from: "2026-01", to: "2026-06" })).toBe("/platform/billing/revenue?from=2026-01&to=2026-06");
  });

  it("shows a rate only with a denominator", () => {
    expect(rate(1, 4)).toBe("25.0%");
    expect(rate(0, 0)).toBe("—");
  });

  it("sizes bars relative to the largest value", () => {
    expect(barWidth(50, 100)).toBe("50%");
    expect(barWidth(0, 100)).toBe("0%");
    expect(barWidth(1, 1000)).toBe("2%");
    expect(barWidth(5, 0)).toBe("0%");
  });
});
