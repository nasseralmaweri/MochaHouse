import {
  classTotalRatePpm,
  locationTaxStateLabel,
  ratePercentLabel,
  salesTaxSetupNote,
  taxRefusalMessage,
  validateDraftRows,
  type TaxComponentDraftRow,
} from "./tax";
import { adminNavItems } from "./nav";
import type { AdminCapabilities } from "./capabilities";

// V1 Sales Tax PR 1 — Admin > Sales tax presentation.
const row = (over: Partial<TaxComponentDraftRow> = {}): TaxComponentDraftRow => ({
  key: "r1",
  name: "Michigan sales tax",
  jurisdiction: "STATE",
  ratePercent: "6",
  taxClassIds: ["food"],
  ...over,
});

describe("sales tax presentation", () => {
  it("sums rates exactly in parts per million", () => {
    const components = [
      { ratePpm: 60_000, taxClassIds: ["food", "grocery"] },
      { ratePpm: 125, taxClassIds: ["food"] },
      { ratePpm: 10_050, taxClassIds: ["grocery"] },
    ];
    expect(classTotalRatePpm(components, "food")).toBe(60_125);
    expect(ratePercentLabel(classTotalRatePpm(components, "food"))).toBe("6.0125%");
    expect(ratePercentLabel(classTotalRatePpm(components, "grocery"))).toBe("7.005%");
    expect(classTotalRatePpm(components, "none")).toBe(0);
    expect(ratePercentLabel(0)).toBe("0%");
  });

  it("validates the editor's rows before saving", () => {
    expect(validateDraftRows([row(), row({ key: "r2", ratePercent: " 0.5 " })])).toEqual({
      ok: true,
      components: [
        { name: "Michigan sales tax", jurisdiction: "STATE", ratePercent: "6", taxClassIds: ["food"] },
        { name: "Michigan sales tax", jurisdiction: "STATE", ratePercent: "0.5", taxClassIds: ["food"] },
      ],
    });
    const bad = validateDraftRows([
      row({ key: "a", name: " " }),
      row({ key: "b", ratePercent: "6.12345" }),
      row({ key: "c", taxClassIds: [] }),
    ]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["a", "b", "c"]);
    // A location with no taxes is allowed (nothing is charged there).
    expect(validateDraftRows([])).toEqual({ ok: true, components: [] });
    const many = validateDraftRows(
      Array.from({ length: 11 }, (_, i) => row({ key: `k${i}` })),
    );
    expect(many.ok).toBe(false);
  });

  it("labels each location's state", () => {
    expect(locationTaxStateLabel({ state: "NOT_SET", hasDraft: false }).label).toBe("Not set up");
    expect(locationTaxStateLabel({ state: "DRAFT", hasDraft: true }).tone).toBe("warning");
    expect(locationTaxStateLabel({ state: "CONFIRMED", hasDraft: true }).label).toBe(
      "Confirmed · changes in draft",
    );
  });

  it("describes setup progress without making it a requirement", () => {
    expect(salesTaxSetupNote({ totalLocations: 2, confirmedLocations: 1 })).toEqual({
      done: false,
      text: expect.stringContaining("1 of 2 locations confirmed"),
    });
    expect(salesTaxSetupNote({ totalLocations: 1, confirmedLocations: 1 }).done).toBe(true);
    expect(salesTaxSetupNote({ totalLocations: 0, confirmedLocations: 0 }).done).toBe(false);
  });

  it("explains refusals plainly", () => {
    expect(taxRefusalMessage(403, null)).toMatch(/authorized administrator/);
    expect(taxRefusalMessage(409, { message: "Review the tax class first." })).toBe(
      "Review the tax class first.",
    );
    expect(taxRefusalMessage(null, null)).toMatch(/Could not reach/);
  });

  it("shows Sales tax in the navigation only with tax.manage", () => {
    const withTax = { "tax.manage": { corporate: true, locationIds: [] } };
    const keys = (capabilities: unknown) =>
      adminNavItems(capabilities as AdminCapabilities).map((item) => item.key);
    expect(keys(withTax)).toContain("tax");
    expect(keys({ "orders.view": { corporate: true, locationIds: [] } })).not.toContain("tax");
  });
});
